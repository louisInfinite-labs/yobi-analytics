import type { ContentFormat } from "../types/domain"

export interface RecentVideo {
  videoId: string
  title: string
  publishedAt: string
  contentFormat: ContentFormat
}

/** Per-creator recent-upload catalog for Home's "latest videos / latest
 * streams" section — a separate fixture from mockVideoStats.ts (that one
 * models one representative daily-growth row per creator for Dashboard's
 * KPIs/charts; this models an ordered recent-upload list per creator, a
 * different shape/purpose entirely, so extending one must not perturb the
 * other). Swap this module's export for a real per-creator video list
 * (Read API/Holodex) once that exists — see homeAssets.ts/
 * mockCreatorStatuses.ts for the same swap-point pattern used elsewhere in
 * Home. */
export const mockRecentVideos: Record<string, RecentVideo[]> = {
  ch_aizawa_ema: [
    { videoId: "mock_ema_live_now", title: "【VALORANT】ランクを本気で上げる配信", publishedAt: "2026-09-03T12:00:00+09:00", contentFormat: "live_now" },
    { videoId: "mock_ema_archive_1", title: "【雑談】最近あったこと話す", publishedAt: "2026-09-02T21:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_ema_archive_2", title: "【歌枠】久しぶりの歌配信", publishedAt: "2026-08-30T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_ema_video_1", title: "自己紹介ムービー2026", publishedAt: "2026-09-01T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_ema_video_2", title: "【告知】今週の配信スケジュール", publishedAt: "2026-08-29T12:00:00+09:00", contentFormat: "normal_video" },
  ],
  ch_shirakami_fubuki: [
    { videoId: "mock_fubuki_archive_1", title: "歌回", publishedAt: "2026-09-01T21:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_archive_2", title: "【ゲーマーズ】久々コラボ雑談", publishedAt: "2026-08-28T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_video_1", title: "フブキ的今週のハイライト", publishedAt: "2026-09-02T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_fubuki_video_2", title: "Shorts: 今日のひとこと", publishedAt: "2026-08-30T12:00:00+09:00", contentFormat: "shorts" },
  ],
  ch_gawr_gura: [
    { videoId: "v_gura_karaoke_stream", title: "karaoke time!! feat. new songs", publishedAt: "2026-09-02T10:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_archive_2", title: "chatting about recent news", publishedAt: "2026-08-27T09:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_video_1", title: "unboxing merch!", publishedAt: "2026-09-01T15:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_gura_video_2", title: "announcement video", publishedAt: "2026-08-25T15:00:00+09:00", contentFormat: "normal_video" },
  ],
}

/** Empty for a creator this fixture has no entries for, rather than throwing — Home must still render something reasonable. */
export function getRecentVideosForCreator(creatorId: string): RecentVideo[] {
  return mockRecentVideos[creatorId] ?? []
}
