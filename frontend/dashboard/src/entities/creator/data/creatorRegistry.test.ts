import { describe, expect, it } from "vitest"
import creatorMasterFile from "./generated/creatorMaster.json"
import { mockCreators } from "./mockCreators"
import {
  getCreatorById,
  getCreatorByYoutubeChannelId,
  getCreators,
  isCurrentMemberEligible,
  isLiveStatusDisplayEligible,
  isMyOshiEligible,
  resolveCreatorKey,
  toLegacyRosterId,
} from "./creatorRegistry"
import type { CanonicalCreator } from "../model/creatorMaster"

/** A default active/member/current CanonicalCreator, overridable per test --
 * eligibility tests build records directly rather than going through the
 * registry, since isCurrentMemberEligible takes a CanonicalCreator, not a key. */
function creator(overrides: Partial<CanonicalCreator> = {}): CanonicalCreator {
  return {
    creatorId: "test_creator",
    displayName: "Test Creator",
    avatarUrl: null,
    organization: "vspo",
    branch: "vspo_jp",
    groupKey: ["NO"],
    channelType: "member",
    themeColor: null,
    lifecycleStage: "active",
    displayOrder: 0,
    active: true,
    youtubeChannelId: "UC_TEST",
    ...overrides,
  }
}

describe("getCreators", () => {
  it("contains every generated creator", () => {
    expect(getCreators().length).toBe(creatorMasterFile.creators.length)
    expect(getCreators().length).toBeGreaterThan(0)
  })

  it("is a read-only view of the same underlying data getCreatorById reads from", () => {
    const first = getCreators()[0]
    expect(getCreatorById(first.creatorId)).toEqual(first)
  })
})

describe("getCreatorById", () => {
  it("resolves a canonical creatorId", () => {
    expect(getCreatorById("aizawa_ema")?.displayName).toBeDefined()
  })

  it("returns undefined for an unknown creatorId", () => {
    expect(getCreatorById("nonexistent_creator")).toBeUndefined()
  })
})

describe("resolveCreatorKey", () => {
  it("resolves a canonical creatorId", () => {
    expect(resolveCreatorKey("aizawa_ema")?.creatorId).toBe("aizawa_ema")
  })

  it("resolves an ordinary ch_-prefixed id by stripping the prefix", () => {
    expect(resolveCreatorKey("ch_aizawa_ema")?.creatorId).toBe("aizawa_ema")
  })

  it("resolves every alias directly from the generated legacyAliases table (not a duplicated TS copy)", () => {
    const aliases = creatorMasterFile.legacyAliases
    expect(Object.keys(aliases).length).toBeGreaterThan(0)
    for (const [legacyId, canonicalId] of Object.entries(aliases)) {
      const resolved = resolveCreatorKey(legacyId)
      expect(resolved).toBeDefined()
      expect(resolved?.creatorId).toBe(canonicalId)
    }
  })

  it("does not resolve ch_hololive_staff (mock/legacy-only, no Creator Master counterpart)", () => {
    expect(resolveCreatorKey("ch_hololive_staff")).toBeUndefined()
  })

  it("returns undefined for an unknown canonical id", () => {
    expect(resolveCreatorKey("nonexistent_creator")).toBeUndefined()
  })

  it("returns undefined for an unknown ch_-prefixed id", () => {
    expect(resolveCreatorKey("ch_nonexistent_creator")).toBeUndefined()
  })

  it("returns undefined for blank or malformed input", () => {
    expect(resolveCreatorKey("")).toBeUndefined()
    expect(resolveCreatorKey("   ")).toBeUndefined()
    expect(resolveCreatorKey(undefined as unknown as string)).toBeUndefined()
    expect(resolveCreatorKey(null as unknown as string)).toBeUndefined()
  })
})

describe("toLegacyRosterId", () => {
  it("produces the ordinary ch_-prefixed form for a creator with no special alias", () => {
    const kagaSumire = getCreatorById("kaga_sumire")!
    expect(toLegacyRosterId(kagaSumire)).toBe("ch_kaga_sumire")
  })

  it("airani_iofifteen: NOT the naive ch_airani_iofifteen -- must reverse-derive the real legacy id ch_iofi", () => {
    const iofi = getCreatorById("airani_iofifteen")!
    expect(toLegacyRosterId(iofi)).toBe("ch_iofi")
    expect(toLegacyRosterId(iofi)).not.toBe("ch_airani_iofifteen")
  })

  it("watson_amelia reverse-derives ch_amelia_myth_graduated, not ch_watson_amelia", () => {
    const amelia = getCreatorById("watson_amelia")!
    expect(toLegacyRosterId(amelia)).toBe("ch_amelia_myth_graduated")
  })

  it("vspo_official reverse-derives ch_vspo_group, not ch_vspo_official", () => {
    const vspoOfficial = getCreatorById("vspo_official")!
    expect(toLegacyRosterId(vspoOfficial)).toBe("ch_vspo_group")
  })

  it("round-trips every legacyAliases entry back to its exact original legacy id: legacy -> resolveCreatorKey -> canonical -> toLegacyRosterId -> the SAME legacy id", () => {
    for (const [legacyId] of Object.entries(creatorMasterFile.legacyAliases)) {
      const resolved = resolveCreatorKey(legacyId)
      expect(resolved).toBeDefined()
      expect(toLegacyRosterId(resolved!)).toBe(legacyId)
    }
  })

  it("is derived from the single generated legacyAliases table, not a second hand-maintained mapping -- every alias target is reverse-mapped by exactly one legacy key", () => {
    const targets = Object.values(creatorMasterFile.legacyAliases)
    expect(new Set(targets).size).toBe(targets.length)
  })
})

