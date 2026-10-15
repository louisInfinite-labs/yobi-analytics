/** Live Status must fill the viewport it is meant to fill at every size, and the resize control exists only where it should.
 *  - Phone (below 768px, portrait or landscape): ALWAYS a true full-viewport sheet, with NO resize control at all (no icon, no button, no gap
 *    left where it was); the close button stays; the page behind it is locked; safe-area insets are inner padding.
 *  - Tablet (768-1023px): keeps the resize control; "full" is the same full-viewport sheet (page locked), "compact" the small bottom-right panel.
 *  - Desktop (1024px and up): the side panel (flush to the right edge) with its resize control, unchanged.
 * jsdom has no layout, so the geometry is pinned against the real stylesheet and the behavior through the component; the rendered result is
 * measured separately in a real browser build. */
import { act, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveScheduleDock } from "./LiveScheduleDock"
import * as useCurrentPageModule from "../../../app/navigation/useCurrentPage"
import * as useCreatorStatusesModule from "../hooks/useCreatorStatuses"
import { mediaBlocks, outsideMedia, readStylesheet, ruleBody } from "../../../test/readStylesheet"

vi.mock("../../../app/navigation/useCurrentPage")
vi.mock("../hooks/useCreatorStatuses", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useCreatorStatuses")>("../hooks/useCreatorStatuses")
  return { ...actual, useCreatorStatuses: vi.fn() }
})

const HOME_CSS = "src/pages/home/styles/home.css"
const now = new Date("2026-09-10T12:00:00+09:00")

function setViewport(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
    window.dispatchEvent(new Event("resize"))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useCurrentPageModule.useCurrentPage).mockReturnValue(["home", vi.fn()])
  vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses: {}, now })
  document.documentElement.style.overflow = ""
  document.body.style.overflow = ""
})

afterEach(() => {
  setViewport(1024)
})

const trigger = () => document.querySelector<HTMLButtonElement>(".live-status-trigger")!
const drawer = () => document.querySelector<HTMLElement>(".live-status-drawer")!
const resizeButton = () => document.querySelector<HTMLElement>(".live-status-drawer__resize")
const closeButton = () => document.querySelector<HTMLElement>(".live-status-drawer__close")!
const isOpen = () => document.querySelector(".live-status-dock")?.getAttribute("data-live-status-open") === "true"

type Layout = "phone" | "tablet" | "desktop"
/** The viewports the task names, with the breakpoint each one belongs to. */
const SIZES: [string, number, number, Layout][] = [
  ["iPhone portrait", 390, 844, "phone"],
  ["iPhone 15 Pro", 393, 852, "phone"],
  ["iPhone Pro Max", 430, 932, "phone"],
  ["iPhone 16 Pro Max", 440, 956, "phone"],
  ["small Android portrait", 360, 800, "phone"],
  ["phone landscape 767", 767, 360, "phone"],
  ["iPad portrait", 768, 1024, "tablet"],
  ["iPad landscape below 1024", 1023, 768, "tablet"],
  ["desktop 1024", 1024, 768, "desktop"],
  ["desktop 1280", 1280, 720, "desktop"],
  ["desktop 1440", 1440, 900, "desktop"],
  ["desktop 1920", 1920, 1080, "desktop"],
]

describe.each(SIZES)("%s (%ipx wide)", (_name, width, _height, layout) => {
  it(layout === "phone" ? "has NO resize control (icon and button gone) and is always the full sheet; the close button stays" : "keeps its resize control and opens full", async () => {
    setViewport(width)
    render(<LiveScheduleDock />)
    await userEvent.setup().click(trigger())

    expect(isOpen()).toBe(true)
    expect(drawer().getAttribute("data-size")).toBe("full")
    if (layout === "phone") {
      expect(resizeButton()).toBeNull()
      expect(drawer().textContent).not.toMatch(/[⤡⤢]/) // not even the glyph is left behind
    } else {
      expect(resizeButton()).not.toBeNull()
    }
    expect(closeButton()).not.toBeNull()
  })

  it(layout === "desktop" ? "does not touch the page's own scrolling" : "locks the page behind the full sheet while open and gives it back on close", async () => {
    setViewport(width)
    const user = userEvent.setup()
    render(<LiveScheduleDock />)

    await user.click(trigger())
    const lockedWhileOpen = document.documentElement.style.overflow
    expect(document.body.style.overflow).toBe("") // <body> is never touched: html AND body together would reset the page's scroll position
    await user.click(closeButton())

    expect(lockedWhileOpen).toBe(layout === "desktop" ? "" : "hidden")
    expect(document.documentElement.style.overflow).toBe("")
  })
})

