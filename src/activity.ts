/**
 * A person's own public changes, made readable: the events the homeserver's
 * stream (`GET /events-stream`) reports for them, one per public file written
 * or removed, with no dates.
 */
import type { FeedEvent } from './model';

/** A run of consecutive changes in one folder. */
export type Burst = {
  /** Where the burst's newest event is in the list, counted from the newest: stable as older events are added. */
  id: number;
  /** The folder under `/pub/` the run's files are in; '' for the top level. */
  folder: string;
  /** Newest first. */
  events: FeedEvent[];
  /** Files written (new or changed) and removed. */
  written: number;
  removed: number;
};

function parseEvent(line: string): FeedEvent | null {
  const match = /^(PUT|DEL) (pubky:\/\/([^/]+)\/pub\/(.*))$/.exec(line);
  if (!match) return null;
  const [, kind, url, pubky, path] = match;
  return { kind: kind as FeedEvent['kind'], url, pubky, path };
}

/** The folder a file is in, under `/pub/`; '' for a file at the top level. */
export const folderOf = (event: FeedEvent): string => event.path.slice(0, Math.max(0, event.path.lastIndexOf('/')));

/** Consecutive events in the same folder, as one burst each. `events` and the bursts are newest first. */
export function groupBursts(events: FeedEvent[]): Burst[] {
  const bursts: Burst[] = [];
  events.forEach((event, index) => {
    const folder = folderOf(event);
    let burst = bursts[bursts.length - 1];
    if (burst?.folder !== folder) {
      burst = { id: index, folder, events: [], written: 0, removed: 0 };
      bursts.push(burst);
    }
    burst.events.push(event);
    if (event.kind === 'PUT') burst.written += 1;
    else burst.removed += 1;
  });
  return bursts;
}

/** The folders the events' files are in and how many changes each saw, busiest first. */
export function summarizeFolders(events: FeedEvent[]): { folder: string; changes: number }[] {
  const folders = new Map<string, number>();
  for (const event of events) folders.set(folderOf(event), (folders.get(folderOf(event)) ?? 0) + 1);
  return [...folders.entries()].map(([folder, changes]) => ({ folder, changes })).sort((a, b) => b.changes - a.changes);
}

/** A path as someone types it ("/pub/site/", "site") as the path under `/pub/` it names ("site"). */
export const pathUnderPub = (typed: string): string =>
  typed
    .trim()
    .replace(/^\/pub(\/|$)/, '')
    .replace(/^\/+|\/+$/g, '');

/**
 * One person's events as `GET /events-stream` sends them in batch mode: SSE
 * blocks of `event: PUT|DEL`, then `data:` lines with the file's address,
 * `cursor: <id>` and a content hash. `cursor` is the last event's, to ask
 * for the ones before it (reverse order) or after it.
 */
export function parseEventStream(text: string): { events: FeedEvent[]; cursor: string | null } {
  const events: FeedEvent[] = [];
  let cursor: string | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    let kind: string | null = null;
    let url: string | null = null;
    let id: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event: ')) kind = line.slice('event: '.length).trim();
      else if (line.startsWith('data: cursor: ')) id = line.slice('data: cursor: '.length).trim();
      else if (line.startsWith('data: pubky://') && !url) url = line.slice('data: '.length).trim();
    }
    const event = kind && url ? parseEvent(`${kind} ${url}`) : null;
    if (!event) continue;
    events.push(event);
    if (id) cursor = id;
  }
  return { events, cursor };
}
