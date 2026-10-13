import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { MainNavbar } from "./MainNavbar"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

// Which shape the navigation takes (56px rail / 160px sidebar / phone top bar) is CSS -- see responsiveNavigation.css.test.ts and the real-browser
// viewport checks. This file covers the phone drawer's behavior, which is the same markup at every width.

const drawer = () => document.querySelector<HTMLElement>("#main-navbar")!
const isOpen = () => drawer().classList.contains("main-navbar--open")
const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] })

beforeEach(() => {
  window.history.pushState({}, "", "/")
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("phone top bar + main navigation drawer", () => {
  it("renders a top bar whose only control is the hamburger, which names itself and controls the navigation", () => {
    render(<MainNavbar />)

    const bar = document.querySelector<HTMLElement>(".main-topbar")!
    const hamburger = within(bar).getByRole("button", { name: "Open navigation" })
    expect(within(bar).getAllByRole("button")).toHaveLength(1)
    expect(hamburger).toHaveAttribute("aria-expanded", "false")
    expect(hamburger).toHaveAttribute("aria-controls", "main-navbar")
  })

  it("the top bar comes BEFORE the navigation in the document (it is the first row), and there is no bottom navigation element", () => {
    const { container } = render(<MainNavbar />)

    expect(container.firstElementChild).toBe(document.querySelector(".main-topbar"))
    expect(container.querySelectorAll("nav")).toHaveLength(1) // one navigation: the drawer / rail / sidebar itself
    expect(container.querySelector("[class*='bottom']")).toBeNull()
  })

  it("the drawer is closed by default (no backdrop, hamburger collapsed)", () => {
    render(<MainNavbar />)

    expect(isOpen()).toBe(false)
    expect(document.querySelector(".main-navbar-backdrop")).toBeNull()
  })

  it("keeps the existing items with icons and visible labels inside the drawer", () => {
    render(<MainNavbar />)

    for (const label of ["Home", "Schedule", "Settings"]) {
      expect(within(drawer()).getByRole("button", { name: label })).toBeInTheDocument()
      expect(within(drawer()).getByText(label)).toHaveClass("main-navbar__label")
    }
    expect(drawer().querySelectorAll(".main-navbar__link svg").length).toBeGreaterThanOrEqual(3)
  })

  it("the hamburger opens it: backdrop shown, focus moves inside", async () => {
    const user = userEvent.setup()
    render(<MainNavbar />)

    await user.click(screen.getByRole("button", { name: "Open navigation" }))

    expect(isOpen()).toBe(true)
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "true")
    expect(document.querySelector(".main-navbar-backdrop")).not.toBeNull()
    expect(drawer().contains(document.activeElement)).toBe(true)
  })

  it("closes via a backdrop tap", async () => {
    const user = userEvent.setup()
    render(<MainNavbar />)
    await user.click(screen.getByRole("button", { name: "Open navigation" }))

    await user.click(document.querySelector(".main-navbar-backdrop")!)

    expect(isOpen()).toBe(false)
  })

  it("closes via Escape and gives focus back to the hamburger", async () => {
    const user = userEvent.setup()
    render(<MainNavbar />)
    const hamburger = screen.getByRole("button", { name: "Open navigation" })
    await user.click(hamburger)

    await user.keyboard("{Escape}")

    expect(isOpen()).toBe(false)
    expect(hamburger).toHaveFocus()
  })

  it("closes via its explicit close control", async () => {
    const user = userEvent.setup()
    render(<MainNavbar />)
    await user.click(screen.getByRole("button", { name: "Open navigation" }))

    await user.click(screen.getByRole("button", { name: "Close navigation" }))

    expect(isOpen()).toBe(false)
  })

  it("selecting a page navigates AND closes the drawer", async () => {
    const user = userEvent.setup()
    render(<MainNavbar />)
    await user.click(screen.getByRole("button", { name: "Open navigation" }))

    await user.click(within(drawer()).getByRole("button", { name: "Schedule" }))

    expect(window.location.pathname).toBe("/schedule")
    expect(isOpen()).toBe(false)
  })

  it("swiping LEFT inside the open drawer closes it; a short, rightward or vertical swipe does not", () => {
    render(<MainNavbar />)
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }))

    fireEvent.touchStart(drawer(), touch(200, 300))
    fireEvent.touchEnd(drawer(), touch(170, 300))
    fireEvent.touchStart(drawer(), touch(100, 300))
    fireEvent.touchEnd(drawer(), touch(220, 300))
    fireEvent.touchStart(drawer(), touch(200, 100))
    fireEvent.touchEnd(drawer(), touch(150, 400))
    expect(isOpen()).toBe(true)

    fireEvent.touchStart(drawer(), touch(200, 300))
    fireEvent.touchEnd(drawer(), touch(80, 305))
    expect(isOpen()).toBe(false)
  })

  it("has NO left-edge swipe-right opener (iOS back gesture): such a swipe on the page never opens it", () => {
    render(<MainNavbar />)

    fireEvent.touchStart(document.body, touch(2, 300))
    fireEvent.touchEnd(document.body, touch(220, 300))
    fireEvent.touchStart(document.querySelector(".main-topbar")!, touch(2, 20))
    fireEvent.touchEnd(document.querySelector(".main-topbar")!, touch(220, 20))

    expect(isOpen()).toBe(false)
  })

  it("keeps Tab inside the open drawer", async () => {
    const user = userEvent.setup()
    render(<MainNavbar />)
    await user.click(screen.getByRole("button", { name: "Open navigation" }))
    const controls = Array.from(drawer().querySelectorAll<HTMLElement>("button"))

    controls[controls.length - 1].focus()
    await user.tab()

    expect(controls[0]).toHaveFocus()
  })

  it("the hamburger / close labels follow the language (zh-TW)", () => {
    localStorage.setItem("yobi.locale", "zh-TW")
    resetAllSharedStateForTests()
    render(<MainNavbar />)

    expect(screen.getByRole("button", { name: "開啟導覽" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "關閉導覽", hidden: true })).toBeInTheDocument()
  })
})
