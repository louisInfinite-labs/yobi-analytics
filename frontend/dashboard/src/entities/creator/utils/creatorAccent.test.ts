import { describe, expect, it } from "vitest"
import { getCreatorAccent } from "./creatorAccent"
import { getCreators, toLegacyRosterId } from "../data/creatorRegistry"
import { getAllNotificationCreators } from "../../../features/notifications/model/notificationCreatorGrouping"
import { getMemberAccent } from "../../../shared/theme/memberAccent"

describe("getCreatorAccent: the one creator color resolution (My Favorites + Notification Members)", () => {
  it("is exactly Favorites' formula -- the verified themeColor, else the hashed palette seeded with the legacy roster id -- for EVERY creator in the roster", () => {
    const creators = getCreators()
    expect(creators.length).toBeGreaterThan(100)
    for (const creator of creators) {
      expect(getCreatorAccent(creator), creator.creatorId).toEqual(getMemberAccent(toLegacyRosterId(creator), creator.themeColor))
    }
  })

  it("uses the creator's verified themeColor when the registry has one (normalized to the canonical upper-case form)", () => {
    const withColor = getCreators().filter((creator) => creator.themeColor)
    expect(withColor.length).toBeGreaterThan(0)
    for (const creator of withColor) expect(getCreatorAccent(creator).primary).toBe(String(creator.themeColor).toUpperCase())
  })

  it("falls back to the SAME hashed palette Favorites uses for a creator with no verified color -- seeded by the legacy roster id, not the YouTube channel id", () => {
    const withoutColor = getCreators().filter((creator) => !creator.themeColor)
    for (const creator of withoutColor) {
      expect(getCreatorAccent(creator).primary).toBe(getMemberAccent(toLegacyRosterId(creator)).primary)
    }
    // The regression this guards: seeding the fallback with the channel id (what the drawer used to do) picks DIFFERENT palette entries.
    const wouldDiffer = withoutColor.filter((creator) => getMemberAccent(creator.youtubeChannelId).primary !== getCreatorAccent(creator).primary)
    if (withoutColor.length > 0) expect(wouldDiffer.length).toBeGreaterThan(0)
  })

  it("ignores the theme color's case so a lower-case registry value cannot produce a different accent", () => {
    const upper = getCreatorAccent({ creatorId: "aizawa_ema", themeColor: "#1A2B3C" })
    const lower = getCreatorAccent({ creatorId: "aizawa_ema", themeColor: "#1a2b3c" })
    expect(lower).toEqual(upper)
  })

  it("resolves a Notification Members creator exactly like the canonical creator it was mapped from (the mapping carries the themeColor, nothing else decides the color)", () => {
    const canonicalById = new Map(getCreators().map((creator) => [creator.creatorId, creator]))
    const notificationCreators = getAllNotificationCreators()
    expect(notificationCreators.length).toBeGreaterThan(90)
    for (const creator of notificationCreators) {
      const canonical = canonicalById.get(creator.creatorId)!
      expect(creator.themeColor, creator.creatorId).toBe(canonical.themeColor)
      expect(getCreatorAccent(creator), creator.creatorId).toEqual(getCreatorAccent(canonical))
    }
  })
})
