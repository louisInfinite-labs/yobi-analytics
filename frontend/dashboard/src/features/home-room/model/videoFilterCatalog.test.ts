import { describe, expect, it } from "vitest"
import { buildVideoFilterEntries } from "./videoFilterCatalog"
import type { BackendVideoTopic } from "./videoTopicCatalog"

// GET /topics: id + per-locale labels, in the backend's own display order (src/tracking/video_topics.py).
const TOPICS: BackendVideoTopic[] = [
  { id: "valorant", labels: { "zh-TW": "VALO", en: "VALO", ja: "VALO" } },
  { id: "sf6", labels: { "zh-TW": "SF6", en: "SF6", ja: "SF6" } },
  { id: "apex", labels: { "zh-TW": "Apex", en: "Apex", ja: "Apex" } },
  { id: "minecraft", labels: { "zh-TW": "Minecraft", en: "Minecraft", ja: "Minecraft" } },
  { id: "singing", labels: { "zh-TW": "歌回", en: "Singing", ja: "歌枠" } },
  { id: "mv", labels: { "zh-TW": "MV", en: "MV", ja: "MV" } },
  { id: "chatting", labels: { "zh-TW": "雜談", en: "Chatting", ja: "雑談" } },
  { id: "other", labels: { "zh-TW": "其他", en: "Other", ja: "その他" } },
]

describe("buildVideoFilterEntries (the one filter list shared by Home and the push settings)", () => {
  it("orders the topics as the backend does with Short immediately before Other", () => {
    expect(buildVideoFilterEntries(TOPICS, "en").map((entry) => entry.id)).toEqual([
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

  it("labels Short Short / Short / ショット in zh-TW / en / ja", () => {
    const shortLabel = (locale: "zh-TW" | "en" | "ja") => buildVideoFilterEntries(TOPICS, locale).find((entry) => entry.id === "short")?.label
    expect(shortLabel("zh-TW")).toBe("Short")
    expect(shortLabel("en")).toBe("Short")
    expect(shortLabel("ja")).toBe("ショット")
  })

  it("keeps the semantic kind: topics are topics, Short is a content format", () => {
    const entries = buildVideoFilterEntries(TOPICS, "en")

    expect(entries.filter((entry) => entry.kind === "format").map((entry) => entry.id)).toEqual(["short"])
    expect(entries.filter((entry) => entry.kind === "topic")).toHaveLength(TOPICS.length)
  })

  it("never contains the browsing shortcuts", () => {
    const ids = buildVideoFilterEntries(TOPICS, "en").map((entry) => entry.id)

    expect(ids).not.toContain("all")
    expect(ids).not.toContain("latestVideos")
    expect(ids).not.toContain("latestLive")
  })

  it("puts Short last when the backend has no Other topic, and is only Short while the topics have not loaded", () => {
    expect(buildVideoFilterEntries(TOPICS.slice(0, 2), "en").map((entry) => entry.id)).toEqual(["valorant", "sf6", "short"])
    expect(buildVideoFilterEntries(null, "en").map((entry) => entry.id)).toEqual(["short"])
  })
})
