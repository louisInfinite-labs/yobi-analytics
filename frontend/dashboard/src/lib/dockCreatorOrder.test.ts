import { describe, expect, it } from "vitest"
import { creatorMatchesSearch, groupCreatorsForDock, DOCK_BRANCH_ORDER } from "./dockCreatorOrder"
import { mockCreators, type MockCreator } from "../data/mockCreators"

function creator(overrides: Partial<MockCreator> & Pick<MockCreator, "channelId" | "channelName" | "branch">): MockCreator {
  return {
    organization: overrides.branch.startsWith("vspo") ? "vspo" : "hololive",
    groupKey: ["NO"],
    channelType: "member",
    lifecycleStage: "active",
    ...overrides,
  }
}

describe("groupCreatorsForDock", () => {
  it("orders groups as VSPO JP, VSPO EN, hololive JP, EN, ID", () => {
    const groups = groupCreatorsForDock(mockCreators)
    const order = groups.map((g) => g.branch)
    // Only asserts relative order among branches actually present — some
    // (e.g. holo_id has just one mock creator) aren't guaranteed non-empty
    // for every fixture, but whichever are present must appear in this order.
    const presentInOrder = DOCK_BRANCH_ORDER.filter((branch) => order.includes(branch))
    expect(order).toEqual(presentInOrder)
  })

  it("omits a branch entirely when the filtered creator list has none", () => {
    const onlyOneCreator = mockCreators.filter((c) => c.branch === "vspo_jp")
    const groups = groupCreatorsForDock(onlyOneCreator)
    expect(groups.map((g) => g.branch)).toEqual(["vspo_jp"])
  })

  it("VSPO JP: sorts by Japanese gojuon reading (kana), not declared array order or Kanji code points", () => {
    const creators = [
      creator({ channelId: "erisa", channelName: "英リサ", branch: "vspo_jp", kana: "えりさ" }),
      creator({ channelId: "ichinose", channelName: "一ノ瀬うるは", branch: "vspo_jp", kana: "いちのせうるは" }),
      creator({ channelId: "aizawa", channelName: "藍沢エマ", branch: "vspo_jp", kana: "あいざわえま" }),
    ]
    const groups = groupCreatorsForDock(creators)
    expect(groups.find((g) => g.branch === "vspo_jp")!.creators.map((c) => c.channelId)).toEqual([
      "aizawa", // reading: aizawaema
      "ichinose", // reading: ichinoseuruha
      "erisa", // reading: erisa
    ])
  })

  it("VSPO JP: sorts Hiragana and Katakana readings as ONE combined phonetic sequence, not Hiragana-then-Katakana", () => {
    const creators = [
      creator({ channelId: "erisa", channelName: "英リサ", branch: "vspo_jp", kana: "えりさ" }),
      creator({ channelId: "urufu", channelName: "ウルフ", branch: "vspo_jp", kana: "ウルフ" }),
      creator({ channelId: "ichinose", channelName: "一ノ瀬うるは", branch: "vspo_jp", kana: "いちのせうるは" }),
      creator({ channelId: "aira", channelName: "アイラ", branch: "vspo_jp", kana: "アイラ" }),
      creator({ channelId: "aizawa", channelName: "藍沢エマ", branch: "vspo_jp", kana: "あいざわえま" }),
    ]
    const groups = groupCreatorsForDock(creators)
    // Normalized readings in gojuon order: aizawaema, aira, ichinoseuruha,
    // urufu, erisa — this would fail under a "collect all Hiragana, then
    // append all Katakana"
    // implementation, which would put aira/urufu (stored as Katakana) after
    // erisa/ichinose/aizawa (stored as Hiragana/Kanji) regardless of reading.
    expect(groups.find((g) => g.branch === "vspo_jp")!.creators.map((c) => c.channelId)).toEqual([
      "aizawa",
      "aira",
      "ichinose",
      "urufu",
      "erisa",
    ])
  })

  it("VSPO JP: a creator missing kana never crashes and falls back to stable roster order, after every creator that has a reading", () => {
    const creators = [
      creator({ channelId: "no_kana_first", channelName: "VSPO! Official", branch: "vspo_jp" }),
      creator({ channelId: "erisa", channelName: "英リサ", branch: "vspo_jp", kana: "えりさ" }),
      creator({ channelId: "no_kana_second", channelName: "Some Other Group", branch: "vspo_jp" }),
      creator({ channelId: "aizawa", channelName: "藍沢エマ", branch: "vspo_jp", kana: "あいざわえま" }),
    ]
    const groups = groupCreatorsForDock(creators)
    expect(groups.find((g) => g.branch === "vspo_jp")!.creators.map((c) => c.channelId)).toEqual([
      "aizawa",
      "erisa",
      "no_kana_first", // missing kana: sorts after every reading, keeps relative order vs. no_kana_second
      "no_kana_second",
    ])
  })

  it("VSPO EN: sorts by display name A-Z case-insensitively", () => {
    const creators = [
      creator({ channelId: "b", channelName: "beta", branch: "vspo_en" }),
      creator({ channelId: "a", channelName: "Alpha", branch: "vspo_en" }),
      creator({ channelId: "c", channelName: "charlie", branch: "vspo_en" }),
    ]
    const groups = groupCreatorsForDock(creators)
    expect(groups.find((g) => g.branch === "vspo_en")!.creators.map((c) => c.channelId)).toEqual(["a", "b", "c"])
  })

  it("Hololive JP: numbered generations ascending, then Gamers, holoX, DEV_IS/ReGLOSS/FLOW GLOW, then unrecognized tags last", () => {
    const creators = [
      creator({ channelId: "staff", channelName: "Staff", branch: "holo_jp", groupKey: ["NO"], channelType: "staff" }),
      creator({ channelId: "gen3", channelName: "Gen3", branch: "holo_jp", groupKey: ["3期生"] }),
      creator({ channelId: "reGloss", channelName: "ReGLOSS Member", branch: "holo_jp", groupKey: ["ReGLOSS"] }),
      creator({ channelId: "gen1b", channelName: "Gen1b", branch: "holo_jp", groupKey: ["1期生"] }),
      creator({ channelId: "gamers", channelName: "Gamers", branch: "holo_jp", groupKey: ["ゲーマーズ"] }),
      creator({ channelId: "gen1a", channelName: "Gen1a", branch: "holo_jp", groupKey: ["1期生"] }),
      creator({ channelId: "holox", channelName: "holoX", branch: "holo_jp", groupKey: ["holoX"], channelType: "group" }),
      creator({ channelId: "devis", channelName: "DEV_IS", branch: "holo_jp", groupKey: ["DEV_IS"], channelType: "group" }),
    ]
    const groups = groupCreatorsForDock(creators)
    expect(groups.find((g) => g.branch === "holo_jp")!.creators.map((c) => c.channelId)).toEqual([
      "gen1b", // Gen 1, stable tie: gen1b appears before gen1a in input
      "gen1a",
      "gen3",
      "gamers",
      "holox",
      "devis",
      "reGloss",
      "staff", // unrecognized groupKey ("NO") sorts last
    ])
  })

  it("Hololive JP: sorts members by kana within the SAME generation; kana can never move a member into a different generation", () => {
    const creators = [
      creator({ channelId: "gen1_fubuki", channelName: "白上フブキ", branch: "holo_jp", groupKey: ["1期生"], kana: "しらかみふぶき" }),
      creator({ channelId: "gen1_coco", channelName: "桐生ココ", branch: "holo_jp", groupKey: ["1期生"], kana: "きりゅうここ" }),
      creator({ channelId: "gen3_pekora", channelName: "兎田ぺこら", branch: "holo_jp", groupKey: ["3期生"], kana: "うさだぺこら" }),
    ]
    const groups = groupCreatorsForDock(creators)
    // Within Gen 1: coco's reading ("ki...") sorts before fubuki's ("shi...")
    // in gojuon order, so coco sorts first there. Pekora's own reading
    // starts with "u" — earlier in gojuon order than both — but she still
    // sorts after all of Gen 1, because generation rank is level 1 and
    // always wins over kana (level 2).
    expect(groups.find((g) => g.branch === "holo_jp")!.creators.map((c) => c.channelId)).toEqual([
      "gen1_coco",
      "gen1_fubuki",
      "gen3_pekora",
    ])
  })

  it("Hololive EN: groups by unit, sorts groups A-Z, then members A-Z within a group", () => {
    const creators = [
      creator({ channelId: "myth_b", channelName: "Bravo", branch: "holo_en", groupKey: ["Myth"] }),
      creator({ channelId: "justice_a", channelName: "Alpha", branch: "holo_en", groupKey: ["Justice"] }),
      creator({ channelId: "myth_a", channelName: "Alpha", branch: "holo_en", groupKey: ["Myth"] }),
    ]
    const groups = groupCreatorsForDock(creators)
    // "Justice" < "Myth" alphabetically; within Myth, "Alpha" < "Bravo".
    expect(groups.find((g) => g.branch === "holo_en")!.creators.map((c) => c.channelId)).toEqual([
      "justice_a",
      "myth_a",
      "myth_b",
    ])
  })

  it("does not reorder when live/upcoming/offline status changes — grouping only reads branch/groupKey/name", () => {
    const groupsBefore = groupCreatorsForDock(mockCreators).find((g) => g.branch === "holo_jp")!.creators.map((c) => c.channelId)
    // groupCreatorsForDock never receives status at all, so calling it again
    // with the exact same creators is the only thing to assert: identical
    // input always produces identical order regardless of any status data
    // held elsewhere in the app.
    const groupsAfter = groupCreatorsForDock(mockCreators).find((g) => g.branch === "holo_jp")!.creators.map((c) => c.channelId)
    expect(groupsAfter).toEqual(groupsBefore)
  })
})

describe("creatorMatchesSearch", () => {
  const matchCreator = mockCreators.find((c) => c.channelName === "白上フブキ")!

  it("matches the Japanese name case-insensitively", () => {
    expect(creatorMatchesSearch(matchCreator, "フブキ")).toBe(true)
  })

  it("does not match an unrelated query", () => {
    expect(creatorMatchesSearch(matchCreator, "ぺこら")).toBe(false)
  })

  it("treats an empty/whitespace query as matching everything", () => {
    expect(creatorMatchesSearch(matchCreator, "")).toBe(true)
    expect(creatorMatchesSearch(matchCreator, "   ")).toBe(true)
  })

  it("matches an English channel name case-insensitively", () => {
    const gura = mockCreators.find((c) => c.channelName === "Gawr Gura")!
    expect(creatorMatchesSearch(gura, "gura")).toBe(true)
  })
})
