/**
 * The page's security policy, in one place. It is sent as response headers by
 * whatever serves the page (examples/Caddyfile, the Docker image's
 * docker/security-headers.conf) and is also built into the
 * page's own HTML (vite.config.ts), so that a web server set up without the
 * headers still serves a page that restricts itself.
 *
 * connect-src stays open: the page talks to whichever homeserver, pkarr relays
 * and HTTP relay it is configured for. 'wasm-unsafe-eval' lets the Pubky SDK
 * start its WebAssembly. A test keeps the copies in the server configs equal
 * to this one.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: http:; img-src 'self' data:; " +
  "style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * The policy as a `<meta>` tag can carry it: browsers ignore `frame-ancestors`
 * there, so that one protection (not being framed by another site) still
 * needs the response header.
 */
export const META_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("; frame-ancestors 'none'", '');

/** Keeps an invite code in the URL from leaking to the sites the page links to. */
export const REFERRER_POLICY = 'no-referrer';
