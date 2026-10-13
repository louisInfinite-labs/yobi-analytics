import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { LanguageFlagIcon } from "./LanguageFlagIcon"
import { LanguagePicker } from "./LanguagePicker"
import type { Locale } from "../translations"

const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
})

describe("LanguageFlagIcon", () => {
  it.each([
    ["zh-TW", "hk"],
    ["en", "gb"],
    ["ja", "jp"],
  ] as [Locale, string][])("%s renders the %s flag as a decorative image with no text", (locale, flag) => {
    const { container } = render(<LanguageFlagIcon locale={locale} />)
    const image = container.querySelector("img")!
    expect(image).toHaveAttribute("data-flag", flag)
    expect(image).toHaveAttribute("alt", "")
    expect(image).toHaveAttribute("aria-hidden", "true")
    expect(image.getAttribute("src")).toMatch(/svg/i)
    expect(container.textContent).toBe("")
  })

  it("gives every language the same icon dimensions, each with its own artwork", () => {
    const images = (["zh-TW", "en", "ja"] as Locale[]).map((locale) => render(<LanguageFlagIcon locale={locale} />).container.querySelector("img")!)
    expect(new Set(images.map((image) => `${image.getAttribute("width")}x${image.getAttribute("height")}`))).toEqual(new Set(["20x15"]))
    expect(new Set(images.map((image) => image.getAttribute("src"))).size).toBe(3)
  })
})

describe("LanguagePicker flags", () => {
  it("shows the same flag treatment in the selected row and every dropdown row, with no emoji and no 'EN' text", async () => {
    const user = userEvent.setup()
    const { container } = render(<LanguagePicker />)

    const triggerFlag = container.querySelector(".language-picker__control .language-picker__flag img")!
    expect(triggerFlag).toHaveAttribute("data-flag", "gb")

    await user.click(screen.getByRole("button", { name: /English/ }))
    const rowFlags = [...container.querySelectorAll(".language-picker__item .language-picker__flag img")]
    expect(rowFlags.map((flag) => flag.getAttribute("data-flag"))).toEqual(["hk", "gb", "jp"])

    const all = [triggerFlag, ...rowFlags]
    expect(new Set(all.map((flag) => `${flag.getAttribute("width")}x${flag.getAttribute("height")}`))).toEqual(new Set(["20x15"]))
    for (const flag of all) {
      expect(flag.parentElement).toHaveClass("language-picker__flag")
      expect(flag.parentElement!.nextElementSibling).not.toBeNull()
    }

    expect(container.textContent).not.toMatch(REGIONAL_INDICATOR)
    for (const flagBox of container.querySelectorAll(".language-picker__flag")) expect(flagBox.textContent).toBe("")
    expect(container.textContent).not.toContain("EN")
  })

  it("selecting a language still changes the locale and persists it, exactly as before", async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)
    await user.click(screen.getByRole("button", { name: /English/ }))
    await user.click(screen.getByRole("menuitem", { name: "Japanese" }))
    expect(localStorage.getItem("yobi.locale")).toBe("ja")
    expect(document.querySelector(".language-picker__control .language-picker__flag img")).toHaveAttribute("data-flag", "jp")
  })
})
