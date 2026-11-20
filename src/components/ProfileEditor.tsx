'use client';

import { type FormEvent, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Profile } from '../model';
import {
  type ProfileEdit,
  type ProfileErrors,
  PROFILE_LIMITS,
  cleanProfileEdit,
  editOf,
  profileErrors,
} from '../profile';

interface ProfileEditorProps {
  /** The profile to start from; null to write a first one. */
  profile: Profile | null;
  onSave: (edit: ProfileEdit) => Promise<void>;
  /** Leaves the editor: after a save, or on Cancel. */
  onClose: () => void;
}

const FIELD =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 md:text-sm';

/** A form for a profile's name, status, bio and links. The picture is left as it is. */
export function ProfileEditor({ profile, onSave, onClose }: ProfileEditorProps) {
  const [edit, setEdit] = useState<ProfileEdit>(() => editOf(profile));
  // Problems show from the first attempt to save, then follow the typing.
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const cleaned = cleanProfileEdit(edit);
  const errors: ProfileErrors = tried ? profileErrors(cleaned) : {};
  const set = (part: Partial<ProfileEdit>) => setEdit((current) => ({ ...current, ...part }));
  const setLink = (index: number, part: Partial<ProfileEdit['links'][number]>) =>
    set({ links: edit.links.map((link, i) => (i === index ? { ...link, ...part } : link)) });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(profileErrors(cleaned)).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      await onSave(cleaned);
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate data-testid="profile-editor">
      <Field id="profile-name" label="Name" error={errors.name}>
        <Input
          id="profile-name"
          value={edit.name}
          onChange={(event) => set({ name: event.target.value })}
          disabled={saving}
          autoComplete="off"
          aria-invalid={Boolean(errors.name)}
        />
      </Field>
      <Field id="profile-status" label="Status" error={errors.status}>
        <Input
          id="profile-status"
          value={edit.status}
          onChange={(event) => set({ status: event.target.value })}
          disabled={saving}
          autoComplete="off"
          aria-invalid={Boolean(errors.status)}
        />
      </Field>
      <Field
        id="profile-bio"
        label="Bio"
        error={errors.bio}
        hint={`${[...cleaned.bio].length} of ${PROFILE_LIMITS.bioMax}`}
      >
        <textarea
          id="profile-bio"
          value={edit.bio}
          onChange={(event) => set({ bio: event.target.value })}
          disabled={saving}
          rows={3}
          className={FIELD}
          aria-invalid={Boolean(errors.bio)}
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium">Links</legend>
        {edit.links.map((link, index) => (
          // Rows have no identity of their own; they are edited in place and removed by position.
          <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="profile-link">
            <Input
              value={link.title}
              onChange={(event) => setLink(index, { title: event.target.value })}
              disabled={saving}
              placeholder="Title"
              aria-label={`Link ${index + 1} title`}
              className="sm:w-1/3"
            />
            <div className="flex flex-1 items-center gap-2">
              <Input
                value={link.url}
                onChange={(event) => setLink(index, { url: event.target.value })}
                disabled={saving}
                placeholder="https://example.com"
                aria-label={`Link ${index + 1} address`}
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 px-2"
                disabled={saving}
                onClick={() => set({ links: edit.links.filter((_, i) => i !== index) })}
                aria-label={`Remove link ${index + 1}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        {errors.links && (
          <p className="text-xs text-destructive" role="alert" data-testid="profile-links-error">
            {errors.links}
          </p>
        )}
        {edit.links.length < PROFILE_LIMITS.links && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => set({ links: [...edit.links, { title: '', url: '' }] })}
            data-testid="profile-add-link"
          >
            <Plus className="size-3" /> Add a link
          </Button>
        )}
      </fieldset>

      {failure && (
        <p className="text-xs text-destructive" role="alert" data-testid="profile-save-failed">
          Your profile could not be saved: {failure}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving} data-testid="profile-save">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={onClose}
          data-testid="profile-cancel"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {hint && <span className="text-xs text-muted-foreground tabular-nums">{hint}</span>}
      </div>
      {children}
      {error && (
        <p className="text-xs text-destructive" role="alert" data-testid={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
