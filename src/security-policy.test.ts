import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, META_CONTENT_SECURITY_POLICY, REFERRER_POLICY } from '../security-policy.mjs';

describe('the security policy', () => {
  // Each of these files states the policy for a web server, which cannot import it.
  it.each(['docker/security-headers.conf', 'examples/Caddyfile'])('is the same in %s', (file) => {
    const config = readFileSync(file, 'utf8');
    expect(config).toContain(`Content-Security-Policy "${CONTENT_SECURITY_POLICY}"`);
    expect(config).toMatch(new RegExp(`Referrer-Policy "?${REFERRER_POLICY}"?`));
    expect(config).toMatch(/X-Content-Type-Options "?nosniff"?/);
  });

  it('leaves out of the page only what a <meta> tag cannot carry', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(META_CONTENT_SECURITY_POLICY).not.toContain('frame-ancestors');
    expect(`${META_CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`).toBe(CONTENT_SECURITY_POLICY);
  });
});
