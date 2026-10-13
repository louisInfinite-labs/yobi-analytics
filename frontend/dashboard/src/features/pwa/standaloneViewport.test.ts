import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyDisplayMode, resetStandaloneViewportForTests, startStandaloneViewport, STANDALONE_VIEWPORT } from "./standaloneViewport"
import { readStylesheet, rulesOf } from "../../test/readStylesheet"

const BROWSER_VIEWPORT = "width=device-width, initial-scale=1.0"

function setStandalone(on: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: on && query === "(display-mode: standalone)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  document.head.innerHTML = `<meta name="viewport" content="${BROWSER_VIEWPORT}">`
  document.documentElement.removeAttribute("data-display-mode")
  resetStandaloneViewportForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, "standalone")
})

const viewport = () => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content

describe("viewport in a normal browser tab", () => {
  it("is left exactly as index.html declared it: zoom and accessibility scaling stay available", () => {
    setStandalone(false)

    applyDisplayMode()

    expect(viewport()).toBe(BROWSER_VIEWPORT)
    expect(viewport()).not.toMatch(/maximum-scale|user-scalable/)
    expect(document.documentElement.getAttribute("data-display-mode")).toBe("browser")
  })
})

describe("viewport in the installed (standalone) app", () => {
  it("locks scale: initial-scale=1, maximum-scale=1, user-scalable=no", () => {
    setStandalone(true)

    applyDisplayMode()

    expect(viewport()).toBe(STANDALONE_VIEWPORT)
    expect(viewport()).toMatch(/initial-scale=1,/)
    expect(viewport()).toMatch(/maximum-scale=1/)
    expect(viewport()).toMatch(/user-scalable=no/)
    expect(document.documentElement.getAttribute("data-display-mode")).toBe("standalone")
  })

  it("detects iOS Home Screen mode through navigator.standalone when the display-mode media query is not available", () => {
    setStandalone(false)
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true })

    applyDisplayMode()

    expect(viewport()).toBe(STANDALONE_VIEWPORT)
  })

  it("restores the original viewport (not a hardcoded one) if the display mode goes back to a browser, and is idempotent", () => {
    setStandalone(true)
    applyDisplayMode()
    applyDisplayMode()
    setStandalone(false)

    applyDisplayMode()

    expect(viewport()).toBe(BROWSER_VIEWPORT)
    expect(document.querySelector('meta[name="viewport"]')!.hasAttribute("data-original-content")).toBe(false)
  })
})

describe("pinch gesture guard (WebKit gesture events)", () => {
  it("cancels gesturestart in the installed app only", () => {
    setStandalone(true)
    startStandaloneViewport()
    const event = new Event("gesturestart", { cancelable: true })

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it("never cancels it in a browser tab", () => {
    setStandalone(false)
    startStandaloneViewport()
    const event = new Event("gesturestart", { cancelable: true })

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it("starting twice does not register the guard twice", () => {
    setStandalone(true)
    const add = vi.spyOn(document, "addEventListener")

    startStandaloneViewport()
    startStandaloneViewport()

    expect(add.mock.calls.filter(([type]) => type === "gesturestart")).toHaveLength(1)
  })
})

describe("standalone.css", () => {
  it('every rule is scoped to html[data-display-mode="standalone"], so nothing can leak into a browser tab', async () => {
    const css = await readStylesheet("src/features/pwa/styles/standalone.css")

    const selectors = rulesOf(css).flatMap((rule) => rule.selector.split(",").map((part) => part.trim()))
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector, selector).toMatch(/^html\[data-display-mode="standalone"\]/)
  })

  it("blocks pinch / double-tap zoom with touch-action while keeping one-finger scrolling (pan-x pan-y)", async () => {
    const css = await readStylesheet("src/features/pwa/styles/standalone.css")

    expect(css).toMatch(/html\[data-display-mode="standalone"\]\s*\{\s*touch-action:\s*pan-x pan-y;/)
    expect(css).toMatch(/touch-action:\s*manipulation/)
  })

  it("form controls get a 16px font (iOS focus auto-zoom threshold) on touch devices only, without touching other typography", async () => {
    const css = await readStylesheet("src/features/pwa/styles/standalone.css")
    const media = css.slice(css.indexOf("@media (pointer: coarse)"))

    expect(media).toMatch(/\binput:not\(/)
    expect(media).toMatch(/\bselect\b/)
    expect(media).toMatch(/\btextarea\b/)
    expect(media).toMatch(/font-size:\s*16px/)
    expect(css.match(/font-size/g)).toHaveLength(1) // that one rule is the only typography change
  })
})
