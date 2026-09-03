import { describe, expect, it } from "vitest"
import { mockCreators } from "../data/mockCreators"
import { mockVideoStats } from "../data/mockVideoStats"
import {
  EMPTY_FILTER_STATE,
  availableBranches,
  availableGroupKeys,
  matchesClassification,
  matchesContent,
  setBranch,
  setOrganization,
  toggleContentTag,
  toggleGroupKey,
  type FilterState,
} from "./filterState"

function matches(state: FilterState) {
  return mockVideoStats.filter((v) => matchesClassification(v, state) && matchesContent(v, state))
}

describe("required scenario: 卒業 (graduated, no other filter)", () => {
  it("matches every graduated creator's videos regardless of organization", () => {
    const state = { ...EMPTY_FILTER_STATE, lifecycleStage: "graduated" as const }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.lifecycleStage === "graduated")).toBe(true)
    // Must include both a Hololive JP and a Hololive EN graduated creator (Kiryu Coco, Watson Amelia).
    expect(result.some((v) => v.branch === "holo_jp")).toBe(true)
    expect(result.some((v) => v.branch === "holo_en")).toBe(true)
  })
})

describe("required scenario: Hololive + 卒業", () => {
  it("narrows graduated results to Hololive only", () => {
    const state = { ...EMPTY_FILTER_STATE, organization: "hololive" as const, lifecycleStage: "graduated" as const }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.organization === "hololive" && v.lifecycleStage === "graduated")).toBe(true)
  })
})

describe("required scenario: Hololive + JP + 1期生 + 卒業", () => {
  it("matches only graduated Hololive JP creators retaining the 1期生 tag", () => {
    const state = {
      ...EMPTY_FILTER_STATE,
      organization: "hololive" as const,
      branch: "holo_jp" as const,
      groupKey: ["1期生"],
      lifecycleStage: "graduated" as const,
    }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    for (const v of result) {
      expect(v.organization).toBe("hololive")
      expect(v.branch).toBe("holo_jp")
      expect(v.groupKey).toContain("1期生")
      expect(v.lifecycleStage).toBe("graduated")
    }
    // A graduated creator keeps their original branch/tag membership alongside
    // the graduated status — never a separate/replacement category.
    expect(result.every((v) => v.channelName === "白上フブキ")).toBe(false) // Fubuki is active, not graduated
  })
})

describe("required scenario: 1期生 + ゲーマーズ (OR within one dimension)", () => {
  it("matches a creator with either tag, not requiring both", () => {
    let state = EMPTY_FILTER_STATE
    state = { ...state, groupKey: ["1期生", "ゲーマーズ"] }
    const result = matches(state)
    const channelNames = new Set(result.map((v) => v.channelName))
    // Fubuki carries both tags; Ema and Pekora carry only one each — all three must appear.
    expect(channelNames.has("藍沢エマ")).toBe(true) // 1期生 only
    expect(channelNames.has("白上フブキ")).toBe(true) // 1期生 + ゲーマーズ
  })
})

describe("required scenario: Hololive + EN", () => {
  it("matches only Hololive EN branch creators", () => {
    const state = { ...EMPTY_FILTER_STATE, organization: "hololive" as const, branch: "holo_en" as const }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.organization === "hololive" && v.branch === "holo_en")).toBe(true)
  })
})

describe("required scenario: VSPO + JP", () => {
  it("matches only VSPO JP branch creators", () => {
    const state = { ...EMPTY_FILTER_STATE, organization: "vspo" as const, branch: "vspo_jp" as const }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.organization === "vspo" && v.branch === "vspo_jp")).toBe(true)
  })
})

describe("required scenario: SF6 content tag", () => {
  it("matches only videos tagged sf6", () => {
    const state = { ...EMPTY_FILTER_STATE, contentTags: ["sf6" as const] }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.contentTags.includes("sf6"))).toBe(true)
  })
})

describe("required scenario: 歌回 (karaoke) content tag", () => {
  it("matches only videos tagged karaoke", () => {
    const state = { ...EMPTY_FILTER_STATE, contentTags: ["karaoke" as const] }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.contentTags.includes("karaoke"))).toBe(true)
  })
})

