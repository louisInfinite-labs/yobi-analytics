import { describe, expect, it } from "vitest"
import { getAvailableTopics, getSelectableTopics } from "./notificationTopicCatalog"

describe("getAvailableTopics", () => {
  it("returns the 5 permanent default topics followed by the 4 topics actually addable via '+'", () => {
    const ids = getAvailableTopics().map((topic) => topic.id)
    expect(ids).toEqual(["all", "sf6", "valo", "apex", "minecraft", "gta", "seven_days_to_die", "mahjong_soul", "endfield"])
  })
})

describe("getSelectableTopics", () => {
  it("excludes the 5 permanent default topics once they're pre-saved (the app's own real starting state)", () => {
    const ids = getSelectableTopics(["all", "sf6", "valo", "apex", "minecraft"]).map((topic) => topic.id)
    expect(ids).toEqual(["gta", "seven_days_to_die", "mahjong_soul", "endfield"])
  })

  it("excludes a topic already claimed by a saved card", () => {
    const ids = getSelectableTopics(["valo"]).map((topic) => topic.id)
    expect(ids).not.toContain("valo")
  })

  it("excludes every saved topic when more than one is already claimed", () => {
    const ids = getSelectableTopics(["gta", "valo"]).map((topic) => topic.id)
    expect(ids).not.toContain("gta")
    expect(ids).not.toContain("valo")
  })

  it("returns every topic when nothing is saved yet", () => {
    expect(getSelectableTopics([]).length).toBe(9)
  })
})