describe("the size control", () => {
  it("on desktop it switches between full and compact", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await user.click(trigger())

    await user.click(resizeButton()!)
    expect(drawer().getAttribute("data-size")).toBe("compact")
    await user.click(resizeButton()!)
    expect(drawer().getAttribute("data-size")).toBe("full")
  })

  it("on a tablet it still switches too: compact is the small panel (page not locked), full the sheet (page locked)", async () => {
    setViewport(768)
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await user.click(trigger())
    expect(document.documentElement.style.overflow).toBe("hidden")

    await user.click(resizeButton()!)
    expect(drawer().getAttribute("data-size")).toBe("compact")
    expect(document.documentElement.style.overflow).toBe("") // a small panel is not a full-screen overlay

    await user.click(resizeButton()!)
    expect(drawer().getAttribute("data-size")).toBe("full")
    expect(document.documentElement.style.overflow).toBe("hidden")
  })

  it("a compact tablet panel that is then narrowed to a phone becomes the full sheet, and its resize control goes", async () => {
    setViewport(900)
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await user.click(trigger())
    await user.click(resizeButton()!)
    expect(drawer().getAttribute("data-size")).toBe("compact")

    setViewport(600)

    expect(drawer().getAttribute("data-size")).toBe("full")
    expect(resizeButton()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("hidden")
  })

  it("rotating a phone from portrait to landscape keeps it a full sheet with the page locked and still no resize control", async () => {
    setViewport(390)
    render(<LiveScheduleDock />)
    await userEvent.setup().click(trigger())

    setViewport(767)

    expect(drawer().getAttribute("data-size")).toBe("full")
    expect(resizeButton()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("hidden")
  })

  it("the header does not keep an empty gap where the control was: the title row holds only the title and the close button on a phone", async () => {
    setViewport(390)
    render(<LiveScheduleDock />)
    await userEvent.setup().click(trigger())

    const row = document.querySelector<HTMLElement>(".live-status-drawer__title-row")!
    expect(Array.from(row.children).map((child) => child.className)).toEqual(["live-status-drawer__title", "live-status-drawer__close"])
  })
})

describe("the page's own overflow is restored exactly", () => {
  it("whatever inline overflow the page had before the sheet opened is what it has after", async () => {
    document.documentElement.style.overflow = "scroll"
    document.body.style.overflow = "auto"
    setViewport(390)
    const user = userEvent.setup()
    render(<LiveScheduleDock />)

    await user.click(trigger())
    await user.click(closeButton())

    expect([document.documentElement.style.overflow, document.body.style.overflow]).toEqual(["scroll", "auto"]) // both given back as they were
  })

  it("unmounting while open (a route change) releases the lock", async () => {
    setViewport(390)
    const { unmount } = render(<LiveScheduleDock />)
    await userEvent.setup().click(trigger())
    expect(document.documentElement.style.overflow).toBe("hidden")

    unmount()

    expect(document.documentElement.style.overflow).toBe("")
  })
})

describe("the stylesheet: what fills the viewport", () => {
  it("below 1024px the FULL drawer covers the whole viewport: all four edges, full width, dynamic viewport height, no gap, no radius", async () => {
    const css = await readStylesheet(HOME_CSS)
    const body = ruleBody(mediaBlocks(css, "(max-width: 1023px)"), '.live-status-drawer[data-size="full"]')

    expect(body).toMatch(/top:\s*0\s*;/)
    expect(body).toMatch(/right:\s*0\s*;/)
    expect(body).toMatch(/left:\s*0\s*;/)
    expect(body).toMatch(/width:\s*100%\s*;/)
    expect(body).toMatch(/height:\s*100vh\s*;[\s\S]*height:\s*100dvh\s*;/) // the vh fallback first, then the dynamic unit
    expect(body).toMatch(/border-radius:\s*0\s*;/)
    expect(body).not.toContain("--home-gap") // the 16px right offset that exposed a strip of the page
    expect(body).not.toMatch(/env\(safe-area/) // safe areas are inner padding, never outer spacing
  })

  it("only the full size is the sheet: a tablet's compact size keeps the small panel geometry", async () => {
    const block = mediaBlocks(await readStylesheet(HOME_CSS), "(max-width: 1023px)")

    expect(block).not.toContain('[data-size="compact"]') // nothing in the narrow-screen block turns compact into a sheet
    const compact = ruleBody(outsideMedia(await readStylesheet(HOME_CSS)), '.live-status-drawer[data-size="compact"]')
    expect(compact).toMatch(/top:\s*auto/)
    expect(compact).toMatch(/height:\s*min\(70vh,\s*520px\)/)
  })

  it("the safe-area insets are padding INSIDE the sheet (header and list)", async () => {
    const block = mediaBlocks(await readStylesheet(HOME_CSS), "(max-width: 1023px)")
    const header = ruleBody(block, '.live-status-drawer[data-size="full"] .live-status-drawer__header')
    const list = ruleBody(block, '.live-status-drawer[data-size="full"] .live-status-drawer__body')

    expect(header).toMatch(/padding-top:\s*max\(12px,\s*env\(safe-area-inset-top\)\)/)
    expect(header).toMatch(/padding-left:\s*max\(12px,\s*env\(safe-area-inset-left\)\)/)
    expect(header).toMatch(/padding-right:\s*max\(12px,\s*env\(safe-area-inset-right\)\)/)
    expect(list).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom\)/)
    expect(list).toMatch(/overscroll-behavior:\s*contain/) // the list scrolls inside the sheet and never chains to the page
  })

  it("the closed sheet is fully off-screen and the open one fully on it", async () => {
    const css = await readStylesheet(HOME_CSS)

    expect(ruleBody(mediaBlocks(css, "(max-width: 1023px)"), '.live-status-drawer[data-size="full"]')).toMatch(/transform:\s*translateX\(100%\)/)
    expect(ruleBody(css, '.live-status-dock[data-live-status-open="true"] .live-status-drawer')).toMatch(/transform:\s*translateX\(0\)/)
  })

  it("the old 640px-only full-width rule is gone: no width at which the drawer is 100vw yet offset by the page gutter", async () => {
    const css = await readStylesheet(HOME_CSS)

    expect(css).not.toMatch(/--live-status-width:\s*100vw/)
    expect(mediaBlocks(css, "(max-width: 640px)")).not.toContain("live-status")
  })

  it("on desktop the side panel is flush to the right edge and as tall as the viewport (no top, bottom or right gap)", async () => {
    const base = ruleBody(outsideMedia(await readStylesheet(HOME_CSS)), ".live-status-drawer")

    expect(base).toMatch(/top:\s*0\s*;/)
    expect(base).toMatch(/bottom:\s*0\s*;/)
    expect(base).toMatch(/right:\s*0\s*;/)
    expect(base).not.toMatch(/right:\s*var\(--home-gap\)/)
    expect(base).toMatch(/width:\s*calc\(var\(--live-status-width\)\s*\+\s*var\(--home-gap\)\)/) // left edge still aligned with the Oshi Status column
    expect(base).toMatch(/transform:\s*translateX\(100%\)/)
  })

  it("the closed trigger keeps clear of a notch / home indicator", async () => {
    const trigger = ruleBody(await readStylesheet(HOME_CSS), ".live-status-trigger")

    expect(trigger).toMatch(/right:\s*max\(14px,\s*env\(safe-area-inset-right\)\)/)
    expect(trigger).toMatch(/bottom:\s*max\(14px,\s*env\(safe-area-inset-bottom\)\)/)
  })
})
