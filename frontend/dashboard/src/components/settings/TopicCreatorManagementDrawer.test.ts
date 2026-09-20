import { describe, expect, it } from "vitest"
import { excludeFavorites, filterAgencyGroups, filterCreatorList, matchesSearch } from "./TopicCreatorManagementDrawer"
import { getAllNotificationCreators, groupCreatorsForNotificationSettings, type CreatorAgencyGroup } from "../../lib/notificationCreatorGrouping"
import { isFavoriteCreatorId } from "../../lib/creatorFavoriteBridge"
import { mockCreators } from "../../data/mockCreators"

// Exercises the actual filtering/grouping logic the drawer renders from,
// against the real Creator Master roster (creators.json, via
// notificationCreatorGrouping.ts) -- not a hand-written fixture -- so a
// regression in the real data's shape (a renamed branch, a creator moved
// between agencies) would surface here too. No antd/React rendering
// involved: these are the same plain functions TopicCreatorManagementDrawer
// itself calls, just exported for direct testing (see that file's own
// comment on matchesSearch).
describe("TopicCreatorManagementDrawer filtering/grouping logic", () => {
  const allCreators = getAllNotificationCreators()
  const baseAgencyGroups = groupCreatorsForNotificationSettings()

  function findCreator(creatorId: string) {
    const creator = allCreators.find((entry) => entry.creatorId === creatorId)
    if (!creator) throw new Error(`fixture creator not found in the real roster: ${creatorId}`)
    return creator
  }

  function flattenCreatorIds(agencyGroups: CreatorAgencyGroup[]): string[] {
    return agencyGroups.flatMap((agency) =>
      agency.regions.flatMap((region) => region.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.creatorId))),
    )
  }

  it("excludeFavorites removes a favorited creator from their normal agency/region group entirely — no duplicate rendering (spec section 7)", () => {
    const filtered = excludeFavorites(baseAgencyGroups, new Set(["aizawa_ema"]))
    expect(flattenCreatorIds(filtered)).not.toContain("aizawa_ema")
    // Everyone else in her VSPO JP group stays.
    expect(flattenCreatorIds(filtered)).toContain("kaga_sumire")
  })

  it("excludeFavorites leaves every group's own creator count intact when nobody is favorited", () => {
    const filtered = excludeFavorites(baseAgencyGroups, new Set())
    expect(flattenCreatorIds(filtered).length).toBe(flattenCreatorIds(baseAgencyGroups).length)
  })

  it("matchesSearch matches a real creator's display name case-insensitively as a substring, and an empty/whitespace query matches everyone", () => {
    const aizawa = findCreator("aizawa_ema")
    expect(matchesSearch(aizawa, "エマ")).toBe(true)
    expect(matchesSearch(aizawa, "valo")).toBe(false)
    expect(matchesSearch(aizawa, "")).toBe(true)
    expect(matchesSearch(aizawa, "   ")).toBe(true)
  })

  it("filterCreatorList narrows the real roster down to the one creator whose name actually matches", () => {
    const matches = filterCreatorList(allCreators, "エマ")
    expect(matches.map((creator) => creator.creatorId)).toEqual(["aizawa_ema"])
  })

  it("filterAgencyGroups drops every subgroup/region/agency with zero matches (spec section 10: never a bare empty heading)", () => {
    const filtered = filterAgencyGroups(baseAgencyGroups, "エマ")
    expect(flattenCreatorIds(filtered)).toEqual(["aizawa_ema"])
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.agencyLabel).toBe("VSPO")
  })

  it("filterAgencyGroups returns nothing at all once no real creator matches", () => {
    expect(filterAgencyGroups(baseAgencyGroups, "no such creator exists xyz")).toEqual([])
  })

  it("isFavoriteCreatorId bridges Favorites' own channelId space to a creatorId via the confirmed 'ch_' + creatorId convention", () => {
    expect(isFavoriteCreatorId("aizawa_ema", new Set(["ch_aizawa_ema"]))).toBe(true)
    expect(isFavoriteCreatorId("aizawa_ema", new Set(["ch_someone_else"]))).toBe(false)
    expect(isFavoriteCreatorId("aizawa_ema", new Set())).toBe(false)
  })

  it("confirms the two real creators.json entries this bridge can never mark favorited (documented in creatorFavoriteBridge.ts)", () => {
    const mockChannelIds = new Set(mockCreators.map((creator) => creator.channelId))
    expect(mockChannelIds.has("ch_watson_amelia")).toBe(false)
    expect(mockChannelIds.has("ch_airani_iofifteen")).toBe(false)
    // Confirms both really are in the live roster this feature manages —
    // this is a real gap, not a typo'd creatorId.
    expect(allCreators.some((creator) => creator.creatorId === "watson_amelia")).toBe(true)
    expect(allCreators.some((creator) => creator.creatorId === "airani_iofifteen")).toBe(true)
  })
})
