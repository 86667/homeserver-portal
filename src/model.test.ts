import { describe, expect, it } from 'vitest';
import { ACCOUNT_CAPABILITY, isInviteCode, normalizeInviteCode, readsRoot, writesProfile } from './model';

describe('normalizeInviteCode', () => {
  it.each([
    ['abcd-efgh-jkmn', 'ABCD-EFGH-JKMN'],
    ['ABCDEFGHJKMN', 'ABCD-EFGH-JKMN'],
    [' abcd efgh jkmn ', 'ABCD-EFGH-JKMN'],
    ['ABCD', 'ABCD'],
    ['ABCDE', 'ABCD-E'],
    // Backspacing over a hyphen leaves no dangling hyphen behind.
    ['ABCD-', 'ABCD'],
    ['ABCD-EFGH-JKMN-PQRS', 'ABCD-EFGH-JKMN'],
    ['', ''],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeInviteCode(raw)).toBe(expected);
  });
});

describe('isInviteCode', () => {
  it('accepts only whole canonical codes', () => {
    expect(isInviteCode('ABCD-EFGH-JKMN')).toBe(true);
    expect(isInviteCode('abcd-efgh-jkmn')).toBe(false);
    expect(isInviteCode('ABCD-EFGH')).toBe(false);
    expect(isInviteCode('../../info')).toBe(false);
    expect(isInviteCode('ABCD-EFGH-JKMN/x')).toBe(false);
  });
});

describe('the capabilities the page asks for', () => {
  it('read the root and write the profile file only', () => {
    expect(ACCOUNT_CAPABILITY).toBe('/:r,/pub/pubky.app/profile.json:rw');
    const [root, profile] = ACCOUNT_CAPABILITY.split(',');
    expect([readsRoot(root), writesProfile(root)]).toEqual([true, false]);
    expect([readsRoot(profile), writesProfile(profile)]).toEqual([false, true]);
  });

  it.each([
    ['/:rw', true],
    ['/pub/:w', true],
    ['/pub/pubky.app/:rw', true],
    ['/pub/pubky.app/profile.json:r', false],
    ['/pub/pubky.app/profile.json.bak:rw', false],
    ['/pub/pubky.app:rw', false],
    ['/pub/other.app/:rw', false],
  ])('%s writes the profile: %s', (capability, expected) => {
    expect(writesProfile(capability)).toBe(expected);
  });
});
