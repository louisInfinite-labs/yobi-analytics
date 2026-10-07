import { describe, expect, it } from "vitest"
import { ALL_TOPICS_ID, getAvailableTopics, getSelectableTopics, LEGACY_TOPIC_ID_ALIASES } from "./notificationTopicCatalog"

const DEFAULT_SAVED = ["all", "sf6", "valorant", "apex", "minecraft"]

describe("getAvailableTopics", () => {
  it("lists the 5 permanent defaults, then the backend-supported addable topics, then the display-only categories", () => {
    const ids = getAvailableTopics().map((topic) => topic.id)
    expect(ids).toEqual([
      "all",
      "sf6",
      "valorant",
      "apex",
      "minecraft",
      "singing",
      "mv",
      "chatting",
      "gta",
      "seven_days_to_die",
      "mahjong_soul",
      "endfield",
    ])
  })

  it("uses the backend canonical id for VALO (valorant) and keeps its VALO label", () => {
    const valo = getAvailableTopics().find((topic) => topic.id === "valorant")
    expect(valo?.labelKey).toBe("recentVideos.tag.valo")
    expect(getAvailableTopics().some((topic) => topic.id === "valo")).toBe(false)
  })

  it("keeps `all` as the creator-level scope id, not a backend topic", () => {
    expect(ALL_TOPICS_ID).toBe("all")
  })

  it("maps the one legacy id (valo) to its canonical id", () => {
    expect(LEGACY_TOPIC_ID_ALIASES).toEqual({ valo: "valorant" })
  })
})

describe("getSelectableTopics", () => {
  it("excludes the 5 permanent default topics once they're pre-saved (the app's own real starting state)", () => {
    const ids = getSelectableTopics(DEFAULT_SAVED).map((topic) => topic.id)
    expect(ids).toEqual(["singing", "mv", "chatting", "gta", "seven_days_to_die", "mahjong_soul", "endfield"])
  })

  it("excludes a topic already claimed by a saved card", () => {
    const ids = getSelectableTopics(["valorant"]).map((topic) => topic.id)
    expect(ids).not.toContain("valorant")
  })

  it("excludes every saved topic when more than one is already claimed", () => {
    const ids = getSelectableTopics(["gta", "valorant"]).map((topic) => topic.id)
    expect(ids).not.toContain("gta")
    expect(ids).not.toContain("valorant")
  })

  it("returns every topic when nothing is saved yet", () => {
    expect(getSelectableTopics([]).length).toBe(12)
  })
})
