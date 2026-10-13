import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { SettingsPage } from "./SettingsPage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"

// The responsive layout itself (rail below 1440px, drawer instead of the second sidebar) is CSS -- see responsiveNavigation.css.test.ts and
// the real-browser viewport checks. This file covers the drawer's behavior, which is the same markup at every width.

function renderSettingsPage() {
  return render(
    <MemberThemeProvider>
      <SettingsPage />
    </MemberThemeProvider>,
  )
}

const drawer = () => document.querySelector<HTMLElement>("#settings-secondary-navbar")!
const isOpen = () => drawer().classList.contains("settings-secondary-navbar--open")
const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] })

beforeEach(() => {
  window.history.pushState({}, "", "/setting")
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("Settings menu drawer (below 1440px)", () => {
  it("starts closed, with a menu button that names the current section and controls the drawer", () => {
    renderSettingsPage()

    const button = screen.getByRole("button", { name: "Open settings menu" })
    expect(isOpen()).toBe(false)
    expect(button).toHaveAttribute("aria-expanded", "false")
    expect(button).toHaveAttribute("aria-controls", "settings-secondary-navbar")
    expect(button).toHaveTextContent("Favorites List") // the section Settings opens on
    expect(document.querySelector(".settings-drawer-backdrop")).toBeNull()
  })

  it("opens from the menu button: backdrop shown, focus moves into the drawer", async () => {
    const user = userEvent.setup()
    renderSettingsPage()

    await user.click(screen.getByRole("button", { name: "Open settings menu" }))

    expect(isOpen()).toBe(true)
    expect(screen.getByRole("button", { name: "Open settings menu" })).toHaveAttribute("aria-expanded", "true")
    expect(document.querySelector(".settings-drawer-backdrop")).not.toBeNull()
    expect(drawer().contains(document.activeElement)).toBe(true)
  })

  it("closes with Escape and returns focus to the menu button", async () => {
    const user = userEvent.setup()
    renderSettingsPage()
    const button = screen.getByRole("button", { name: "Open settings menu" })
    await user.click(button)

    await user.keyboard("{Escape}")

    expect(isOpen()).toBe(false)
    expect(button).toHaveFocus()
    expect(document.querySelector(".settings-drawer-backdrop")).toBeNull()
  })

  it("closes with a backdrop click", async () => {
    const user = userEvent.setup()
    renderSettingsPage()
    await user.click(screen.getByRole("button", { name: "Open settings menu" }))

    await user.click(document.querySelector(".settings-drawer-backdrop")!)

    expect(isOpen()).toBe(false)
  })

  it("closes with its explicit close button", async () => {
    const user = userEvent.setup()
    renderSettingsPage()
    await user.click(screen.getByRole("button", { name: "Open settings menu" }))

    await user.click(screen.getByRole("button", { name: "Close settings menu" }))

    expect(isOpen()).toBe(false)
  })

  it("picking a section switches the content AND closes the drawer", async () => {
    const user = userEvent.setup()
    renderSettingsPage()
    await user.click(screen.getByRole("button", { name: "Open settings menu" }))

    await user.click(within(drawer()).getByRole("button", { name: "Display" }))

    expect(isOpen()).toBe(false)
    expect(window.location.search).toContain("section=display")
    expect(screen.getByRole("button", { name: "Open settings menu" })).toHaveTextContent("Display")
  })

  it("swiping LEFT inside the open drawer closes it", () => {
    renderSettingsPage()
    fireEvent.click(screen.getByRole("button", { name: "Open settings menu" }))

    fireEvent.touchStart(drawer(), touch(200, 300))
    fireEvent.touchEnd(drawer(), touch(80, 306))

    expect(isOpen()).toBe(false)
  })

  it("a short, rightward or mostly vertical swipe does not close it", () => {
    renderSettingsPage()
    fireEvent.click(screen.getByRole("button", { name: "Open settings menu" }))

    fireEvent.touchStart(drawer(), touch(200, 300))
    fireEvent.touchEnd(drawer(), touch(170, 300)) // only 30px left
    fireEvent.touchStart(drawer(), touch(100, 300))
    fireEvent.touchEnd(drawer(), touch(220, 300)) // rightward
    fireEvent.touchStart(drawer(), touch(200, 100))
    fireEvent.touchEnd(drawer(), touch(150, 400)) // scrolling, not swiping

    expect(isOpen()).toBe(true)
  })

  it("has NO edge-swipe opener: a rightward swipe from the left edge of the page never opens it (that gesture is iOS back navigation)", () => {
    renderSettingsPage()

    fireEvent.touchStart(document.body, touch(2, 300))
    fireEvent.touchEnd(document.body, touch(220, 300))
    fireEvent.touchStart(document.querySelector(".settings-page")!, touch(2, 300))
    fireEvent.touchEnd(document.querySelector(".settings-page")!, touch(220, 300))

    expect(isOpen()).toBe(false)
  })

  it("keeps Tab inside the open drawer (wraps from the last control to the first)", async () => {
    const user = userEvent.setup()
    renderSettingsPage()
    await user.click(screen.getByRole("button", { name: "Open settings menu" }))
    const controls = Array.from(drawer().querySelectorAll<HTMLElement>("button"))

    controls[controls.length - 1].focus()
    await user.tab()

    expect(controls[0]).toHaveFocus()
  })

  it("the drawer is the one persistent nav element at every width: the same labelled <nav> holds the four sections", () => {
    renderSettingsPage()

    expect(drawer().tagName).toBe("NAV")
    expect(Array.from(drawer().querySelectorAll(".settings-secondary-navbar__link"))).toHaveLength(4)
  })

  it("the menu labels follow the language (zh-TW)", () => {
    localStorage.setItem("yobi.locale", "zh-TW")
    resetAllSharedStateForTests()
    renderSettingsPage()

    expect(screen.getByRole("button", { name: "開啟設定選單" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "關閉設定選單", hidden: true })).toBeInTheDocument()
  })
})

