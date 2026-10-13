import { beforeAll, describe, expect, it } from "vitest"
import { mediaBlocks, outsideMedia, readStylesheet, ruleBody } from "../../test/readStylesheet"

const zIndex = (body: string) => Number(body.match(/z-index:\s*(\d+)/)?.[1])

describe("Phone navigation (main-navbar.css, below 768px)", () => {
  let css = ""
  let phone = ""
  beforeAll(async () => {
    css = await readStylesheet("src/app/navigation/styles/main-navbar.css")
    phone = mediaBlocks(css, "(max-width: 767px)")
  })

  it("reserves NOTHING on the left: no rail, no sidebar width, content offset 0", () => {
    expect(ruleBody(phone, ":root")).toMatch(/--main-navbar-width:\s*0px/)
  })

  it("the first row is a full-width top bar, sticky, only as tall as the hamburger needs", () => {
    const bar = ruleBody(phone, ".main-topbar")
    expect(bar).toMatch(/display:\s*flex/)
    expect(bar).toMatch(/position:\s*sticky/)
    expect(bar).toMatch(/width:\s*100%/)
    expect(bar).toMatch(/top:\s*0/)
    expect(ruleBody(phone, ":root")).toMatch(/--main-topbar-height:\s*48px/)
    expect(ruleBody(phone, ".main-topbar__menu")).toMatch(/width:\s*44px[\s\S]*height:\s*44px/) // a 44px touch target
  })

  it("the hamburger has a visible focus state", () => {
    expect(ruleBody(phone, ".main-topbar__menu:focus-visible")).toMatch(/outline:\s*2px solid/)
  })

  it("the navigation is a fixed left overlay drawer, hidden (not focusable) until opened, shown without moving the page", () => {
    const drawer = ruleBody(phone, ".main-navbar")
    expect(drawer).toMatch(/transform:\s*translateX\(-100%\)/)
    expect(drawer).toMatch(/visibility:\s*hidden/)
    expect(ruleBody(outsideMedia(css), ".main-navbar")).toMatch(/position:\s*fixed/)
    const open = ruleBody(phone, ".main-navbar--open")
    expect(open).toMatch(/transform:\s*none/)
    expect(open).toMatch(/visibility:\s*visible/)
    expect(open).not.toMatch(/margin|padding|width|position/)
  })

  it("the drawer shows the labels again, and its backdrop sits just below it", () => {
    expect(ruleBody(phone, ".main-navbar__label")).toMatch(/display:\s*block/)
    const backdrop = ruleBody(phone, ".main-navbar-backdrop")
    expect(backdrop).toMatch(/position:\s*fixed/)
    expect(backdrop).toMatch(/inset:\s*0/)
    expect(zIndex(backdrop)).toBeLessThan(zIndex(ruleBody(phone, ".main-navbar")))
  })

  it("the phone-only pieces (top bar, backdrop, close button) are hidden from 768px up; tablets keep the 56px rail, desktops the 160px sidebar", () => {
    for (const selector of [".main-topbar", ".main-navbar-backdrop", ".main-navbar__close"]) {
      expect(ruleBody(outsideMedia(css), selector), selector).toMatch(/display:\s*none/)
    }
    expect(ruleBody(outsideMedia(css), ":root")).toMatch(/--main-navbar-width:\s*56px/)
    expect(ruleBody(mediaBlocks(css, "(min-width: 1440px)"), ":root")).toMatch(/--main-navbar-width:\s*160px/)
  })

  it("the main drawer (960) and the Settings secondary drawer (950) are separate layers: the main one is above, the top bar is below both", () => {
    expect(zIndex(ruleBody(phone, ".main-navbar"))).toBe(960)
    expect(zIndex(ruleBody(phone, ".main-topbar"))).toBeLessThan(940)
  })

  it("never introduces a bottom navigation", () => {
    expect(css).not.toMatch(/bottom:\s*0/)
  })
})

describe("Home on narrow screens (home.css, below 1024px)", () => {
  let css = ""
  let narrow = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/home/styles/home.css")
    narrow = mediaBlocks(css, "(max-width: 1023px)")
  })

  it("is one scrolling column, in this order: player, Oshi Status, Oshi Videos", () => {
    expect(ruleBody(narrow, ".oshi-home__canvas")).toMatch(/display:\s*flex[\s\S]*flex-direction:\s*column/)
    expect(ruleBody(narrow, ".oshi-home")).toMatch(/height:\s*auto/)
    expect(ruleBody(narrow, ".oshi-home")).toMatch(/overflow:\s*visible/)
    expect(ruleBody(narrow, ".oshi-stream")).toMatch(/order:\s*1/)
    expect(ruleBody(narrow, ".oshi-status")).toMatch(/order:\s*2/)
    expect(ruleBody(narrow, ".oshi-videos")).toMatch(/order:\s*3/)
  })

  it("the player box is the full available width and always a 16:9 box that does not depend on the iframe (never collapses)", () => {
    const ratio = ruleBody(narrow, ".oshi-player-frame__ratio")
    expect(ratio).toMatch(/width:\s*100%/)
    expect(ratio).toMatch(/aspect-ratio:\s*16\s*\/\s*9/)
    expect(ratio).not.toMatch(/\bheight:\s*0/)
    expect(ruleBody(narrow, ".oshi-player-frame")).toMatch(/padding:\s*0/)
    expect(ruleBody(narrow, ".oshi-player-frame__stage")).toMatch(/container-type:\s*normal/) // the desktop height-bound sizing is off
  })

  it("the desktop 2x2 grid is unchanged from 1024px up", () => {
    expect(ruleBody(outsideMedia(css), ".oshi-home__canvas")).toMatch(/display:\s*grid/)
    expect(ruleBody(outsideMedia(css), ".oshi-home")).toMatch(/height:\s*100dvh/)
  })
})
