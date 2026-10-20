// Central guard that keeps automated browsers from polluting PRODUCTION data.
//
// Plain ESM + JSDoc (no TypeScript syntax) on purpose: the repo's Playwright specs import it, and so can ad-hoc `playwright-core` scripts
// run with plain `node`. Read frontend/dashboard/AGENTS.md section 43 before pointing ANY automation at https://oshiyobi.web.app.
//
// What it blocks (and nothing else):
//  1. GA4 collection requests (`.../g/collect`, `/j/collect`, `/ccm/collect` on the Google collect hosts) -- answered locally with 204, so
//     an automated browser can never mint a user, first_visit, session or page_view in the production GA4 property.
//  2. Mutating requests (anything but GET/HEAD/OPTIONS) to the deployed AWS API (`*.execute-api.*.amazonaws.com`, plus any origin passed
//     in `apiOrigins` or listed in YOBI_GUARD_API_ORIGINS) -- answered locally with 403, so automation can never register a client
//     credential (POST /clients/{id}/credential), send a heartbeat (POST /heartbeat), or write a notification preference, push
//     subscription or reminder (PUT/DELETE /clients/{id}/...) in DynamoDB.
// API GETs, gtag.js, firebase.googleapis.com / firebaseinstallations.googleapis.com, Service Workers, Web Push endpoints, cookies and
// localStorage are never touched. No bot detection is added to the app: this lives entirely in the test tooling.
//
// Coverage: the guard only exists in a Playwright BrowserContext it was installed on, BEFORE the first navigation (guardAutomation /
// launchGuarded / launchGuardedPersistent do that). Tools that cannot install it (Claude Browser pane, hand-rolled CDP clients) are NOT
// protected -- do not point them at production (see AGENTS.md section 43).

/** Collection endpoints: `/g/collect` (GA4), `/j/collect` + `/collect` (legacy), `/ccm/collect` (consent mode / Google signals). */
const GA_COLLECT_PATH = /^\/(?:(?:g|j|ccm)\/)?collect\/?$/
/** Hosts GA4/gtag send collection beacons to (any google.com / google-analytics.com host also counts for the collect paths). */
const GA_HOST = /(^|\.)(google-analytics\.com|google\.com|doubleclick\.net)$/
/** The deployed API is API Gateway (execute-api) in any region. */
const AWS_API_HOST = /^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/
/** Methods that never change server state. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Chromium launch args: a process-wide backstop that makes the GA collection hosts unresolvable, covering anything that bypasses
 * `context.route` (e.g. service-worker or beacon traffic). Route interception runs first, so this only catches what slipped past it.
 * Chromium only. Use as `launchOptions: { args: ANALYTICS_LAUNCH_ARGS }`.
 */
export const ANALYTICS_LAUNCH_ARGS = [
  "--host-resolver-rules=MAP www.google-analytics.com ~NOTFOUND, MAP analytics.google.com ~NOTFOUND, MAP stats.g.doubleclick.net ~NOTFOUND, MAP region1.google-analytics.com ~NOTFOUND",
]

/** Whether `url` is a GA collection request (collect path on a Google host, so a new regional collect host is still caught). */
export function isAnalyticsCollectUrl(url) {
  const { hostname, pathname } = new URL(url)
  return GA_COLLECT_PATH.test(pathname) && GA_HOST.test(hostname)
}

/** Extra API origins from the YOBI_GUARD_API_ORIGINS environment variable (comma-separated), for a custom-domain or non-AWS API. */
export function apiOriginsFromEnv(env = typeof process === "undefined" ? {} : process.env) {
  return (env.YOBI_GUARD_API_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin)
}

/** Whether `url` belongs to a guarded API: the AWS API Gateway host pattern or one of `apiOrigins` (full origins). */
export function isGuardedApiUrl(url, apiOrigins = []) {
  const parsed = new URL(url)
  return AWS_API_HOST.test(parsed.hostname) || apiOrigins.includes(parsed.origin)
}

/** Whether an HTTP method can change server state (everything except GET/HEAD/OPTIONS). */
export function isMutatingMethod(method) {
  return !SAFE_METHODS.has(method.toUpperCase())
}

