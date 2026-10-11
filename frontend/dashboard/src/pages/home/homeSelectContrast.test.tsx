import { render } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { DisplaySettings } from "../settings/DisplaySettings"
import { readStylesheet, ruleBody, rulesOf } from "../../test/readStylesheet"

// One dropdown treatment for every Home-style native select. The app root is color-scheme: light and a native <select>'s open list follows
// the scheme of the select itself, so a select outside .oshi-home (Display Settings, a portalled drawer) opened a LIGHT list under Home's
// light-on-dark text -- unreadable. The fix lives on the shared .oshi-videos__sort class, not in any one page.

describe("the shared Home-style select (.oshi-videos__sort) stays readable wherever it is used", () => {
  let home = ""
  let settings = ""
  beforeAll(async () => {
    home = await readStylesheet("src/pages/home/styles/home.css")
    settings = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("the select declares its OWN dark color scheme (so its open list is dark in Home and everywhere else) -- on the shared class", () => {
    const bodies = rulesOf(home)
      .filter(({ selector }) => selector.split(",").some((part) => part.trim() === ".oshi-videos__sort"))
      .map(({ body }) => body)
      .join("\n")
    expect(bodies).toMatch(/color-scheme:\s*dark/)
  })

  it("its options carry Home's surface and text colors, and a disabled option stays legible", () => {
    expect(ruleBody(home, ".oshi-videos__sort option")).toMatch(/background:\s*var\(--oshi-surface-2\)/)
    expect(ruleBody(home, ".oshi-videos__sort option")).toMatch(/color:\s*var\(--oshi-text-1\)/)
    expect(ruleBody(home, ".oshi-videos__sort option:disabled")).toMatch(/color:\s*var\(--oshi-text-3\)/)
  })

  it("no page re-themes it: Settings and the drawer add only a width, never their own select colors", () => {
    expect(ruleBody(settings, ".display-setting-select").replace(/\s+/g, " ").trim()).toBe("width: 360px;")
    expect(rulesOf(settings).filter(({ selector }) => /oshi-videos__sort/.test(selector))).toEqual([])
  })

  it("Display Settings' two controls are that shared class", () => {
    localStorage.setItem("yobi.locale", "en")
    render(<DisplaySettings />)
    const selects = Array.from(document.querySelectorAll("select"))
    expect(selects).toHaveLength(2)
    for (const select of selects) expect(select).toHaveClass("oshi-videos__sort")
  })
})
