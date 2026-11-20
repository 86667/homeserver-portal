import { describe, expect, it } from 'vitest';
import { type ProfileEdit, type ProfileErrors, cleanProfileEdit, editOf, mergeProfile, profileErrors } from './profile';

const edit = { name: 'Alice', bio: '', status: '', links: [] as { title: string; url: string }[] };

describe('editOf', () => {
  it('starts from the profile, or blank', () => {
    const links = [{ title: 'Site', url: 'https://a.example/' }];
    expect(editOf({ name: 'Alice', bio: null, status: 'around', links, avatar: 'data:x' })).toEqual({
      name: 'Alice',
      bio: '',
      status: 'around',
      links,
    });
    expect(editOf(null)).toEqual({ name: '', bio: '', status: '', links: [] });
  });
});

describe('cleanProfileEdit', () => {
  it('trims, puts addresses in canonical form and drops blank link rows', () => {
    expect(
      cleanProfileEdit({
        name: '  Alice ',
        bio: ' hi\n',
        status: ' ',
        links: [
          { title: ' Site ', url: ' HTTPS://Alice.example ' },
          { title: ' ', url: '' },
          { title: 'Half', url: '' },
          { title: 'Odd', url: 'alice.example' },
        ],
      }),
    ).toEqual({
      name: 'Alice',
      bio: 'hi',
      status: '',
      links: [
        { title: 'Site', url: 'https://alice.example/' },
        { title: 'Half', url: '' },
        { title: 'Odd', url: 'alice.example' },
      ],
    });
  });
});

describe('profileErrors', () => {
  it('passes a profile within pubky.app’s limits', () => {
    const links = Array.from({ length: 5 }, (_, i) => ({ title: `Link ${i}`, url: `https://a.example/${i}` }));
    expect(profileErrors({ name: 'Bob', bio: 'b'.repeat(160), status: 's'.repeat(50), links })).toEqual({});
  });

  it('counts characters, not UTF-16 units', () => {
    expect(profileErrors({ ...edit, name: '😀😀' }).name).toBeDefined();
    expect(profileErrors({ ...edit, name: '😀'.repeat(50) })).toEqual({});
  });

  it.each([
    ['name', { name: 'Al' }],
    ['name', { name: 'a'.repeat(51) }],
    ['name', { name: '[DELETED]' }],
    ['bio', { bio: 'b'.repeat(161) }],
    ['status', { status: 's'.repeat(51) }],
    ['links', { links: Array.from({ length: 6 }, () => ({ title: 'T', url: 'https://a.example/' })) }],
    ['links', { links: [{ title: '', url: 'https://a.example/' }] }],
    ['links', { links: [{ title: 'T', url: '' }] }],
    ['links', { links: [{ title: 'T', url: 'a.example' }] }],
    ['links', { links: [{ title: 't'.repeat(101), url: 'https://a.example/' }] }],
    ['links', { links: [{ title: 'T', url: `https://a.example/${'p'.repeat(300)}` }] }],
  ] satisfies [keyof ProfileErrors, Partial<ProfileEdit>][])('refuses a bad %s', (part, change) => {
    expect(Object.keys(profileErrors({ ...edit, ...change }))).toEqual([part]);
  });
});

describe('mergeProfile', () => {
  it('replaces the edited parts, nulls the emptied ones and keeps everything else', () => {
    expect(mergeProfile({ name: 'Al', bio: 'old', links: [], image: 'pubky://x', extra: 1 }, edit)).toEqual({
      name: 'Alice',
      bio: null,
      status: null,
      links: null,
      image: 'pubky://x',
      extra: 1,
    });
  });
});
