import { render } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { OshiSettings } from "../../features/oshi/components/OshiSettings"
import { HOME_FILTER_SEGMENTED_TOKENS } from "../../shared/theme/homeFilterSegmentedTheme"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"
import { readStylesheet, ruleBody, rulesOf } from "../../test/readStylesheet"

// One visual system: every Settings tab (Display, 推送通知, 收藏名單, ...) paints Home's page surface and reads Home's --oshi-* tokens. These
// tests pin that on the real stylesheet, so a tab cannot quietly grow a palette of its own again.

async function sourceOf(relativeToDashboard: string): Promise<string> {
  const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":"))
  const { process } = globalThis as unknown as { process: { cwd(): string } }
  return String(fs.readFileSync(`${process.cwd()}/${relativeToDashboard}`, "utf8"))
}

describe("Settings: one page surface for every tab", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("the shared Settings content surface is Home's --oshi-bg, and no tab modifier repaints it with a palette of its own", () => {
    expect(ruleBody(css, ".settings-page__content")).toMatch(/background:\s*var\(--oshi-bg\)/)
    for (const modifier of ["main-oshi", "favorites", "notification"]) {
      const bodies = rulesOf(css)
        .filter(({ selector }) => selector.split(",").some((part) => part.trim() === `.settings-page__content--${modifier}`))
        .map(({ body }) => body)
        .join("\n")
      expect(bodies).not.toMatch(/background(-color)?\s*:\s*(#|rgb)/)
    }
  })
})

describe("推送通知 reads Home's tokens (the same system as 顯示設定)", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("its page variables are ALIASES of --oshi-* tokens -- no hex, no rgb", () => {
    const vars = ruleBody(css, ".notification-settings-page")
    const declarations = Array.from(vars.matchAll(/(--notification-[\w-]+):\s*([^;]+);/g))
    expect(declarations.length).toBeGreaterThanOrEqual(12)
    for (const [, name, value] of declarations) expect(`${name}: ${value}`).toMatch(/var\(--oshi-/)
    expect(vars).not.toMatch(/--notification-blue/)
  })

  it("no rule of the page keeps a literal color: every color is a token", () => {
    const rules = rulesOf(css).filter(({ selector }) => /^\.notification-(?!.*topic-creator)|\.settings-page__content--notification/.test(selector))
    expect(rules.length).toBeGreaterThan(30)
    for (const { selector, body } of rules) {
      const declarations = body
        .split(";")
        .map((declaration) => declaration.trim())
        .filter((declaration) => /^(color|background|background-color|border|border-color|border-top|border-bottom|border-left|border-right|outline)\s*:/.test(declaration))
      for (const declaration of declarations) expect(`${selector} { ${declaration} }`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    }
  })

  it("the page's antd theme uses Home tokens and no accent color token", async () => {
    const source = await sourceOf("src/features/notifications/components/NotificationSettings.tsx")
    const theme = source.slice(source.indexOf("<ConfigProvider"), source.indexOf("</ConfigProvider>") === -1 ? undefined : source.indexOf("</ConfigProvider>"))
    expect(theme).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(theme).not.toMatch(/colorPrimary/)
    expect(source).not.toContain("NOTIFICATION_ACCENT")
  })

  it("the Reset action no longer exists anywhere in the page's source, styles or strings", async () => {
    const source = await sourceOf("src/features/notifications/components/NotificationSettings.tsx")
    const translations = await sourceOf("src/shared/i18n/translations.ts")
    expect(source).not.toMatch(/onReset|resetTopicDefaults|resetButton|notification-reset-button/)
    expect(css).not.toContain("notification-reset-button")
    expect(translations).not.toMatch(/notificationSettings\.resetButton/)
  })
})

describe("收藏名單 reads Home's tokens", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
  })
  beforeEach(() => {
    localStorage.setItem("yobi.locale", "en")
    resetAllSharedStateForTests()
  })

  it("its palette variables are Home's tokens, and the normal creator names use Home's primary text", () => {
    const vars = ruleBody(css, ".settings-page__content--favorites")
    expect(vars).toMatch(/--roster-bg:\s*var\(--oshi-bg\)/)
    expect(vars).toMatch(/--roster-surface:\s*var\(--oshi-surface-2\)/)
    expect(vars).toMatch(/--roster-border:\s*var\(--oshi-border\)/)
    expect(vars).toMatch(/--roster-text-primary:\s*var\(--oshi-text-1\)/)
    expect(vars).toMatch(/--roster-text-secondary:\s*var\(--oshi-text-2\)/)
    expect(vars).toMatch(/--roster-text-tertiary:\s*var\(--oshi-text-3\)/)
    expect(ruleBody(css, ".favorites-roster__name")).toMatch(/color:\s*var\(--roster-text-primary\)/)
    expect(ruleBody(css, ".favorites-roster__region-title")).toMatch(/color:\s*var\(--roster-text-primary\)/)
    expect(ruleBody(css, ".favorites-roster__region-count")).toMatch(/color:\s*var\(--roster-text-tertiary\)/) // help / meta text stays secondary
  })

  it("ALL / 收藏 is Home's filter control: the shared Home tokens and look classes, not the Favorites palette or the notification skin", async () => {
    const { container } = render(
      <MemberThemeProvider>
        <OshiSettings />
      </MemberThemeProvider>,
    )

    const root = container.querySelector(".favorites-roster__segmented")!
    expect(root).toHaveClass("home-filter-segmented")
    expect(root).not.toHaveClass("shared-filter-segmented")
    expect(container.querySelector(".home-filter-segment-label")).not.toBeNull()
    const oshi = await sourceOf("src/features/oshi/components/OshiSettings.tsx")
    const dock = await sourceOf("src/features/live-status/components/LiveScheduleDock.tsx")
    expect(oshi).toContain("Segmented: HOME_FILTER_SEGMENTED_TOKENS")
    expect(oshi).toContain("antdTheme.defaultSeed.colorPrimary") // the focus ring is antd's own default primary, exactly like Live Status' selector
    expect(dock).toContain("Segmented: HOME_FILTER_SEGMENTED_TOKENS") // the same object as Live Status' own selector
    expect(oshi).not.toMatch(/roster-surface|theme\.primary,\s*\n\s*itemSelectedColor/)
    for (const value of Object.values(HOME_FILTER_SEGMENTED_TOKENS)) expect(String(value)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
