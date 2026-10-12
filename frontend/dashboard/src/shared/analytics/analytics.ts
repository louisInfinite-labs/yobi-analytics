import type { Analytics } from "firebase/analytics"
import { firebaseConfig } from "./firebaseConfig"

/** The only origins whose visits are measured: the deployed Firebase Hosting site (both of its default domains). Everything else --
 * localhost, `vite preview` of a production build, a dev server, automated tests (jsdom is localhost, and tests are not a PROD build
 * either) -- never loads or contacts Firebase/Google Analytics, so development can't pollute the production property. */
const ANALYTICS_HOSTNAMES: ReadonlySet<string> = new Set(["oshiyobi.web.app", "oshiyobi.firebaseapp.com"])

/** Whether this page is the deployed production site (a production build served from an allowed hostname). */
export function isAnalyticsEnvironment(hostname: string = window.location.hostname): boolean {
  return import.meta.env.PROD && ANALYTICS_HOSTNAMES.has(hostname)
}

/** The only routes that are measured: the root Home, the creator pages and Schedule. Every other route (Settings, About, anything unknown or
 * development-only) is never measured. */
export function isAnalyticsRoute(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === "/" || path === "/schedule" || path === "/creator" || path.startsWith("/creator/")
}

type SdkAnalytics = typeof import("firebase/analytics")
interface AnalyticsHandle {
  analytics: Analytics
  logEvent: SdkAnalytics["logEvent"]
  setAnalyticsCollectionEnabled: SdkAnalytics["setAnalyticsCollectionEnabled"]
}

let started: Promise<AnalyticsHandle | null> | null = null
let lastRoutePath: string | null = null
let sdkPageViewCovered = false
let hostnameForTests: string | null = null

/** Starts Firebase Analytics once for the page's lifetime (repeat calls return the same promise; the Firebase app is also reused if one
 * already exists, so it can never be initialised twice). Only on the production site and in a browser that supports Analytics; the Firebase
 * SDK is imported on demand, so a page that is never measured never even fetches it. It is started only by trackRoute, from the first
 * measured route -- never at page load -- so a visit that lands on an unmeasured route sends nothing. Analytics must never break the app, so
 * every failure resolves to null (that visit is simply not measured). */
export function initAnalytics(hostname: string = hostnameForTests ?? window.location.hostname): Promise<AnalyticsHandle | null> {
  if (started) return started
  started = isAnalyticsEnvironment(hostname) ? start() : Promise.resolve(null)
  return started
}

async function start(): Promise<AnalyticsHandle | null> {
  try {
    const [{ getApps, initializeApp }, sdk] = await Promise.all([import("firebase/app"), import("firebase/analytics")])
    if (!(await sdk.isSupported())) return null
    return { analytics: sdk.getAnalytics(getApps()[0] ?? initializeApp(firebaseConfig)), logEvent: sdk.logEvent, setAnalyticsCollectionEnabled: sdk.setAnalyticsCollectionEnabled }
  } catch {
    return null
  }
}

/** Reports the route now being shown; call it for EVERY route change (measured or not).
 *  - A measured route (see isAnalyticsRoute): the first one starts Analytics, whose own first page_view covers it; every later change of
 *    path switches collection on and logs exactly one page_view (the SDK sees no pushState navigation by itself).
 *  - An unmeasured route: collection is switched OFF (so no page_view and no automatic event, such as scroll or outbound clicks, is sent while
 *    the visitor is there) and nothing is logged. If Analytics was never started it still is not.
 * Consecutive calls for the same path do nothing. */
export function trackRoute(path: string, title: string): void {
  if (path === lastRoutePath) return
  lastRoutePath = path

  if (!isAnalyticsRoute(path)) {
    if (started) void started.then((handle) => handle?.setAnalyticsCollectionEnabled(handle.analytics, false))
    return
  }
  if (!sdkPageViewCovered) {
    sdkPageViewCovered = true
    void initAnalytics()
    return
  }
  void initAnalytics().then((handle) => {
    if (!handle) return
    handle.setAnalyticsCollectionEnabled(handle.analytics, true)
    handle.logEvent(handle.analytics, "page_view", { page_path: path, page_title: title, page_location: window.location.origin + path })
  })
}

/** Test-only: forget that Analytics was started and which route was last recorded, and optionally pretend the page is served from `hostname`. */
export function resetAnalyticsForTests(hostname: string | null = null): void {
  hostnameForTests = hostname
  started = null
  lastRoutePath = null
  sdkPageViewCovered = false
}
