import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DisplaySettings } from "./DisplaySettings"
import { SettingsPage } from "./SettingsPage"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { readStylesheet, rulesOf, ruleBody } from "../../test/readStylesheet"

const TIME_FORMAT_KEY = "yobi.timeFormat"
const MODE_KEY = "yobi.upcomingDisplayMode"
const COUNTDOWN_LANGUAGE_KEY = "yobi.countdownLanguage"

/** Picks the option with the given text in Home's native select, found by its accessible name. */
async function choose(user: ReturnType<typeof userEvent.setup>, selectName: string, optionText: string) {
  await user.selectOptions(screen.getByRole("combobox", { name: selectName }), optionText)
}

/** The displayed option text of a native select found by its accessible name. */
function selectedValue(selectName: string): string | null {
  const select = screen.getByRole("combobox", { name: selectName }) as HTMLSelectElement
  return select.selectedOptions[0]?.textContent ?? null
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("DisplaySettings", () => {
  it("renders the page heading, description, and exactly the two time-related setting rows -- no Appearance/Theme row", () => {
    render(<DisplaySettings />)

    expect(screen.getByRole("heading", { level: 1, name: "Display" })).toBeInTheDocument()
    expect(screen.getByText("Choose how time information is shown in the app.")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Time format" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Upcoming streams" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Appearance" })).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Dashboard theme" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("combobox")).toHaveLength(2)
  })

  it("defaults to 24-hour time format and persists a 12-hour selection", async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)

    expect(selectedValue("Time format")).toBe("24-hour (HH:mm)")
    expect(localStorage.getItem(TIME_FORMAT_KEY)).toBeNull()

    await choose(user, "Time format", "12-hour (AM/PM)")

    expect(localStorage.getItem(TIME_FORMAT_KEY)).toBe("12h")
    expect(selectedValue("Time format")).toBe("12-hour (AM/PM)")
  })

  it("defaults to HH:mm upcoming display and persists a Countdown selection, with no separate countdown-language control ever rendered", async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)

    expect(selectedValue("Upcoming streams")).toBe("HH:mm")
    expect(localStorage.getItem(MODE_KEY)).toBeNull()
    expect(screen.getAllByRole("combobox")).toHaveLength(2)

    await choose(user, "Upcoming streams", "Countdown")

    expect(localStorage.getItem(MODE_KEY)).toBe("countdown")
    expect(selectedValue("Upcoming streams")).toBe("Countdown")
    // Still exactly two controls -- selecting Countdown never reveals a third,
    // language-specific selector (that independent setting was removed).
    expect(screen.getAllByRole("combobox")).toHaveLength(2)
    expect(localStorage.getItem(COUNTDOWN_LANGUAGE_KEY)).toBeNull()
  })

  it("updates the Upcoming streams absolute-mode option label to match the global time format, without changing the stored mode", async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)

    expect(selectedValue("Upcoming streams")).toBe("HH:mm")

    await choose(user, "Time format", "12-hour (AM/PM)")

    expect(selectedValue("Upcoming streams")).toBe("h:mm AM/PM")

    await choose(user, "Time format", "24-hour (HH:mm)")

    expect(selectedValue("Upcoming streams")).toBe("HH:mm")
    expect(localStorage.getItem(MODE_KEY)).toBeNull()
  })

  it("restores the saved time format and upcoming-display mode after a reload", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<DisplaySettings />)
    await choose(user, "Time format", "12-hour (AM/PM)")
    await choose(user, "Upcoming streams", "Countdown")
    unmount()

    resetAllSharedStateForTests()
    render(<DisplaySettings />)

    expect(selectedValue("Time format")).toBe("12-hour (AM/PM)")
    expect(selectedValue("Upcoming streams")).toBe("Countdown")
  })
})

