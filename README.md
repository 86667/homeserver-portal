# Homeserver portal

The public page for the people who use a Pubky homeserver. They sign up with [Pubky Ring](https://pubkyring.app/) and an invite code, or sign in to an account they already have, and the page confirms their pubky has an account on this homeserver. To invite someone, send them `https://<page>/?token=<code>`: the page fills in the code and checks it before offering sign-up. On a homeserver with open sign-ups no code is asked for.

It is plain static files with no server side and no admin credential: the visitor's browser talks to the homeserver's public API itself. It began as part of [homeserver-dashboard](https://github.com/pubky/homeserver-dashboard), the homeserver's admin dashboard, and keeps the same look; the two are separate programs and neither needs the other.

## Run it for your homeserver

The portal is a directory of files. Any web server can serve it, and the one that already holds your domain and its TLS certificate is the natural choice. You need the homeserver's public key and a domain for the page, ideally a sub-domain of the homeserver's (`portal.example.com` next to `homeserver.example.com`).

1. Download the [latest release](https://github.com/86667/homeserver-portal/releases/latest) and unpack it. There is one archive for every platform. The commands here use version 0.1.0; put the release's version in its place:

   ```sh
   curl --fail --location --remote-name https://github.com/86667/homeserver-portal/releases/download/v0.1.0/homeserver-portal-v0.1.0.tar.gz
   tar --extract --gzip --file homeserver-portal-v0.1.0.tar.gz
   ```

   It unpacks to `homeserver-portal-v0.1.0/`: `site/` is the directory to serve, `config.example.json` is the config to fill in, and `examples/Caddyfile` is a site file for Caddy.

2. Put `site/` where your web server serves from, with a `config.json` in it:

   ```sh
   sudo mkdir -p /var/www
   sudo cp -r homeserver-portal-v0.1.0/site /var/www/homeserver-portal
   sudo cp homeserver-portal-v0.1.0/config.example.json /var/www/homeserver-portal/config.json
   ```

3. Edit `/var/www/homeserver-portal/config.json` and set `homeserverPublicKey` to your homeserver's public key. The key is on the Overview page of the [admin dashboard](https://github.com/pubky/homeserver-dashboard), and it is the `public_key` that the homeserver's admin API reports at `/info`. The portal itself never talks to the admin API. See [Configuration](#configuration) for the other two settings.

4. Serve the directory. With [Caddy](https://caddyserver.com/), which also gets the TLS certificate: copy the site from `examples/Caddyfile` into your Caddyfile, replace `portal.example.com` with your domain, and reload Caddy. Any other web server works too: point it at the directory and set the same headers.

Open the page: its Homeserver tab shows whether it reached your homeserver. With no usable key in `config.json`, the page says it is not set up.

The page carries most of its security policy in its own HTML, so it restricts itself even on a web server set up without the headers in the example. Keep them anyway: only a header can stop another site from framing the page (`frame-ancestors`) or the browser from guessing file types (`nosniff`).

To update, copy the new release's `site/` over the old one. The archive has no `config.json`, so yours stays:

```sh
sudo cp -r homeserver-portal-v0.1.0/site/. /var/www/homeserver-portal/
```

## Configuration

`config.json` sits next to `index.html` and the page reads it on every load. None of it is a secret.

| Setting               | Description                                                                                                                                               | When `null`                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `homeserverPublicKey` | The homeserver's public key. The page finds the homeserver by it.                                                                                         | the page says it is not set up |
| `relay`               | HTTP relay Pubky Ring answers through. Visitors' browsers wait on it, so it must be reachable from them (never `localhost`), over HTTPS when the page is. | the Pubky SDK's relay          |
| `testnetHost`         | Development only: use a local pubky-testnet on this host instead of mainnet.                                                                              | mainnet                        |

## Docker

The image is the same files served by nginx on port 8080, as an unprivileged user, with the security headers set. There is no published image yet; build it from a checkout:

```sh
docker build -t homeserver-portal .
docker run -p 8080:8080 -e HOMESERVER_PUBLIC_KEY=<key> homeserver-portal
```

The container writes `config.json` from its environment when it starts: `HOMESERVER_PUBLIC_KEY`, `AUTH_RELAY` and `PUBKY_TESTNET_HOST` set `homeserverPublicKey`, `relay` and `testnetHost`. A value that is set but malformed stops the container at start. Put the container behind your TLS proxy.

## How it works

The page is laid out like the admin dashboard (same width, header with a sign-in pill, or a sign-out pill once signed in, footer) with tabs: **Homeserver**, where the page opens, **Account**, where an invite link opens it, and **Activity**, which appears once someone has signed in. Each tab's data is read when it is first opened.

- The invite code check and the "are codes required?" check are the homeserver's public `GET /signup_tokens/{code}`.
- The page asks Ring for a grant (the SDK's `startGrantAuthFlow`) with the capability `/:r`: read everything, write nothing. The root scope is needed because the homeserver reports an account (`GET /account`, pubky-core #749) only to a grant that reads the root, an account not being scoped to any path. The page says so before the QR code. For a sign-up, Ring first creates the keys and registers them on the homeserver with the invite code, then approves the grant; Ring returns the approval through the relay.
- The SDK exchanges the approved grant for a session at the person's homeserver: the one their own record on the Pubky network names (for a sign-up, this one). The page checks that the session is at this homeserver; one elsewhere means no account here, and the page names the other homeserver. A pubky this homeserver does not know answers 404, and one with no record at all cannot be placed: both are "no account here".
- Through the session the page reads the account (`session.grant.account()`): when it signed up, whether it is disabled, the storage used against the allowance, and the download and upload limits and writable paths that apply, each marked when it was set for this account in particular. Then it revokes the grant (`session.signout()`), so nothing stays authorised. A homeserver from before `GET /account` (it arrived in 0.18.0) refuses the read (403 on 0.17.x, where the path falls to the storage routes; 404 otherwise) and the page says it does not report account details, showing no storage figure at all. If Ring granted less than reading everything, the homeserver is not asked and the page says why; a grant that reads the root with more (`/:rw`) also counts.
- After a sign-up the page reads the code's status again: a spent code means a new account, a still-unused one means Ring approved with a key that was already signed up here.
- Once signed in, the Account tab also shows the person's pubky.app profile, from the homeserver's public storage API: `GET /storage/<pubky>/pub/pubky.app/profile.json`. Its image is fetched and shown as a `data:` URL, since the page's Content-Security-Policy allows no other image source. This needs no session: a person's public files are public.

- The Activity tab is there for signed-in account holders only. It shows the person's own newest public changes (files written and removed) from the event stream's batch mode, ten at a time and grouped by folder: `GET /events-stream?user=<pubky>&reverse=true&limit=10`, one request per page, "Load 10 more" asking for the ten before the last cursor. A filter narrows them to one file or folder, typed or chosen from the folders shown, and the homeserver does the filtering: the request gains `path=/pub/<path>&path=/pub/<path>/`, the file and the folder reading of what was typed. Changes to private files are not shown, since the page asks without a session.
- The Homeserver tab is the admin dashboard's "Server & Connection" card, from public sources: `GET /info` (whether the homeserver answers, the address its key resolved to, the features it announces), the sign-up mode from the invite check, and the homeserver's signed record on the Pubky network, read from the pkarr relay (`https://pkarr.pubky.app/<key>`, or the testnet's) and decoded in the browser: the Pubky address (IP and port) it publishes, when it was published, and a "View" dialog with its DNS records. The homeserver's version is admin-only and not shown.

Because every request comes from the visitor's own browser, the homeserver sees each visitor's address and applies its rate limits per visitor. The page never sees a private key and forgets everything on reload.

## Known limits

- **The sign-in asks to read everything.** Ring shows a request for `/:r`, because `GET /account` requires a grant on the root scope. The page holds that access for one read and revokes it, but a person has only the page's word for it. Homeservers up to pubky-core #749 require `/:rw` and refuse `/:r` with 403, which the page reports as the homeserver not reporting account details.
- **A sign-in follows the person's record.** The grant is exchanged at the homeserver the pubky's own record names. Someone with an account here whose record points elsewhere is told they have no account here.
- **A grant can be left behind.** Revoking the grant is best effort; one that is not revoked (the browser was closed first, say) is listed in Ring and expires on its own.
- **Disabled accounts are only reported by newer homeservers.** Up to 0.17.1 the homeserver lets a disabled account sign in and reports nothing about it, so the page says the person has an account and nothing more.
- **Polling outlives the attempt.** The SDK cannot stop waiting on the relay, so after Cancel an abandoned request keeps polling quietly until the page is closed.
- **The homeserver's rate limits trust a header.** The homeserver keys its limits on the first `X-Forwarded-For` entry a client sends, so a client talking to it directly can sidestep them. That is upstream behaviour, not something this page adds.

## Development

```sh
npm install
HOMESERVER_PUBLIC_KEY=<key> npm run dev     # the dev server serves config.json from the environment
npm test                                    # unit tests (Vitest)
npm run typecheck
npm run build                               # static files in dist/
```

`scripts/release-archive.sh` packs `dist/` into the release archive and `scripts/smoke-test-archive.sh <archive>` checks one by unpacking and serving it. A release is a `v*.*.*` tag that matches the version in `package.json`: the release workflow builds, packs and smoke-tests the archive and attaches it to the GitHub release.

`npm run e2e` drives the page in Chrome against a local pubky-testnet, with the Pubky SDK playing Ring; it skips when no testnet answers. See the header of `e2e/account.spec.mjs` for its settings.

## Code layout

| Path                       | What                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/components/`          | The page: `AccountFlow` (the tabs), the Account tab's steps and cards, `ActivityTab` and `HomeserverTab`.                    |
| `src/useAccountFlow.ts`    | The sign-up/sign-in steps as a state machine.                                                                                |
| `src/useProfile.ts`        | Their pubky.app profile.                                                                                                     |
| `src/useOwnActivity.ts`    | A signed-in person's own changes, a page at a time, grouped by folder and filtered by path; `activity.ts` is the pure part.  |
| `src/useHomeserver.ts`     | `/info` and the homeserver's signed network record; `pkarr.ts` decodes the record.                                           |
| `src/homeserver-client.ts` | The only module that loads the Pubky SDK: invite checks, Ring requests, sign-in checks, public file, profile and feed reads. |
| `src/config.ts`            | Loads and checks `config.json`.                                                                                              |
| `docker/`                  | nginx config, security headers, and the start-up script that writes `config.json`.                                           |
| `security-policy.mjs`      | The security policy: built into the page, and repeated as headers in `examples/` and `docker/` (a test keeps them equal).    |
| `examples/`                | A Caddy site file for serving a release.                                                                                     |
| `scripts/`                 | Packs the release archive and smoke-tests it.                                                                                |

`src/components/ui`, `src/hooks/useCopyFeedback.ts`, `src/lib/` and `src/theme.css` are the UI primitives, helpers and theme copied from the admin dashboard, kept as they are there so a change in one can be carried to the other.
