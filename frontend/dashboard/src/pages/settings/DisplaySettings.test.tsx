import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { DisplaySettings } from "./DisplaySettings"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

const TIME_FORMAT_KEY = "yobi.timeFormat"
const MODE_KEY = "yobi.upcomingDisplayMode"
const COUNTDOWN_LANGUAGE_KEY = "yobi.countdownLanguage"

/** Opens an antd Select by its accessible name and picks the option with the given text. */
async function choose(user: ReturnType<typeof userEvent.setup>, selectName: string, optionText: string) {
  await user.click(screen.getByRole("combobox", { name: selectName }))
  await user.click(await screen.findByText(optionText, { selector: ".ant-select-item-option-content" }))
}

/** The displayed value of an antd Select found by its accessible name -- the
 * combobox role sits on the hidden `<input>`, whose own text content is
 * always empty, so the visible label is read from its `.ant-select-content`
 * wrapper's `title` instead. */
function selectedValue(selectName: string): string | null {
  return screen.getByRole("combobox", { name: selectName }).closest(".ant-select-content")?.getAttribute("title") ?? null
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
