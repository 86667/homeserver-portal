import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountConfig, AccountInfo, AccountRecord, FeedEvent, InviteStatus, Profile, PublicFile } from '../model';
import { AccountFlow } from './AccountFlow';
import { HomeserverClient, type RingRequest } from '../homeserver-client';

vi.mock('../homeserver-client', () => ({ HomeserverClient: { connect: vi.fn() } }));

const CONFIG: AccountConfig = {
  homeserver: '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo',
  relay: null,
  testnetHost: null,
};
const CODE = 'ABCD-EFGH-JKMN';
const ALICE = 'whgxto9xtroaih7ict9chtuxh1xmbpmci5qd71jsen3ow3bscipy';

type FakeHomeserver = {
  inviteRequired?: boolean | null;
  /** The code's status, by how many times it has been asked about. */
  inviteStatus?: (askedBefore: number) => InviteStatus;
  account?: () => Promise<AccountInfo>;
  files?: PublicFile[];
  profile?: Profile | null;
  events?: FeedEvent[];
};

const feedEvent = (kind: 'PUT' | 'DEL', pubky: string, path: string): FeedEvent => ({
  kind,
  url: `pubky://${pubky}/pub/${path}`,
  pubky,
  path,
});
const BOB = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';

const ALICE_ACCOUNT: AccountRecord = {
  createdAt: new Date('2026-10-22T10:11:12Z'),
  disabled: false,
  usedBytes: 450 * 1024 * 1024,
  quota: {
    effective: { storageQuotaMb: 500, rateRead: '100mb/m', rateWrite: 'unlimited', allowedWritePaths: ['/pub/x/'] },
    overrides: { allowedWritePaths: ['/pub/x/'] },
  },
};

const publicFile = (path: string, size: number): PublicFile => ({
  url: `pubky://${ALICE}/pub/${path}`,
  path,
  app: path.split('/')[0],
  size,
});

/** A homeserver client whose answers the test chooses. */
function homeserver({
  inviteRequired = true,
  inviteStatus = () => 'valid',
  account = () => Promise.resolve({ pubky: ALICE, hasAccount: true }),
  files = [publicFile('pubky.app/profile.json', 140), publicFile('pubky.app/posts/1', 60)],
  profile = { name: 'Alice', bio: 'Hi there', status: null, links: [], avatar: null },
  events = [feedEvent('PUT', BOB, 'site/index.html'), feedEvent('PUT', ALICE, 'pubky.app/profile.json')],
}: FakeHomeserver = {}) {
  let asked = 0;
  const client = {
    isInviteRequired: vi.fn(async () => inviteRequired),
    inviteStatus: vi.fn(async () => inviteStatus(asked++)),
    startRequest: vi.fn(
      async (): Promise<RingRequest> => ({ authUrl: 'pubkyauth://signup?secret=s', awaitAccount: () => account() }),
    ),
    listPublicFiles: vi.fn(async () => ({ files: files.map(({ size: _, ...f }) => ({ ...f })), more: false })),
    fileStats: vi.fn(async (f: PublicFile) => ({ size: files.find((x) => x.path === f.path)?.size ?? 0 })),
    profile: vi.fn(async (pubky: string) => (pubky === ALICE ? profile : null)),
    ownEvents: vi.fn(async (pubky: string, cursor: string | null, _limit: number, path = '') => {
      const mine = events.filter((e) => e.pubky === pubky && e.path.startsWith(path)).reverse();
      return cursor === null ? { events: mine, cursor: '1' } : { events: [], cursor: null };
    }),
    info: vi.fn(async () => ({ features: ['webdav-locks', 'something-new'], address: 'https://hs.example.com' })),
    homeserverRecord: vi.fn(async () => ({
      // Half an hour clear of the boundary: the page takes its "now" a moment before this is read.
      publishedAt: new Date(Date.now() - 3.5 * 3_600_000),
      records: [
        { name: '@', type: 'HTTPS', value: '1 . port=6287 ipv4hint=2.28.97.159', ttl: 3600 },
        { name: '@', type: 'HTTPS', value: '10 hs.example.com', ttl: 3600 },
      ],
    })),
  };
  vi.mocked(HomeserverClient.connect).mockResolvedValue(client as unknown as HomeserverClient);
  return client;
}

/** The page with no invite code, moved from the Homeserver tab it opens on to the Account tab. */
function renderOnAccount() {
  render(<AccountFlow config={CONFIG} initialCode="" />);
  fireEvent.mouseDown(screen.getByTestId('tab-account'));
}

