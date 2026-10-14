import { beforeAll, describe, expect, it } from "vitest"
import { mediaBlocks, readStylesheet, ruleBody, rulesOf } from "../../../test/readStylesheet"

/** The Notification Members drawer draws its organization headings with Live Status' own shared markup (LiveStatusGroups) and the shared
 * .live-status-group__heading rule (home.css). They looked broken -- an avatar peeking over "HOLOLIVE // JP", the band inset -- because the
 * drawer's SCROLLER carried padding: a sticky heading pins to the scroller's top edge, so 24px of padding left a gap above it that rows scrolled
 * through. These tests pin the cause (a padding-free scroller, gutter on the content) and the reuse (the drawer redefines none of the band's own
 * rules). The pixel result is compared against Live Status in a real browser at five viewports. */
describe("Notification Members drawer: organization headings follow Live Status", () => {
  let home = ""
  let settings = ""
  beforeAll(async () => {
    home = await readStylesheet("src/pages/home/styles/home.css")
    settings = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("the reference: Live Status' heading is a flush, sticky, 28px band inside a scroller with no padding", () => {
    const heading = ruleBody(home, ".live-status-group__heading")
    expect(heading).toMatch(/position:\s*sticky/)
    expect(heading).toMatch(/top:\s*0/)
    expect(heading).toMatch(/height:\s*28px/)
    expect(heading).toMatch(/background:\s*#0d1825/)
    expect(ruleBody(home, ".live-status-drawer__body")).not.toMatch(/padding/)
  })

  it("the drawer's scroller (.ant-drawer-body) has NO padding, on desktop or on a phone -- the cause of the gap above the sticky band", () => {
    const scrollerRules = rulesOf(settings).filter((rule) => rule.selector.split(",").some((part) => part.trim() === ".topic-creator-drawer .ant-drawer-body"))
    expect(scrollerRules.length).toBeGreaterThan(0)
    const withPadding = scrollerRules.filter((rule) => /(^|[\s;])padding(?!-)[^:]*:/.test(rule.body) && !/padding:\s*0\s*;/.test(rule.body))
    expect(withPadding).toEqual([])
    const phone = mediaBlocks(settings, "(max-width: 560px)")
    expect(phone).not.toMatch(/\.topic-creator-drawer\s+\.ant-drawer-body\s*\{[^}]*padding/)
  })

  it("the side gutter moves onto the content (a variable, tighter on a phone), so it can never hold a sticky band away from the edge", () => {
    expect(ruleBody(settings, ".topic-creator-drawer")).toMatch(/--drawer-gutter:\s*var\(--space-5\)/)
    expect(mediaBlocks(settings, "(max-width: 560px)")).toMatch(/--drawer-gutter:\s*var\(--space-3\)/)
    expect(ruleBody(settings, ".topic-creator-drawer__content")).toMatch(/padding:\s*var\(--drawer-gutter\)\s+0/)
    expect(settings).toMatch(/margin-inline:\s*var\(--drawer-gutter\)/)
  })

  it("reuses the shared band: the drawer only sets the band's inline padding and never redefines its position, height, colors or font", () => {
    const own = rulesOf(settings).filter((rule) => /\.live-status-group__(heading|subheading)/.test(rule.selector) && rule.selector.includes(".topic-creator-drawer "))
    expect(own.length).toBeGreaterThan(0)
    for (const rule of own) {
      const declared = [...rule.body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1])
      expect(declared).toEqual(["padding-inline"])
    }
    // The favorites heading (the same band) only resets the h3's default margin.
    expect(ruleBody(settings, ".topic-creator-drawer__favorites-heading").replace(/\s+/g, "")).toBe("margin:0;")
  })

  it("puts the label over the rows' avatar column the way Live Status does (gutter + the row's own inline padding)", () => {
    expect(ruleBody(settings, ".topic-creator-drawer .live-status-group__heading")).toMatch(/padding-inline:\s*calc\(var\(--drawer-gutter\)\s*\+\s*var\(--space-2\)\)/)
    const rowRules = rulesOf(settings).filter((rule) => rule.selector.split(",").some((part) => part.trim() === ".topic-creator-drawer__row"))
    expect(rowRules.some((rule) => /padding:\s*7px\s+var\(--space-2\)/.test(rule.body))).toBe(true)
  })

  it("keeps a long organization name inside the fixed band: the label is cut with an ellipsis (shared rule, so Live Status benefits too)", () => {
    const label = ruleBody(home, ".live-status-group__heading > span:first-child")
    expect(label).toMatch(/min-width:\s*0/)
    expect(label).toMatch(/overflow:\s*hidden/)
    expect(label).toMatch(/text-overflow:\s*ellipsis/)
    expect(label).toMatch(/white-space:\s*nowrap/)
  })

  it("the search box fills the space between the gutters instead of overflowing by the margins (Home's .live-status-search is width: 100%)", () => {
    expect(ruleBody(settings, ".topic-creator-drawer .topic-creator-drawer__search")).toMatch(/width:\s*auto/)
  })
})
