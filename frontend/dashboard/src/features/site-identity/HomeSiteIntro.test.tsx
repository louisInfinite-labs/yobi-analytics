import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { HomeSiteIntro } from "./HomeSiteIntro"
import { SITE_INTRO_COPY } from "./siteIntroCopy"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

function setLocale(locale: string) {
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
  window.sessionStorage.clear()
  setLocale("en")
})

describe("HomeSiteIntro", () => {
  it("a real heading, a line on each feature and crawlable links to Schedule, Settings and About", () => {
    render(<HomeSiteIntro />)
    const section = screen.getByRole("region", { name: "About OshiYobi" })
    expect(within(section).getByRole("heading", { level: 2, name: "About OshiYobi" })).toBeInTheDocument()
    expect(section.querySelectorAll("li")).toHaveLength(4)
    expect(section).not.toHaveTextContent(SITE_INTRO_COPY.en.lead) // the description is in the page heading (HomeSiteHeading), never twice
    expect(within(section).getByRole("link", { name: "Live Schedule" })).toHaveAttribute("href", "/schedule")
    expect(within(section).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/setting")
    expect(within(section).getByRole("link", { name: "More about OshiYobi" })).toHaveAttribute("href", "/about")
  })

  it("a plain click navigates in place; a modified click is left to the browser", async () => {
    const user = userEvent.setup()
    render(<HomeSiteIntro />)
    const link = screen.getByRole("link", { name: "Live Schedule" })
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
    link.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(false)
    expect(window.location.pathname).toBe("/")
    await user.click(link)
    expect(window.location.pathname).toBe("/schedule")
  })

  it.each(["zh-TW", "ja"] as const)("is written in %s too", (locale) => {
    setLocale(locale)
    render(<HomeSiteIntro />)
    expect(screen.getByRole("heading", { level: 2, name: SITE_INTRO_COPY[locale].heading })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: SITE_INTRO_COPY[locale].scheduleLink })).toHaveAttribute("href", "/schedule")
  })
})
