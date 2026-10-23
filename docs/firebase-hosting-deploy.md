# Firebase Hosting: deploying the dashboard

The dashboard (`frontend/dashboard`) is a static Vite SPA. Firebase Hosting serves `dist/` over HTTPS, which Web Push and the service worker require.

## What is already in the repo

| File | Purpose |
|---|---|
| `frontend/dashboard/firebase.json` | `public: dist`; **no SPA catch-all rewrite** (every public route is a generated static page, see "Static SEO pages"; an unknown path gets `404.html` with HTTP 404); `trailingSlash: false`; 301 `/index.html` -> `/` and `/creator` -> `/`; `no-cache` for every HTML route and `/sw.js`; `immutable` 1-year cache for hashed `/assets/**`; `X-Robots-Tag: noindex` for `/setting` and `/404.html`; basic security headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) |
| `frontend/dashboard/.env.production` | `VITE_API_BASE_URL` (public API URL, not a secret). Wins over a developer's `.env.local`, so hosted builds do not depend on a local env file |
| `frontend/dashboard/.gitignore` | ignores `.firebase/` |
| `frontend/dashboard/.firebaserc` | default project `oshiyobi` |

`frontend/dashboard/.firebaserc` pins the project: `oshiyobi` (default site https://oshiyobi.web.app). A project id is not a secret.

## Static SEO pages

`vite build` (`seoPagesPlugin` in `vite.config.ts`, logic in `src/app/seo/pageSeo.ts`) writes one HTML file per public route from the built `index.html`: `/` -> `index.html`, `/schedule`, `/about`, `/setting`, and `/creator/<slug>` for every sitemap Creator -> `<path>/index.html` (Firebase serves it at the extensionless URL), plus `404.html`. Each has its own title, description, canonical (always `https://oshiyobi.web.app`), Open Graph tags and real text and links inside `#root`, which React replaces on first render (no hydration, no hidden copy). That raw HTML is what non-rendering crawlers and Google's first pass read; what a renderer sees after React runs is the app itself. The page set is the sitemap's own path list plus `/setting`; Creator facts come only from the generated Creator Registry.

A new app route needs a page here (add it to `FIXED_PAGES` in `pageSeo.ts` and to the sitemap), otherwise Hosting answers it with the 404 page.

Local check without deploying: `firebase emulators:start --only hosting --project demo-oshiyobi-test` from `frontend/dashboard`. On Windows the emulator's glob matching is broken (headers and redirects silently do nothing), so use WSL/Linux, or preload a fix for `glob-slash`.

## Setup

The Firebase CLI must be installed and logged in (`npm install -g firebase-tools`, `firebase login`); the project `oshiyobi` already exists.

## Deploy

```
cd frontend/dashboard
npm ci
npm run build                                  # tsc -b && vite build  (mode=production, reads .env.production)
node scripts/retainDeployedAssets.mjs          # keep the LIVE release's hashed assets next to the new ones (see below) -- never skip
node scripts/retainDeployedAssets.mjs --check  # must print CHECK OK
firebase deploy --only hosting
```

Hosting-only: this never touches the AWS backend.

## Keep the live release's assets (no blank screen for cached pages)

**The problem.** Every release replaces `dist/assets`. A browser that fetched `/` (or any app route) less than an hour before the deploy still holds the OLD
HTML (`Cache-Control: max-age=3600` on the pre-SEO config), and that HTML asks for `/assets/index-<oldhash>.js` and `.css`, which the new release no
longer has -- the first launch is a blank page until a manual reload. This was reproduced (old HTML cached, old assets not cached, new release without the
old files: the app does not render and `/assets/index-<oldhash>.js` answers 404). Installed PWAs are affected the same way as browser tabs. Storage, the
service worker registration and push subscriptions are NOT affected -- only the first paint.

**The fix.** `scripts/retainDeployedAssets.mjs` reads the live site (read-only GET requests), starts from the live HTML (it compares `/`, `/index.html`,
`/schedule`, `/about` and a creator route), follows every hashed asset named in the HTML, JS and CSS until nothing new turns up, and copies each live asset
the new build lacks into `dist/assets`. A name that is not a real file on the live site (404, or the SPA fallback's HTML) is ignored as a false match; a
referenced asset that cannot be fetched fails the run; a same-name file with different bytes is refused. It is idempotent.

For the release that introduces the static SEO pages, the live closure is exactly six files; two disappear from the new build and are retained:

| Live asset | Bytes | In the new build? |
|---|---|---|
| `index-Dn5AXzsz.js` (main bundle) | 973,097 | no -> **retained** |
| `index-JPQhNxKg.css` | 136,168 | no -> **retained** |
| `brand-icon-DzThQ0nY.png` | 15,010 | yes, byte-identical |
| `index.esm-CaP7CaCT.js`, `index.esm-D4N8y42I.js`, `index.esm-Nr9gEvPL.js` (lazy Firebase Analytics chunks, loaded only on the production hostnames) | 690 - 27,777 | yes, byte-identical |

Retaining only the main JS and CSS would be correct today only because the three lazy chunks happen to keep their hashes; the script does not rely on that.
Unhashed files the old shell and bundle use (`/icons/*`, `/manifest.webmanifest`, `/sw.js`, `/favicon.ico`) are public files and are in every release.

**Verify before deploying** (local, nothing is published):

1. `node scripts/retainDeployedAssets.mjs --check` prints `CHECK OK`.
2. `firebase emulators:start --only hosting --project demo-oshiyobi-test` serves it. Request every file listed under `liveAssets` in the script's JSON output: each
   must be `200` with a non-HTML content type, `Cache-Control: public, max-age=31536000, immutable`.
3. `curl -s https://oshiyobi.web.app/sw.js` and `/manifest.webmanifest` must be byte-identical to `dist/sw.js` and `dist/manifest.webmanifest` (an unchanged service
   worker is what keeps installed apps from updating, re-registering or losing their push subscription).

**After deploying**, immediately `curl -I` each retained `/assets/...` URL on the live site (200, immutable), and fetch `/`, a creator page and `/sw.js`.

**Removal policy.** The old files cost about 1.1 MB of hosting storage and nothing in transfer unless requested, so there is no hurry to remove them, and a
timer is the wrong trigger. What bounds the need:

- HTML freshness: `/` and the other routes were served with `max-age=3600`, so a browser can only start from the old HTML for one hour after the last time
  it fetched it -- at most one hour after the deploy. The new config serves HTML with `no-cache`, so no new stale shells are created after that.
- Beyond that hour, a browser may still reopen an old HTML entry from history (back/forward navigation uses the cache without revalidating) or a long-lived
  installed window may reload a lazy chunk; browsers and WebViews differ (iOS in particular) and this repository cannot measure it.
- So the rule is by release, not by clock: **each release retains the live release's closure** (the script does this), and **a retained file is dropped only
  when at least two releases have shipped since it was last live AND at least 30 days have passed**. The 30 days is a judgement, not a measurement: it is far
  longer than any HTML freshness window and than the usual browser cache eviction horizon for unvisited entries.
- If two releases ship less than an hour apart, the second must also keep the first release's retained files: pass the previous release's `dist` with
  `--also <previous dist>` (keep each deployed `dist` until the policy above allows dropping it).

**Rollback** (no user action needed; this is hosting-only). Firebase Hosting keeps the release history: roll back from the Firebase console (Hosting >
Release history > the previous release > Rollback) or `firebase hosting:rollback`. The previous release contains its own assets, so the old shell and the
old files are served as before. Note the live version id before deploying. If the new HTML is the problem, rolling back also removes the retained files from
the live site, which is fine because the old release does not need them. Nothing stored on a user's device (service worker, storage, subscription) has to be
touched either way.

**What this cannot prove.** The simulations ran in Chromium on one origin; real iOS/Android installed apps (WebKit/WebView caches, Home Screen launch) and a
real deployment on the production origin remain to be checked.

## Why the service worker is safe here

- `/sw.js` is served from the site origin root, so its default scope covers the whole app. It is served `no-cache`, so a new worker is picked up on the next visit.
- Hosting is HTTPS-only, which satisfies the secure-context requirement for `PushManager` / `serviceWorker`.
- The worker shows `payload.title` / `payload.body` exactly as the backend sends them (pinned by `serviceWorker.test.ts`).
- `sw.js` has no fetch handler and no caches, so it never serves a stale page, and the static SEO pages did not change it. `public/favicon.ico` is shipped so `/favicon.ico` is an icon, not the HTML shell.

## CORS

The API Gateway allows every origin (`allow_origins = ["*"]`, methods GET/POST/PUT/DELETE, headers `content-type`, `x-admin-key`, `x-client-secret`). Requests carry no cookies (auth is by header), so the hosted origin works with no change. Optionally tighten `allow_origins` to the hosted origin(s) once the URL is final (a narrow `terraform apply -target` on the API resource).

## Bundle security review (checked on the production build)

- No API keys, AWS keys, private keys or Secrets Manager / SSM references in `dist/`.
- The Holodex client (`VITE_HOLODEX_API_KEY`) is **not** bundled: no `X-APIKEY` string in `dist/`. Do not import `integrations/holodex/holodexClient` from app code, or a local key would be inlined.
- Only public values are inlined: the API base URL and the Web Push **public** VAPID key.
- The admin panel (`?admin`) ships in the bundle but holds no secret; the admin key is typed by the operator and sent as `X-Admin-Key`.
- Remote images come from `yt3.ggpht.com` / `img.youtube.com`; embeds from `www.youtube.com`. A Content-Security-Policy was deliberately not added blind; if wanted, start with `Content-Security-Policy-Report-Only` allowing those hosts plus the API origin.
