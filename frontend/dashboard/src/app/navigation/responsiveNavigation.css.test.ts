import { beforeAll, describe, expect, it } from "vitest"
import { readStylesheet, ruleBody } from "../../test/readStylesheet"

/** The text of every block `@media <query> { ... }` (balanced braces), concatenated. */
function mediaBlocks(css: string, query: string): string {
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from)
    if (start === -1) break
    const open = css.indexOf("{", start)
    let depth = 1
    let i = open + 1
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1
      else if (css[i] === "}") depth -= 1
      i += 1
    }
    out.push(css.slice(open + 1, i - 1))
    from = i
  }
  return out.join("\n")
}

/** Everything outside every @media block. */
function outsideMedia(css: string): string {
  let result = css
  for (;;) {
    const start = result.indexOf("@media")
    if (start === -1) return result
    const open = result.indexOf("{", start)
    let depth = 1
    let i = open + 1
    while (depth > 0 && i < result.length) {
      if (result[i] === "{") depth += 1
      else if (result[i] === "}") depth -= 1
      i += 1
    }
    result = result.slice(0, start) + result.slice(i)
  }
}

describe("Main Navbar breakpoints (main-navbar.css)", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/app/navigation/styles/main-navbar.css")
  })

  it("is a 56px icon-only rail by default (below 1440px) and the full 160px sidebar from 1440px", () => {
    expect(ruleBody(outsideMedia(css), ":root")).toMatch(/--main-navbar-width:\s*56px/)
    expect(ruleBody(mediaBlocks(css, "(min-width: 1440px)"), ":root")).toMatch(/--main-navbar-width:\s*160px/)
  })

  it("the rail and the content offset read the SAME width variable, so they can never disagree", () => {
    expect(ruleBody(css, ".app-shell__content")).toContain("margin-left: var(--main-navbar-width)")
    expect(ruleBody(css, ".main-navbar")).toContain("width: var(--main-navbar-width)")
  })

  it("hides the text labels only below 1440px (display: none, not just clipped); the full sidebar keeps them", () => {
    expect(ruleBody(mediaBlocks(css, "(max-width: 1439px)"), ".main-navbar__label")).toMatch(/display:\s*none/)
    expect(outsideMedia(css)).not.toMatch(/\.main-navbar__label\s*\{[^}]*display:\s*none/)
  })

  it("never introduces a bottom navigation (the nav stays a left-docked, full-height column)", () => {
    const nav = ruleBody(css, ".main-navbar")
    expect(nav).toMatch(/position:\s*fixed/)
    expect(nav).toMatch(/left:\s*0/)
    expect(nav).toMatch(/top:\s*0/)
    expect(css).not.toMatch(/bottom:\s*0/)
  })
})

describe("Settings navigation breakpoints (settings.css)", () => {
  let css = ""
  let below1440 = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
    below1440 = mediaBlocks(css, "(max-width: 1439px)")
  })

  it("below 1440px the secondary navigation is a fixed, full-height LEFT overlay drawer that sits above the rail and the page", () => {
    const drawer = ruleBody(below1440, ".settings-secondary-navbar")
    expect(drawer).toMatch(/position:\s*fixed/)
    expect(drawer).toMatch(/top:\s*0/)
    expect(drawer).toMatch(/left:\s*0/)
    expect(drawer).toMatch(/height:\s*100dvh/)
    expect(drawer).toMatch(/transform:\s*translateX\(-100%\)/)
    expect(drawer).toMatch(/visibility:\s*hidden/) // closed: not focusable, not read out
    expect(Number(drawer.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThan(10) // main navbar's z-index
    expect(drawer).toMatch(/width:\s*min\(var\(--settings-secondary-navbar-width\),\s*85vw\)/)
  })

  it("opening shows it without moving the page: the open state only changes transform/visibility, never width, margin or flow", () => {
    const open = ruleBody(below1440, ".settings-secondary-navbar--open")
    expect(open).toMatch(/transform:\s*none/)
    expect(open).toMatch(/visibility:\s*visible/)
    expect(open).not.toMatch(/margin|padding|width|position/)
  })

  it("the backdrop covers the whole viewport below the drawer; the menu bar, close button and backdrop exist only below 1440px", () => {
    const backdrop = ruleBody(below1440, ".settings-drawer-backdrop")
    expect(backdrop).toMatch(/position:\s*fixed/)
    expect(backdrop).toMatch(/inset:\s*0/)
    expect(Number(backdrop.match(/z-index:\s*(\d+)/)?.[1])).toBeLessThan(Number(ruleBody(below1440, ".settings-secondary-navbar").match(/z-index:\s*(\d+)/)?.[1]))
    for (const selector of [".settings-secondary-navbar__close", ".settings-drawer-backdrop", ".settings-page__menu-bar"]) {
      expect(ruleBody(outsideMedia(css), selector), selector).toMatch(/display:\s*none/)
    }
  })

  it("from 1440px the persistent second sidebar is unchanged: sticky, viewport-tall, 240px, in the normal flow", () => {
    expect(ruleBody(mediaBlocks(css, "(min-width: 1440px)"), ".settings-secondary-navbar")).toMatch(/position:\s*sticky/)
    const base = ruleBody(outsideMedia(css), ".settings-secondary-navbar")
    expect(base).toMatch(/flex:\s*0 0 var\(--settings-secondary-navbar-width\)/)
    expect(css).toMatch(/--settings-secondary-navbar-width:\s*240px/)
    // none of the old stacked-column rules for the secondary navigation survive
    expect(css).not.toMatch(/@media \(max-width: 900px\)\s*\{\s*\.settings-page\s*\{\s*flex-direction:\s*column/)
  })
})
