# Firebase Hosting: deploying the dashboard

The dashboard (`frontend/dashboard`) is a static Vite SPA. Firebase Hosting serves `dist/` over HTTPS, which Web Push and the service worker require.

## What is already in the repo

| File | Purpose |
|---|---|
| `frontend/dashboard/firebase.json` | `public: dist`; SPA rewrite `** -> /index.html`; `no-cache` for `/index.html` and `/sw.js`; `immutable` 1-year cache for hashed `/assets/**`; basic security headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) |
| `frontend/dashboard/.env.production` | `VITE_API_BASE_URL` (public API URL, not a secret). Wins over a developer's `.env.local`, so hosted builds do not depend on a local env file |
| `frontend/dashboard/.gitignore` | ignores `.firebase/` |

No Firebase project id is committed. `.firebaserc` is created locally by `firebase use`.

## One-time setup (user)

1. Create (or pick) a Firebase project in the Firebase console: https://console.firebase.google.com -> Add project. Hosting is available on the free Spark plan.
2. Install the CLI and log in (a browser sign-in; it cannot be automated):
   ```
   npm install -g firebase-tools
   firebase login
   ```
3. Tell Claude the **project id**, or run `firebase use --add` in `frontend/dashboard`.

## Deploy

```
cd frontend/dashboard
npm ci
npm run build          # tsc -b && vite build  (mode=production, reads .env.production)
firebase deploy --only hosting
```

Hosting-only: this never touches the AWS backend.

## Why the service worker is safe here

- `/sw.js` is served from the site origin root, so its default scope covers the whole app. It is served `no-cache`, so a new worker is picked up on the next visit.
- Hosting is HTTPS-only, which satisfies the secure-context requirement for `PushManager` / `serviceWorker`.
- The worker shows `payload.title` / `payload.body` exactly as the backend sends them (pinned by `serviceWorker.test.ts`).
- `sw.js` references `/favicon.ico` as the notification icon; the app does not ship one yet, so the icon is simply missing (harmless 404). Add `public/favicon.ico` if a notification icon is wanted.

## CORS

The API Gateway allows every origin (`allow_origins = ["*"]`, methods GET/POST/PUT/DELETE, headers `content-type`, `x-admin-key`, `x-client-secret`). Requests carry no cookies (auth is by header), so the hosted origin works with no change. Optionally tighten `allow_origins` to the hosted origin(s) once the URL is final (a narrow `terraform apply -target` on the API resource).

## Bundle security review (checked on the production build)

- No API keys, AWS keys, private keys or Secrets Manager / SSM references in `dist/`.
- The Holodex client (`VITE_HOLODEX_API_KEY`) is **not** bundled: no `X-APIKEY` string in `dist/`. Do not import `integrations/holodex/holodexClient` from app code, or a local key would be inlined.
- Only public values are inlined: the API base URL and the Web Push **public** VAPID key.
- The admin panel (`?admin`) ships in the bundle but holds no secret; the admin key is typed by the operator and sent as `X-Admin-Key`.
- Remote images come from `yt3.ggpht.com` / `img.youtube.com`; embeds from `www.youtube.com`. A Content-Security-Policy was deliberately not added blind; if wanted, start with `Content-Security-Policy-Report-Only` allowing those hosts plus the API origin.
