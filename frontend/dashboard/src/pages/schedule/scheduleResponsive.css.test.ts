import { beforeAll, describe, expect, it } from "vitest"
import { AVATAR_GAP_PX, DEFAULT_AVATAR_SIZE_PX, MORE_CHIP_MIN_WIDTH_PX } from "../../features/live-schedule/model/scheduleAvatarOverflow"
import { mediaBlocks, outsideMedia, readStylesheet, rulesOf } from "../../test/readStylesheet"

const px = (body: string, property: string) => Number(body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+(?:\\.\\d+)?)px`))?.[1])
const zIndex = (body: string) => Number(body.match(/z-index:\s*(\d+)/)?.[1])

describe("Schedule responsive stylesheet (schedule.css)", () => {
  let css = ""
  let phone = ""
  let desktop = ""
  const declared = (source: string, selector: string) =>
    rulesOf(source)
      .filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector))
      .map((rule) => rule.body)
      .join("\n")

  beforeAll(async () => {
    css = await readStylesheet("src/pages/schedule/styles/schedule.css")
    phone = mediaBlocks(css, "(max-width: 767px)")
    desktop = outsideMedia(css)
  })

  it("the avatar numbers the +N calculation uses are the ones the stylesheet draws", async () => {
    expect(px(declared(desktop, ".stream-avatar-group"), "gap")).toBe(AVATAR_GAP_PX)
    expect(px(declared(desktop, ".more-streams"), "min-width")).toBe(MORE_CHIP_MIN_WIDTH_PX)
    const avatarCss = await readStylesheet("src/shared/styles/creatorAvatar.css")
    expect(px(avatarCss, "--creator-avatar-size")).toBe(DEFAULT_AVATAR_SIZE_PX)
  })

  it("tablet and desktop keep the multi-day grid: a time column plus seven day columns", () => {
    expect(declared(desktop, ".schedule-grid")).toMatch(/grid-template-columns:\s*var\(--schedule-time-column-width\)\s+repeat\(7,\s*minmax\(0,\s*1fr\)\)/)
    expect(declared(desktop, ":root")).toMatch(/--schedule-time-column-width:\s*98px/)
    expect(declared(desktop, ".schedule-day-header")).not.toMatch(/display:\s*none/)
    expect(declared(desktop, ".time-header")).not.toMatch(/display:\s*none/)
  })

  it("below 768px the grid is the time column and ONE day column (never seven squeezed ones)", () => {
    const grid = declared(phone, ".schedule-grid")
    expect(grid).toMatch(/grid-template-columns:\s*var\(--schedule-time-column-width\)\s+minmax\(0,\s*1fr\)/)
    expect(grid).not.toMatch(/repeat\(7/)
    expect(declared(phone, ":root")).toMatch(/--schedule-time-column-width:\s*52px/)
  })

  it("on a phone both header cells go (the date navigator names the day), so the time rows and the day rows stay aligned", () => {
    expect(declared(phone, ".time-header")).toMatch(/display:\s*none/)
    expect(declared(phone, ".schedule-day-header")).toMatch(/display:\s*none/)
  })

  it("the date navigator is pinned directly under the phone top bar, below the top bar and the +N popover", async () => {
    const nav = declared(css, ".schedule-day-nav")
    expect(nav).toMatch(/position:\s*sticky/)
    expect(nav).toMatch(/top:\s*var\(--main-topbar-height,\s*0px\)/)
    const navbarCss = await readStylesheet("src/app/navigation/styles/main-navbar.css")
    expect(zIndex(nav)).toBeLessThan(zIndex(declared(mediaBlocks(navbarCss, "(max-width: 767px)"), ".main-topbar")))
    expect(zIndex(nav)).toBeLessThan(zIndex(declared(css, ".hidden-streams-popover")))
  })

  it("the date arrows are real 44px touch targets with a visible focus state, and a disabled arrow reads as disabled", () => {
    const arrow = declared(css, ".schedule-day-nav__arrow")
    expect(px(arrow, "width")).toBeGreaterThanOrEqual(44)
    expect(px(arrow, "height")).toBeGreaterThanOrEqual(44)
    expect(declared(css, ".schedule-day-nav__arrow:focus-visible")).toMatch(/outline:\s*2px solid/)
    expect(declared(css, ".schedule-day-nav__arrow:disabled")).toMatch(/cursor:\s*not-allowed/)
  })

  it("introduces no horizontal page overflow on a phone: the page keeps its 100% width and the day column may shrink", () => {
    expect(declared(desktop, ".schedule-page")).toMatch(/width:\s*100%/)
    expect(declared(phone, ".schedule-grid")).toMatch(/minmax\(0,\s*1fr\)/)
  })
})
