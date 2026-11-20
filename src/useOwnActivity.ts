import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Burst, groupBursts, pathUnderPub, summarizeFolders } from './activity';
import type { HomeserverClient } from './homeserver-client';
import type { FeedEvent } from './model';

/** Events per page: the first read, and each "load more". */
export const OWN_PAGE = 10;

type Pages = {
  status: 'idle' | 'loading' | 'done' | 'failed';
  /** Newest first. */
  events: FeedEvent[];
  /** Whether an older page may exist. */
  more: boolean;
  loadingMore: boolean;
  /** Whether a newer read is under way while the last one's events stay on show. */
  refreshing: boolean;
  /** The filter the events on show were read with, which trails `path` while refreshing. */
  shownPath: string;
  /** When the first page was read. */
  checkedAt: Date | null;
  message?: string;
};

export type OwnActivity = Pages & {
  /** The events as runs in one folder each, newest first. */
  bursts: Burst[];
  folders: { folder: string; changes: number }[];
  /** The file or folder under `/pub/` the events are limited to; '' for all of them. */
  path: string;
  loadMore: () => void;
  /** Starts again with only the events of this file or folder; '' for all. */
  filterBy: (path: string) => void;
  /** Reads the newest page again. */
  refresh: () => void;
};

/**
 * A signed-in person's own newest public changes, one page at a time, from
 * the event stream's batch mode: one request per page. Idle until there is a
 * client, a pubky and the tab is open.
 */
export function useOwnActivity(client: HomeserverClient | null, pubky: string | null, enabled: boolean): OwnActivity {
  const [pages, setPages] = useState<Pages>(IDLE);
  const [path, setPath] = useState('');
  const [reads, setReads] = useState(0);
  const cursor = useRef<string | null>(null);
  // The read the pages belong to; a result for an earlier sign-in, filter or refresh is dropped.
  const read = useRef<object | null>(null);

  useEffect(() => {
    if (!client || !pubky || !enabled) {
      setPages(IDLE);
      // The next person to sign in starts unfiltered.
      if (!pubky) setPath('');
      return;
    }
    const mine = {};
    read.current = mine;
    cursor.current = null;
    // What is on show stays until the new read answers, so a filter or refresh does not blank the list.
    setPages((current) =>
      current.status === 'done'
        ? { ...current, refreshing: true, loadingMore: false, message: undefined }
        : { ...IDLE, status: 'loading' },
    );
    client
      .ownEvents(pubky, null, OWN_PAGE, path)
      .then((page) => {
        if (read.current !== mine) return;
        cursor.current = page.cursor;
        setPages({
          status: 'done',
          events: page.events,
          more: page.events.length === OWN_PAGE,
          loadingMore: false,
          refreshing: false,
          shownPath: path,
          checkedAt: new Date(),
        });
      })
      .catch((error) => {
        if (read.current === mine) setPages({ ...IDLE, status: 'failed', message: messageOf(error) });
      });
    return () => {
      read.current = null;
    };
  }, [client, pubky, enabled, path, reads]);

  const loadMore = useCallback(() => {
    if (!client || !pubky || pages.status !== 'done' || pages.refreshing || !pages.more || pages.loadingMore) return;
    const mine = read.current;
    setPages((current) => ({ ...current, loadingMore: true, message: undefined }));
    client
      .ownEvents(pubky, cursor.current, OWN_PAGE, path)
      .then((page) => {
        if (read.current !== mine) return;
        cursor.current = page.cursor ?? cursor.current;
        setPages((current) => ({
          ...current,
          events: [...current.events, ...page.events],
          more: page.events.length === OWN_PAGE,
          loadingMore: false,
        }));
      })
      .catch((error) => {
        if (read.current === mine)
          setPages((current) => ({ ...current, loadingMore: false, message: messageOf(error) }));
      });
  }, [client, pubky, path, pages.status, pages.refreshing, pages.more, pages.loadingMore]);

  const filterBy = useCallback((typed: string) => setPath(pathUnderPub(typed)), []);
  const refresh = useCallback(() => setReads((n) => n + 1), []);

  const bursts = useMemo(() => groupBursts(pages.events), [pages.events]);
  const folders = useMemo(() => summarizeFolders(pages.events), [pages.events]);

  return { ...pages, bursts, folders, path, loadMore, filterBy, refresh };
}

const IDLE: Pages = {
  status: 'idle',
  events: [],
  more: false,
  loadingMore: false,
  refreshing: false,
  shownPath: '',
  checkedAt: null,
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
