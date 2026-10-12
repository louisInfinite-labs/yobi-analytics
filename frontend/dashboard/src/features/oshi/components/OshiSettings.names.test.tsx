import { render } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { OshiSettings } from "./OshiSettings"
import { getCreatorById } from "../../../entities/creator/data/creatorRegistry"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"
import { readStylesheet, ruleBody } from "../../../test/readStylesheet"

const HOLOLIVE_FULL_NAME = "hololive ホロライブ - VTuber Group"

describe("the Hololive group channel's canonical display name", () => {
  it("is 'hololive ホロライブ - VTuber Group' everywhere the registry's displayName is used, with the creator's identity untouched", () => {
    const creator = getCreatorById("hololive_official")!
    expect(creator.displayName).toBe(HOLOLIVE_FULL_NAME)
    expect(creator.creatorId).toBe("hololive_official")
    expect(creator.youtubeChannelId).toMatch(/^UC/)
  })
})

describe("My Favorites names", () => {
  it("shows the Hololive name on exactly two lines, broken only after the hyphen, and every other name unbroken", () => {
    const { container } = render(
      <MemberThemeProvider>
        <OshiSettings />
      </MemberThemeProvider>,
    )
    const names = Array.from(container.querySelectorAll(".favorites-roster__name")).map((element) => element.textContent ?? "")

    expect(names).toContain("hololive ホロライブ -\nVTuber Group")
    expect(names.filter((name) => name.includes("\n"))).toEqual(["hololive ホロライブ -\nVTuber Group"])
    for (const oneLine of ["アキ・ローゼンタール", "ぶいすぽっ!【公式】"]) expect(names).toContain(oneLine)
  })
})

describe("name layout CSS", () => {
  let settings = ""
  beforeAll(async () => {
    settings = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("My Favorites tiles are 160px wide (144px of text): room for the longest one-line names and each line of the two-line Hololive name", () => {
    expect(ruleBody(settings, ".favorites-roster__grid")).toMatch(/repeat\(auto-fill,\s*160px\)/)
  })

  it("the notification member previews are as wide as their names and never cut them with an ellipsis", () => {
    expect(ruleBody(settings, ".notification-member-preview__item")).toMatch(/width:\s*auto/)
    const name = ruleBody(settings, ".notification-member-preview__name")
    expect(name).toMatch(/white-space:\s*nowrap/)
    expect(name).not.toMatch(/text-overflow|overflow:\s*hidden/)
  })

  it("the notification member drawer keeps names on one line", () => {
    expect(ruleBody(settings, ".topic-creator-drawer__creator-name")).toMatch(/white-space:\s*nowrap/)
  })
})
