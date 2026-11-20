/**
 * The portal's link to the homeserver and to Pubky Ring, from the
 * visitor's own browser. The page has no server side: every request here goes
 * from the browser to the homeserver's public API, so the homeserver sees each
 * visitor's own address and applies its rate limits per visitor, and no admin
 * credential is involved anywhere.
 *
 * This is the only module that loads the Pubky SDK. It is loaded on demand in
 * the browser: it is large, and its Node build must never run in the server.
 */
import type {
  AccountInfo as SdkAccount,
  AuthFlowKind,
  Capabilities,
  GrantAuthFlowOptions,
  GrantSession,
  Pubky,
  Session,
} from '@synonymdev/pubky';
import { parseHomeserverTime } from './account';
import { parseEventStream } from './activity';
import {
  type AccountConfig,
  type AccountInfo,
  type AccountRecord,
  type FeedEvent,
  type HomeserverInfo,
  type InviteStatus,
  type Profile,
  ACCOUNT_CAPABILITY,
  PROFILE_PATH,
  readsRoot,
  writesProfile,
  type SignedRecord,
} from './model';
import { parseSignedRecord } from './pkarr';
import { type ProfileEdit, mergeProfile } from './profile';
import { withTimeout } from './with-timeout';

type Sdk = typeof import('@synonymdev/pubky');

export type RingRequestKind = 'signup' | 'signin';

export type RingRequest = {
  /** The `pubkyauth://` link to show as a QR code and to open on this device. */
  authUrl: string;
  /** Resolves once Ring's approval has been checked against this homeserver; rejects when the request expires. */
  awaitAccount: () => Promise<AccountInfo>;
};

/** The SDK's error for a homeserver's refusal names the pubky it could not place. */
const UNRESOLVED_HOMESERVER = /could not resolve homeserver for ([a-z0-9]{52})/;

/**
 * How long a request waits for Ring. Long enough to install Ring and create a
 * key first, for a sign-up. The SDK cannot stop waiting on the relay, so an
 * abandoned request keeps polling until the page is closed; it is ignored.
 */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** A syntactically valid code no homeserver issues; asks whether codes are required. */
const PROBE_INVITE_CODE = '0000-0000-0000';

/** An avatar larger than this is not shown. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Where a key's signed record is read from: the Pubky SDK's default relay, or the testnet's. */
const PKARR_RELAY = 'https://pkarr.pubky.app';
const TESTNET_PKARR_PORT = 15411;

export class HomeserverClient {
  /** The signed-in person's session, kept to write their profile with; null when nobody is signed in. */
  private session: Session | null = null;
  /** Whether this browser can keep a sign-in across visits; found out once, on first need. */
  private keepsSignIn: Promise<boolean> | null = null;

  private constructor(
    private readonly sdk: Sdk,
    private readonly pubky: Pubky,
    private readonly config: AccountConfig,
  ) {}

  static async connect(config: AccountConfig): Promise<HomeserverClient> {
    const sdk = await import('@synonymdev/pubky');
    const pubky = config.testnetHost ? sdk.Pubky.testnet(config.testnetHost) : new sdk.Pubky();
    return new HomeserverClient(sdk, pubky, config);
  }

  /** `code` must be a whole invite code. Never throws: a failure is 'error'. */
  async inviteStatus(code: string): Promise<InviteStatus> {
    try {
      const response = await this.homeserverFetch(`/signup_tokens/${encodeURIComponent(code)}`);
      return await statusOf(response);
    } catch {
      return 'error';
    }
  }

  /** Whether sign-up needs an invite code; null when the homeserver gave no clear answer. */
  async isInviteRequired(): Promise<boolean | null> {
    const status = await this.inviteStatus(PROBE_INVITE_CODE);
    if (status === 'not_required') return false;
    if (status === 'error' || status === 'rate_limited') return null;
    return true;
  }

