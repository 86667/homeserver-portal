import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_CAPABILITY, type AccountConfig } from './model';
import { HomeserverClient } from './homeserver-client';

const HOMESERVER = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';
const ALICE = 'whgxto9xtroaih7ict9chtuxh1xmbpmci5qd71jsen3ow3bscipy';
const OTHER_HOMESERVER = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';

// A stand-in for the Pubky SDK: records what the client asks of it.
const sdk = vi.hoisted(() => {
  const clientFetch = vi.fn();
  const startGrantAuthFlow = vi.fn();
  const publicGet = vi.fn();
  // The browser's store of saved sign-ins: what `saved` holds. Not available unless a test says so.
  type Saved = { id: string; homeserver: string; publicKey: string; createdAt: number; session: unknown };
  const saved: Saved[] = [];
  const store = {
    saved,
    isAvailable: vi.fn(async () => false),
    save: vi.fn(async (session: { info: { publicKey: { z32: () => string } }; savedAt?: string }) => {
      const record = {
        id: `saved-${saved.length + 1}`,
        homeserver: session.savedAt ?? '',
        publicKey: session.info.publicKey.z32(),
        createdAt: Date.now(),
        session,
      };
      saved.push(record);
      return record;
    }),
    list: vi.fn(async () => [...saved]),
    restore: vi.fn(async (id: string): Promise<unknown> => {
      const record = saved.find((r) => r.id === id);
      if (!record) throw Object.assign(new Error('Browser session is no longer valid.'), { name: 'ClientStateError' });
      if (record.session instanceof Error) throw record.session;
      return record.session;
    }),
    remove: vi.fn(async (id: string) => {
      const at = saved.findIndex((r) => r.id === id);
      if (at >= 0) saved.splice(at, 1);
    }),
    clear: vi.fn(async () => undefined),
  };
  const GrantAuthFlow = { isDelegationAvailable: false, startDelegated: vi.fn() };
  class Pubky {
    client = { fetch: clientFetch };
    publicStorage = { get: publicGet };
    browserSessionStore = store;
    startGrantAuthFlow = startGrantAuthFlow;
    static testnet = vi.fn(() => new Pubky());
  }
  return {
    clientFetch,
    publicGet,
    startGrantAuthFlow,
    store,
    GrantAuthFlow,
    Pubky,
    AuthFlowKind: {
      signup: vi.fn((homeserver: { key: string }, code: string | null) => ({
        kind: 'signup',
        homeserver: homeserver.key,
        code,
      })),
      signin: vi.fn(() => ({ kind: 'signin' })),
    },
    PublicKey: { from: vi.fn((key: string) => ({ key })) },
  };
});
vi.mock('@synonymdev/pubky', () => sdk);

const config: AccountConfig = { homeserver: HOMESERVER, relay: 'https://relay.example.com/inbox', testnetHost: null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ACCOUNT = {
  createdAt: '2026-10-22T10:11:12.123456',
  disabled: false,
  usedBytes: 30 * 1024,
  quota: { effective: { storageQuotaMb: 500, rateRead: '100mb/m', rateWrite: 'unlimited' }, overrides: {} },
};

/** A grant session the SDK would hand over once Ring approved: ALICE's, at this homeserver, with her account. */
function session({
  pubky = ALICE,
  homeserver = HOMESERVER,
  account = () => Promise.resolve(ACCOUNT),
  signout = vi.fn(async () => undefined),
  capabilities = ACCOUNT_CAPABILITY.split(','),
  getJson = vi.fn(async (): Promise<unknown> => Promise.reject(sdkError(404))),
  putJson = vi.fn(async () => undefined),
}: {
  pubky?: string;
  homeserver?: string;
  capabilities?: string[];
  account?: () => Promise<unknown>;
  signout?: () => Promise<void>;
  getJson?: (path: string) => Promise<unknown>;
  putJson?: (path: string, body: unknown) => Promise<void>;
} = {}) {
  return {
    info: { publicKey: { z32: () => pubky } },
    grant: {
      sessionInfo: async () => ({ homeserver: { z32: () => homeserver }, capabilities }),
      account,
    },
    storage: { getJson, putJson },
    signout,
    // Where the fake store files this session when it is saved.
    savedAt: homeserver,
  };
}

/** A Ring flow whose approval resolves with `approved`, or rejects with it when it is an Error. */
function flow(approved: unknown) {
  sdk.startGrantAuthFlow.mockResolvedValue({
    authorizationUrl: 'pubkyauth://signin_grant?secret=s',
    awaitApproval: () => (approved instanceof Error ? Promise.reject(approved) : Promise.resolve(approved)),
  });
}

/** The SDK's error for an HTTP refusal. */
function sdkError(statusCode: number, message = `HTTP ${statusCode}`) {
  return Object.assign(new Error(message), { name: 'RequestError', data: { statusCode } });
}

/** Answers the client's fetches by method and URL. */
function homeserver(routes: Record<string, () => Response | Promise<Response>>) {
  sdk.clientFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    return routes[key]();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sdk.GrantAuthFlow.isDelegationAvailable = false;
  sdk.store.isAvailable.mockResolvedValue(false);
  sdk.store.saved.length = 0;
});