describe("DisplaySettings uses Home's palette and Home's select", () => {
  let css = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("both controls are Home's own native select (.oshi-videos__sort) -- not an antd Select with a Settings-only skin", () => {
    render(<DisplaySettings />)

    for (const select of screen.getAllByRole("combobox")) {
      expect(select.tagName).toBe("SELECT")
      expect(select).toHaveClass("oshi-videos__sort")
    }
    expect(document.querySelector(".ant-select")).toBeNull()
    // only the width is this page's own; every other look is Home's .oshi-videos__sort
    expect(ruleBody(css, ".display-setting-select").replace(/\s+/g, " ").trim()).toBe("width: 360px;")
  })

  it("every Settings tab paints Home's page surface (--oshi-bg), and the page title / description use Home's text tokens", () => {
    expect(ruleBody(css, ".settings-page__content")).toMatch(/background:\s*var\(--oshi-bg\)/)
    expect(ruleBody(css, ".settings-page-title")).toMatch(/color:\s*var\(--oshi-text-1\)/)
    expect(ruleBody(css, ".settings-page-description")).toMatch(/color:\s*var\(--oshi-text-2\)/)
    expect(ruleBody(css, ".display-setting-row")).toMatch(/border-bottom:\s*1px solid var\(--oshi-border\)/)
    expect(ruleBody(css, ".display-setting-label")).toMatch(/color:\s*var\(--oshi-text-1\)/)
    expect(ruleBody(css, ".display-setting-help")).toMatch(/color:\s*var\(--oshi-text-3\)/)
  })

  it("no purple / pink Display-only palette is left on any display-setting rule", () => {
    const displayRules = rulesOf(css).filter(({ selector }) => /display-setting|display-settings/.test(selector))
    expect(displayRules.length).toBeGreaterThan(5)
    for (const { body } of displayRules) {
      expect(body).not.toMatch(/#c87ca4|200,\s*124,\s*164|196,\s*184,\s*204|181,\s*168,\s*190|28,\s*24,\s*34|#211c26|#17141d|#efebf1|#aaa3b2|#96909e|#b9b3c1|#9a94a3|#f3eff5/i)
    }
    expect(css).not.toMatch(/--display-(accent|control|divider|text)/)
    expect(css).not.toMatch(/display-settings-select-dropdown/)
  })
})

describe("Language Settings lives in Display Settings, as its last item", () => {
  it("is the last row, after the existing rows (which keep their order), and is the only language picker on the page", () => {
    const { container } = render(<DisplaySettings />)

    const headings = Array.from(container.querySelectorAll(".display-setting-label")).map((heading) => heading.textContent)
    expect(headings).toEqual(["Time format", "Upcoming streams", "Language"])
    const rows = container.querySelectorAll(".display-setting-row")
    expect(rows[rows.length - 1].querySelector(".language-picker")).not.toBeNull()
    expect(container.querySelectorAll(".language-picker")).toHaveLength(1)
  })

  it("keeps its behaviour: it offers the same three languages and switching one updates the page text and the persisted locale", async () => {
    const user = userEvent.setup()
    render(<DisplaySettings />)

    await user.click(screen.getByRole("button", { name: /English/ }))
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["🇭🇰Traditional Chinese", "ENEnglish", "🇯🇵Japanese"])

    await user.click(screen.getByRole("menuitem", { name: "Japanese" }))

    expect(localStorage.getItem("yobi.locale")).toBe("ja")
    expect(screen.getByRole("heading", { name: "言語設定" })).toBeInTheDocument()
  })

  it("is no longer in the Settings navigation (and nowhere else on the Settings page)", () => {
    window.history.pushState({}, "", "/setting?section=oshi")
    const { container } = render(
      <MemberThemeProvider>
        <SettingsPage />
      </MemberThemeProvider>,
    )

    expect(container.querySelectorAll(".language-picker")).toHaveLength(0) // Favorites List shows none, and neither does the navbar
    expect(container.querySelector(".settings-secondary-navbar .language-picker")).toBeNull()
    window.history.pushState({}, "", "/setting")
  })
})
