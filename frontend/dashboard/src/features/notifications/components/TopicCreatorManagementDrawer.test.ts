import { describe, expect, it } from "vitest"
import { excludeFavorites, filterBranchGroups, filterCreatorList } from "./TopicCreatorManagementDrawer"
import { creatorMatchesNameQuery } from "../../../entities/creator/utils/creatorNameSearch"
import { getAllNotificationCreators, groupCreatorsForNotificationSettings, sortCreatorsLikeLiveStatus, type NotificationBranchGroup } from "../model/notificationCreatorGrouping"
import { formatBranchHeading } from "../../live-status/components/LiveStatusGroups"
import { groupEligibleCreatorsForLiveStatus } from "../../live-status/utils/liveStatusCanonicalRoster"
import { isFavoriteCreatorId } from "../../favorites/utils/creatorFavoriteBridge"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { getCreatorById, isCurrentMemberEligible } from "../../../entities/creator/data/creatorRegistry"

// Exercises the actual filtering/grouping logic the drawer renders from,
// against the real Creator Master roster (creators.json, via
// notificationCreatorGrouping.ts) -- not a hand-written fixture -- so a
// regression in the real data's shape (a renamed branch, a creator moved
// between agencies) would surface here too. No antd/React rendering
// involved: these are the same plain functions TopicCreatorManagementDrawer
// itself calls, just exported for direct testing (see that file's own
// comment on filterCreatorList).
describe("TopicCreatorManagementDrawer filtering/grouping logic", () => {
  const allCreators = getAllNotificationCreators()
  const baseGroups = groupCreatorsForNotificationSettings()

  function findCreator(creatorId: string) {
    const creator = allCreators.find((entry) => entry.creatorId === creatorId)
    if (!creator) throw new Error(`fixture creator not found in the real roster: ${creatorId}`)
    return creator
  }

  function flattenCreatorIds(groups: NotificationBranchGroup[]): string[] {
    return groups.flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.creatorId)))
  }

  it("excludeFavorites removes a favorited creator from their normal branch group entirely — no duplicate rendering (spec section 7)", () => {
    const filtered = excludeFavorites(baseGroups, new Set(["aizawa_ema"]))
    expect(flattenCreatorIds(filtered)).not.toContain("aizawa_ema")
    // Everyone else in her VSPO JP group stays.
    expect(flattenCreatorIds(filtered)).toContain("kaga_sumire")
  })

  it("excludeFavorites leaves every group's own creator count intact when nobody is favorited", () => {
    const filtered = excludeFavorites(baseGroups, new Set())
    expect(flattenCreatorIds(filtered).length).toBe(flattenCreatorIds(baseGroups).length)
  })

  it("the shared matcher matches a real creator's display name case-insensitively as a substring, and an empty/whitespace query matches everyone", () => {
    const aizawa = findCreator("aizawa_ema")
    expect(creatorMatchesNameQuery(aizawa, "エマ")).toBe(true)
    expect(creatorMatchesNameQuery(aizawa, "valo")).toBe(false)
    expect(creatorMatchesNameQuery(aizawa, "")).toBe(true)
    expect(creatorMatchesNameQuery(aizawa, "   ")).toBe(true)
  })

  it("filterCreatorList finds a member by canonical romanized name in either order, and not by a typo", () => {
    expect(filterCreatorList(allCreators, "Ema Aizawa").map((c) => c.creatorId)).toEqual(["aizawa_ema"])
    expect(filterCreatorList(allCreators, "aizawa_ema").map((c) => c.creatorId)).toEqual(["aizawa_ema"])
    expect(filterCreatorList(allCreators, "aizamaema")).toEqual([])
  })

  it("filterCreatorList narrows the real roster down to the one creator whose name actually matches", () => {
    const matches = filterCreatorList(allCreators, "エマ")
    expect(matches.map((creator) => creator.creatorId)).toEqual(["aizawa_ema"])
  })

  it("filterBranchGroups keeps only the romanized match's own branch/subgroup, in either name order, and nothing for a typo", () => {
    for (const query of ["aizawa ema", "EMA AIZaWa", "aizawa-ema"]) {
      expect(flattenCreatorIds(filterBranchGroups(baseGroups, query))).toEqual(["aizawa_ema"])
    }
    expect(filterBranchGroups(baseGroups, "aizamaema")).toEqual([])
    expect(filterBranchGroups(baseGroups, "aizazwaema")).toEqual([])
  })

  it("filterBranchGroups drops every subgroup/branch with zero matches (spec section 10: never a bare empty heading)", () => {
    const filtered = filterBranchGroups(baseGroups, "エマ")
    expect(flattenCreatorIds(filtered)).toEqual(["aizawa_ema"])
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.branch).toBe("vspo_jp")
    expect(formatBranchHeading(filtered[0]!.branch)).toBe("VSPO! // JP")
  })

  it("filterBranchGroups returns nothing at all once no real creator matches", () => {
    expect(filterBranchGroups(baseGroups, "no such creator exists xyz")).toEqual([])
  })

  describe("grouping, headings and member order are Live Status'", () => {
    const liveStatusGroups = groupEligibleCreatorsForLiveStatus("", (creator) => isCurrentMemberEligible(creator))

    it("has exactly Live Status' branch groups in Live Status' order (VSPO! // JP, VSPO! // EN, HOLOLIVE // JP, ...), each one complete heading", () => {
      expect(baseGroups.map((group) => group.branch)).toEqual(liveStatusGroups.map((group) => group.branch))
      const headings = baseGroups.map((group) => formatBranchHeading(group.branch))
      expect(headings.slice(0, 2)).toEqual(["VSPO! // JP", "VSPO! // EN"])
      // never a bare "VSPO" / "JP" / "EN" parent-and-child pair
      expect(headings.every((heading) => /^(VSPO!|HOLOLIVE) \/\/ (JP|EN|ID)$/.test(heading))).toBe(true)
    })

    it("lists each group's subgroups and members in exactly Live Status' order", () => {
      const ours = baseGroups.map((group) => group.subgroups.map((subgroup) => [subgroup.label, subgroup.creators.map((creator) => creator.creatorId)]))
      const theirs = liveStatusGroups.map((group) => group.subgroups.map((subgroup) => [subgroup.label, subgroup.creators.map((creator) => creator.creatorId)]))
      expect(ours).toEqual(theirs)
    })

    it("the flat Favorites order follows the same Live Status order, whatever order the favorites are given in", () => {
      const ids = ["aizawa_ema", "kaga_sumire", "kanade_izuru"].filter((id) => allCreators.some((creator) => creator.creatorId === id))
      const shuffled = [...ids].reverse().map(findCreator)
      const expected = flattenCreatorIds(baseGroups).filter((id) => ids.includes(id))

      expect(sortCreatorsLikeLiveStatus(shuffled).map((creator) => creator.creatorId)).toEqual([...new Set(expected)])
    })
  })

  it("isFavoriteCreatorId bridges Favorites' own channelId space to a creatorId via the confirmed 'ch_' + creatorId convention", () => {
    expect(isFavoriteCreatorId("aizawa_ema", new Set(["ch_aizawa_ema"]))).toBe(true)
    expect(isFavoriteCreatorId("aizawa_ema", new Set(["ch_someone_else"]))).toBe(false)
    expect(isFavoriteCreatorId("aizawa_ema", new Set())).toBe(false)
  })

  // watson_amelia used to be this bridge's other documented gap alongside
  // airani_iofifteen, but the canonical Creator Registry now carries her as
  // lifecycleStage "graduated" -- isCurrentMemberEligible
  // (notificationCreatorGrouping.ts) excludes her from the live roster
  // entirely on that basis alone, the same as any other graduated member, so
  // she is no longer in allCreators to be a bridge gap at all. airani_iofifteen
  // remains eligible and remains unbridged.
  it("confirms the one real canonical registry entry this bridge can never mark favorited (documented in creatorFavoriteBridge.ts)", () => {
    const mockChannelIds = new Set(mockCreators.map((creator) => creator.channelId))
    expect(mockChannelIds.has("ch_airani_iofifteen")).toBe(false)
    // Confirms she really is in the live roster this feature manages — this
    // is a real gap, not a typo'd creatorId.
    expect(allCreators.some((creator) => creator.creatorId === "airani_iofifteen")).toBe(true)
  })

  it("airani_iofifteen (eligible, no Favorites bridge) still appears in the live roster — availability is driven by canonical eligibility, not by mockCreators presence", () => {
    const canonical = getCreatorById("airani_iofifteen")
    expect(canonical).toBeDefined()
    expect(isCurrentMemberEligible(canonical!)).toBe(true)
    expect(allCreators.some((creator) => creator.creatorId === "airani_iofifteen")).toBe(true)
  })

  it("watson_amelia (graduated, no Favorites bridge) is absent from the live roster because she is canonically ineligible — not because she has no mockCreators counterpart", () => {
    const canonical = getCreatorById("watson_amelia")
    expect(canonical).toBeDefined()
    expect(canonical?.lifecycleStage).toBe("graduated")
    expect(isCurrentMemberEligible(canonical!)).toBe(false)
    expect(allCreators.some((creator) => creator.creatorId === "watson_amelia")).toBe(false)
  })
})