describe("getCreatorByYoutubeChannelId", () => {
  it("resolves a valid youtubeChannelId", () => {
    const known = getCreators()[0]
    expect(getCreatorByYoutubeChannelId(known.youtubeChannelId)?.creatorId).toBe(known.creatorId)
  })

  it("returns undefined for an unknown youtubeChannelId", () => {
    expect(getCreatorByYoutubeChannelId("UC_DOES_NOT_EXIST")).toBeUndefined()
  })

  it("returns undefined for blank input", () => {
    expect(getCreatorByYoutubeChannelId("")).toBeUndefined()
  })

  it("has no duplicate youtubeChannelId across the generated registry (module load would have thrown otherwise)", () => {
    const ids = getCreators().map((c) => c.youtubeChannelId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("resolves every real creator's own youtubeChannelId back to itself", () => {
    for (const c of getCreators()) {
      expect(getCreatorByYoutubeChannelId(c.youtubeChannelId)?.creatorId).toBe(c.creatorId)
    }
  })
})

describe("generated field preservation", () => {
  it("preserves avatarUrl exactly as generated for every current creator", () => {
    const avatarUrlById = new Map(creatorMasterFile.creators.map((c) => [c.creatorId, c.avatarUrl]))
    expect(getCreators().every((c) => c.avatarUrl === avatarUrlById.get(c.creatorId))).toBe(true)
  })

  it("preserves active as a real boolean on every creator", () => {
    expect(getCreators().every((c) => typeof c.active === "boolean")).toBe(true)
  })
})

describe("isCurrentMemberEligible", () => {
  it("active member is eligible", () => {
    expect(isCurrentMemberEligible(creator({ lifecycleStage: "active" }))).toBe(true)
  })

  it("pre_debut member is eligible", () => {
    expect(isCurrentMemberEligible(creator({ lifecycleStage: "pre_debut" }))).toBe(true)
  })

  it("graduated member is not eligible", () => {
    expect(isCurrentMemberEligible(creator({ lifecycleStage: "graduated" }))).toBe(false)
  })

  it("retired member is not eligible", () => {
    expect(isCurrentMemberEligible(creator({ lifecycleStage: "retired" }))).toBe(false)
  })

  it("group is not eligible, regardless of lifecycleStage", () => {
    expect(isCurrentMemberEligible(creator({ channelType: "group", lifecycleStage: "active" }))).toBe(false)
    expect(isCurrentMemberEligible(creator({ channelType: "group", lifecycleStage: "pre_debut" }))).toBe(false)
  })

  it("staff is not eligible", () => {
    expect(isCurrentMemberEligible(creator({ channelType: "staff", lifecycleStage: "active" }))).toBe(false)
  })

  it("active=false is not eligible even if lifecycleStage says active", () => {
    expect(isCurrentMemberEligible(creator({ active: false, lifecycleStage: "active" }))).toBe(false)
  })

  it("vspo_official (real generated data) resolves but is ineligible", () => {
    const vspoOfficial = getCreatorById("vspo_official")
    expect(vspoOfficial).toBeDefined()
    expect(isCurrentMemberEligible(vspoOfficial!)).toBe(false)
  })

  it("hololive_asobimawaritai (real generated data) resolves but is ineligible", () => {
    const asobimawaritai = getCreatorById("hololive_asobimawaritai")
    expect(asobimawaritai).toBeDefined()
    expect(asobimawaritai?.channelType).toBe("group")
    expect(asobimawaritai?.lifecycleStage).toBe("pre_debut")
    expect(isCurrentMemberEligible(asobimawaritai!)).toBe(false)
  })
})

describe("isLiveStatusDisplayEligible / isMyOshiEligible are separate from the current-member rule", () => {
  it("Live Status displays every channel: member (any lifecycle), group and staff", () => {
    for (const lifecycleStage of ["active", "pre_debut", "graduated"] as const) {
      expect(isLiveStatusDisplayEligible(creator({ lifecycleStage }))).toBe(true)
    }
    expect(isLiveStatusDisplayEligible(creator({ channelType: "group" }))).toBe(true)
    expect(isLiveStatusDisplayEligible(creator({ channelType: "staff" }))).toBe(true)
  })

  it("My Oshi accepts an individual creator in any stage, including graduated", () => {
    for (const lifecycleStage of ["active", "pre_debut", "graduated"] as const) {
      expect(isMyOshiEligible(creator({ lifecycleStage }))).toBe(true)
    }
  })

  it("My Oshi never accepts a group or staff channel, whatever its lifecycle", () => {
    for (const channelType of ["group", "staff"] as const) {
      for (const lifecycleStage of ["active", "pre_debut", "graduated"] as const) {
        expect(isMyOshiEligible(creator({ channelType, lifecycleStage }))).toBe(false)
      }
    }
  })

  it("a graduated member is Live Status- and My Oshi-eligible but not a CURRENT member", () => {
    const graduated = creator({ lifecycleStage: "graduated" })

    expect(isLiveStatusDisplayEligible(graduated)).toBe(true)
    expect(isMyOshiEligible(graduated)).toBe(true)
    expect(isCurrentMemberEligible(graduated)).toBe(false)
  })

  it("real generated data: every channel displayed, Oshi-eligible = individual creators (incl. 13 graduated), non-members never", () => {
    const all = getCreators()
    const members = all.filter((c) => c.channelType === "member")

    expect(all.filter(isLiveStatusDisplayEligible)).toHaveLength(all.length)
    expect(all.filter(isMyOshiEligible)).toHaveLength(members.length)
    expect(all.filter((c) => c.lifecycleStage === "graduated" && isMyOshiEligible(c))).toHaveLength(13)
    expect(all.filter((c) => c.channelType !== "member" && isMyOshiEligible(c))).toHaveLength(0)
    expect(all.filter((c) => c.channelType !== "member").map((c) => c.creatorId).sort()).toEqual(
      [
        "achrora",
        "fuwamoco",
        "holoan_room",
        "hololive_asobimawaritai",
        "hololive_dev_is_flow_glow",
        "hololive_dev_is_regloss",
        "hololive_official",
        "unit_b_pre_debut",
        "vspo_official",
      ].sort(),
    )
  })

  it("hololive_official is the main hololive channel (verified id), a displayed non-member, and ch_hololive_staff stays unresolved", () => {
    const official = getCreatorById("hololive_official")!

    expect(official.youtubeChannelId).toBe("UCJFZiqLMntJufDCHc6bQixg")
    expect(official.channelType).toBe("group")
    expect(official.branch).toBe("holo_jp")
    expect(isLiveStatusDisplayEligible(official)).toBe(true)
    expect(isMyOshiEligible(official)).toBe(false)
    expect(getCreatorByYoutubeChannelId("UCJFZiqLMntJufDCHc6bQixg")?.creatorId).toBe("hololive_official")
    expect(resolveCreatorKey("ch_hololive_staff")).toBeUndefined()
  })

  it("the frontend predicates agree with the backend rules on the real master (display=all, Oshi=members)", () => {
    for (const c of getCreators()) {
      expect(isLiveStatusDisplayEligible(c), c.creatorId).toBe(c.active)
      expect(isMyOshiEligible(c), c.creatorId).toBe(c.active && c.channelType === "member")
    }
  })
})

describe("Hololive creator theme colors come from the canonical backend data", () => {
  const colorOf = (creatorId: string) => getCreators().find((creator) => creator.creatorId === creatorId)?.themeColor?.toLowerCase()

  it("天音かなた is #76c0ea (Oshimark's first Image Color), where the registry used to have none", () => {
    expect(colorOf("amane_kanata")).toBe("#76c0ea")
  })

  it.each([
    ["hoshimachi_suisei", "#2dcde4"], // Hololive JP
    ["takanashi_kiara", "#dc3907"], // Hololive EN
    ["kobo_kanaeru", "#161c4f"], // Hololive ID
    ["hiodoshi_ao", "#16264b"], // graduated
  ])("%s uses %s", (creatorId, expected) => {
    expect(colorOf(creatorId)).toBe(expected)
  })

  it("every Hololive individual that has a canonical color has a valid #RRGGBB one", () => {
    const hololiveIndividuals = getCreators().filter((creator) => creator.organization === "hololive" && creator.channelType === "member")
    expect(hololiveIndividuals.length).toBeGreaterThan(70)
    for (const creator of hololiveIndividuals.filter((candidate) => candidate.themeColor !== null)) {
      expect(creator.themeColor, creator.creatorId).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it("no frontend-owned map duplicates the canonical colors: mockCreators carries no themeColor at all", () => {
    expect(mockCreators.length).toBeGreaterThan(0)
    expect(mockCreators.filter((creator) => "themeColor" in creator)).toEqual([])
  })
})
