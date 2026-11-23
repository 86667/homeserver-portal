import { describe, expect, it } from 'vitest';
import { groupBursts, parseEventStream, pathUnderPub, summarizeFolders } from './activity';
import type { FeedEvent } from './model';

const A = 'whgxto9xtroaih7ict9chtuxh1xmbpmci5qd71jsen3ow3bscipy';

const event = (kind: FeedEvent['kind'], path: string): FeedEvent => ({
  kind,
  url: `pubky://${A}/pub/${path}`,
  pubky: A,
  path,
});
/** Newest first. */
const EVENTS = [
  event('PUT', 'hello.txt'),
  event('DEL', 'pubky.app/posts/1'),
  event('PUT', 'pubky.app/posts/1'),
  event('PUT', 'site/index.html'),
  event('PUT', 'pubky.app/posts/0'),
  event('PUT', 'pubky.app/profile.json'),
];

describe('groupBursts', () => {
  it('groups consecutive changes in the same folder, newest first', () => {
    const bursts = groupBursts(EVENTS);
    expect(bursts.map((b) => [b.id, b.folder, b.written, b.removed])).toEqual([
      [0, '', 1, 0],
      [1, 'pubky.app/posts', 1, 1],
      [3, 'site', 1, 0],
      [4, 'pubky.app/posts', 1, 0],
      [5, 'pubky.app', 1, 0],
    ]);
    expect(bursts[1].events.map((e) => e.kind)).toEqual(['DEL', 'PUT']);
  });

  it("keeps each burst's id when older events are added", () => {
    const before = groupBursts(EVENTS.slice(0, 2)).map((b) => b.id);
    expect(
      groupBursts(EVENTS)
        .map((b) => b.id)
        .slice(0, 2),
    ).toEqual(before);
  });
});

describe('summarizeFolders', () => {
  it('counts changes per folder, busiest first', () => {
    const folders = summarizeFolders(EVENTS);
    expect(folders[0]).toEqual({ folder: 'pubky.app/posts', changes: 3 });
    expect(
      folders
        .slice(1)
        .map((f) => `${f.folder}:${f.changes}`)
        .sort(),
    ).toEqual([':1', 'pubky.app:1', 'site:1']);
  });
});

describe('pathUnderPub', () => {
  it('reads a typed path as the path under /pub/', () => {
    expect(
      ['site', ' /pub/site/ ', '/site', 'site/index.html', '/pub/', '/pub', '', 'pub/x'].map(pathUnderPub),
    ).toEqual(['site', 'site', 'site', 'site/index.html', '', '', '', 'pub/x']);
  });
});

describe('parseEventStream', () => {
  it('reads SSE blocks into events, with the last cursor', () => {
    const text = [
      'event: PUT',
      `data: pubky://${A}/pub/site/try.html`,
      'data: cursor: 206',
      'data: content_hash: Wxt2cfTRtTvRTMMs5DR/9EhV0pRdct3yrl/fTo1v+oU=',
      '',
      'event: DEL',
      `data: pubky://${A}/pub/site/old.html`,
      'data: cursor: 205',
      '',
      ': a comment',
      '',
    ].join('\n');
    const { events, cursor } = parseEventStream(text);
    expect(cursor).toBe('205');
    expect(events.map((e) => `${e.kind} ${e.pubky.slice(0, 4)} ${e.path}`)).toEqual([
      'PUT whgx site/try.html',
      'DEL whgx site/old.html',
    ]);
    expect(events[0].url).toBe(`pubky://${A}/pub/site/try.html`);
  });

  it('is empty for an empty stream', () => {
    expect(parseEventStream('')).toEqual({ events: [], cursor: null });
  });
});