beforeEach(() => {
  vi.mocked(HomeserverClient.connect).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountFlow sign-up', () => {
  it('signs up with the code from an invite link and welcomes the new account', async () => {
    const client = homeserver({ inviteStatus: (asked) => (asked === 0 ? 'valid' : 'used') });

    render(<AccountFlow config={CONFIG} initialCode={CODE.toLowerCase()} />);
    const input = (await screen.findByLabelText('Invite code')) as HTMLInputElement;
    expect(input.value).toBe(CODE);
    await screen.findByText('Invite code accepted.');
    fireEvent.click(screen.getByTestId('account-signup'));

    await screen.findByText('Welcome to your homeserver');
    expect(screen.getByTestId('account-pubky').textContent).toBe(`pubky${ALICE}`);
    expect(client.startRequest).toHaveBeenCalledWith('signup', CODE);
    expect(HomeserverClient.connect).toHaveBeenCalledWith(CONFIG);
  });

  it('keeps sign-up disabled until the code is known to be valid', async () => {
    homeserver({ inviteStatus: () => 'used' });
    renderOnAccount();
    const input = await screen.findByLabelText('Invite code');
    const signUp = screen.getByTestId('account-signup') as HTMLButtonElement;
    expect(signUp.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'abcd' } });
    expect(screen.getByTestId('invite-code-hint').textContent).toBe('Codes look like XXXX-XXXX-XXXX.');

    fireEvent.change(input, { target: { value: CODE } });
    await screen.findByText('This invite code has already been used.');
    expect(signUp.disabled).toBe(true);
  });

  it('checks the code again on returning to the start, since a sign-up may have spent it', async () => {
    homeserver({ inviteStatus: (asked) => (asked === 0 ? 'valid' : 'used') });
    render(<AccountFlow config={CONFIG} initialCode={CODE} />);
    await screen.findByText('Invite code accepted.');
    fireEvent.click(screen.getByTestId('account-signup'));
    await screen.findByTestId('account-details');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('This invite code has already been used.');
  });

  it('offers sign-up without a code on a homeserver that needs none', async () => {
    const client = homeserver({ inviteRequired: false });
    renderOnAccount();
    const signUp = (await screen.findByTestId('account-signup')) as HTMLButtonElement;
    expect(screen.queryByLabelText('Invite code')).toBeNull();
    expect(signUp.disabled).toBe(false);
    fireEvent.click(signUp);
    await screen.findByText('You have an account on this homeserver');
    expect(client.startRequest).toHaveBeenCalledWith('signup', null);
  });

  it('lets a visitor sign up without a code when the homeserver only says so in answer to one', async () => {
    const client = homeserver({ inviteRequired: null, inviteStatus: () => 'not_required' });
    renderOnAccount();
    fireEvent.change(await screen.findByLabelText('Invite code'), { target: { value: CODE } });
    await screen.findByText(/does not need an invite code/);
    const signUp = screen.getByTestId('account-signup') as HTMLButtonElement;
    expect(signUp.disabled).toBe(false);
    fireEvent.click(signUp);
    await screen.findByTestId('account-details');
    expect(client.startRequest).toHaveBeenCalledWith('signup', null);
  });

  it('explains a sign-up that left no account behind', async () => {
    homeserver({ inviteRequired: false, account: () => Promise.resolve({ pubky: ALICE, hasAccount: false }) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signup'));
    expect((await screen.findByTestId('account-missing')).textContent).toMatch(/did not go through/);
  });
});

