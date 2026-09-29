import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { SettingsPage } from "./SettingsPage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"

/** Mounts the whole Settings page under the theme provider its sections read. */
function renderSettingsPage() {
  return render(
    <MemberThemeProvider>
      <SettingsPage />
    </MemberThemeProvider>,
  )
}

beforeEach(() => {
  // The active section now lives in the URL (see useSettingsSection.ts),
  // so it persists across jsdom's own shared window within this file the
  // same way it would persist across a real reload -- reset it before
  // every test the same way MainNavbar.test.tsx already resets its own
  // page-level path, or a later test would inherit whichever section a
  // prior test navigated to.
  window.history.pushState({}, "", "/setting")
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("SettingsPage navigation", () => {
  it("lists the four sections in the fixed order and opens Favorites List by default", () => {
    renderSettingsPage()

    const nav = screen.getByRole("navigation", { name: "Settings navigation" })
    const labels = Array.from(nav.querySelectorAll(".settings-secondary-navbar__link")).map((item) => item.textContent)
    expect(labels).toEqual(["Oshi Settings", "Favorites List", "Live/Video Notifications", "Display"])

    expect(screen.getByRole("button", { name: "Favorites List" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("heading", { name: "My Favorites" })).toBeInTheDocument()
  })

  it("switches the content area and the active item when a section is selected", async () => {
    const user = userEvent.setup()
    renderSettingsPage()

    await user.click(screen.getByRole("button", { name: "Oshi Settings" }))
    expect(screen.getByRole("button", { name: "Oshi Settings" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("button", { name: "Favorites List" })).not.toHaveAttribute("aria-current")
    // Page title now follows the shared Settings header i18n (spec: header
    // renamed from "MAIN OSHI SELECT" to the localized nav label).
    expect(screen.getByRole("heading", { level: 1, name: "Oshi Settings" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "My Favorites" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Display" }))
    expect(screen.getByRole("heading", { level: 1, name: "Display" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "MAIN OSHI SELECT" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Live/Video Notifications" }))
    expect(screen.getByRole("button", { name: "Live/Video Notifications" })).toHaveAttribute("aria-current", "page")
    expect(screen.queryByRole("heading", { level: 1, name: "Display" })).not.toBeInTheDocument()
  })

  it("keeps a favorite chosen in Favorites List after leaving and returning to the section", async () => {
    const user = userEvent.setup()
    renderSettingsPage()

    await user.click(screen.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }))
    await user.click(screen.getByRole("button", { name: "Display" }))
    await user.click(screen.getByRole("button", { name: "Favorites List" }))

    expect(screen.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()
  })
})
