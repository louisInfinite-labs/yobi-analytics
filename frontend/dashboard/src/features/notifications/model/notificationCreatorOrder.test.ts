import { describe, expect, it } from "vitest"
import { sortFlatNotificationCreatorsLikeLiveStatus, sortNotificationCreatorsLikeLiveStatus } from "./notificationCreatorOrder"
import { getAllNotificationCreators } from "./notificationCreatorGrouping"

// Confirms Notification Settings' own creator ordering now matches Live
// Status's (this session's own fix: creators.json's raw, undefined array
// order previously didn't match Live Status's gojuon/kana order at all).
describe("sortNotificationCreatorsLikeLiveStatus", () => {
  const allCreators = getAllNotificationCreators()

  it("puts a VSPO JP creator with a real kana reading before every VSPO JP creator with none at all — Live Status's own fallback rule", () => {
    const vspoJp = allCreators.filter((creator) => creator.branch === "vspo_jp")
    const sorted = sortNotificationCreatorsLikeLiveStatus("vspo_jp", vspoJp)
    const aizawaIndex = sorted.findIndex((creator) => creator.creatorId === "aizawa_ema")
    const kagaSumireIndex = sorted.findIndex((creator) => creator.creatorId === "kaga_sumire")
    expect(aizawaIndex).toBeGreaterThanOrEqual(0)
    expect(kagaSumireIndex).toBeGreaterThan(aizawaIndex)
  })

  it("keeps no-kana creators in mockCreators' own declared relative order (kaga_sumire before kaga_nazuna), matching Live Status exactly", () => {
    const vspoJp = allCreators.filter((creator) => creator.branch === "vspo_jp")
    const sorted = sortNotificationCreatorsLikeLiveStatus("vspo_jp", vspoJp)
    const sumireIndex = sorted.findIndex((creator) => creator.creatorId === "kaga_sumire")
    const nazunaIndex = sorted.findIndex((creator) => creator.creatorId === "kaga_nazuna")
    expect(sumireIndex).toBeLessThan(nazunaIndex)
  })

  it("sorts a creator with no mockCreators counterpart at all (watson_amelia) after every bridged creator in their own branch", () => {
    const holoEn = allCreators.filter((creator) => creator.branch === "holo_en")
    const sorted = sortNotificationCreatorsLikeLiveStatus("holo_en", holoEn)
    expect(sorted[sorted.length - 1]?.creatorId).toBe("watson_amelia")
  })
})

describe("sortFlatNotificationCreatorsLikeLiveStatus", () => {
  it("keeps same-branch creators adjacent, ordered VSPO JP before Hololive JP (DOCK_BRANCH_ORDER) — for the Favorites section's own flat, cross-branch list", () => {
    const allCreators = getAllNotificationCreators()
    const mixed = allCreators.filter((creator) => ["aizawa_ema", "usada_pekora", "kaga_sumire"].includes(creator.creatorId))
    const sorted = sortFlatNotificationCreatorsLikeLiveStatus(mixed)
    const branches = sorted.map((creator) => creator.branch)
    expect(branches.indexOf("holo_jp")).toBeGreaterThan(branches.lastIndexOf("vspo_jp"))
  })
})
