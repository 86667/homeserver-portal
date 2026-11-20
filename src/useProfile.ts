import { useCallback, useEffect, useRef, useState } from 'react';
import type { HomeserverClient } from './homeserver-client';
import type { Profile } from './model';
import type { ProfileEdit } from './profile';

export type ProfileState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; profile: Profile | null }
  | { status: 'failed'; message: string };

export type OwnProfile = {
  state: ProfileState;
  /** Writes a cleaned, valid edit and shows it; rejects with the reason when the homeserver did not take it. */
  save: (edit: ProfileEdit) => Promise<void>;
};

/**
 * A signed-in person's pubky.app profile on this homeserver, if they have
 * one, and saving an edit of it. Idle until there is a client and a pubky.
 */
export function useProfile(client: HomeserverClient | null, pubky: string | null): OwnProfile {
  const [state, setState] = useState<ProfileState>({ status: 'idle' });

  useEffect(() => {
    if (!client || !pubky) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    client
      .profile(pubky)
      .then((profile) => {
        if (!cancelled) setState({ status: 'done', profile });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, pubky]);

  // Whose profile is on show; a save that ends after someone else signed in must not put its edit there.
  const shown = useRef(pubky);
  useEffect(() => {
    shown.current = pubky;
  }, [pubky]);

  const save = useCallback(
    async (edit: ProfileEdit) => {
      if (!client) throw new Error('The homeserver is not connected.');
      await client.saveProfile(edit);
      if (shown.current !== pubky) return;
      // What was written, with the picture the edit does not touch.
      setState((current) => ({
        status: 'done',
        profile: {
          name: edit.name,
          bio: edit.bio || null,
          status: edit.status || null,
          links: edit.links,
          avatar: current.status === 'done' ? (current.profile?.avatar ?? null) : null,
        },
      }));
    },
    [client, pubky],
  );

  return { state, save };
}
