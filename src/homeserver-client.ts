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
import { type ProfileEdit, isFollowableLink, mergeProfile } from './profile';
import { withTimeout } from './with-timeout';
import { messageOf } from './format';

type Sdk = typeof import('@synonymdev/pubky');

export type RingRequestKind = 'signup' | 'signin';

export type RingRequest = {
  /** The `pubkyauth://` link to show as a QR code and to open on this device. */
  authUrl: string;
  /** Resolves once Ring's approval has been checked against this homeserver; rejects when the request expires. */
  awaitAccount: () => Promise<AccountInfo>;
  /** Whether an approved sign-in outlasts the page on this browser. */
  staysSignedIn: boolean;
};

/** The SDK's error for a homeserver's refusal names the pubky it could not place. */
const UNRESOLVED_HOMESERVER = /could not resolve homeserver for ([a-z0-9]{52})/;

/**
 * How long a request waits for Ring. Long enough to install Ring and create a
 * key first, for a sign-up. The SDK cannot stop waiting on the relay, so an
 * abandoned request keeps polling until the page is closed; an approval that
 * still arrives for it is revoked.
 */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a visit waits for a saved sign-in to be checked before starting signed out. */
const RESTORE_TIMEOUT_MS = 10 * 1000;

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
  /** The saved record of that session in the browser's store, when it has one. */
  private savedId: string | null = null;
  /** The Ring request whose approval would sign someone in; an approval for any other is revoked. */
  private request: object | null = null;
  /** The check of a saved sign-in that may still sign someone in; one that timed out or was overtaken may not. */
  private restoring: object | null = null;
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
    const mine = {};
    await this.endSignIn(mine);
    const flow = await this.startFlow(this.flowKind(kind, inviteCode));
    const account = flow.awaitApproval().then(
      (session) => this.confirmAccount(session, mine),
      (error: unknown) => noAccountOf(error),
    );
    // An abandoned request may still fail later; nobody is waiting for it then.
    account.catch(() => undefined);
    return {
      authUrl: flow.authorizationUrl,
      staysSignedIn: await this.canKeepSignIn(),
      awaitAccount: () =>
        withTimeout(account, APPROVAL_TIMEOUT_MS, 'This request expired. Start again.').catch((error: unknown) => {
          // Expired or failed: an approval that comes later signs nobody in.
          if (this.request === mine) this.request = null;
          throw error;
        }),
    };
  }

  /**
   * A grant flow whose session can be kept across visits where the browser
   * allows: a "delegated" one, signed for with a key the browser holds and
   * script cannot copy out. Elsewhere a plain flow, whose session lasts until
   * the page is closed and is never saved.
   */
  private async startFlow(kind: AuthFlowKind) {
    const capabilities = ACCOUNT_CAPABILITY as Capabilities;
    const options = { clientId: clientId(), relay: this.config.relay };
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
   * the account is here, Ring granted writing the profile, and `request` is
   * still the one being waited for: an approval that arrives after Cancel,
   * after the request expired or after a newer request signs nobody in.
   * Otherwise the grant is revoked at once. A kept session is also saved in
   * the browser where it can be, so the next visit starts signed in.
   */
  private async confirmAccount(session: Session, request: object): Promise<AccountInfo> {
    let keep = false;
    try {
      const account = await this.readAccountInfo(session);
      keep = keepsSessionFor(account);
      return account;
    } finally {
      if (keep && this.request === request) {
        this.request = null;
        this.session = session;
        if (await this.canKeepSignIn()) await this.saveSignIn(session);
      } else await revoke(session);
    }
  }

  /** Saves a session just adopted. Not saved is not a failure: the sign-in then lasts until the page is closed. */
  private async saveSignIn(session: Session): Promise<void> {
    const store = this.pubky.browserSessionStore;
    const saved = await store.save(session).catch(() => null);
    if (!saved) return;
    // Signed out while it was being saved: that sign-out found nothing to forget.
    if (this.session === session) this.savedId = saved.id;
    else await store.remove(saved.id).catch(() => undefined);
  }

  /**
   * The account of whoever stayed signed in on this browser, or null when
   * nobody did. A saved sign-in the homeserver no longer honours (its grant
   * was revoked in Ring, or ran out) is forgotten. One that cannot be checked
   * within ten seconds is left saved for the next visit, and signs nobody in
   * on this one, however its check ends. Never throws.
   */
  async restoreSignIn(): Promise<AccountInfo | null> {
    const mine = {};
    this.restoring = mine;
    const restored = this.canKeepSignIn().then((keeps) => (keeps ? this.restoreSaved(mine) : null));
    return withTimeout(restored, RESTORE_TIMEOUT_MS, 'The saved sign-in could not be checked in time')
      .catch(() => null)
      .finally(() => {
        if (this.restoring === mine) this.restoring = null;
      });
  }

  /** The newest saved sign-in for this homeserver that it still honours; another tab may have saved a later one. */
  private async restoreSaved(restoring: object): Promise<AccountInfo | null> {
    const store = this.pubky.browserSessionStore;
    // A sign-out that was cut short (the tab was closed, the homeserver was slow) is finished first.
    for (const [pubky, at] of Object.entries(signingOut.read())) await this.forgetSignIns(pubky, at);
    // What could not be forgotten just now is signed out all the same.
    const signedOut = signingOut.read();
    for (const { id, publicKey, createdAt } of await this.savedSignIns()) {
      if (createdAt <= (signedOut[publicKey] ?? -Infinity)) continue;
      try {
        const session = await store.restore(id);
        const account = await this.readAccountInfo(session);
        // Timed out, or a sign-in or sign-out took over meanwhile: the rest stays saved, unchecked.
        if (this.restoring !== restoring) return null;
        if (keepsSessionFor(account)) {
          this.session = session;
          this.savedId = id;
          return account;
        }
        // Not a sign-in the page keeps a session for.
        await revoke(session);
        await store.remove(id).catch(() => undefined);
      } catch (error) {
        if (isDeadSignIn(error)) await store.remove(id).catch(() => undefined);
      }
    }
    return null;
  }

  /** The sign-ins saved in this browser for this homeserver, newest first; `pubky`'s only when given. */
  private async savedSignIns(pubky?: string) {
    const saved = await this.pubky.browserSessionStore.list();
    return saved
      .filter((record) => record.homeserver === this.config.homeserver && (!pubky || record.publicKey === pubky))
      .sort((a, b) => b.createdAt - a.createdAt);
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

  /**
   * Signs out: abandons any Ring request or check of a saved sign-in,
   * revokes the grant the page holds and forgets every sign-in saved in this
   * browser for the same person, revoking those too. Sign-ins saved for
   * other people are left alone. Never throws.
   */
  signOut(): Promise<void> {
    return this.endSignIn(null);
  }

  /**
   * Ends the sign-in and makes `next` the request being waited for, at once:
   * a slower call that started earlier must not take that over. The saved
   * sign-in is needed to revoke with, so the sign-out is noted first and the
   * record forgotten after: if the revocation does not land (the homeserver
   * is slow or out of reach, the tab is closed), the next visit still starts
   * signed out, and tries again.
   */
  private async endSignIn(next: object | null): Promise<void> {
    const { session, savedId } = this;
    this.request = next;
    this.restoring = null;
    this.session = null;
    this.savedId = null;
    if (!session) return;
    const pubky = session.info.publicKey.z32();
    const at = signingOut.mark(pubky);
    const revoked = await revoke(session);
    if (!(await this.canKeepSignIn())) signingOut.clear(pubky, at);
    else if (revoked || !savedId) await this.forgetSignIns(pubky, at, savedId);
  }

  /**
   * Revokes and forgets the sign-ins saved for `pubky` up to the sign-out at
   * `at`; one saved since is a new sign-in, and stays. `revoked` is the one
   * whose grant is revoked already. A sign-in that could not be revoked stays
   * saved, with the note of the sign-out, for the next visit to try again.
   */
  private async forgetSignIns(pubky: string, at: number, revoked: string | null = null): Promise<void> {
    const store = this.pubky.browserSessionStore;
    const signedOut = async () => (await this.savedSignIns(pubky)).filter((record) => record.createdAt <= at);
    try {
      for (const { id } of await signedOut()) {
        const gone = id === revoked || (await store.restore(id).then(revoke, isDeadSignIn));
        // Gone too when another tab forgot it meanwhile. A failure to remove tells little: revoking can take the
        // record away already.
        if (gone) await store.remove(id).catch(() => undefined);
      }
      if ((await signedOut()).length === 0) signingOut.clear(pubky, at);
    } catch {
      // The store could not be read: still noted as signed out.
    }
  }

  /**
   * Writes an edited profile for the signed-in person. The stored file is
   * read first and only the edited parts replaced, so its picture and whatever
   * else another app keeps there survive.
   */
  async saveProfile(edit: ProfileEdit): Promise<void> {
    if (!this.session) throw new Error('You are signed out. Sign in again to save your profile.');
    const storage = this.session.storage;
    try {
      const stored = await storage.getJson(PROFILE_PATH).catch((error: unknown) => {
        if (statusCodeOf(error) === 404) return {};
        throw error;
      });
      await storage.putJson(PROFILE_PATH, mergeProfile(isRecord(stored) ? stored : {}, edit));
    } catch (error) {
      // Signed out in another tab, or revoked in Ring, since this page signed in.
      if (isEndedSignIn(error)) throw new Error('Your sign-in has ended. Sign out and sign in again.');
      throw error;
    }
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
      // Another app may have stored an address that runs script; such a link is not shown.
      links: Array.isArray(raw.links) ? raw.links.filter(isLink).filter((link) => isFollowableLink(link.url)) : [],
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
 * The people a sign-out is under way for and when each began, noted where a
 * write lands at once (`localStorage`), unlike the store their sign-ins are
 * saved in. Storage that cannot be used is no failure: the sign-out then
 * depends on finishing.
 */
const signingOut = {
  key: 'homeserver-portal:signing-out',
  /** Pubky to the time of the sign-out, in Unix milliseconds. */
  read(): Record<string, number> {
    try {
      const noted: unknown = JSON.parse(localStorage.getItem(this.key) ?? '{}');
      return isRecord(noted)
        ? Object.fromEntries(
            Object.entries(noted).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
          )
        : {};
    } catch {
      return {};
    }
  },
  write(noted: Record<string, number>) {
    try {
      if (Object.keys(noted).length > 0) localStorage.setItem(this.key, JSON.stringify(noted));
      else localStorage.removeItem(this.key);
    } catch {
      // No storage: nothing to note it in.
    }
  },
  /** Notes a sign-out beginning now, and returns when that is. */
  mark(pubky: string): number {
    const at = Date.now();
    this.write({ ...this.read(), [pubky]: at });
    return at;
  },
  /** Drops the note of the sign-out at `at`; a later one for the same person stays. */
  clear(pubky: string, at: number) {
    const { [pubky]: noted, ...others } = this.read();
    if (noted !== undefined && noted <= at) this.write(others);
  },
};

/**
 * Whether a saved sign-in failed because the homeserver no longer honours it,
 * not because it could not be asked. The SDK reports a refused restore as a
 * `ClientStateError`; a refusal met later carries the HTTP status.
 */
function isDeadSignIn(error: unknown): boolean {
  return isEndedSignIn(error) || statusCodeOf(error) === 403;
}

/**
 * Whether a write failed because the session behind it is gone: signed out
 * in another tab, or revoked in Ring. Not 403, which a write also gets for an
 * account that may not write.
 */
function isEndedSignIn(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'ClientStateError' || statusCodeOf(error) === 401;
}

/** Whether the page keeps a session for this account: it is here, and Ring granted writing its profile. */
const keepsSessionFor = (account: AccountInfo) => account.hasAccount && account.canEditProfile === true;

/**
 * Revokes a session's grant; whether it is revoked now, which a session the
 * homeserver had ended already also is. Best effort: a grant that could not be
 * revoked stays listed in Ring until it expires.
 */
const revoke = (session: Session): Promise<boolean> =>
  session.signout().then(
    () => true,
    (error: unknown) => isDeadSignIn(error),
  );

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
