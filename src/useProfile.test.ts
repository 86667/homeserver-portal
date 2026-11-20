import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HomeserverClient } from './homeserver-client';
import { useProfile } from './useProfile';

const ALICE = 'whgxto9xtroaih7ict9chtuxh1xmbpmci5qd71jsen3ow3bscipy';
const profile = { name: 'Alice', bio: null, status: null, links: [], avatar: null };

describe('useProfile', () => {
  it('is idle without a client or a pubky', () => {
    const { result } = renderHook(() => useProfile(null, ALICE));
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('loads the profile, or its absence', async () => {
    const c = { profile: vi.fn(async () => profile) } as unknown as HomeserverClient;
    const { result } = renderHook(() => useProfile(c, ALICE));
    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.state).toEqual({ status: 'done', profile }));
    const none = { profile: vi.fn(async () => null) } as unknown as HomeserverClient;
    const { result: r2 } = renderHook(() => useProfile(none, ALICE));
    await waitFor(() => expect(r2.current.state).toEqual({ status: 'done', profile: null }));
  });

  it('reports a failure', async () => {
    const c = { profile: vi.fn(async () => Promise.reject(new Error('offline'))) } as unknown as HomeserverClient;
    const { result } = renderHook(() => useProfile(c, ALICE));
    await waitFor(() => expect(result.current.state).toEqual({ status: 'failed', message: 'offline' }));
  });

  it('saves an edit and shows it, keeping the picture; a refused save changes nothing', async () => {
    const saveProfile = vi.fn(async () => undefined);
    const withAvatar = { ...profile, avatar: 'data:image/png;base64,AA==' };
    const c = { profile: vi.fn(async () => withAvatar), saveProfile } as unknown as HomeserverClient;
    const { result } = renderHook(() => useProfile(c, ALICE));
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    const edit = { name: 'Alicia', bio: '', status: 'around', links: [] };
    await act(() => result.current.save(edit));
    expect(saveProfile).toHaveBeenCalledWith(edit);
    expect(result.current.state).toEqual({
      status: 'done',
      profile: { name: 'Alicia', bio: null, status: 'around', links: [], avatar: withAvatar.avatar },
    });
    saveProfile.mockRejectedValueOnce(new Error('quota'));
    await expect(act(() => result.current.save({ ...edit, name: 'Other' }))).rejects.toThrow('quota');
    expect(result.current.state).toMatchObject({ profile: { name: 'Alicia' } });
  });

  it('does not show an edit that was saved after someone else signed in', async () => {
    let saved: () => void = () => undefined;
    const saveProfile = vi.fn(() => new Promise<void>((resolve) => (saved = resolve)));
    const c = { profile: vi.fn(async () => profile), saveProfile } as unknown as HomeserverClient;
    const { result, rerender } = renderHook(({ pubky }) => useProfile(c, pubky), { initialProps: { pubky: ALICE } });
    await waitFor(() => expect(result.current.state.status).toBe('done'));
    const saving = result.current.save({ name: 'Alicia', bio: '', status: '', links: [] });
    rerender({ pubky: 'someone-else' });
    await waitFor(() => expect(result.current.state).toEqual({ status: 'done', profile }));
    saved();
    await act(() => saving);
    expect(result.current.state).toEqual({ status: 'done', profile });
  });
});
