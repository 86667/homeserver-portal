/**
 * Editing a pubky.app profile (`/pub/pubky.app/profile.json`): the rules
 * pubky.app's own model sets (pubky-app-specs' `PubkyAppUser`), so what the
 * page writes is a profile pubky.app accepts.
 */
import type { Profile } from './model';

/** The parts of a profile the page edits. The picture is not one of them. */
export type ProfileEdit = {
  name: string;
  bio: string;
  status: string;
  links: { title: string; url: string }[];
};

export const PROFILE_LIMITS = {
  nameMin: 3,
  nameMax: 50,
  bioMax: 160,
  statusMax: 50,
  links: 5,
  linkTitleMax: 100,
  linkUrlMax: 300,
};

/** What is wrong with each part of an edit; a part that is fine is absent. */
export type ProfileErrors = { name?: string; bio?: string; status?: string; links?: string };

/** The editor's starting point: the profile as it is, or blank for a first one. */
export function editOf(profile: Profile | null): ProfileEdit {
  return {
    name: profile?.name ?? '',
    bio: profile?.bio ?? '',
    status: profile?.status ?? '',
    links: profile?.links.map(({ title, url }) => ({ title, url })) ?? [],
  };
}

/** The edit as it is saved: trimmed, link addresses in their canonical form, and rows left wholly blank dropped. */
export function cleanProfileEdit(edit: ProfileEdit): ProfileEdit {
  return {
    name: edit.name.trim(),
    bio: edit.bio.trim(),
    status: edit.status.trim(),
    links: edit.links
      .map(({ title, url }) => ({ title: title.trim(), url: canonicalUrl(url) }))
      .filter(({ title, url }) => title || url),
  };
}

/** Checks a cleaned edit against pubky.app's limits. Lengths count characters, as pubky.app does, not UTF-16 units. */
export function profileErrors(edit: ProfileEdit): ProfileErrors {
  const errors: ProfileErrors = {};
  const name = length(edit.name);
  if (name < PROFILE_LIMITS.nameMin || name > PROFILE_LIMITS.nameMax)
    errors.name = `A name has ${PROFILE_LIMITS.nameMin} to ${PROFILE_LIMITS.nameMax} characters.`;
  // pubky.app shows this name for a deleted profile, and does not take it as one.
  else if (edit.name === '[DELETED]') errors.name = 'This name is not available.';
  if (length(edit.bio) > PROFILE_LIMITS.bioMax) errors.bio = `A bio has up to ${PROFILE_LIMITS.bioMax} characters.`;
  if (length(edit.status) > PROFILE_LIMITS.statusMax)
    errors.status = `A status has up to ${PROFILE_LIMITS.statusMax} characters.`;
  const links = linksError(edit.links);
  if (links) errors.links = links;
  return errors;
}

function linksError(links: ProfileEdit['links']): string | undefined {
  if (links.length > PROFILE_LIMITS.links) return `A profile has up to ${PROFILE_LIMITS.links} links.`;
  for (const { title, url } of links) {
    if (!title || !url) return 'Each link needs a title and an address.';
    if (length(title) > PROFILE_LIMITS.linkTitleMax)
      return `A link's title has up to ${PROFILE_LIMITS.linkTitleMax} characters.`;
    if (length(url) > PROFILE_LIMITS.linkUrlMax)
      return `A link's address has up to ${PROFILE_LIMITS.linkUrlMax} characters.`;
    if (!URL.canParse(url)) return `"${url}" is not a full address, such as https://example.com.`;
  }
  return undefined;
}

/**
 * The profile file to write: the stored one with the edited parts replaced.
 * Its picture and anything else another app keeps there stay as they are. An
 * emptied bio or status, or no links, is written as null, as pubky.app does.
 */
export function mergeProfile(stored: Record<string, unknown>, edit: ProfileEdit): Record<string, unknown> {
  return {
    ...stored,
    name: edit.name,
    bio: edit.bio || null,
    status: edit.status || null,
    links: edit.links.length > 0 ? edit.links : null,
  };
}

const length = (text: string) => [...text].length;

function canonicalUrl(typed: string): string {
  const trimmed = typed.trim();
  return URL.canParse(trimmed) ? new URL(trimmed).href : trimmed;
}
