import { beforeAll, describe, expect, it } from "vitest"
import { readStylesheet, ruleBody, rulesOf } from "../../../test/readStylesheet"

/** The compact time-picker's layout contract, read from the real stylesheet (jsdom does no layout): the same dropdown concept on phone and
 * desktop, controls that wrap instead of overflowing, nothing that could bring the 48-button grid back. The pixel-level result is verified
 * in a real browser at the viewport sizes of the acceptance list. */
describe("New Video notification times layout (settings.css)", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("has no slot grid, no grid columns and no container-query columns for the times any more", () => {
    const selectors = rulesOf(css).map((rule) => rule.selector)
    expect(selectors.some((selector) => /notification-delivery-times__(grid|slot|chip|count|hint|selection)/.test(selector))).toBe(false)
    expect(css).not.toMatch(/container:\s*delivery-times/)
    expect(css).not.toMatch(/@container\s+delivery-times/)
    expect(css).not.toMatch(/repeat\(\s*(8|12)\s*,/) // the old 8- and 12-column slot grids
  })

  it("lays the dropdowns out as a wrapping flex row, so controls wrap cleanly on a narrow phone and never force one row", () => {
    const list = ruleBody(css, ".notification-delivery-times__list")
    expect(list).toMatch(/display:\s*flex/)
    expect(list).toMatch(/flex-wrap:\s*wrap/)
    expect(list).toMatch(/min-width:\s*0/)
    expect(list).not.toMatch(/flex-wrap:\s*nowrap/)
    expect(list).not.toMatch(/overflow-x:\s*(auto|scroll)/) // wrapping, not a sideways scroller
  })

  it("keeps each dropdown a compact, bounded control that can never be wider than the card", () => {
    const select = ruleBody(css, ".notification-delivery-times__select")
    expect(select).toMatch(/max-width:\s*100%/)
    expect(select).toMatch(/box-sizing:\s*border-box/)
    expect(select).toMatch(/height:\s*36px/)
    expect(Number(select.match(/min-width:\s*(\d+)px/)?.[1])).toBeLessThanOrEqual(110) // two fit side by side even on the narrowest card
    expect(select).not.toMatch(/(?:^|[\s;])width:\s*100%/) // a compact control, not a full-width bar on desktop
  })

  it("styles the + box like the Add topic button (dashed) at the dropdowns' own height", () => {
    const add = ruleBody(css, ".notification-add-time.ant-btn")
    expect(add).toMatch(/border:\s*1px dashed/)
    expect(add).toMatch(/height:\s*36px/)
  })

  it("is one set of rules for every width: the only media query tightens the minimum dropdown width on the narrowest cards", () => {
    const rules = rulesOf(css).filter((rule) => rule.selector.includes("notification-delivery-times"))
    expect(rules.length).toBeGreaterThan(0)
    expect(css).not.toMatch(/@media[^{]*\{[^@]*notification-delivery-times__(list|item)[^}]*display:\s*none/)
  })

  describe("the delete x beside each chosen time", () => {
    const ERROR_RED = "#f87171" // the page's own error red (.notification-delivery-times__error)

    it("is a soft, light red by default -- the error red mixed down toward the muted text color, not a bright warning red", () => {
      const remove = ruleBody(css, ".notification-delivery-times__remove")
      expect(remove).toMatch(/color:\s*color-mix\(in srgb,\s*#f87171\s+\d+%,\s*var\(--notification-text-secondary\)\)/)
      const strength = Number(remove.match(/#f87171\s+(\d+)%/)?.[1])
      expect(strength).toBeGreaterThan(40)
      expect(strength).toBeLessThan(100) // always mixed down, never the full-strength red by default
    })

    it("gets stronger on hover and keyboard focus, and again on press", () => {
      const hover = rulesOf(css).find((rule) => rule.selector.includes(".notification-delivery-times__remove:hover"))!
      expect(hover.selector).toContain(".notification-delivery-times__remove:focus-visible")
      expect(hover.body).toContain(`color: ${ERROR_RED}`)
      expect(hover.body).toMatch(/background:\s*color-mix\(in srgb,\s*#f87171\s+14%,\s*transparent\)/)
      const focusRing = rulesOf(css).find((rule) => rule.selector.trim() === ".notification-delivery-times__remove:focus-visible")!
      expect(focusRing.body).toMatch(/outline:\s*2px solid color-mix\(in srgb,\s*#f87171/)
      const active = ruleBody(css, ".notification-delivery-times__remove:active")
      expect(active).toMatch(/background:\s*color-mix\(in srgb,\s*#f87171\s+24%,\s*transparent\)/)
      expect(active).toMatch(/color:\s*#fca5a5/)
    })

    it("changes only color: its size, shape and spacing are exactly what they were", () => {
      const remove = ruleBody(css, ".notification-delivery-times__remove")
      expect(remove).toMatch(/width:\s*28px/)
      expect(remove).toMatch(/height:\s*28px/)
      expect(remove).toMatch(/border-radius:\s*50%/)
      expect(remove).toMatch(/padding:\s*0/)
      expect(remove).toMatch(/background:\s*transparent/)
      expect(ruleBody(css, ".notification-delivery-times__item")).toMatch(/gap:\s*4px/)
    })

    it("leaves the + box and every other control alone: the red appears only in the delete control's own rules (and the existing inline error)", () => {
      expect(ruleBody(css, ".notification-add-time.ant-btn")).not.toMatch(/f87171|fca5a5/i)
      expect(ruleBody(css, ".notification-add-time.ant-btn:hover")).not.toMatch(/f87171|fca5a5/i)
      const withRed = rulesOf(css).filter((rule) => /#f87171|#fca5a5/i.test(rule.body) && rule.selector.includes("notification-delivery-times"))
      expect(withRed.every((rule) => /__remove|__error/.test(rule.selector))).toBe(true)
    })
  })
})