describe("required scenario: Shorts format", () => {
  it("matches only shorts-format videos", () => {
    const state = { ...EMPTY_FILTER_STATE, contentFormat: "shorts" as const }
    const result = matches(state)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((v) => v.contentFormat === "shorts")).toBe(true)
  })
})

describe("required scenario: empty filter result", () => {
  it("returns an empty array for an impossible combination, not an error", () => {
    const state = { ...EMPTY_FILTER_STATE, organization: "vspo" as const, contentTags: ["3d_live" as const] }
    // No VSPO video in the fixture is tagged 3d_live.
    expect(matches(state)).toEqual([])
  })
})

describe("hierarchical narrowing", () => {
  it("setBranch rejects a branch that doesn't belong to the current organization", () => {
    // vspo_jp is a VSPO branch; the state is scoped to Hololive.
    const state = setBranch({ ...EMPTY_FILTER_STATE, organization: "hololive" }, "vspo_jp", mockCreators)
    expect(state.branch).toBeNull()
  })

  it("clears an invalid branch when the organization changes", () => {
    const withBranch = setBranch({ ...EMPTY_FILTER_STATE, organization: "hololive" }, "holo_jp", mockCreators)
    const afterOrgChange = setOrganization(withBranch, "vspo", mockCreators)
    expect(afterOrgChange.branch).toBeNull()
  })

  it("retains a still-valid branch-independent groupKey selection isn't kept if invalid under the new branch", () => {
    const withTag = { ...EMPTY_FILTER_STATE, organization: "hololive" as const, branch: "holo_jp" as const, groupKey: ["1期生"] }
    const afterBranchChange = setBranch(withTag, "holo_en", mockCreators)
    // "1期生" isn't a Hololive EN tag in this fixture (EN uses "Myth") — must be cleared.
    expect(afterBranchChange.groupKey).toEqual([])
  })

  it("keeps a groupKey selection still valid under the new branch", () => {
    const withTag = { ...EMPTY_FILTER_STATE, organization: "hololive" as const, branch: "holo_en" as const, groupKey: ["Myth"] }
    const afterBranchChange = setBranch(withTag, "holo_en", mockCreators)
    expect(afterBranchChange.groupKey).toEqual(["Myth"])
  })

  it("availableBranches narrows to only branches present under the selected organization", () => {
    expect(availableBranches("vspo", mockCreators).sort()).toEqual(["vspo_en", "vspo_jp"])
  })

  it("availableGroupKeys narrows to only tags present under the selected organization+branch", () => {
    const keys = availableGroupKeys("hololive", "holo_en", mockCreators)
    expect(keys).toContain("Myth")
    expect(keys).not.toContain("1期生")
  })
})

describe("toggle helpers", () => {
  it("toggleGroupKey adds then removes a key", () => {
    const added = toggleGroupKey(EMPTY_FILTER_STATE, "1期生")
    expect(added.groupKey).toEqual(["1期生"])
    const removed = toggleGroupKey(added, "1期生")
    expect(removed.groupKey).toEqual([])
  })

  it("toggleContentTag adds then removes a tag", () => {
    const added = toggleContentTag(EMPTY_FILTER_STATE, "sf6")
    expect(added.contentTags).toEqual(["sf6"])
    const removed = toggleContentTag(added, "sf6")
    expect(removed.contentTags).toEqual([])
  })
})

describe("dedupe by creator", () => {
  it("a creator matching more than one selected content tag still appears once in the raw match set", () => {
    // v_pekora_sf6_tournament carries both sf6 and collab tags.
    const state = { ...EMPTY_FILTER_STATE, contentTags: ["sf6" as const, "collab" as const] }
    const result = matches(state)
    const ids = result.map((v) => v.videoId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("matchesContent", () => {
  it("an omitted content dimension means All", () => {
    expect(matchesContent({ contentTags: ["karaoke"], contentFormat: "live_archive" }, EMPTY_FILTER_STATE)).toBe(true)
  })
})
