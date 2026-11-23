import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { MainNavbar } from "./MainNavbar"
import { selectCreator } from "./useCurrentPage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

function setLocale(locale: string) {
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
  window.sessionStorage.clear()
})

describe("MainNavbar", () => {
  it("renders a visible label (not just a tooltip) for every nav item", () => {
    setLocale("en")
    render(<MainNavbar />)
    expect(screen.getByText("Home")).toBeInTheDocument()
    expect(screen.getByText("Schedule")).toBeInTheDocument()
    expect(screen.getByText("Video Data")).toBeInTheDocument()
    expect(screen.getByText("Settings")).toBeInTheDocument()
  })

  it("does not render the old hover tooltip element", () => {
    setLocale("en")
    const { container } = render(<MainNavbar />)
    expect(container.querySelector(".main-navbar__tooltip")).not.toBeInTheDocument()
  })

  it("renders the correct label per locale", () => {
    setLocale("zh-TW")
    render(<MainNavbar />)
    expect(screen.getByText("首頁")).toBeInTheDocument()
    expect(screen.getByText("影片數據")).toBeInTheDocument()
    expect(screen.getByText("設定")).toBeInTheDocument()
  })

  it("marks Home active on load and moves the active class on click, without duplicating it", async () => {
    setLocale("en")
    const user = userEvent.setup()
    render(<MainNavbar />)

    const home = screen.getByRole("link", { name: "Home" })
    const dashboard = screen.getByRole("link", { name: "Video Data" })
    expect(home).toHaveClass("main-navbar__link--active")
    expect(home).toHaveAttribute("aria-current", "page")
    expect(dashboard).not.toHaveClass("main-navbar__link--active")

    await user.click(dashboard)
    expect(dashboard).toHaveClass("main-navbar__link--active")
    expect(dashboard).toHaveAttribute("aria-current", "page")
    expect(home).not.toHaveClass("main-navbar__link--active")
    expect(home).not.toHaveAttribute("aria-current")
  })

  it("renders every item as a crawlable <a href> to the page it opens", () => {
    setLocale("en")
    render(<MainNavbar />)
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/")
    expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute("href", "/schedule")
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/setting")
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute("href", "/about")
  })

  it("points Home at the root \"/\" always: a creator switch never changes the link (there are no per-creator URLs)", () => {
    setLocale("en")
    window.sessionStorage.setItem("yobi.session.homeCreator", "ch_amayui_moka")
    render(<MainNavbar />)
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/")

    act(() => selectCreator("tachibana_hinano"))
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/")
    expect(document.querySelectorAll('a[href^="/creator"]')).toHaveLength(0)
  })

  it("navigates in place on a plain click but leaves a modified click (new tab/window) to the browser", () => {
    setLocale("en")
    render(<MainNavbar />)
    const schedule = screen.getByRole("link", { name: "Schedule" })

    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
    schedule.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(false)
    expect(window.location.pathname).toBe("/")

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      schedule.dispatchEvent(plain)
    })
    expect(plain.defaultPrevented).toBe(true)
    expect(window.location.pathname).toBe("/schedule")
  })
})
