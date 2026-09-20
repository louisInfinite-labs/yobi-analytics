/** Maps this app's own internal mock channelId (mockCreators.ts, e.g.
 * "ch_gawr_gura") to the creator's real YouTube/Holodex channel ID (UC...),
 * for the local-testing Holodex swap-in (holodexClient.ts). Only creators
 * listed here fetch real data; everyone else keeps using mockRecentVideos.ts
 * — this is intentionally a small, hand-picked subset for trying the real
 * API's effect, not a full roster. */
export const holodexChannelIdByCreatorId: Record<string, string> = {
  ch_gawr_gura: "UCoSrY_IQQVpmIRZ9Xf-y93g", // Gawr Gura (hololive EN Myth)
}
