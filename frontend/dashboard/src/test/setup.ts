import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { resetLiveDockExpandedForTests } from "../features/live-status/hooks/useLiveDockExpanded"
import { resetHomeSelectedVideoForTests } from "../features/home-room/hooks/useHomeSelectedVideo"
import { resetStreamNotificationOverrideCacheForTests } from "../features/live-schedule/hooks/streamNotificationOverrideCache"
import { resetNotificationSaveStatusForTests } from "../features/notifications/hooks/notificationSaveStatus"
import { resetAllSharedStateForTests } from "../shared/state/sharedState"
import { resetLiveStreamsPollingForTests } from "../shared/api/liveStreamsPollState"
import { resetAboutContentFetchForTests } from "../pages/about/aboutContentFetchState"
import { clearVideoSearchInput } from "../features/video-search/hooks/useVideoSearchInput"

// A unit test must never reach a real server, whatever .env.local says: a developer checkout can set VITE_API_BASE_URL to the PRODUCTION API there, and any
// component that fetches on mount (the Live Status roster reads GET /milestones) would then call production from a test run. So the real fetch is replaced,
// once, here, by one that REJECTS every request except to the local machine (a dev mock server on localhost is still reachable). A test that needs a
// response stubs fetch (or the request function) itself -- vi.stubGlobal("fetch", ...) / vi.mock -- which replaces this guard for that test only. This file
// imports no application module on purpose: importing one here would load it before a test file's own vi.mock could replace it.
const realFetch = globalThis.fetch.bind(globalThis)
const LOCAL_URL = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)|\/(?!\/))/i
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  // redirect: "error": a local mock that answers with a redirect must not be able to send the request on to a remote host past this check.
  if (LOCAL_URL.test(url)) return realFetch(input, { ...init, redirect: "error" })
  return Promise.reject(new TypeError(`Real network access is blocked in tests (stub fetch or mock the request): ${url}`))
}) as typeof fetch
// @testing-library/react's own auto-cleanup only self-registers when
// `afterEach` is a global (vitest's `test.globals: true`); this project
// deliberately keeps globals off and imports test functions explicitly, so
// cleanup must be wired up here instead — otherwise each test's render
// stays mounted and stacks on top of the next test's.
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  // lib/sharedState's stores are module-level singletons (needed so every
  // mounted component reacts to the same change immediately, not just
  // components that happen to remount) -- clearing localStorage alone
  // doesn't reset their in-memory value, so without this a favorite/Oshi
  // selection toggled in one test would still be set at the start of the
  // next one.
  resetAllSharedStateForTests()
  // useLiveDockExpanded is the same kind of module-level singleton but
  // isn't one of lib/sharedState's localStorage-backed stores (it's
  // deliberately not persisted), so it needs its own reset here.
  resetLiveDockExpandedForTests()
  // Same reasoning as useLiveDockExpanded above -- Home's selected-video
  // singleton is deliberately not persisted either.
  resetHomeSelectedVideoForTests()
  // liveStreamsStore's poll ref-count/interval handle are the same kind of
  // non-persisted module-level singleton, separate from its
  // createSharedState-backed value (already covered by
  // resetAllSharedStateForTests above).
  resetLiveStreamsPollingForTests()
  // useStreamNotificationOverride's cache is backend-fetched, deliberately
  // not localStorage-backed (the backend is the real source of truth) --
  // same non-persisted module-level singleton reasoning as the two above.
  resetStreamNotificationOverrideCacheForTests()
  // aboutContentStore's fetch-once flag is the same kind of non-persisted
  // module-level singleton as the ones above, separate from its own
  // createSharedState-backed value (already covered by
  // resetAllSharedStateForTests above).
  resetAboutContentFetchForTests()
  // The Settings "couldn't save" flag is the same kind of non-persisted module-level singleton.
  resetNotificationSaveStatusForTests()
  // So is the shared video-search text (the desktop box and the phone header input are two views of it).
  clearVideoSearchInput()
  // Re-initialising the shared stores above writes first-use defaults back (the NEW-content tracking baseline);
  // leave storage empty for the next test, whose own stores read their in-memory defaults.
  window.localStorage.clear()
})

// jsdom has no matchMedia implementation; components that read
// prefers-reduced-motion need a safe default so they don't throw in tests.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

// jsdom has no ResizeObserver either. The Dashboard reads its real content
// width through one, and antd's Select (and other rc-component popups) observe
// their popup size to position it. jsdom never computes real box sizes, so this
// no-op stub only needs to exist so mounting doesn't throw.
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
