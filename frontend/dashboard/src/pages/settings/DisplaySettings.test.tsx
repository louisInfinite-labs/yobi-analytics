import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { DisplaySettings } from "./DisplaySettings"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"

const MODE_KEY = "yobi.upcomingDisplayMode"
const LANGUAGE_KEY = "yobi.countdownLanguage"

/** Mounts the Display settings section under the theme provider it reads. */
function renderDisplaySettings() {
  return render(
    <MemberThemeProvider>
      <DisplaySettings />
    </MemberThemeProvider>,
  )
}

/** Opens an antd Select by its accessible name and picks the option with the given text. */
async function choose(user: ReturnType<typeof userEvent.setup>, selectName: string, optionText: string) {
  await user.click(screen.getByRole("combobox", { name: selectName }))
  await user.click(await screen.findByText(optionText, { selector: ".ant-select-item-option-content" }))
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("DisplaySettings", () => {
  it("renders the page heading, description and both setting groups", () => {
    renderDisplaySettings()

    expect(screen.getByRole("heading", { level: 1, name: "Display" })).toBeInTheDocument()
    expect(screen.getByText("Choose how the app looks and how upcoming stream times are shown.")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Upcoming streams" })).toBeInTheDocument()
  })

  it("defaults to the Hololive theme and switches the active theme from the selector", async () => {
    const user = userEvent.setup()
    const { container } = renderDisplaySettings()
    const themeRoot = container.querySelector(".theme-root")!
    expect(themeRoot).toHaveAttribute("data-theme-id", "hololive-jp")

    await choose(user, "Dashboard theme", "VSPO JP — Tactical")

    expect(themeRoot).toHaveAttribute("data-theme-id", "vspo-jp-tactical")
  })

  it("defaults to absolute (HH:mm) upcoming times and hides the countdown language control", () => {
    renderDisplaySettings()

    expect(screen.getByRole("combobox", { name: "Upcoming stream time display" })).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Countdown label language" })).not.toBeInTheDocument()
    expect(localStorage.getItem(MODE_KEY)).toBeNull()
  })

  it("selecting Countdown persists the mode and reveals the countdown language control", async () => {
    const user = userEvent.setup()
    renderDisplaySettings()

    await choose(user, "Upcoming stream time display", "Countdown")

    expect(localStorage.getItem(MODE_KEY)).toBe("countdown")
    expect(screen.getByRole("combobox", { name: "Countdown label language" })).toBeInTheDocument()
  })

  it("persists the chosen countdown language", async () => {
    const user = userEvent.setup()
    renderDisplaySettings()
    await choose(user, "Upcoming stream time display", "Countdown")

    await choose(user, "Countdown label language", "日本語")

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("ja")
  })

  it("switching back to HH:mm hides the countdown language control again", async () => {
    const user = userEvent.setup()
    renderDisplaySettings()
    await choose(user, "Upcoming stream time display", "Countdown")

    await choose(user, "Upcoming stream time display", "HH:mm")

    expect(localStorage.getItem(MODE_KEY)).toBe("absolute")
    expect(screen.queryByRole("combobox", { name: "Countdown label language" })).not.toBeInTheDocument()
  })

  it("restores the saved upcoming-time mode after a reload", async () => {
    const user = userEvent.setup()
    const { unmount } = renderDisplaySettings()
    await choose(user, "Upcoming stream time display", "Countdown")
    unmount()

    resetAllSharedStateForTests()
    renderDisplaySettings()

    expect(screen.getByRole("combobox", { name: "Countdown label language" })).toBeInTheDocument()
  })
})
