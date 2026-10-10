import { describe, expect, it } from "vitest"
import { buildVideoFilterEntries } from "../../home-room/model/videoFilterCatalog"
import { ALL_TOPICS_ID, getSelectableTopics, isShortCard, LEGACY_TOPIC_ID_ALIASES, RETIRED_TOPIC_IDS, SHORT_TOPIC_ID } from "./notificationTopicCatalog"

const DEFAULT_SAVED = ["all", "sf6", "valorant", "apex", "minecraft"]
// GET /topics, in the backend's order (src/tracking/video_topics.py).
const BACKEND_TOPICS = ["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"].map((id) => ({ id, labels: { en: id } }))
const ENTRIES = buildVideoFilterEntries(BACKEND_TOPICS, "en")

describe("the selectable categories are Home's list", () => {
  it("is VALO, SF6, Apex, Minecraft, Singing, MV, Chatting, Short, Other -- Short immediately before Other", () => {
    expect(getSelectableTopics(ENTRIES, []).map((entry) => entry.id)).toEqual([
      "valorant",
      "sf6",
      "apex",
      "minecraft",
      "singing",
      "mv",
      "chatting",
      "short",
      "other",
    ])
  })

  it("no longer offers the old notification-only hard-coded categories", () => {
    const ids = getSelectableTopics(ENTRIES, []).map((entry) => entry.id)
    for (const retired of ["gta", "seven_days_to_die", "mahjong_soul", "endfield"]) {
      expect(ids).not.toContain(retired)
      expect(RETIRED_TOPIC_IDS.has(retired)).toBe(true)
    }
  })

  it("excludes the cards already saved: after the 5 permanent defaults the dropdown offers the rest, in order", () => {
    expect(getSelectableTopics(ENTRIES, DEFAULT_SAVED).map((entry) => entry.id)).toEqual(["singing", "mv", "chatting", "short", "other"])
  })

  it("excludes a Short card once it is saved", () => {
    expect(getSelectableTopics(ENTRIES, [...DEFAULT_SAVED, "short"]).map((entry) => entry.id)).toEqual(["singing", "mv", "chatting", "other"])
  })

  it("offers only Short while GET /topics has not loaded (never a hardcoded topic list)", () => {
    expect(getSelectableTopics(buildVideoFilterEntries(null, "en"), DEFAULT_SAVED).map((entry) => entry.id)).toEqual(["short"])
  })
})

describe("ids", () => {
  it("keeps `all` as the creator-level scope id, not a backend topic", () => {
    expect(ALL_TOPICS_ID).toBe("all")
  })

  it("maps the one legacy id (valo) to its canonical id", () => {
    expect(LEGACY_TOPIC_ID_ALIASES).toEqual({ valo: "valorant" })
  })

  it("identifies the Short card by Home's own Short filter id, which is a content format and not a backend topic", () => {
    expect(SHORT_TOPIC_ID).toBe("short")
    expect(isShortCard("short")).toBe(true)
    expect(isShortCard("mv")).toBe(false)
    expect(ENTRIES.find((entry) => entry.id === SHORT_TOPIC_ID)?.kind).toBe("format")
  })
})