/** @typedef {{ analytics: string[], apiWrites: { method: string, path: string }[] }} AutomationGuard */

/**
 * Answers every GA collection request locally (204) so it never leaves the machine.
 * @param {import("@playwright/test").BrowserContext | import("@playwright/test").Page} target install BEFORE the first navigation
 * @param {AutomationGuard} [guard] record of what was blocked
 */
export async function blockAnalytics(target, guard = { analytics: [], apiWrites: [] }) {
  await target.route(
    (url) => isAnalyticsCollectUrl(url.href),
    async (route) => {
      guard.analytics.push(route.request().url())
      await route.fulfill({ status: 204, body: "" })
    },
  )
  return guard
}

/**
 * Answers every mutating request to a guarded API locally (403 `automation_guard_blocked`); GET/HEAD fall through untouched, so normal
 * API reads keep working. CORS preflights for routed requests are answered by Playwright itself and never reach the API.
 * @param {import("@playwright/test").BrowserContext | import("@playwright/test").Page} target install BEFORE the first navigation
 * @param {{ apiOrigins?: string[], guard?: AutomationGuard }} [options]
 */
export async function blockApiWrites(target, { apiOrigins = apiOriginsFromEnv(), guard = { analytics: [], apiWrites: [] } } = {}) {
  await target.route(
    (url) => isGuardedApiUrl(url.href, apiOrigins),
    async (route) => {
      const request = route.request()
      if (!isMutatingMethod(request.method())) {
        await route.fallback()
        return
      }
      guard.apiWrites.push({ method: request.method(), path: new URL(request.url()).pathname })
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "x-automation-guard", "x-automation-guard": "blocked" },
        body: JSON.stringify({ error: "Blocked by the test automation guard", code: "automation_guard_blocked" }),
      })
    },
  )
  return guard
}

/**
 * Installs both guards on a context (or page). Call it before the first `page.goto`.
 * @param {import("@playwright/test").BrowserContext | import("@playwright/test").Page} target
 * @param {{ apiOrigins?: string[] }} [options]
 * @returns {Promise<AutomationGuard>}
 */
export async function guardAutomation(target, options = {}) {
  const guard = { analytics: [], apiWrites: [] }
  await blockAnalytics(target, guard)
  await blockApiWrites(target, { ...options, guard })
  return guard
}

/**
 * Ad-hoc scripts: launch a browser and a fresh guarded context in one call, so no page can exist before the guard does.
 * @param {import("playwright-core").BrowserType} browserType e.g. `chromium` from playwright-core
 * @param {{ launchOptions?: object, contextOptions?: object, apiOrigins?: string[] }} [options]
 */
export async function launchGuarded(browserType, { launchOptions = {}, contextOptions = {}, apiOrigins } = {}) {
  const browser = await browserType.launch({ ...launchOptions, args: [...ANALYTICS_LAUNCH_ARGS, ...(launchOptions.args ?? [])] })
  const context = await browser.newContext(contextOptions)
  const guard = await guardAutomation(context, { apiOrigins })
  return { browser, context, guard }
}

/**
 * Ad-hoc scripts that need a persistent profile (e.g. real Chrome via `channel: "chrome"` for Web Push work): the Playwright-owned
 * replacement for driving Chrome through a hand-rolled CDP client, which cannot be guarded reliably.
 * @param {import("playwright-core").BrowserType} browserType
 * @param {string} userDataDir a dedicated throwaway profile directory -- never the user's own profile
 * @param {{ launchOptions?: object, apiOrigins?: string[] }} [options] launchOptions may include `channel`, `headless`, `permissions`...
 */
export async function launchGuardedPersistent(browserType, userDataDir, { launchOptions = {}, apiOrigins } = {}) {
  const context = await browserType.launchPersistentContext(userDataDir, { ...launchOptions, args: [...ANALYTICS_LAUNCH_ARGS, ...(launchOptions.args ?? [])] })
  const guard = await guardAutomation(context, { apiOrigins })
  return { context, guard }
}