describe('AccountFlow sign-in', () => {
  it('signs in without sending a code, and says welcome back', async () => {
    const client = homeserver();
    render(<AccountFlow config={CONFIG} initialCode={CODE} />);
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');
    expect(client.startRequest).toHaveBeenCalledWith('signin', null);
  });

  it('explains when the pubky has no account here', async () => {
    homeserver({ account: () => Promise.resolve({ pubky: ALICE, hasAccount: false }) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByTestId('account-missing');
    expect(screen.getByText('No account on this homeserver')).toBeTruthy();
  });

  it('copies the pubky', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    homeserver();
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy pubky' }));
    await screen.findByRole('button', { name: 'Copied pubky' });
    expect(writeText).toHaveBeenCalledWith(`pubky${ALICE}`);
  });
});

describe('AccountFlow waiting and failures', () => {
  it('shows the QR code and the link while waiting, copies the link, and Cancel goes back', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    homeserver({ account: () => new Promise(() => {}) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByTestId('account-qr');
    expect(screen.getByRole('link', { name: 'Open in Pubky Ring on this device' }).getAttribute('href')).toBe(
      'pubkyauth://signup?secret=s',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await screen.findByRole('button', { name: 'Copied link' });
    expect(writeText).toHaveBeenCalledWith('pubkyauth://signup?secret=s');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByTestId('account-start');
  });

  it('reports a failed request with a way to try again', async () => {
    homeserver({ account: () => Promise.reject(new Error('AuthToken already used')) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    expect((await screen.findByTestId('account-failed')).textContent).toContain('AuthToken already used');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('account-start');
  });

  it('says when the homeserver cannot be reached, and retries', async () => {
    vi.mocked(HomeserverClient.connect).mockRejectedValueOnce(new Error('Failed to load the Pubky SDK'));
    renderOnAccount();
    expect((await screen.findByTestId('account-unavailable')).textContent).toContain('Failed to load the Pubky SDK');
    homeserver();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('account-start');
  });

  it('says the page is not set up without a config, and connects to nothing', () => {
    render(<AccountFlow config={null} initialCode="" />);
    expect(screen.getByTestId('account-not-set-up').textContent).toContain('not set up');
    expect(HomeserverClient.connect).not.toHaveBeenCalled();
  });
});

describe('AccountFlow tabs', () => {
  it('opens on Homeserver, the first tab, with Account next to it and no Activity for a visitor', async () => {
    const client = homeserver();
    render(<AccountFlow config={CONFIG} initialCode="" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Homeserver', 'Account']);
    expect(await screen.findByTestId('homeserver-features')).toBeTruthy();
    expect(client.info).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('account')).toBeNull();

    fireEvent.mouseDown(screen.getByTestId('tab-account'));
    expect(await screen.findByTestId('account-signin')).toBeTruthy();
    expect(client.ownEvents).not.toHaveBeenCalled();
  });

  it('opens an invite link on the Account tab, and reads the homeserver only when its tab is opened', async () => {
    const client = homeserver();
    render(<AccountFlow config={CONFIG} initialCode={CODE} />);
    expect(await screen.findByTestId('account-signup')).toBeTruthy();
    expect(client.info).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('tab-homeserver'));
    expect(await screen.findByTestId('homeserver-features')).toBeTruthy();
    expect(client.info).toHaveBeenCalledTimes(1);
  });

  it('adds the Activity tab on sign-in and takes it away on sign-out', async () => {
    homeserver();
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Homeserver', 'Account', 'Activity']);
    fireEvent.mouseDown(screen.getByTestId('tab-activity'));
    await screen.findByTestId('activity-tab');
    fireEvent.click(screen.getByTestId('sign-out'));
    await screen.findByTestId('account-signin');
    expect(screen.queryByTestId('tab-activity')).toBeNull();
  });

  it('shows the tabs even when the page is not set up', () => {
    render(<AccountFlow config={null} initialCode="" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Homeserver', 'Account']);
    expect(screen.getByTestId('account-not-set-up')).toBeTruthy();
    expect(screen.queryByTestId('homeserver-key')).toBeNull();
    fireEvent.mouseDown(screen.getByTestId('tab-account'));
    expect(screen.getByTestId('account-not-set-up')).toBeTruthy();
  });

  it('keeps the sign-in while switching tabs', async () => {
    homeserver();
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');
    fireEvent.mouseDown(screen.getByTestId('tab-activity'));
    await screen.findByTestId('activity-tab');
    fireEvent.mouseDown(screen.getByTestId('tab-account'));
    expect(await screen.findByText('Welcome back')).toBeTruthy();
  });
});

describe('AccountFlow activity tab', () => {
  it('shows the signed-in person their own changes, a page at a time', async () => {
    const client = homeserver({
      events: Array.from({ length: 12 }, (_, i) => feedEvent('PUT', ALICE, `pubky.app/posts/${i + 1}`)),
    });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');
    expect(client.ownEvents).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('tab-activity'));

    const list = await screen.findByTestId('own-events');
    // One folder, so one group, already open on its twelve files.
    expect(list.querySelectorAll('details[open]')).toHaveLength(1);
    expect(list.querySelectorAll('details li')).toHaveLength(12);
    expect(list.textContent).toContain('pubky.app/posts');
    expect(screen.getByTestId('own-summary').textContent).toContain('1 folder');
    expect(client.ownEvents).toHaveBeenCalledWith(ALICE, null, 10, '');
  });

  it("filters the person's changes by a typed path or a chosen folder, and clears the filter", async () => {
    const client = homeserver({
      events: [
        feedEvent('PUT', ALICE, 'site/index.html'),
        feedEvent('PUT', ALICE, 'pubky.app/posts/1'),
        feedEvent('DEL', ALICE, 'pubky.app/posts/1'),
      ],
    });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');
    fireEvent.mouseDown(screen.getByTestId('tab-activity'));
    const folders = await screen.findByTestId('own-folders');
    expect(folders.textContent).toContain('pubky.app/posts2');
    expect(folders.textContent).toContain('site1');

    fireEvent.click(screen.getByRole('button', { name: /pubky\.app\/posts/ }));
    await waitFor(() => expect(client.ownEvents).toHaveBeenLastCalledWith(ALICE, null, 10, 'pubky.app/posts'));
    const input = screen.getByLabelText('Filter by file or folder') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('pubky.app/posts'));
    await waitFor(() => expect(screen.getByTestId('own-folders').textContent).not.toContain('site'));

    fireEvent.change(screen.getByLabelText('Filter by file or folder'), { target: { value: '/pub/nothing/' } });
    fireEvent.submit(screen.getByTestId('own-filter'));
    expect((await screen.findByTestId('own-none')).textContent).toContain('at nothing');

    fireEvent.click(screen.getByTestId('own-filter-clear'));
    await waitFor(() => expect(client.ownEvents).toHaveBeenLastCalledWith(ALICE, null, 10, ''));
    expect(await screen.findByTestId('own-folders')).toBeTruthy();

    // The chosen folder is marked, and choosing it again takes the filter away.
    fireEvent.click(await screen.findByRole('button', { name: /^site/ }));
    await waitFor(() => expect(client.ownEvents).toHaveBeenLastCalledWith(ALICE, null, 10, 'site'));
    const chosen = await screen.findByRole('button', { name: /^site/, pressed: true });
    fireEvent.click(chosen);
    await waitFor(() => expect(client.ownEvents).toHaveBeenLastCalledWith(ALICE, null, 10, ''));
    expect(await screen.findByRole('button', { name: /^site/, pressed: false })).toBeTruthy();
  });

  it('says when the person has not changed anything yet', async () => {
    homeserver({ events: [] });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');
    fireEvent.mouseDown(screen.getByTestId('tab-activity'));
    expect(await screen.findByTestId('own-none')).toBeTruthy();
  });
});

describe('AccountFlow homeserver tab', () => {
  it('shows the connection, key, addresses, sign-up mode, features and the network record', async () => {
    homeserver({ inviteRequired: true });
    render(<AccountFlow config={CONFIG} initialCode="" />);

    expect(screen.getByTestId('homeserver-key').textContent).toBe(CONFIG.homeserver);
    expect(await screen.findByTestId('homeserver-connected')).toBeTruthy();
    expect(screen.getByTestId('homeserver-address').textContent).toContain('hs.example.com');
    expect(screen.getByTestId('homeserver-address').textContent).toContain('Reachable');
    expect(screen.getByTestId('homeserver-signups').textContent).toBe('By invite code');
    const features = screen.getByTestId('homeserver-features');
    expect(features.textContent).toContain('WebDAV locks');
    expect(features.textContent).toContain('something-new');
    expect((await screen.findByTestId('record-published')).textContent?.trim()).toBe('Published 3 hours ago');
    expect(screen.getByTestId('homeserver-pubky-address').textContent).toBe('2.28.97.159:6287');

    fireEvent.click(screen.getByTestId('record-view'));
    const entries = await screen.findByTestId('record-entries');
    expect(entries.textContent).toContain('10 hs.example.com');
    expect(entries.textContent).toContain('3600');
  });
});

describe('AccountFlow page', () => {
  it('offers sign-in in the header from any tab, and shows the QR code on the Account tab', async () => {
    let approve: (info: AccountInfo) => void = () => undefined;
    const client = homeserver({ account: () => new Promise<AccountInfo>((resolve) => (approve = resolve)) });
    renderOnAccount();
    expect(screen.queryByTestId('header-signin')).toBeNull(); // still connecting
    await screen.findByTestId('account-signin');
    fireEvent.mouseDown(screen.getByTestId('tab-homeserver'));
    await screen.findByTestId('homeserver-key');
    fireEvent.click(screen.getByTestId('header-signin'));
    expect(await screen.findByTestId('account-qr')).toBeTruthy();
    approve({ pubky: ALICE, hasAccount: true });
    expect(screen.queryByTestId('header-signin')).toBeNull(); // one at a time
    expect(client.startRequest).toHaveBeenCalledWith('signin', null);
    await screen.findByText('Welcome back');
    expect(screen.getByTestId('sign-out')).toBeTruthy();
  });

  it('offers sign-out in the header only once signed in, and shows the version in the footer', async () => {
    homeserver();
    renderOnAccount();
    await screen.findByTestId('account-signin');
    expect(screen.queryByTestId('sign-out')).toBeNull();
    expect(screen.getByTestId('page-version').textContent).toMatch(/^v\d+\.\d+\.\d+$/);
    fireEvent.click(screen.getByTestId('account-signin'));
    await screen.findByText('Welcome back');
    fireEvent.mouseDown(screen.getByTestId('tab-homeserver'));
    await screen.findByTestId('homeserver-key');
    fireEvent.click(screen.getByTestId('sign-out'));
    // Signing out returns to the Account tab, where the sign-in is.
    await screen.findByTestId('account-signin');
    expect(screen.queryByTestId('sign-out')).toBeNull();
    expect(screen.queryByTestId('homeserver-key')).toBeNull();
  });
});

describe('AccountFlow signed-in details', () => {
  it('shows the profile and the files with the space they use', async () => {
    const client = homeserver();
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByText('Welcome back');

    expect((await screen.findByTestId('profile-name')).textContent).toBe('Alice');
    expect(screen.getByText('Hi there')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('files-summary').textContent).toContain('200 B'));
    expect(screen.getByTestId('files-summary').textContent).toContain('in 2 public files');
    expect(screen.getByTestId('files-by-app').textContent).toContain('pubky.app');
    expect(screen.getByTestId('files-by-app').textContent).toContain('profile.json');
    expect(client.listPublicFiles).toHaveBeenCalledWith(ALICE);
    expect(client.profile).toHaveBeenCalledWith(ALICE);
  });

  it('says so when there is no profile and nothing stored', async () => {
    homeserver({ files: [], profile: null });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByTestId('profile-none');
    await screen.findByTestId('files-none');
  });

  it('shows neither card for a pubky without an account here', async () => {
    homeserver({ account: () => Promise.resolve({ pubky: ALICE, hasAccount: false }) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByTestId('account-missing');
    expect(screen.queryByTestId('profile-card')).toBeNull();
    expect(screen.queryByTestId('files-card')).toBeNull();
  });

  it('removes the cards again on sign-out', async () => {
    homeserver();
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    await screen.findByTestId('files-card');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByTestId('account-signin');
    expect(screen.queryByTestId('files-card')).toBeNull();
  });
});

describe('AccountFlow account summary', () => {
  async function signIn(info: AccountInfo) {
    homeserver({ account: () => Promise.resolve(info) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    return screen.findByTestId('account-details');
  }

  it('shows when the account was made, its storage against the allowance, and its limits', async () => {
    await signIn({ pubky: ALICE, hasAccount: true, account: ALICE_ACCOUNT });
    const summary = screen.getByTestId('account-summary');
    expect(summary.textContent).toContain('Signed up');
    expect(summary.textContent).toContain('2026');
    expect(screen.getByTestId('account-storage').textContent).toBe('450 MB of 500 MB (90%)');
    expect(summary.textContent).toContain('100 MB per minute');
    expect(summary.textContent).toContain('No limit');
    expect(summary.textContent).toContain('/pub/x/');
    expect(screen.getAllByText('set for you')).toHaveLength(1);
    expect(screen.queryByTestId('account-disabled')).toBeNull();
    expect(screen.queryByTestId('account-not-reported')).toBeNull();
  });

  it('says plainly when the account is disabled', async () => {
    await signIn({ pubky: ALICE, hasAccount: true, account: { ...ALICE_ACCOUNT, disabled: true } });
    expect(screen.getByTestId('account-disabled').textContent).toContain('Your account is disabled');
  });

  it('says when the homeserver does not report the account, or was not asked for want of a full grant', async () => {
    await signIn({ pubky: ALICE, hasAccount: true });
    expect(screen.getByTestId('account-not-reported')).toBeTruthy();
    expect(screen.queryByTestId('account-summary')).toBeNull();
    cleanup();
    await signIn({ pubky: ALICE, hasAccount: true, partialGrant: true });
    expect(screen.getByTestId('account-partial-grant')).toBeTruthy();
    expect(screen.queryByTestId('account-not-reported')).toBeNull();
  });

  it('explains a pubky that lives on another homeserver, and one the sign-in could not name', async () => {
    homeserver({ account: () => Promise.resolve({ pubky: ALICE, hasAccount: false, otherHomeserver: BOB }) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    const missing = await screen.findByTestId('account-missing');
    expect(missing.textContent).toContain(`another homeserver (${BOB})`);
    expect(missing.textContent).toContain(`pubky${ALICE}`);
    cleanup();

    homeserver({ account: () => Promise.resolve({ pubky: null, hasAccount: false }) });
    renderOnAccount();
    fireEvent.click(await screen.findByTestId('account-signin'));
    expect((await screen.findByTestId('account-missing')).querySelector('.font-mono')).toBeNull();
  });
});
