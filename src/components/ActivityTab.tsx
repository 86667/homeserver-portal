'use client';

import { type FormEvent, useState } from 'react';
import { Activity as ActivityIcon, FileMinus, FilePen, Folder, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { Burst } from '../activity';
import { formatDateTime } from '../format';
import { OWN_PAGE, type OwnActivity } from '../useOwnActivity';

/** A signed-in person's own recent public changes. */
export function ActivityTab({ own }: { own: OwnActivity }) {
  return (
    <Card data-testid="activity-tab">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <ActivityIcon className="size-5" />
          Your activity
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Your public changes on this homeserver, newest first: files written and removed, by folder. Changes to private
          files are not shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Keyed by the filter, so choosing a folder below also fills the box. */}
        <PathFilter key={own.path} path={own.path} onFilter={own.filterBy} />
        <OwnBody own={own} />
      </CardContent>
    </Card>
  );
}

function PathFilter({ path, onFilter }: { path: string; onFilter: (path: string) => void }) {
  const [typed, setTyped] = useState(path);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onFilter(typed);
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2" data-testid="own-filter">
      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder="Filter by file or folder, e.g. pubky.app/posts"
        aria-label="Filter by file or folder"
        className="font-mono text-xs md:text-xs"
      />
      <Button type="submit" variant="outline" size="sm">
        Filter
      </Button>
      {path && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onFilter('')} data-testid="own-filter-clear">
          <X className="size-3" /> Clear
        </Button>
      )}
    </form>
  );
}

function OwnBody({ own }: { own: OwnActivity }) {
  if (own.status === 'idle' || own.status === 'loading') {
    return (
      <div className="space-y-2" data-testid="own-loading">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (own.status === 'failed') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="own-failed">
        Your activity could not be read: {own.message}
      </p>
    );
  }
  if (own.events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="own-none">
        {own.path
          ? `No public changes of yours at ${own.path}.`
          : 'Nothing yet. Your first public file will show up here.'}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-3" data-testid="own-summary">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-semibold tabular-nums">{own.events.length}</span>
          <span className="text-xs text-muted-foreground">
            {own.more ? 'newest changes' : 'changes, all there are'}
            {own.path && ` at ${own.path}`} · {own.folders.length} {own.folders.length === 1 ? 'folder' : 'folders'}
          </span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {own.checkedAt && `Read ${formatDateTime(own.checkedAt)}.`}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            onClick={own.refresh}
            aria-label="Read again"
            data-testid="own-refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </p>
      </div>

      <ul className="flex flex-wrap gap-2" data-testid="own-folders" aria-label="Folders changed, to filter by">
        {own.folders.map(({ folder, changes }) => {
          const chosen = folder !== '' && folder === own.path;
          return (
            <li key={folder}>
              <button
                type="button"
                // The top level has no path to ask the homeserver for.
                disabled={!folder}
                aria-pressed={chosen}
                // Choosing the folder that is the filter already takes the filter away.
                onClick={() => own.filterBy(chosen ? '' : folder)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs enabled:hover:bg-muted ${chosen ? 'border-brand bg-brand/16' : ''}`}
                title={chosen ? 'Remove the filter' : folder ? `Show only ${folder}` : undefined}
              >
                <Folder className="size-3 text-muted-foreground" />
                <span className="max-w-64 truncate font-medium">{folder || '(top level)'}</span>
                <span className="text-muted-foreground tabular-nums">{changes}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <ul className="max-h-[28rem] space-y-2 overflow-y-auto" data-testid="own-events">
        {own.bursts.map((burst) => (
          <li key={burst.id}>
            <BurstRow burst={burst} />
          </li>
        ))}
      </ul>
      {own.message && <p className="text-xs text-muted-foreground">Could not load more: {own.message}</p>}
      {own.more && (
        <Button variant="outline" size="sm" onClick={own.loadMore} disabled={own.loadingMore} data-testid="own-more">
          {own.loadingMore ? 'Loading…' : `Load ${OWN_PAGE} more`}
        </Button>
      )}
    </div>
  );
}

/** One burst: its folder and counts, open on its files and able to close. */
function BurstRow({ burst }: { burst: Burst }) {
  return (
    <details className="group rounded-lg border" open>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm select-none [&::-webkit-details-marker]:hidden">
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={burst.folder}>
          {burst.folder || '(top level)'}
        </code>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {burst.written > 0 && (
            <span className="inline-flex items-center gap-0.5" title={`${burst.written} written`}>
              <FilePen className="size-3" /> {burst.written}
            </span>
          )}
          {burst.written > 0 && burst.removed > 0 && ' '}
          {burst.removed > 0 && (
            <span className="inline-flex items-center gap-0.5" title={`${burst.removed} removed`}>
              <FileMinus className="size-3" /> {burst.removed}
            </span>
          )}
        </span>
      </summary>
      <ul className="max-h-72 divide-y overflow-y-auto border-t text-xs">
        {burst.events.map((event, index) => (
          <li key={`${index}-${event.url}`} className="flex items-center gap-3 px-3 py-1.5">
            {event.kind === 'PUT' ? (
              <FilePen className="size-3 shrink-0 text-muted-foreground" aria-label="written" />
            ) : (
              <FileMinus className="size-3 shrink-0 text-muted-foreground" aria-label="removed" />
            )}
            <code className="min-w-0 flex-1 truncate font-mono" title={event.path}>
              {burst.folder ? event.path.slice(burst.folder.length + 1) : event.path}
            </code>
          </li>
        ))}
      </ul>
    </details>
  );
}
