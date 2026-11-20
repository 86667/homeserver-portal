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
  class Pubky {
    client = { fetch: clientFetch };
    publicStorage = { get: publicGet };
    startGrantAuthFlow = startGrantAuthFlow;
    static testnet = vi.fn(() => new Pubky());
  }
  return {
    clientFetch,
    publicGet,
    startGrantAuthFlow,
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
  capabilities = [ACCOUNT_CAPABILITY],
}: {
  pubky?: string;
  homeserver?: string;
  capabilities?: string[];
  account?: () => Promise<unknown>;
  signout?: () => Promise<void>;
} = {}) {
  return {
    info: { publicKey: { z32: () => pubky } },
    grant: {
      sessionInfo: async () => ({ homeserver: { z32: () => homeserver }, capabilities }),
      account,
    },
    signout,
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
});

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

  it('reads the account through the session, then revokes the grant', async () => {
    const signout = vi.fn(async () => undefined);
    flow(session({ signout }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toEqual({
      pubky: ALICE,
      hasAccount: true,
      account: {
        createdAt: new Date('2026-10-22T10:11:12.123Z'),
        disabled: false,
        usedBytes: 30 * 1024,
        quota: { effective: { storageQuotaMb: 500, rateRead: '100mb/m', rateWrite: 'unlimited' }, overrides: {} },
      },
    });
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

  it('still reports the account when revoking the grant fails', async () => {
    flow(session({ signout: vi.fn(async () => Promise.reject(new TypeError('blocked'))) }));
    const client = await HomeserverClient.connect(config);
    await expect((await client.startRequest('signin', null)).awaitAccount()).resolves.toMatchObject({
      pubky: ALICE,
      hasAccount: true,
    });
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