  /** Starts a Ring request; `inviteCode` only for a sign-up on a homeserver that needs one. */
  async startRequest(kind: RingRequestKind, inviteCode: string | null): Promise<RingRequest> {
    await this.signOut();
    const flow = await this.startFlow(ACCOUNT_CAPABILITY as Capabilities, this.flowKind(kind, inviteCode), {
      clientId: clientId(),
      relay: this.config.relay,
    });
    const account = flow.awaitApproval().then(
      (session) => this.confirmAccount(session),
      (error: unknown) => noAccountOf(error),
    );
    // An abandoned request may still fail later; nobody is waiting for it then.
    account.catch(() => undefined);
    return {
      authUrl: flow.authorizationUrl,
      awaitAccount: () => withTimeout(account, APPROVAL_TIMEOUT_MS, 'This request expired. Start again.'),
    };
  }

  /**
   * A grant flow whose session can be kept across visits where the browser
   * allows: a "delegated" one, signed for with a key the browser holds and
   * script cannot copy out. Elsewhere a plain flow, whose session lasts until
   * the page is closed and is never saved.
   */
  private async startFlow(capabilities: Capabilities, kind: AuthFlowKind, options: GrantAuthFlowOptions) {
    return (await this.canKeepSignIn())
      ? this.sdk.GrantAuthFlow.startDelegated(capabilities, kind, options)
      : this.pubky.startGrantAuthFlow(capabilities, kind, options);
  }

  /**
   * Whether a sign-in can outlast the page here: the browser must hold keys
   * and a store for them. Never on a testnet, which only the SDK's facade
   * knows how to reach, and the delegated flow starts without it.
   */
  private canKeepSignIn(): Promise<boolean> {
    this.keepsSignIn ??= (async () =>
      !this.config.testnetHost &&
      this.sdk.GrantAuthFlow.isDelegationAvailable &&
      (await this.pubky.browserSessionStore.isAvailable()))().catch(() => false);
    return this.keepsSignIn;
  }

  private flowKind(kind: RingRequestKind, inviteCode: string | null) {
    const { AuthFlowKind, PublicKey } = this.sdk;
    return kind === 'signup'
      ? AuthFlowKind.signup(PublicKey.from(this.config.homeserver), inviteCode)
      : AuthFlowKind.signin();
  }

  /**
   * Ring's approval opened a session at the person's homeserver: the one
   * their own record names, or, for a sign-up, this one. Reads the account
   * through it. A session at another homeserver means no account here,
   * whatever is there. The session is kept, for the profile editor, only when
   * the account is here and Ring granted writing the profile; otherwise the
   * grant is revoked at once. A kept session is also saved in the browser
   * where it can be, so the next visit starts signed in.
   */
  private async confirmAccount(session: Session): Promise<AccountInfo> {
    let keep = false;
    try {
      const account = await this.readAccountInfo(session);
      keep = account.hasAccount && account.canEditProfile === true;
      return account;
    } finally {
      if (keep) {
        this.session = session;
        // Not saved is not a failure: the sign-in then lasts until the page is closed.
        if (await this.canKeepSignIn()) await this.pubky.browserSessionStore.save(session).catch(() => undefined);
      } else await revoke(session);
    }
  }

  /**
   * The account of whoever stayed signed in on this browser, or null when
   * nobody did. A saved sign-in the homeserver no longer honours (its grant
   * was revoked in Ring, or ran out) is forgotten. Never throws: one that
   * cannot be checked right now is left for the next visit.
   */
  async restoreSignIn(): Promise<AccountInfo | null> {
    if (!(await this.canKeepSignIn())) return null;
    const store = this.pubky.browserSessionStore;
    try {
      const saved = (await store.list()).find((record) => record.homeserver === this.config.homeserver);
      if (!saved) return null;
      try {
        const session = await store.restore(saved.id);
        const account = await this.readAccountInfo(session);
        if (!account.hasAccount || !account.canEditProfile) return null;
        this.session = session;
        return account;
      } catch (error) {
        if (isDeadSignIn(error)) await store.remove(saved.id);
        return null;
      }
    } catch {
      return null;
    }
  }

  private async readAccountInfo(session: Session): Promise<AccountInfo> {
    const pubky = session.info.publicKey.z32();
    const grant = session.grant;
    if (!grant) throw new Error('The sign-in did not open a grant session');
    const info = await grant.sessionInfo();
    const homeserver = info.homeserver.z32();
    if (homeserver !== this.config.homeserver) return { pubky, hasAccount: false, otherHomeserver: homeserver };
    const canEditProfile = info.capabilities.some(writesProfile);
    if (!info.capabilities.some(readsRoot)) return { pubky, hasAccount: true, partialGrant: true, canEditProfile };
    const account = await readAccount(grant);
    return { pubky, hasAccount: true, canEditProfile, ...(account && { account }) };
  }

