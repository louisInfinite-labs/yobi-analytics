import { describe, expect, it } from "vitest"
import { resolveTopicIds } from "./topicResolution"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

/** Real backend topic data (src/tracking/video_topics.py's TOPICS, as GET /topics would actually return
 * it with this task's own searchAliases addition) -- proves the resolver against production wiring, not
 * an invented fixture, for every case where a real topic/alias exists. */
const REAL_TOPICS: BackendVideoTopic[] = [
  { id: "valorant", labels: { "zh-TW": "VALO", en: "VALO", ja: "VALO" }, searchAliases: ["valorant", "valo", "バロラント", "ヴァロ", "ヴァロラント"] },
  {
    id: "sf6",
    labels: { "zh-TW": "SF6", en: "SF6", ja: "SF6" },
    searchAliases: ["sf6", "street fighter 6", "street fighter vi", "ストリートファイター6", "スト6", "スト 6"],
  },
  { id: "apex", labels: { "zh-TW": "Apex", en: "Apex", ja: "Apex" }, searchAliases: ["apex", "apex legends", "エーペックス", "エペ"] },
  { id: "minecraft", labels: { "zh-TW": "Minecraft", en: "Minecraft", ja: "Minecraft" }, searchAliases: ["minecraft", "マインクラフト", "マイクラ"] },
  { id: "chatting", labels: { "zh-TW": "雜談", en: "Chatting", ja: "雑談" }, searchAliases: ["雑談", "zatsudan", "free talk", "chatting"] },
  { id: "other", labels: { "zh-TW": "其他", en: "Other", ja: "その他" }, searchAliases: [] },
]

describe("resolveTopicIds -- display locale never limits Search match language", () => {
  it("resolves the English label/id regardless of current UI locale (locale is not even a parameter)", () => {
    expect(resolveTopicIds("VALO", REAL_TOPICS)).toEqual(["valorant"])
    expect(resolveTopicIds("valo", REAL_TOPICS)).toEqual(["valorant"])
  })

  it("resolves a real Japanese search alias even though the displayed label for that locale is English (\"VALO\")", () => {
    expect(resolveTopicIds("バロラント", REAL_TOPICS)).toEqual(["valorant"])
    expect(resolveTopicIds("ヴァロ", REAL_TOPICS)).toEqual(["valorant"])
  })

  it("resolves the real zh-TW label text directly", () => {
    expect(resolveTopicIds("雜談", REAL_TOPICS)).toEqual(["chatting"])
  })

  it("resolves a real alias in one script while the catalog's displayed label for that topic is a different script entirely", () => {
    // sf6's own displayed labels are all "SF6" (zh-TW/en/ja identical) -- スト6 is a Japanese-only alias.
    expect(resolveTopicIds("スト6", REAL_TOPICS)).toEqual(["sf6"])
  })
})

describe("resolveTopicIds -- the topic id itself resolves", () => {
  it("resolves the raw id text directly", () => {
    expect(resolveTopicIds("minecraft", REAL_TOPICS)).toEqual(["minecraft"])
  })
})

describe("resolveTopicIds -- searchAliases resolve", () => {
  it("resolves a multi-word real alias", () => {
    expect(resolveTopicIds("street fighter 6", REAL_TOPICS)).toEqual(["sf6"])
  })

  it("resolves a shorter real alias prefix", () => {
    expect(resolveTopicIds("エペ", REAL_TOPICS)).toEqual(["apex"])
  })
})

describe("resolveTopicIds -- no match / no fuzzy correction", () => {
  it("returns [] for text matching no topic", () => {
    expect(resolveTopicIds("completely unrelated text", REAL_TOPICS)).toEqual([])
  })

  it("returns [] for a typo that is not a literal prefix of any real form", () => {
    expect(resolveTopicIds("minceraft", REAL_TOPICS)).toEqual([])
    expect(resolveTopicIds("birtgday", REAL_TOPICS)).toEqual([])
  })

  it("returns [] for an empty or whitespace-only query -- NEVER every topic", () => {
    expect(resolveTopicIds("", REAL_TOPICS)).toEqual([])
    expect(resolveTopicIds("   ", REAL_TOPICS)).toEqual([])
  })

  it("a topic with no searchAliases field at all (optional) does not throw", () => {
    const topics: BackendVideoTopic[] = [{ id: "asmr", labels: { en: "ASMR" } }]
    expect(resolveTopicIds("asmr", topics)).toEqual(["asmr"])
  })
})

describe("resolveTopicIds -- multiple matches return multiple canonical ids", () => {
  it("unions every topic the query is a prefix of, using FIXTURE-ONLY topics (the real 8-topic set is disjoint per query)", () => {
    const topics: BackendVideoTopic[] = [
      { id: "topic_a", labels: { en: "Topic A" }, searchAliases: ["zz-alpha"] },
      { id: "topic_b", labels: { en: "Topic B" }, searchAliases: ["zz-beta"] },
      { id: "topic_c", labels: { en: "Topic C" }, searchAliases: ["unrelated"] },
    ]
    expect(resolveTopicIds("zz", topics)).toEqual(["topic_a", "topic_b"])
  })
})

describe("resolveTopicIds -- monotonicity (required for Search-session cache safety)", () => {
  it("extending a real multi-token alias never gains a topic a shorter qualifying prefix did not already have", () => {
    const query = "street fighter 6"
    let previous = new Set(resolveTopicIds(query, REAL_TOPICS))
    for (let end = query.length - 1; end > 0; end--) {
      const shorter = new Set(resolveTopicIds(query.slice(0, end), REAL_TOPICS))
      for (const id of previous) expect(shorter.has(id)).toBe(true)
      previous = shorter
    }
  })

  it("extending a real single alias ('valo' -> 'valorant') never gains a topic", () => {
    const query = "valorant"
    let previous = new Set(resolveTopicIds(query, REAL_TOPICS))
    for (let end = query.length - 1; end > 0; end--) {
      const shorter = new Set(resolveTopicIds(query.slice(0, end), REAL_TOPICS))
      for (const id of previous) expect(shorter.has(id)).toBe(true)
      previous = shorter
    }
  })
})
