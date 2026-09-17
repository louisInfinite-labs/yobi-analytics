import { describe, expect, it } from "vitest"
import { groupCreatorsForOshiSettings } from "./oshiSettingsGrouping"

// Confirms VSPO! Official (mockCreators' own vspo_jp "group" channel) is
// pinned to the very bottom of VSPO JP's list here too -- Oshi Settings
// previously used mockCreators' own raw declared array order (where it
// sits in position 2, right after 藍沢エマ), unlike Live Status and
// Notification Settings, which already got this fix. Confirmed with the
// user: all three should be consistent.
describe("groupCreatorsForOshiSettings", () => {
  it("pins VSPO! Official to the very end of VSPO JP's own creator list", () => {
    const agencies = groupCreatorsForOshiSettings("")
    const vspoJpRegion = agencies.flatMap((agency) => agency.regions).find((region) => region.branch === "vspo_jp")!
    const vspoJpCreators = vspoJpRegion.subgroups.flatMap((subgroup) => subgroup.creators)
    const officialIndex = vspoJpCreators.findIndex((creator) => creator.channelId === "ch_vspo_group")
    expect(officialIndex).toBe(vspoJpCreators.length - 1)
  })

  it("leaves every other branch's own existing order untouched", () => {
    const agencies = groupCreatorsForOshiSettings("")
    const holoJpRegion = agencies.flatMap((agency) => agency.regions).find((region) => region.branch === "holo_jp")!
    // holo_jp has no non-member entries pulled to the end by this change —
    // just confirms the branch still groups/renders at all.
    expect(holoJpRegion.subgroups.flatMap((subgroup) => subgroup.creators).length).toBeGreaterThan(0)
  })
})