  /** Revokes the signed-in person's grant, if the page holds one, and forgets any saved sign-in. Never throws. */
  async signOut(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await revoke(session);
    if (await this.canKeepSignIn()) await this.pubky.browserSessionStore.clear().catch(() => undefined);
  }

  /**
   * Writes an edited profile for the signed-in person. The stored file is
   * read first and only the edited parts replaced, so its picture and whatever
   * else another app keeps there survive.
   */
  async saveProfile(edit: ProfileEdit): Promise<void> {
    if (!this.session) throw new Error('You are signed out. Sign in again to save your profile.');
    const storage = this.session.storage;
    const stored = await storage.getJson(PROFILE_PATH).catch((error: unknown) => {
      if (statusCodeOf(error) === 404) return {};
      throw error;
    });
    await storage.putJson(PROFILE_PATH, mergeProfile(isRecord(stored) ? stored : {}, edit));
  }

  /** The person's pubky.app profile, or null when they have none here. */
  async profile(pubky: string): Promise<Profile | null> {
    const response = await this.homeserverFetch(`/storage/${pubky}${PROFILE_PATH}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The homeserver could not read the profile (${response.status})`);
    const raw = (await response.json()) as Record<string, unknown>;
    if (typeof raw.name !== 'string') return null;
    return {
      name: raw.name,
      bio: typeof raw.bio === 'string' && raw.bio.trim() ? raw.bio : null,
      status: typeof raw.status === 'string' && raw.status.trim() ? raw.status : null,
      links: Array.isArray(raw.links) ? raw.links.filter(isLink) : [],
      avatar: typeof raw.image === 'string' && raw.image ? await this.avatar(raw.image).catch(() => null) : null,
    };
  }

  /**
   * A profile image as a `data:` URL, or null. pubky.app stores an image as a
   * `pubky://…/pub/pubky.app/files/<id>` record whose `src` names the blob; a
   * plain https URL is fetched as it is. A data URL because the page's
   * Content-Security-Policy allows no other image source.
   */
  private async avatar(image: string): Promise<string | null> {
    let source = image;
    if (image.startsWith('pubky://') && image.includes('/pub/pubky.app/files/')) {
      const record = (await this.readPublic(image).then((r) => r.json())) as { src?: unknown };
      if (typeof record.src !== 'string') return null;
      source = record.src;
    }
    const response = await this.readPublic(source);
    const size = Number(response.headers.get('content-length') ?? 0);
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/') || size > MAX_AVATAR_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_AVATAR_BYTES) return null;
    return `data:${type};base64,${toBase64(bytes)}`;
  }

  /** Reads a public resource: a `pubky://` address wherever its owner's homeserver is, or an https URL. */
  private readPublic(url: string): Promise<Response> {
    return url.startsWith('pubky://')
      ? this.pubky.publicStorage.get(url as `pubky://${string}/pub/${string}`)
      : this.pubky.client.fetch(url);
  }

  /** What the homeserver says about itself, and the address its key resolved to. */
  async info(): Promise<HomeserverInfo> {
    const response = await this.homeserverFetch('/info');
    if (!response.ok) throw new Error(`The homeserver did not describe itself (${response.status})`);
    const raw = (await response.json()) as { features?: unknown };
    const features = Array.isArray(raw.features) ? raw.features.filter((f): f is string => typeof f === 'string') : [];
    return { features, address: originOf(response.url) };
  }

  /** The homeserver's signed record on the Pubky network, or null when the relay has none. */
  async homeserverRecord(): Promise<SignedRecord | null> {
    const relay = this.config.testnetHost ? `http://${this.config.testnetHost}:${TESTNET_PKARR_PORT}` : PKARR_RELAY;
    const response = await fetch(`${relay}/${this.config.homeserver}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The relay could not serve the record (${response.status})`);
    return parseSignedRecord(new Uint8Array(await response.arrayBuffer()), this.config.homeserver);
  }

