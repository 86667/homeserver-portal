import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { configFromEnv } from './config-from-env.mjs';
import { META_CONTENT_SECURITY_POLICY, REFERRER_POLICY } from './security-policy.mjs';
import { version } from './package.json';

/** Serves /config.json from the environment in dev and preview, as the image does at start. */
function configJson(): Plugin {
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/config.json') return next();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(configFromEnv(process.env)));
  };
  return {
    name: 'account-config-json',
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}

/**
 * Builds the security policy into the page itself, ahead of everything else in
 * its head. Only in a build: the dev server's own inline scripts would break it.
 */
function securityPolicy(): Plugin {
  return {
    name: 'portal-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: META_CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
      { tag: 'meta', attrs: { name: 'referrer', content: REFERRER_POLICY }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), configJson(), securityPolicy()],
  // The page shows its own version in the footer.
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2022',
    // The Pubky SDK (its WebAssembly inlined) is one ~3 MB chunk of its own,
    // loaded only once the page connects; it cannot be split further.
    chunkSizeWarningLimit: 3500,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
