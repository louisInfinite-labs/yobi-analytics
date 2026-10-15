/** The Home tag bar's category part is FIXED: the catalog supplies ids and labels, never the list. */
import { describe, expect, it } from "vitest"
import { HOME_TAG_TOPIC_IDS, buildHomeVideoTagEntries, buildVideoFilterEntries } from "./videoFilterCatalog"
import type { BackendVideoTopic } from "./videoTopicCatalog"

const topic = (id: string, zh: string, en: string, ja: string): BackendVideoTopic => ({ id, labels: { "zh-TW": zh, en, ja } })
const FIXED: BackendVideoTopic[] = [
  topic("valorant", "VALO", "VALO", "VALO"),
  topic("sf6", "SF6", "SF6", "SF6"),
  topic("apex", "Apex", "Apex", "Apex"),
  topic("minecraft", "Minecraft", "Minecraft", "Minecraft"),
  topic("singing", "歌回", "Singing", "歌枠"),
  topic("mv", "MV", "MV", "MV"),
  topic("chatting", "雜談", "Chatting", "雑談"),
  topic("other", "其他", "Other", "その他"),
]
const MORE: BackendVideoTopic[] = [
  topic("phasmophobia", "Phasmophobia", "Phasmophobia", "Phasmophobia"),
  topic("among_us", "Among Us", "Among Us", "Among Us"),
  topic("peak", "PEAK", "PEAK", "PEAK"),
]

describe("buildHomeVideoTagEntries", () => {
  it("is the fixed seven topics, then Short, then Other -- in that order, whatever order GET /topics returned", () => {
    const expected = ["chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant", "short", "other"]
    expect(buildHomeVideoTagEntries(FIXED, "en").map((entry) => entry.id)).toEqual(expected)
    expect(buildHomeVideoTagEntries([...FIXED].reverse(), "en").map((entry) => entry.id)).toEqual(expected)
    expect(HOME_TAG_TOPIC_IDS).toEqual(["chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant"])
  })

  it("never appends any other catalog topic, however many the catalog has", () => {
    const ids = buildHomeVideoTagEntries([...FIXED, ...MORE], "en").map((entry) => entry.id)

    expect(ids).toEqual(["chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant", "short", "other"])
    for (const extra of MORE) expect(ids).not.toContain(extra.id)
  })

  it("the shared notification list still carries the whole catalog (only the Home bar is fixed)", () => {
    const ids = buildVideoFilterEntries([...FIXED, ...MORE], "en").map((entry) => entry.id)

    for (const extra of MORE) expect(ids).toContain(extra.id)
  })

  it("labels come from the catalog in the selected language", () => {
    const labels = (locale: "zh-TW" | "en" | "ja") => buildHomeVideoTagEntries(FIXED, locale).map((entry) => entry.label)

    expect(labels("zh-TW")).toEqual(["雜談", "歌回", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "其他"])
    expect(labels("en")).toEqual(["Chatting", "Singing", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "Other"])
    expect(labels("ja")).toEqual(["雑談", "歌枠", "MV", "Apex", "Minecraft", "SF6", "VALO", "ショット", "その他"])
  })

  it("never invents a replacement for a topic the catalog does not have: it is simply left out", () => {
    const withoutMv = FIXED.filter((entry) => entry.id !== "mv")
    const withoutOther = FIXED.filter((entry) => entry.id !== "other")

    expect(buildHomeVideoTagEntries(withoutMv, "en").map((entry) => entry.id)).toEqual(["chatting", "singing", "apex", "minecraft", "sf6", "valorant", "short", "other"])
    expect(buildHomeVideoTagEntries(withoutOther, "en").map((entry) => entry.id).at(-1)).toBe("short")
  })

  it("keeps the kinds: topics are topics, Short is a content format", () => {
    const kinds = Object.fromEntries(buildHomeVideoTagEntries(FIXED, "en").map((entry) => [entry.id, entry.kind]))

    expect(kinds.short).toBe("format")
    expect(kinds.chatting).toBe("topic")
    expect(kinds.other).toBe("topic")
  })

  it("while GET /topics has not succeeded (null) only Short is offered -- never a hardcoded topic list", () => {
    expect(buildHomeVideoTagEntries(null, "en").map((entry) => entry.id)).toEqual(["short"])
  })
})
