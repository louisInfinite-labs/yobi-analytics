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

type LogEvent = typeof import("firebase/analytics").logEvent
interface AnalyticsHandle {
  analytics: Analytics
  logEvent: LogEvent
}

let started: Promise<AnalyticsHandle | null> | null = null
let lastPagePath: string | null = null

/** Starts Firebase Analytics once for the page's lifetime (repeat calls return the same promise; the Firebase app is also reused if one
 * already exists, so it can never be initialised twice). Only on the production site and in a browser that supports Analytics; the Firebase
 * SDK is imported on demand, so any other page never even fetches it. Analytics must never break the app, so every failure resolves to null
 * (that visit is simply not measured). */
export function initAnalytics(hostname: string = window.location.hostname): Promise<AnalyticsHandle | null> {
  if (started) return started
  started = isAnalyticsEnvironment(hostname) ? start() : Promise.resolve(null)
  return started
}

async function start(): Promise<AnalyticsHandle | null> {
  try {
    const [{ getApps, initializeApp }, { getAnalytics, isSupported, logEvent }] = await Promise.all([import("firebase/app"), import("firebase/analytics")])
    if (!(await isSupported())) return null
    return { analytics: getAnalytics(getApps()[0] ?? initializeApp(firebaseConfig)), logEvent }
  } catch {
    return null
  }
}

/** Records one SPA page view. The SDK itself sends the page_view for the page the visitor LANDED on, but not for the pushState navigations
 * that follow (measured: one page_view on load, none on route changes), so the first call only remembers the landing page and every later
 * change of page logs exactly one page_view. Consecutive calls for the same path never log twice. */
export function trackPageView(path: string, title: string): void {
  if (path === lastPagePath) return
  const isLanding = lastPagePath === null
  lastPagePath = path
  if (isLanding) return
  void initAnalytics().then((handle) => {
    handle?.logEvent(handle.analytics, "page_view", { page_path: path, page_title: title, page_location: window.location.origin + path })
  })
}

/** Test-only: forget that Analytics was started and which page was last recorded. */
export function resetAnalyticsForTests(): void {
  started = null
  lastPagePath = null
}
