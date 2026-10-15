import { describe, expect, it } from "vitest"
import {
  ALL_TOPICS_ID,
  NOTIFICATION_TOPIC_IDS,
  buildNotificationTopicEntries,
  getSelectableTopics,
  isNotificationTopic,
  isShortCard,
  LEGACY_TOPIC_ID_ALIASES,
  RETIRED_TOPIC_IDS,
  SHORT_TOPIC_ID,
} from "./notificationTopicCatalog"
import { loadGlobalCatalog } from "../../../test/globalTopicCatalog"

const DEFAULT_SAVED = ["all", "chatting", "singing", "mv", "apex"]
// GET /topics, in the backend's order (src/tracking/video_topics.py).
const BACKEND_TOPICS = ["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"].map((id) => ({ id, labels: { en: id } }))
const ENTRIES = buildNotificationTopicEntries(BACKEND_TOPICS, "en")

describe("the selectable categories are the notification list's own", () => {
  it("is Chatting, Singing, MV, Apex, Minecraft, SF6, VALO, Short, Other, in the notification list's display order", () => {
    expect(getSelectableTopics(ENTRIES, []).map((entry) => entry.id)).toEqual([
      "chatting",
      "singing",
      "mv",
      "apex",
      "minecraft",
      "sf6",
      "valorant",
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
    expect(getSelectableTopics(ENTRIES, DEFAULT_SAVED).map((entry) => entry.id)).toEqual(["minecraft", "sf6", "valorant", "short", "other"])
  })

  it("excludes a Short card once it is saved", () => {
    expect(getSelectableTopics(ENTRIES, [...DEFAULT_SAVED, "short"]).map((entry) => entry.id)).toEqual(["minecraft", "sf6", "valorant", "other"])
  })

  it("offers only Short while GET /topics has not loaded (never a hardcoded topic list)", () => {
    expect(getSelectableTopics(buildNotificationTopicEntries(null, "en"), DEFAULT_SAVED).map((entry) => entry.id)).toEqual(["short"])
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

describe("the push-notification topic list is EXACTLY ten, in this order, whatever the catalog holds", () => {
  const EXPECTED_IDS = ["all", "chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant", "short", "other"]
  const EXPECTED_LABELS = {
    "zh-TW": ["全部", "雜談", "歌回", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "其他"],
    en: ["All", "Chatting", "Singing", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "Other"],
    ja: ["全部", "雑談", "歌枠", "MV", "Apex", "Minecraft", "SF6", "VALO", "ショット", "その他"],
  } as const

  it("the explicit configuration is the ten ids, with 全部 first", () => {
    expect(NOTIFICATION_TOPIC_IDS).toEqual(EXPECTED_IDS)
  })

  it("with the whole 52-topic GLOBAL catalog, the offered categories are the nine others (全部 is the permanent card) -- nothing appended", async () => {
    const catalog = await loadGlobalCatalog()
    expect(catalog).toHaveLength(52)

    const ids = buildNotificationTopicEntries(catalog, "zh-TW").map((entry) => entry.id)

    expect(ids).toEqual(EXPECTED_IDS.slice(1))
    expect(buildNotificationTopicEntries([...catalog].reverse(), "zh-TW").map((entry) => entry.id)).toEqual(EXPECTED_IDS.slice(1)) // not the catalog's order
  })

  it.each(["zh-TW", "en", "ja"] as const)("%s: the labels come from the catalog in the selected language", async (locale) => {
    const catalog = await loadGlobalCatalog()
    const labels = buildNotificationTopicEntries(catalog, locale).map((entry) => entry.label)

    expect(labels).toEqual(EXPECTED_LABELS[locale].slice(1))
  })

  it("never contains the Home-only browsing shortcuts 最新影片 / 最新直播 (or any such id)", async () => {
    const ids = buildNotificationTopicEntries(await loadGlobalCatalog(), "zh-TW").map((entry) => entry.id)
    const labels = buildNotificationTopicEntries(await loadGlobalCatalog(), "zh-TW").map((entry) => entry.label)

    for (const shortcut of ["latestVideos", "latestLive"]) expect(ids).not.toContain(shortcut)
    expect(labels).not.toContain("最新影片")
    expect(labels).not.toContain("最新直播")
  })

  it("a topic the catalog lacks is left out, never replaced", () => {
    const withoutMv = BACKEND_TOPICS.filter((topic) => topic.id !== "mv")

    expect(buildNotificationTopicEntries(withoutMv, "en").map((entry) => entry.id)).toEqual(["chatting", "singing", "apex", "minecraft", "sf6", "valorant", "short", "other"])
  })

  it("isNotificationTopic: the ten are shown; any other id (a topic saved earlier) is not displayed", () => {
    for (const id of EXPECTED_IDS) expect(isNotificationTopic(id)).toBe(true)
    for (const id of ["phasmophobia", "among_us", "latestVideos", "latestLive", "gta"]) expect(isNotificationTopic(id)).toBe(false)
  })
})
