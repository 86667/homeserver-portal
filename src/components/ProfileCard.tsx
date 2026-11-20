'use client';

import { useState } from 'react';
import { ExternalLink, IdCard, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { OwnProfile, ProfileState } from '../useProfile';
import { Avatar } from './Avatar';
import { ProfileEditor } from './ProfileEditor';

interface ProfileCardProps {
  state: ProfileState;
  /** Saves an edit; null when the page was not granted writing the profile, and so offers no editing. */
  onSave: OwnProfile['save'] | null;
}

/** The person's pubky.app profile, read from their own public files on this homeserver, and an editor for it. */
export function ProfileCard({ state, onSave }: ProfileCardProps) {
  const [editing, setEditing] = useState(false);
  const canEdit = onSave !== null && state.status === 'done';
  return (
    <Card data-testid="profile-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <IdCard className="size-5" />
          Your profile
        </CardTitle>
        <CardDescription>
          Your name, picture, bio and links. Your profile is a public file you own on this homeserver, and Pubky apps
          read it to show who you are.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {canEdit && editing ? (
          <ProfileEditor profile={state.profile} onSave={onSave} onClose={() => setEditing(false)} />
        ) : (
          <div className="space-y-4">
            <ProfileBody state={state} canEdit={canEdit} />
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="profile-edit">
                <Pencil className="size-3" /> {state.profile ? 'Edit profile' : 'Create a profile'}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileBody({ state, canEdit }: { state: ProfileState; canEdit: boolean }) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="flex items-center gap-4" data-testid="profile-loading">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="profile-failed">
        Your profile could not be read: {state.message}
      </p>
    );
  }
  if (!state.profile) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="profile-none">
        {canEdit
          ? 'No profile here yet.'
          : 'No pubky.app profile here yet. Sign in to pubky.app with this pubky and set one up; it will appear here.'}
      </p>
    );
  }
  const { name, bio, status, links, avatar } = state.profile;
  return (
    <div className="flex items-start gap-4">
      <Avatar image={avatar} name={name} testId="profile-avatar" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-base font-semibold break-words" data-testid="profile-name">
          {name}
        </p>
        {status && <p className="text-xs text-muted-foreground">{status}</p>}
        {bio && <p className="text-sm break-words whitespace-pre-line">{bio}</p>}
        {links.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            {links.map((link) => (
              <li key={`${link.title}|${link.url}`}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex items-center gap-1 text-brand underline-offset-2 hover:underline"
                >
                  {link.title}
                  <ExternalLink className="size-3" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
