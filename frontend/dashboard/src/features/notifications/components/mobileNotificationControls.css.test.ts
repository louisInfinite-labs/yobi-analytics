import { beforeAll, describe, expect, it } from "vitest"
import { readStylesheet, ruleBody, rulesOf } from "../../../test/readStylesheet"

/** Regression contracts for two phone-only defects of the notification settings, read from the real stylesheet (jsdom does no layout or custom-property resolution);
 * the pixel results were verified in a real browser at 320 / 375 / 390 / 414 px (zh-TW and ja) and at 1366 / 1920 px. */
describe("mobile notification controls (settings.css)", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("the checkbox reads no drawer-scoped token without a global fallback, so it is drawn outside the member drawer too", () => {
    // The Simultaneous Livestream Notice renders this same checkbox in the notification panel, where the --drawer-* aliases (declared on .topic-creator-drawer only) do not
    // exist. A bare var(--drawer-*) made the whole `border` declaration invalid there: no border, transparent fill, an invisible unchecked box.
    const rules = rulesOf(css).filter((rule) => rule.selector.split(",").some((part) => part.trim().startsWith(".topic-creator-drawer__checkbox")))
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect({ selector: rule.selector, bare: rule.body.match(/var\(--drawer-[a-z-]+\)/g) ?? [] }).toEqual({ selector: rule.selector, bare: [] })
    }
  })

  it("the unchecked checkbox keeps a visible 2px border and a global-token color", () => {
    const input = ruleBody(css, ".topic-creator-drawer__checkbox-input")
    expect(input).toMatch(/border:\s*2px solid var\(--drawer-text-tertiary,\s*var\(--oshi-text-3\)\)/)
    expect(input).toMatch(/width:\s*22px/)
    expect(input).toMatch(/height:\s*22px/)
  })

  it("the checked fill resolves the same system highlight outside the drawer (the control declares its own dark color scheme)", () => {
    expect(ruleBody(css, ".topic-creator-drawer__checkbox-input")).toMatch(/color-scheme:\s*dark/)
    expect(ruleBody(css, ".topic-creator-drawer__checkbox-input:checked")).toMatch(/var\(--oshi-select-highlight\)/)
  })

  it("keeps a 44px touch target around the checkbox", () => {
    const label = ruleBody(css, ".topic-creator-drawer__checkbox")
    expect(label).toMatch(/min-width:\s*44px/)
    expect(label).toMatch(/min-height:\s*44px/)
  })

  describe("the member drawer's reminder-time select", () => {
    const selector = ".topic-creator-drawer__reminder-select-wrap > select"

    it("draws its own arrow with a fixed room for it, instead of the platform's arrow (about 16px on desktop, about 24px on Android and iOS)", () => {
      const select = ruleBody(css, selector)
      expect(select).toMatch(/appearance:\s*none/)
      expect(select).toMatch(/-webkit-appearance:\s*none/)
      expect(select).toMatch(/padding-right:\s*18px/)
      expect(select).toMatch(/background-image:\s*url\("data:image\/svg\+xml/)
      expect(select).toMatch(/background-repeat:\s*no-repeat/)
      expect(ruleBody(css, ".topic-creator-drawer__reminder-select")).toMatch(/width:\s*100%/) // still the full width of its column
    })

    it("every locale's column leaves at least 8px beyond its longest timing label once the select's own padding and arrow room are taken off", () => {
      // The longest label of each locale at the select's 10px / 600 type, measured in a real browser: zh-TW "10 分鐘前" 44px, ja "配信開始時" 50px, en "30 minutes before" 86px.
      const widestLabel = { "zh-TW": 44, ja: 50, en: 86 }
      const leftPadding = 6
      const arrowRoom = 18
      for (const [locale, widest] of Object.entries(widestLabel)) {
        const column = ruleBody(css, `.topic-creator-drawer__content[data-locale="${locale}"]`).match(/--drawer-reminder-col:\s*calc\((\d+)px/)
        expect(column, `a fixed ${locale} reminder column`).not.toBeNull()
        expect(Number(column![1]) - leftPadding - arrowRoom - widest, `${locale} slack`).toBeGreaterThanOrEqual(8)
      }
    })

    it("keeps the prompt overlay clear of the arrow room", () => {
      expect(ruleBody(css, ".topic-creator-drawer__reminder-select-prompt")).toMatch(/right:\s*20px/)
    })
  })
})
