import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { MainNavbar } from "./MainNavbar"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

function setLocale(locale: string) {
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
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

    const home = screen.getByRole("button", { name: "Home" })
    const dashboard = screen.getByRole("button", { name: "Video Data" })
    expect(home).toHaveClass("main-navbar__link--active")
    expect(dashboard).not.toHaveClass("main-navbar__link--active")

    await user.click(dashboard)
    expect(dashboard).toHaveClass("main-navbar__link--active")
    expect(home).not.toHaveClass("main-navbar__link--active")
  })
})
