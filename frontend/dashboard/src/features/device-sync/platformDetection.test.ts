import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveDeviceSyncPlatform } from "./platformDetection"

function mockMatchMedia({ coarse }: { coarse: boolean }) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: query === "(pointer: coarse)" && coarse, media: query }) as MediaQueryList,
  )
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "standalone")
  vi.restoreAllMocks()
})

describe("resolveDeviceSyncPlatform", () => {
  it("resolves iOS/iPadOS Safari (navigator.standalone exists, false) to ios-safari", () => {
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true })
    mockMatchMedia({ coarse: true })

    expect(resolveDeviceSyncPlatform(false)).toBe("ios-safari")
  })

  it("resolves an installed iOS/iPadOS PWA (navigator.standalone exists, installed=true) to ios-pwa", () => {
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true })
    mockMatchMedia({ coarse: true })

    expect(resolveDeviceSyncPlatform(true)).toBe("ios-pwa")
  })

  it("resolves a touch-primary browser with no navigator.standalone (Android Chrome) to android-browser", () => {
    mockMatchMedia({ coarse: true })

    expect(resolveDeviceSyncPlatform(false)).toBe("android-browser")
  })

  it("resolves an installed touch-primary PWA to android-pwa", () => {
    mockMatchMedia({ coarse: true })

    expect(resolveDeviceSyncPlatform(true)).toBe("android-pwa")
  })

  it("resolves a non-touch, non-iOS browser (desktop) to pc", () => {
    mockMatchMedia({ coarse: false })

    expect(resolveDeviceSyncPlatform(false)).toBe("pc")
  })

  it("resolves pc even when a desktop browser has installed OshiYobi as a desktop app", () => {
    mockMatchMedia({ coarse: false })

    expect(resolveDeviceSyncPlatform(true)).toBe("pc")
  })

  it("iOS detection takes priority over the touch heuristic (iPadOS reports coarse pointer too)", () => {
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true })
    mockMatchMedia({ coarse: true })

    expect(resolveDeviceSyncPlatform(false)).toBe("ios-safari")
  })
})
