import { useEffect, useState } from 'react';
import type { HomeserverClient } from './homeserver-client';
import type { PublicFile } from './model';

/** Files whose size is read; beyond this the rest are listed without one. */
export const MAX_MEASURED = 2000;
/** HEAD requests in flight at once: quick, and well under the homeserver's limits. */
const CONCURRENCY = 4;

export type PublicFiles =
  | { status: 'idle' }
  | { status: 'listing' }
  | { status: 'measuring' | 'done'; files: PublicFile[]; more: boolean; measured: number }
  | { status: 'failed'; message: string };

/**
 * A person's public files on this homeserver, with their sizes as they come
 * in, to total the space they take: the listing names files only, so each
 * size is a HEAD request, a few at a time. Idle until there is a client and
 * a pubky.
 */
export function usePublicFiles(client: HomeserverClient | null, pubky: string | null): PublicFiles {
  const [state, setState] = useState<PublicFiles>({ status: 'idle' });

  useEffect(() => {
    if (!client || !pubky) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const update = (next: PublicFiles) => {
      if (!cancelled) setState(next);
    };

    (async () => {
      update({ status: 'listing' });
      const { files, more } = await client.listPublicFiles(pubky);
      update({ status: 'measuring', files, more, measured: 0 });

      const toMeasure = files.slice(0, MAX_MEASURED);
      let next = 0;
      let measured = 0;
      const worker = async () => {
        while (next < toMeasure.length && !cancelled) {
          const file = toMeasure[next++];
          try {
            Object.assign(file, await client.fileStats(file));
          } catch {
            // Left without a size; the total says how many were measured.
          }
          measured += 1;
          update({ status: 'measuring', files: [...files], more, measured });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      update({ status: 'done', files: [...files], more, measured });
    })().catch((error) =>
      update({ status: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );

    return () => {
      cancelled = true;
    };
  }, [client, pubky]);

  return state;
}

/** The space the files take and how many of them have a known size. */
export function summarize(files: PublicFile[]): { bytes: number; sized: number } {
  const sizes = files.flatMap((file) => (file.size === undefined ? [] : [file.size]));
  return { bytes: sizes.reduce((total, size) => total + size, 0), sized: sizes.length };
}