  /**
   * One person's newest public events, newest first, at most `limit`; with a
   * `cursor` (from the previous page) the ones before it. With a `path`
   * under `/pub/`, only that file's events or, when it is a folder, those of
   * everything in it. One request each: the event stream answers a batch
   * and closes.
   */
  async ownEvents(
    pubky: string,
    cursor: string | null,
    limit: number,
    path = '',
  ): Promise<{ events: FeedEvent[]; cursor: string | null }> {
    const user = cursor ? `${pubky}:${encodeURIComponent(cursor)}` : pubky;
    // The homeserver takes a path with a trailing slash as a folder and one without as a single file: ask for both.
    const under = path ? `&path=${encodeURIComponent(`/pub/${path}`)}&path=${encodeURIComponent(`/pub/${path}/`)}` : '';
    const response = await this.homeserverFetch(`/events-stream?user=${user}&reverse=true&limit=${limit}${under}`);
    if (!response.ok) throw new Error(`The homeserver could not list your changes (${response.status})`);
    return parseEventStream(await response.text());
  }

  private homeserverFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.pubky.client.fetch(`https://${this.config.homeserver}${path}`, { ...init, credentials: 'include' });
  }
}

/**
 * The account as the homeserver reports it, or undefined when it does not:
 * a homeserver from before `GET /account` (0.18) takes the path for a storage
 * read and refuses it (403 on 0.17, 404 otherwise). Any other failure is
 * reported.
 */
async function readAccount(grant: GrantSession): Promise<AccountRecord | undefined> {
  try {
    return toAccountRecord(await grant.account());
  } catch (error) {
    if (statusCodeOf(error) === 404 || statusCodeOf(error) === 403) return undefined;
    throw error;
  }
}

/**
 * Whether a saved sign-in failed because the homeserver no longer honours it,
 * not because it could not be asked. The SDK reports a refused restore as a
 * `ClientStateError`; a refusal met later carries the HTTP status.
 */
function isDeadSignIn(error: unknown): boolean {
  const status = statusCodeOf(error);
  return (error as { name?: unknown } | null)?.name === 'ClientStateError' || status === 401 || status === 403;
}

/** Best effort: a grant that could not be revoked stays listed in Ring until it expires. */
const revoke = (session: Session) => session.signout().catch(() => undefined);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toAccountRecord(account: SdkAccount): AccountRecord {
  return {
    createdAt: parseHomeserverTime(account.createdAt),
    disabled: account.disabled,
    usedBytes: account.usedBytes,
    quota: { effective: { ...account.quota.effective }, overrides: { ...account.quota.overrides } },
  };
}

/**
 * A failed approval that means "no account", or the failure itself. The
 * homeserver answers 404 for a pubky it does not know; a pubky whose record
 * names no homeserver at all cannot be placed by the SDK. Who approved is
 * only known in the second case, from the SDK's message.
 */
function noAccountOf(error: unknown): AccountInfo {
  if (statusCodeOf(error) === 404) return { pubky: null, hasAccount: false };
  const unresolved = UNRESOLVED_HOMESERVER.exec(messageOf(error));
  if (unresolved) return { pubky: unresolved[1], hasAccount: false };
  throw error;
}

/** The HTTP status in a Pubky SDK error, if it carries one. */
function statusCodeOf(error: unknown): number | null {
  const data = (error as { data?: unknown } | null)?.data;
  const status = typeof data === 'object' && data !== null ? (data as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' ? status : null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How the page names itself in Ring's list of grants: its host. */
function clientId(): string {
  const host = typeof location === 'undefined' ? '' : location.hostname;
  return host || 'homeserver-portal';
}

async function statusOf(response: Response): Promise<InviteStatus> {
  // 400 is also the answer to a malformed code, which callers rule out first.
  if (response.status === 400) return 'not_required';
  if (response.status === 404) return 'unknown';
  if (response.status === 429) return 'rate_limited';
  if (!response.ok) return 'error';
  const body = (await response.json()) as { status?: unknown };
  if (body.status === 'used' || body.status === 'valid') return body.status;
  return 'error';
}

/** `https://host[:port]` of a response's URL, or null when it is not an http(s) URL. */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

const isLink = (value: unknown): value is { title: string; url: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { title?: unknown }).title === 'string' &&
  typeof (value as { url?: unknown }).url === 'string';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
