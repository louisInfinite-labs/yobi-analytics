import { describe, expect, it } from "vitest"
import { resolveHolodexChannelId } from "./useRecentVideos"
import { getCreatorById } from "../../../entities/creator/data/creatorRegistry"

// resolveHolodexChannelId is the one place useRecentVideos derives a
// creator's real Holodex/YouTube channel id -- exercised directly here
// (rather than only through the full async, fetch-driven hook) against the
// real canonical registry, so a regression in the real data's shape would
// surface here too. No manually maintained Holodex channel table
// (integrations/holodex/holodexChannelIds.ts, deleted in C6) is involved
// anywhere in this resolution anymore -- the ONLY thing gating which
// creators attempt a real fetch is REAL_FETCH_ENABLED_CREATOR_IDS
// (currently just gawr_gura, this session's original hand-picked
// local-testing case), gated on the canonical creatorId itself, never a
// second creatorId->channelId table.
describe("resolveHolodexChannelId", () => {
  it("resolves gawr_gura's real-fetch-enabled ch_-prefixed legacy creatorId to the canonical registry's own youtubeChannelId", () => {
    const canonical = getCreatorById("gawr_gura")
    expect(canonical).toBeDefined()
    expect(resolveHolodexChannelId("ch_gawr_gura")).toBe(canonical!.youtubeChannelId)
  })

  it("resolves gawr_gura's bare canonical creatorId to the same youtubeChannelId as its ch_-prefixed form", () => {
    expect(resolveHolodexChannelId("gawr_gura")).toBe(resolveHolodexChannelId("ch_gawr_gura"))
  })

  it("a registry-resolvable creator OTHER than gawr_gura does not attempt the real Holodex fetch — real-fetch scope stays narrow in C6", () => {
    // aizawa_ema resolves cleanly through the same resolveCreatorKey() path
    // gawr_gura does (confirmed real registry entry, real youtubeChannelId)
    // — she's just not in REAL_FETCH_ENABLED_CREATOR_IDS, so this must stay
    // undefined (usePaginatedVideos's own `!holodexChannelId` branch keeps
    // her on mock data, same as today).
    expect(getCreatorById("aizawa_ema")?.youtubeChannelId).toBeTruthy()
    expect(resolveHolodexChannelId("ch_aizawa_ema")).toBeUndefined()
    expect(resolveHolodexChannelId("aizawa_ema")).toBeUndefined()
  })

  it("ch_iofi resolves through the generated legacyAliases table to a real registry entry, but stays gated out (not gawr_gura)", () => {
    expect(getCreatorById("airani_iofifteen")).toBeDefined()
    expect(resolveHolodexChannelId("ch_iofi")).toBeUndefined()
  })

  it("ch_amelia_myth_graduated resolves through the generated legacyAliases table to a real registry entry, but stays gated out (not gawr_gura)", () => {
    expect(getCreatorById("watson_amelia")).toBeDefined()
    expect(resolveHolodexChannelId("ch_amelia_myth_graduated")).toBeUndefined()
  })

  it("ch_vspo_group resolves through the generated legacyAliases table to vspo_official, but stays gated out (not gawr_gura)", () => {
    expect(getCreatorById("vspo_official")).toBeDefined()
    expect(resolveHolodexChannelId("ch_vspo_group")).toBeUndefined()
  })

  it("returns undefined for an unknown creatorId", () => {
    expect(resolveHolodexChannelId("nonexistent_creator")).toBeUndefined()
  })

  it("returns undefined for ch_hololive_staff (mock/legacy-only, no Creator Master counterpart) rather than inventing a channel id", () => {
    expect(resolveHolodexChannelId("ch_hololive_staff")).toBeUndefined()
  })
})
