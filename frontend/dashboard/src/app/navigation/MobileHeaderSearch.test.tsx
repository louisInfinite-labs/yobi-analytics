/** The phone header's video search: where it sits (immediately right of the hamburger, the header's only icon), that it is the Video List's own
 * SearchView (same component, placeholder, locale), that it is phone-only by the stylesheet, and that submitting from another page takes the viewer
 * to Home with the query kept. The submit-driven behavior on Home itself is covered in pages/home/HomePage.mobileSearch.test.tsx. */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { MainNavbar } from "./MainNavbar"
import { readStylesheet, mediaBlocks, outsideMedia, ruleBody } from "../../test/readStylesheet"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

const NAV_CSS = "src/app/navigation/styles/main-navbar.css"

beforeEach(() => {
  window.history.pushState({}, "", "/")
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

const input = () => document.querySelector<HTMLInputElement>(".main-topbar__search input")!

describe("placement", () => {
  it("the search is the element immediately after the hamburger inside the header, and the header holds nothing else", () => {
    render(<MainNavbar />)

    const header = document.querySelector(".main-topbar")!
    expect(Array.from(header.children).map((child) => child.className.split(" ")[0])).toEqual(["main-topbar__menu", "main-topbar__search"])
    expect(header.querySelector(".main-topbar__menu")!.nextElementSibling).toBe(header.querySelector(".main-topbar__search"))
  })

  it("is the Video List's own SearchView: the same input with the same placeholder, in a labelled search landmark", () => {
    render(<MainNavbar />)

    expect(screen.getByRole("search")).toBeInTheDocument()
    expect(input().placeholder).toBe("Search videos")
    expect(input().getAttribute("aria-label")).toBe("Search videos")
    expect(input().getAttribute("enterkeyhint")).toBe("search")
  })

  it("uses the selected language's own placeholder", () => {
    localStorage.setItem("yobi.locale", "ja")
    resetAllSharedStateForTests()
    render(<MainNavbar />)

    expect(input().placeholder).toBe("動画を検索")
  })
})

describe("the stylesheet", () => {
  it("takes the rest of the bar without pushing past it, off the hamburger by a margin, with 16px text (no iOS focus zoom)", async () => {
    const phone = mediaBlocks(await readStylesheet(NAV_CSS), "(max-width: 767px)")

    expect(ruleBody(phone, ".main-topbar__search")).toMatch(/flex:\s*1 1 auto/)
    expect(ruleBody(phone, ".main-topbar__search")).toMatch(/min-width:\s*0/)
    expect(ruleBody(phone, ".main-topbar__search")).toMatch(/margin-inline:/)
    expect(ruleBody(phone, ".main-topbar__search-input.ant-input-affix-wrapper")).toMatch(/font-size:\s*16px/)
    expect(Number(/height:\s*(\d+)px/.exec(ruleBody(phone, ".main-topbar__search-input.ant-input-affix-wrapper"))![1])).toBeGreaterThanOrEqual(32)
  })

  it("exists only on a phone: the whole header is display:none outside the phone media query, and the search has no rule outside it", async () => {
    const css = await readStylesheet(NAV_CSS)

    expect(ruleBody(outsideMedia(css), ".main-topbar")).toMatch(/display:\s*none/)
    expect(outsideMedia(css)).not.toContain("main-topbar__search")
  })
})

describe("from another page", () => {
  it("submitting on Schedule takes the viewer to Home with the query kept (typing alone does not navigate)", async () => {
    window.history.pushState({}, "", "/schedule")
    const user = userEvent.setup()
    render(<MainNavbar />)

    await user.type(input(), "VALO")
    expect(window.location.pathname).toBe("/schedule") // a draft only

    await user.keyboard("{Enter}")

    expect(window.location.pathname).not.toBe("/schedule")
    expect(input().value).toBe("VALO")
  })

  it("an empty submit does not navigate", async () => {
    window.history.pushState({}, "", "/schedule")
    render(<MainNavbar />)

    fireEvent.submit(document.querySelector(".main-topbar__search")!)

    expect(window.location.pathname).toBe("/schedule")
  })
})
