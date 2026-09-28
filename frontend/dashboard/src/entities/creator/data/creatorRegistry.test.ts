import { describe, expect, it } from "vitest"
import creatorMasterFile from "./generated/creatorMaster.json"
import {
  getCreatorById,
  getCreatorByYoutubeChannelId,
  getCreators,
  isCurrentMemberEligible,
  resolveCreatorKey,
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
