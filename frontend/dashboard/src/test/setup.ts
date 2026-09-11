import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"
import "@testing-library/jest-dom/vitest"
import { resetAllSharedStateForTests } from "../lib/sharedState"

// @testing-library/react's own auto-cleanup only self-registers when
// `afterEach` is a global (vitest's `test.globals: true`); this project
// deliberately keeps globals off and imports test functions explicitly, so
// cleanup must be wired up here instead — otherwise each test's render
// stays mounted and stacks on top of the next test's.
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  // lib/sharedState's stores are module-level singletons (needed so every
  // mounted component reacts to the same change immediately, not just
  // components that happen to remount) -- clearing localStorage alone
  // doesn't reset their in-memory value, so without this a favorite/Oshi
  // selection toggled in one test would still be set at the start of the
  // next one.
  resetAllSharedStateForTests()
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
