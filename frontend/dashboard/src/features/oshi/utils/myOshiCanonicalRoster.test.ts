import { describe, expect, it } from "vitest"
import { getCreators, isMyOshiEligible } from "../../../entities/creator/data/creatorRegistry"
import { groupSelectableCreatorsForMyOshi } from "./myOshiCanonicalRoster"

const GRADUATED_IDS = [
  "amane_kanata",
  "ceres_fauna",
  "gawr_gura",
  "hiodoshi_ao",
  "kiryu_coco",
  "mano_aloe",
  "minato_aqua",
  "murasaki_shion",
  "nanashi_mumei",
  "sakamata_chloe",
  "uruha_rushia",
  "watson_amelia",
  "yozora_mel",
]

/** Every creator the My Oshi picker offers, flattened (a creator tagged with two groups, e.g. Gamers, can repeat). */
function offeredCreatorIds(query = ""): string[] {
  return groupSelectableCreatorsForMyOshi(query).flatMap((agency) =>
    agency.regions.flatMap((region) => region.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.creatorId))),
  )
}

describe("My Oshi eligibility (separate from Live Status)", () => {
  it("every individual creator is offered: 110 distinct creators", () => {
    expect(new Set(offeredCreatorIds()).size).toBe(110)
    expect(getCreators().filter(isMyOshiEligible)).toHaveLength(110)
  })

  it("all 13 graduated individual creators are offered and selectable", () => {
    const offered = new Set(offeredCreatorIds())

    for (const id of GRADUATED_IDS) {
      expect(offered.has(id), id).toBe(true)
      expect(isMyOshiEligible(getCreators().find((c) => c.creatorId === id)!), id).toBe(true)
    }
  })

  it("active and pre-debut individual creators are still offered", () => {
    const offered = new Set(offeredCreatorIds())
    const current = getCreators().filter((c) => c.channelType === "member" && c.lifecycleStage !== "graduated")

    expect(current).toHaveLength(97)
    for (const creator of current) expect(offered.has(creator.creatorId), creator.creatorId).toBe(true)
  })

  it.each([
    "vspo_official",
    "hololive_dev_is_regloss",
    "hololive_dev_is_flow_glow",
    "hololive_asobimawaritai",
    "fuwamoco",
    "achrora",
    "unit_b_pre_debut",
    "holoan_room",
  ])("the group/official/staff channel %s is not offered and not eligible", (creatorId) => {
    const creator = getCreators().find((c) => c.creatorId === creatorId)!

    expect(isMyOshiEligible(creator)).toBe(false)
    expect(offeredCreatorIds()).not.toContain(creatorId)
  })

  it("a graduated creator can be found by search", () => {
    const gura = getCreators().find((c) => c.creatorId === "gawr_gura")!

    expect(offeredCreatorIds(gura.displayName)).toContain("gawr_gura")
  })

  it("a graduated creator stays in her original group; there is no separate Graduated group", () => {
    const labels = groupSelectableCreatorsForMyOshi("").flatMap((agency) =>
      agency.regions.flatMap((region) => region.subgroups.map((subgroup) => subgroup.label ?? "")),
    )
    const myth = groupSelectableCreatorsForMyOshi("")
      .flatMap((agency) => agency.regions.flatMap((region) => region.subgroups))
      .find((subgroup) => subgroup.label === "Myth")

    expect(labels.some((label) => /graduat|卒業/i.test(label))).toBe(false)
    expect(myth?.creators.map((creator) => creator.creatorId)).toEqual(expect.arrayContaining(["gawr_gura", "watson_amelia"]))
  })
})