/** A sign-in saved in the browser on an earlier visit, or by another tab; an Error is one that cannot be restored. */
function savedSignIn(id: string, restored: unknown, { createdAt = 1, homeserver = HOMESERVER, pubky = ALICE } = {}) {
  sdk.store.saved.push({ id, homeserver, publicKey: pubky, createdAt, session: restored });
}

const SIGNING_OUT = 'homeserver-portal:signing-out';

/** A browser that can keep a sign-in: the delegated flow resolves with `approved`. */
function keepingBrowser(approved?: unknown) {
  sdk.GrantAuthFlow.isDelegationAvailable = true;
  sdk.store.isAvailable.mockResolvedValue(true);
  sdk.GrantAuthFlow.startDelegated.mockResolvedValue({
    authorizationUrl: 'pubkyauth://signin_grant?cpk=k',
    awaitApproval: () => Promise.resolve(approved),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HomeserverClient.connect', () => {
  it('uses mainnet by default, and the testnet on the configured host', async () => {
    await HomeserverClient.connect(config);
    expect(sdk.Pubky.testnet).not.toHaveBeenCalled();
    await HomeserverClient.connect({ ...config, testnetHost: '10.0.0.2' });
    expect(sdk.Pubky.testnet).toHaveBeenCalledWith('10.0.0.2');
  });
});

describe('inviteStatus', () => {
  it.each([
    [() => json({ status: 'valid' }), 'valid'],
    [() => json({ status: 'used' }), 'used'],
    [() => new Response('Token not found', { status: 404 }), 'unknown'],
    [() => new Response('Signup tokens not required', { status: 400 }), 'not_required'],
    [() => new Response('slow down', { status: 429 }), 'rate_limited'],
    [() => new Response('boom', { status: 500 }), 'error'],
    [() => json({ status: 'weird' }), 'error'],
    [() => new Response('not json'), 'error'],
  ])('maps the homeserver answer to %s', async (answer, expected) => {
    homeserver({ [`GET https://${HOMESERVER}/signup_tokens/ABCD-EFGH-JKMN`]: answer });
    const client = await HomeserverClient.connect(config);
    await expect(client.inviteStatus('ABCD-EFGH-JKMN')).resolves.toBe(expected);
  });

  it('reports a network failure as error, never throws', async () => {
    sdk.clientFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = await HomeserverClient.connect(config);
    await expect(client.inviteStatus('ABCD-EFGH-JKMN')).resolves.toBe('error');
  });
});

describe('isInviteRequired', () => {
  const probe = `GET https://${HOMESERVER}/signup_tokens/0000-0000-0000`;

  it.each([
    [404, true],
    [400, false],
    [429, null],
    [500, null],
  ])('a probe answered %i means %s', async (status, expected) => {
    homeserver({ [probe]: () => new Response('', { status }) });
    const client = await HomeserverClient.connect(config);
    await expect(client.isInviteRequired()).resolves.toBe(expected);
  });
});

describe('startRequest', () => {
  it('asks Ring to sign up on this homeserver with the code, to read everything, through the relay, as this page', async () => {
    flow(session());
    const client = await HomeserverClient.connect(config);
    const request = await client.startRequest('signup', 'ABCD-EFGH-JKMN');
    expect(request.authUrl).toBe('pubkyauth://signin_grant?secret=s');
    expect(sdk.startGrantAuthFlow).toHaveBeenCalledWith(
      ACCOUNT_CAPABILITY,
      { kind: 'signup', homeserver: HOMESERVER, code: 'ABCD-EFGH-JKMN' },
      { clientId: 'localhost', relay: 'https://relay.example.com/inbox' },
    );
  });

  it('asks Ring for a plain sign-in', async () => {
    flow(session());
    const client = await HomeserverClient.connect(config);
    await client.startRequest('signin', null);
    expect(sdk.startGrantAuthFlow).toHaveBeenCalledWith(
      ACCOUNT_CAPABILITY,
      { kind: 'signin' },
      {
        clientId: 'localhost',
        relay: config.relay,
      },
    );
  });

  it('reads the account through the session, and keeps the grant until sign-out', async () => {
    const signout = vi.fn(async () => undefined);
    flow(session({ signout }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
      pubky: ALICE,
      hasAccount: true,
      canEditProfile: true,
      account: {
        createdAt: new Date('2026-10-22T10:11:12.123Z'),
        disabled: false,
        usedBytes: 30 * 1024,
        quota: { effective: { storageQuotaMb: 500, rateRead: '100mb/m', rateWrite: 'unlimited' }, overrides: {} },
      },
    });
    expect(signout).not.toHaveBeenCalled();
    await client.signOut();
    await client.signOut();
    expect(signout).toHaveBeenCalledTimes(1);
  });

  it('revokes the grant at once when Ring did not grant writing the profile', async () => {
    const signout = vi.fn(async () => undefined);
    flow(session({ signout, capabilities: ['/:r'] }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toMatchObject({
      hasAccount: true,
      canEditProfile: false,
    });
    expect(signout).toHaveBeenCalledTimes(1);
  });

  it('revokes the grant it holds before asking Ring for another', async () => {
    const signout = vi.fn(async () => undefined);
    flow(session({ signout }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    await client.startRequest('signin', null);
    expect(signout).toHaveBeenCalledTimes(1);
  });

  it('reports the account without details when the homeserver cannot give them', async () => {
    // A homeserver from before the route takes /account for a storage read: 403 on 0.17, 404 elsewhere.
    for (const status of [403, 404]) {
      flow(session({ account: () => Promise.reject(sdkError(status)) }));
      const client = await HomeserverClient.connect(config);
      await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
        pubky: ALICE,
        hasAccount: true,
        canEditProfile: true,
      });
    }
  });

  it('does not ask for the account when Ring granted less than reading everything', async () => {
    const account = vi.fn();
    flow(session({ account, capabilities: ['/pub/:rw'] }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
      pubky: ALICE,
      hasAccount: true,
      partialGrant: true,
      canEditProfile: true,
    });
    expect(account).not.toHaveBeenCalled();
  });

  it('takes any grant that reads the root as enough, as a Ring that grants more than asked might', async () => {
    flow(session({ capabilities: ['/:rw'] }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toMatchObject({
      hasAccount: true,
      account: expect.anything(),
    });
  });

  it('passes on any other failure to read the account, after revoking the grant', async () => {
    const signout = vi.fn(async () => undefined);
    flow(session({ account: () => Promise.reject(sdkError(500, 'database down')), signout }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).rejects.toThrow('database down');
    expect(signout).toHaveBeenCalledTimes(1);
  });

  it('treats a session at another homeserver as no account here, naming that homeserver', async () => {
    const signout = vi.fn(async () => undefined);
    flow(session({ homeserver: OTHER_HOMESERVER, signout }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
      pubky: ALICE,
      hasAccount: false,
      otherHomeserver: OTHER_HOMESERVER,
    });
    expect(signout).toHaveBeenCalledTimes(1);
  });

  it('reports no account when the homeserver does not know the signer, or the signer has no homeserver', async () => {
    flow(sdkError(404, 'Not Found'));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
      pubky: null,
      hasAccount: false,
    });
    flow(Object.assign(new Error(`could not resolve homeserver for ${ALICE}`), { name: 'RequestError' }));
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
      pubky: ALICE,
      hasAccount: false,
    });
  });

  it("passes on the homeserver's reason for refusing the sign-in", async () => {
    flow(sdkError(400, 'grant expired'));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).rejects.toThrow('grant expired');
  });

  it('still reports the account, and still signs out, when revoking the grant fails', async () => {
    const signout = vi.fn(async () => Promise.reject(new TypeError('blocked')));
    flow(session({ signout, capabilities: ['/:r'] }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toMatchObject({
      pubky: ALICE,
      hasAccount: true,
    });
    flow(session({ signout }));
    await (await client.startRequest('signin', null)).awaitAccount();
    await expect(client.signOut()).resolves.toBeUndefined();
    expect(signout).toHaveBeenCalledTimes(2);
  });

  it('gives up waiting for Ring after ten minutes', async () => {
    vi.useFakeTimers();
    sdk.startGrantAuthFlow.mockResolvedValue({
      authorizationUrl: 'pubkyauth://x',
      awaitApproval: () => new Promise(() => {}),
    });
    const client = await HomeserverClient.connect(config);
    const waiting = (await client.startRequest('signin', null)).awaitAccount();
    vi.advanceTimersByTime(10 * 60 * 1000);
    await expect(waiting).rejects.toThrow('This request expired. Start again.');
  });

  it('does not leave an abandoned request failing unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    sdk.startGrantAuthFlow.mockResolvedValue({
      authorizationUrl: 'pubkyauth://x',
      awaitApproval: () => Promise.reject(new Error('relay gone')),
    });
    const client = await HomeserverClient.connect(config);
    await client.startRequest('signin', null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('staying signed in', () => {
  it('asks Ring through a delegated flow and saves the session it keeps', async () => {
    const approved = session();
    keepingBrowser(approved);
    const client = await HomeserverClient.connect(config);
    const request = await client.startRequest('signin', null);
    expect(request.authUrl).toBe('pubkyauth://signin_grant?cpk=k');
    expect(sdk.GrantAuthFlow.startDelegated).toHaveBeenCalledWith(
      ACCOUNT_CAPABILITY,
      { kind: 'signin' },
      { clientId: 'localhost', relay: config.relay },
    );
    expect(sdk.startGrantAuthFlow).not.toHaveBeenCalled();
    expect(request.staysSignedIn).toBe(true);
    await request.awaitAccount();
    expect(sdk.store.save).toHaveBeenCalledWith(approved);
  });

  it('saves nothing for a session it does not keep, and still signs in when saving fails', async () => {
    keepingBrowser(session({ homeserver: OTHER_HOMESERVER }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    expect(sdk.store.save).not.toHaveBeenCalled();

    keepingBrowser(session());
    sdk.store.save.mockRejectedValueOnce(new Error('quota'));
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toMatchObject({
      canEditProfile: true,
    });
  });

  it('uses the plain flow on a testnet, and where the browser cannot keep a key', async () => {
    keepingBrowser(session());
    flow(session());
    const testnet = await HomeserverClient.connect({ ...config, testnetHost: '10.0.0.2' });
    await testnet.startRequest('signin', null);
    sdk.store.isAvailable.mockResolvedValue(false);
    const client = await HomeserverClient.connect(config);
    const request = await client.startRequest('signin', null);
    expect(request.staysSignedIn).toBe(false);
    await request.awaitAccount();
    expect(sdk.GrantAuthFlow.startDelegated).not.toHaveBeenCalled();
    expect(sdk.startGrantAuthFlow).toHaveBeenCalledTimes(2);
    expect(sdk.store.save).not.toHaveBeenCalled();
    await expect(client.restoreSignIn()).resolves.toBeNull();
  });

  it('restores the newest saved sign-in for this homeserver, ready to save a profile', async () => {
    keepingBrowser();
    const putJson = vi.fn(async () => undefined);
    savedSignIn('elsewhere', session(), { homeserver: OTHER_HOMESERVER, createdAt: 3 });
    savedSignIn('older', session(), { createdAt: 1 });
    savedSignIn('here', session({ putJson }), { createdAt: 2 });
    const client = await HomeserverClient.connect(config);
    await expect(client.restoreSignIn()).resolves.toMatchObject({
      pubky: ALICE,
      hasAccount: true,
      canEditProfile: true,
      account: { usedBytes: 30 * 1024 },
    });
    expect(sdk.store.restore.mock.calls).toEqual([['here']]);
    await client.saveProfile({ name: 'Alice', bio: '', status: '', links: [] });
    expect(putJson).toHaveBeenCalled();
  });

  it('is nobody when nothing was saved', async () => {
    keepingBrowser();
    const client = await HomeserverClient.connect(config);
    await expect(client.restoreSignIn()).resolves.toBeNull();
    expect(sdk.store.restore).not.toHaveBeenCalled();
  });

  it('forgets a saved sign-in the homeserver no longer honours, and falls back to an older one', async () => {
    keepingBrowser();
    savedSignIn('older', session(), { createdAt: 1 });
    savedSignIn(
      'revoked',
      Object.assign(new Error('Browser session is no longer valid.'), { name: 'ClientStateError' }),
      { createdAt: 2 },
    );
    savedSignIn('refused', sdkError(401), { createdAt: 3 });
    const client = await HomeserverClient.connect(config);
    await expect(client.restoreSignIn()).resolves.toMatchObject({ pubky: ALICE });
    expect(sdk.store.restore.mock.calls).toEqual([['refused'], ['revoked'], ['older']]);
    expect(sdk.store.saved.map((r) => r.id)).toEqual(['older']);
  });

  it('revokes and forgets a saved sign-in that is no longer one the page keeps', async () => {
    keepingBrowser();
    const signout = vi.fn(async () => undefined);
    savedSignIn('read-only', session({ signout, capabilities: ['/:r'] }));
    const client = await HomeserverClient.connect(config);
    await expect(client.restoreSignIn()).resolves.toBeNull();
    expect(signout).toHaveBeenCalledTimes(1);
    expect(sdk.store.saved).toEqual([]);
  });

  it('keeps a saved sign-in it could not check, for the next visit', async () => {
    keepingBrowser();
    savedSignIn('here', new TypeError('Failed to fetch'));
    const client = await HomeserverClient.connect(config);
    await expect(client.restoreSignIn()).resolves.toBeNull();
    sdk.store.list.mockRejectedValueOnce(new Error('storage blocked'));
    await expect(client.restoreSignIn()).resolves.toBeNull();
    expect(sdk.store.remove).not.toHaveBeenCalled();
  });

  it('starts signed out when the check takes over ten seconds, and stays so when the check ends', async () => {
    vi.useFakeTimers();
    keepingBrowser();
    const signout = vi.fn(async () => undefined);
    let answer: (account: unknown) => void = () => undefined;
    savedSignIn('here', session({ signout, account: () => new Promise((resolve) => (answer = resolve)) }));
    const client = await HomeserverClient.connect(config);
    const restored = client.restoreSignIn();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(restored).resolves.toBeNull();
    answer(ACCOUNT);
    await vi.advanceTimersByTimeAsync(0);
    // Nobody is signed in behind the page, and the sign-in is still saved, unrevoked.
    await expect(client.saveProfile({ name: 'Alice', bio: '', status: '', links: [] })).rejects.toThrow(/signed out/);
    await client.signOut();
    expect(signout).not.toHaveBeenCalled();
    expect(sdk.store.saved.map((r) => r.id)).toEqual(['here']);
  });

  it('on sign-out revokes the grant, then forgets the saved sign-in', async () => {
    const signout = vi.fn(async () => undefined);
    keepingBrowser(session({ signout }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    expect(sdk.store.saved).toHaveLength(1);
    await client.signOut();
    // The saved sign-in is what the revocation is signed with, so it goes last.
    expect(signout.mock.invocationCallOrder[0]).toBeLessThan(sdk.store.remove.mock.invocationCallOrder[0]);
    expect(signout).toHaveBeenCalledTimes(1);
    expect(sdk.store.saved).toEqual([]);
    expect(sdk.store.clear).not.toHaveBeenCalled();
    expect(localStorage.getItem(SIGNING_OUT)).toBeNull();
  });

  it("on sign-out also revokes and forgets the same person's other saved sign-ins, and nobody else's", async () => {
    const unchecked = vi.fn(async () => undefined);
    const bobs = vi.fn(async () => undefined);
    keepingBrowser(session());
    // One an earlier visit could not check, and another person's from another tab.
    savedSignIn('unchecked', session({ signout: unchecked }));
    savedSignIn('bob', session({ pubky: OTHER_HOMESERVER, signout: bobs }), { pubky: OTHER_HOMESERVER });
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    // Starting a sign-in forgot nothing.
    expect(sdk.store.saved).toHaveLength(3);
    await client.signOut();
    expect(unchecked).toHaveBeenCalledTimes(1);
    expect(bobs).not.toHaveBeenCalled();
    expect(sdk.store.saved.map((r) => r.id)).toEqual(['bob']);
  });

  it('finishes on the next visit a sign-out whose revocation never landed', async () => {
    const hung = vi.fn(() => new Promise<void>(() => undefined));
    keepingBrowser(session({ signout: hung }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    void client.signOut(); // the tab is closed before the homeserver answers
    await vi.waitFor(() => expect(hung).toHaveBeenCalledTimes(1));
    expect(sdk.store.saved).toHaveLength(1);
    expect(Object.keys(JSON.parse(localStorage.getItem(SIGNING_OUT)!))).toEqual([ALICE]);

    // The next visit: the sign-in is still saved, and must not be restored.
    const signout = vi.fn(async () => undefined);
    sdk.store.saved[0].session = session({ signout });
    const next = await HomeserverClient.connect(config);
    await expect(next.restoreSignIn()).resolves.toBeNull();
    expect(signout).toHaveBeenCalledTimes(1);
    expect(sdk.store.saved).toEqual([]);
    expect(localStorage.getItem(SIGNING_OUT)).toBeNull();
  });

  it('tries again on the next visit when the revocation failed, and signs nobody in meanwhile', async () => {
    const signout = vi.fn(async (): Promise<void> => Promise.reject(new TypeError('Failed to fetch')));
    keepingBrowser(session({ signout }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    await client.signOut();
    // Still saved: it is what the revocation is signed with.
    expect(sdk.store.saved).toHaveLength(1);

    // Still out of reach on the next visit: signed out all the same.
    const offline = await HomeserverClient.connect(config);
    await expect(offline.restoreSignIn()).resolves.toBeNull();
    expect(sdk.store.saved).toHaveLength(1);
    expect(signout).toHaveBeenCalledTimes(2);

    signout.mockResolvedValue(undefined);
    const online = await HomeserverClient.connect(config);
    await expect(online.restoreSignIn()).resolves.toBeNull();
    expect(sdk.store.saved).toEqual([]);
    expect(localStorage.getItem(SIGNING_OUT)).toBeNull();
  });

  it("keeps the note of a sign-out while the sign-in could not be forgotten, and of other people's", async () => {
    keepingBrowser(session());
    savedSignIn('bob', new TypeError('Failed to fetch'), { pubky: OTHER_HOMESERVER });
    localStorage.setItem(SIGNING_OUT, JSON.stringify({ [OTHER_HOMESERVER]: 5 }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    sdk.store.remove.mockRejectedValueOnce(new Error('storage blocked'));
    await client.signOut();
    expect(Object.keys(JSON.parse(localStorage.getItem(SIGNING_OUT)!))).toEqual([OTHER_HOMESERVER, ALICE]);
    const next = await HomeserverClient.connect(config);
    await expect(next.restoreSignIn()).resolves.toBeNull();
    // Alice's is forgotten now; Bob's could not be revoked, so it and its note stay, and he is not signed in.
    expect(sdk.store.saved.map((r) => r.id)).toEqual(['bob']);
    expect(Object.keys(JSON.parse(localStorage.getItem(SIGNING_OUT)!))).toEqual([OTHER_HOMESERVER]);
  });

  it('leaves alone a sign-in made after the sign-out began, by the same person', async () => {
    vi.useFakeTimers();
    const slow = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    keepingBrowser(session({ signout: slow }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    const signingOut = client.signOut();
    await vi.advanceTimersByTimeAsync(10);
    // Signed in again while the homeserver has not answered the revocation.
    const signout = vi.fn(async () => undefined);
    keepingBrowser(session({ signout }));
    await (await client.startRequest('signin', null)).awaitAccount();
    await vi.advanceTimersByTimeAsync(50);
    await signingOut;
    expect(signout).not.toHaveBeenCalled();
    expect(sdk.store.saved.map((r) => r.id)).toEqual(['saved-2']);
    // And the next visit restores it, whatever note the sign-out left.
    const next = await HomeserverClient.connect(config);
    await expect(next.restoreSignIn()).resolves.toMatchObject({ pubky: ALICE });
    expect(signout).not.toHaveBeenCalled();
  });

  it('forgets a sign-in whose saving ended after the sign-out', async () => {
    keepingBrowser(session());
    let finishSave: () => void = () => undefined;
    const save = sdk.store.save.getMockImplementation()!;
    sdk.store.save.mockImplementationOnce(async (approved) => {
      await new Promise<void>((resolve) => (finishSave = resolve));
      return save(approved);
    });
    const client = await HomeserverClient.connect(config);
    const signedIn = (await client.startRequest('signin', null)).awaitAccount();
    await vi.waitFor(() => expect(sdk.store.save).toHaveBeenCalled());
    await client.signOut();
    finishSave();
    await signedIn;
    expect(sdk.store.saved).toEqual([]);
  });
});

describe('an approval nobody is waiting for', () => {
  /** A Ring flow, in a browser that keeps sign-ins, approved when the test says so. */
  function pendingFlow() {
    let approve: (session: unknown) => void = () => undefined;
    const approval = new Promise((resolve) => (approve = resolve));
    keepingBrowser();
    sdk.GrantAuthFlow.startDelegated.mockResolvedValueOnce({
      authorizationUrl: 'pubkyauth://x',
      awaitApproval: () => approval,
    });
    return (session: unknown) => approve(session);
  }
  const edit = { name: 'Alice', bio: '', status: '', links: [] };

  it('signs nobody in after Cancel: the grant is revoked and nothing is saved', async () => {
    const signout = vi.fn(async () => undefined);
    const approve = pendingFlow();
    const client = await HomeserverClient.connect(config);
    const request = await client.startRequest('signin', null);
    await client.signOut(); // Cancel
    approve(session({ signout }));
    await request.awaitAccount();
    expect(signout).toHaveBeenCalledTimes(1);
    expect(sdk.store.save).not.toHaveBeenCalled();
    await expect(client.saveProfile(edit)).rejects.toThrow(/signed out/);
  });

  it('signs nobody in once the request has expired', async () => {
    vi.useFakeTimers();
    const signout = vi.fn(async () => undefined);
    const approve = pendingFlow();
    const client = await HomeserverClient.connect(config);
    const waiting = (await client.startRequest('signin', null)).awaitAccount();
    waiting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(waiting).rejects.toThrow('This request expired');
    approve(session({ signout }));
    await vi.waitFor(() => expect(signout).toHaveBeenCalledTimes(1));
    expect(sdk.store.save).not.toHaveBeenCalled();
    await expect(client.saveProfile(edit)).rejects.toThrow(/signed out/);
  });

  it('does not replace the person a newer request signed in', async () => {
    const lateSignout = vi.fn(async () => undefined);
    const putJson = vi.fn(async () => undefined);
    const approveFirst = pendingFlow();
    const client = await HomeserverClient.connect(config);
    const first = await client.startRequest('signin', null);
    const kept = session({ putJson });
    keepingBrowser(kept);
    await (await client.startRequest('signin', null)).awaitAccount();
    approveFirst(session({ pubky: OTHER_HOMESERVER, signout: lateSignout }));
    await first.awaitAccount();
    expect(lateSignout).toHaveBeenCalledTimes(1);
    expect(sdk.store.save.mock.calls).toEqual([[kept]]);
    await client.saveProfile(edit);
    expect(putJson).toHaveBeenCalledTimes(1);
  });

  it('keeps the newer of two requests started while a sign-out was still under way', async () => {
    vi.useFakeTimers();
    const slow = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    keepingBrowser(session({ signout: slow }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    const putJson = vi.fn(async () => undefined);
    const signout = vi.fn(async () => undefined);
    // The second request reaches Ring first and is approved; the first one's QR code is never scanned.
    sdk.GrantAuthFlow.startDelegated
      .mockResolvedValueOnce({
        authorizationUrl: 'pubkyauth://second',
        awaitApproval: () => Promise.resolve(session({ putJson, signout })),
      })
      .mockResolvedValue({ authorizationUrl: 'pubkyauth://first', awaitApproval: () => new Promise(() => undefined) });
    // The first waits on the slow sign-out; the second starts after it and overtakes it.
    const first = client.startRequest('signin', null);
    await vi.advanceTimersByTimeAsync(10);
    const second = await client.startRequest('signin', null);
    await second.awaitAccount();
    await vi.advanceTimersByTimeAsync(50);
    await first;
    // The second request's sign-in is the one held, unrevoked and still saved.
    await client.saveProfile(edit);
    expect(putJson).toHaveBeenCalledTimes(1);
    expect(signout).not.toHaveBeenCalled();
    expect(sdk.store.saved.map((r) => r.id)).toEqual(['saved-2']);
  });
});

describe('saveProfile', () => {
  const edit = { name: 'Alice', bio: '', status: 'around', links: [{ title: 'Site', url: 'https://alice.example/' }] };

  it('replaces the edited parts of the stored profile and keeps the rest', async () => {
    const putJson = vi.fn(async () => undefined);
    const stored = { name: 'Al', bio: 'old', image: 'pubky://x/pub/pubky.app/files/1', extra: 1 };
    flow(session({ getJson: async () => stored, putJson }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    await client.saveProfile(edit);
    expect(putJson).toHaveBeenCalledWith('/pub/pubky.app/profile.json', {
      name: 'Alice',
      bio: null,
      status: 'around',
      links: edit.links,
      image: 'pubky://x/pub/pubky.app/files/1',
      extra: 1,
    });
  });

  it('writes a first profile when there is none, or the stored one is not a profile at all', async () => {
    for (const getJson of [undefined, async () => ['not', 'a', 'profile']]) {
      const putJson = vi.fn(async () => undefined);
      flow(session({ ...(getJson && { getJson }), putJson }));
      const client = await HomeserverClient.connect(config);
      await (await client.startRequest('signin', null)).awaitAccount();
      await client.saveProfile(edit);
      expect(putJson).toHaveBeenCalledWith('/pub/pubky.app/profile.json', {
        name: 'Alice',
        bio: null,
        status: 'around',
        links: edit.links,
      });
    }
  });

  it('does not write over a profile it could not read', async () => {
    const putJson = vi.fn(async () => undefined);
    flow(session({ getJson: async () => Promise.reject(sdkError(500, 'database down')), putJson }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    await expect(client.saveProfile(edit)).rejects.toThrow('database down');
    expect(putJson).not.toHaveBeenCalled();
  });

  it('says the sign-in has ended when the session is gone: refused, or forgotten by another tab', async () => {
    const gone = Object.assign(new Error('Browser session is no longer valid.'), { name: 'ClientStateError' });
    const sessions = [
      session({ getJson: async () => Promise.reject(sdkError(401)) }),
      session({ putJson: async () => Promise.reject(sdkError(401)) }),
      session({ putJson: async () => Promise.reject(gone) }),
    ];
    for (const ended of sessions) {
      flow(ended);
      const client = await HomeserverClient.connect(config);
      await (await client.startRequest('signin', null)).awaitAccount();
      await expect(client.saveProfile(edit)).rejects.toThrow(/sign-in has ended/);
    }
  });

  it("passes on a refusal to write as it is, such as a disabled account's", async () => {
    flow(session({ putJson: async () => Promise.reject(sdkError(403, 'account disabled')) }));
    const client = await HomeserverClient.connect(config);
    await (await client.startRequest('signin', null)).awaitAccount();
    await expect(client.saveProfile(edit)).rejects.toThrow('account disabled');
  });

  it('refuses once signed out', async () => {
    flow(session());
    const client = await HomeserverClient.connect(config);
    await expect(client.saveProfile(edit)).rejects.toThrow(/signed out/);
    await (await client.startRequest('signin', null)).awaitAccount();
    await client.signOut();
    await expect(client.saveProfile(edit)).rejects.toThrow(/signed out/);
  });
});

describe('profile', () => {
  const url = `GET https://${HOMESERVER}/storage/${ALICE}/pub/pubky.app/profile.json`;

  it('is null for someone without a pubky.app profile', async () => {
    homeserver({ [url]: () => new Response('', { status: 404 }) });
    const client = await HomeserverClient.connect(config);
    expect(await client.profile(ALICE)).toBeNull();
  });

  it('reads name, bio, status and links, dropping what is malformed', async () => {
    homeserver({
      [url]: () =>
        json({
          name: 'Alice',
          bio: ' ',
          status: 'around',
          links: [{ title: 'Site', url: 'https://alice.example' }, { title: 'bad' }, 'junk'],
          image: null,
        }),
    });
    const client = await HomeserverClient.connect(config);
    expect(await client.profile(ALICE)).toEqual({
      name: 'Alice',
      bio: null,
      status: 'around',
      links: [{ title: 'Site', url: 'https://alice.example' }],
      avatar: null,
    });
  });

  it('turns a pubky.app image record into a data URL through its blob', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    homeserver({ [url]: () => json({ name: 'Alice', image: `pubky://${ALICE}/pub/pubky.app/files/img1` }) });
    sdk.publicGet.mockImplementation(async (address: string) => {
      if (address.endsWith('/files/img1')) return json({ src: `pubky://${ALICE}/pub/pubky.app/blobs/blob1` });
      if (address.endsWith('/blobs/blob1')) {
        return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': '4' } });
      }
      throw new Error(`unexpected read: ${address}`);
    });
    const client = await HomeserverClient.connect(config);
    expect((await client.profile(ALICE))?.avatar).toBe('data:image/png;base64,iVBORw==');
  });

  it.each([
    ['not an image', () => new Response('x', { headers: { 'Content-Type': 'text/html' } })],
    ['too large', () => new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': '9999999' } })],
    ['unreachable', () => Promise.reject(new Error('offline'))],
  ])('shows no avatar when the image is %s, and still returns the profile', async (_case, reply) => {
    homeserver({ [url]: () => json({ name: 'Alice', image: 'https://cdn.example/a.png' }) });
    sdk.clientFetch.mockImplementation(async (target: string) =>
      target === 'https://cdn.example/a.png' ? reply() : json({ name: 'Alice', image: 'https://cdn.example/a.png' }),
    );
    const client = await HomeserverClient.connect(config);
    expect(await client.profile(ALICE)).toMatchObject({ name: 'Alice', avatar: null });
  });

  it('ignores a profile without a name', async () => {
    homeserver({ [url]: () => json({ bio: 'no name' }) });
    const client = await HomeserverClient.connect(config);
    expect(await client.profile(ALICE)).toBeNull();
  });
});

const BASE = `https://${HOMESERVER}`;
const feedLine = (kind: string, pubky: string, path: string) => `${kind} pubky://${pubky}/pub/${path}`;
const feed = (lines: string[], cursor: number | null) =>
  new Response([...lines, ...(cursor === null ? [] : [`cursor: ${cursor}`])].join('\n'), { status: 200 });

/** A response that reports the URL it was fetched from, as a real one does. */
function fetchedFrom(url: string, response: Response): Response {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('info', () => {
  it('reads the features and where the homeserver was reached', async () => {
    homeserver({
      [`GET ${BASE}/info`]: () =>
        fetchedFrom('https://homeserver.example.com/info', json({ features: ['path-addressed-storage', 7] })),
    });
    const client = await HomeserverClient.connect(config);
    expect(await client.info()).toEqual({
      features: ['path-addressed-storage'],
      address: 'https://homeserver.example.com',
    });
  });

  it('copes with a response that does not say where it came from', async () => {
    homeserver({ [`GET ${BASE}/info`]: () => json({}) });
    const client = await HomeserverClient.connect(config);
    expect(await client.info()).toEqual({ features: [], address: null });
  });
});

describe('homeserverRecord', () => {
  it('reads the record from the relay, or reports that there is none', async () => {
    const bytes = new Uint8Array(64 + 8 + 12);
    new DataView(bytes.buffer).setBigUint64(64, 1_700_000_000_000_000n);
    const relayFetch = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal('fetch', relayFetch);
    const client = await HomeserverClient.connect(config);
    expect(await client.homeserverRecord()).toEqual({ publishedAt: new Date(1_700_000_000_000), records: [] });
    expect(relayFetch).toHaveBeenCalledWith(`https://pkarr.pubky.app/${HOMESERVER}`, { cache: 'no-store' });

    relayFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await client.homeserverRecord()).toBeNull();
  });

  it('asks the testnet relay on the testnet', async () => {
    const relayFetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', relayFetch);
    const client = await HomeserverClient.connect({ ...config, testnetHost: '10.0.0.2' });
    await client.homeserverRecord();
    expect(relayFetch).toHaveBeenCalledWith(`http://10.0.0.2:15411/${HOMESERVER}`, { cache: 'no-store' });
  });
});

describe('ownEvents', () => {
  it('asks the event stream for the newest events, then for the ones before a cursor', async () => {
    const sse = (id: number) => `event: PUT\ndata: pubky://${ALICE}/pub/a/${id}\ndata: cursor: ${id}\n\n`;
    homeserver({
      [`GET ${BASE}/events-stream?user=${ALICE}&reverse=true&limit=2`]: () => new Response(sse(9) + sse(8)),
      [`GET ${BASE}/events-stream?user=${ALICE}:8&reverse=true&limit=2`]: () => new Response(sse(7)),
    });
    const client = await HomeserverClient.connect(config);
    const first = await client.ownEvents(ALICE, null, 2);
    expect(first.events.map((e) => e.path)).toEqual(['a/9', 'a/8']);
    expect(first.cursor).toBe('8');
    const next = await client.ownEvents(ALICE, first.cursor, 2);
    expect(next.events.map((e) => e.path)).toEqual(['a/7']);
  });

  it('asks for a path as a file and as a folder', async () => {
    const paths = 'path=%2Fpub%2Fpubky.app%2Fposts&path=%2Fpub%2Fpubky.app%2Fposts%2F';
    homeserver({
      [`GET ${BASE}/events-stream?user=${ALICE}&reverse=true&limit=2&${paths}`]: () =>
        new Response(`event: DEL\ndata: pubky://${ALICE}/pub/pubky.app/posts/1\ndata: cursor: 5\n\n`),
    });
    const client = await HomeserverClient.connect(config);
    const page = await client.ownEvents(ALICE, null, 2, 'pubky.app/posts');
    expect(page.events.map((e) => `${e.kind} ${e.path}`)).toEqual(['DEL pubky.app/posts/1']);
  });
});
