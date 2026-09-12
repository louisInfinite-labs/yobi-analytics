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
 * other). Each creator carries at least 5 normal_video entries and 5
 * live_now/live_archive entries so selectLatestVideos/selectLivestreamSlots
 * (both capped at 5, this session: "最新影片和 最新直播也是5條影片") have
 * enough to actually fill 5 slots instead of being capped by sparse
 * fixture data. Swap this module's export for a real per-creator video list
 * (Read API/Holodex) once that exists — see homeAssets.ts/
 * mockCreatorStatuses.ts for the same swap-point pattern used elsewhere in
 * Home. */
export const mockRecentVideos: Record<string, RecentVideo[]> = {
  ch_aizawa_ema: [
    { videoId: "mock_ema_live_now", title: "【VALORANT】ランクを本気で上げる配信", publishedAt: "2026-09-03T12:00:00+09:00", contentFormat: "live_now" },
    { videoId: "mock_ema_archive_1", title: "【雑談】最近あったこと話す", publishedAt: "2026-09-02T21:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_ema_archive_2", title: "【歌枠】久しぶりの歌配信", publishedAt: "2026-08-30T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_ema_archive_3", title: "【VALORANT】視聴者参加型配信", publishedAt: "2026-08-28T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_ema_archive_4", title: "【雑談】質問コーナー", publishedAt: "2026-08-26T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_ema_video_1", title: "自己紹介ムービー2026", publishedAt: "2026-09-01T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_ema_video_2", title: "【告知】今週の配信スケジュール", publishedAt: "2026-08-29T12:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_ema_video_3", title: "衣装お披露目ムービー", publishedAt: "2026-08-27T12:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_ema_video_4", title: "【告知】コラボ企画予告", publishedAt: "2026-08-24T12:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_ema_video_5", title: "ファンアート紹介", publishedAt: "2026-08-22T12:00:00+09:00", contentFormat: "normal_video" },
  ],
  ch_shirakami_fubuki: [
    { videoId: "mock_fubuki_archive_1", title: "歌回", publishedAt: "2026-09-01T21:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_archive_2", title: "【ゲーマーズ】久々コラボ雑談", publishedAt: "2026-08-28T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_archive_3", title: "作業配信", publishedAt: "2026-08-26T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_archive_4", title: "視聴者ゲーム大会", publishedAt: "2026-08-24T20:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_archive_5", title: "深夜雑談", publishedAt: "2026-08-22T22:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_fubuki_video_1", title: "フブキ的今週のハイライト", publishedAt: "2026-09-02T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_fubuki_video_2", title: "Shorts: 今日のひとこと", publishedAt: "2026-08-30T12:00:00+09:00", contentFormat: "shorts" },
    { videoId: "mock_fubuki_video_3", title: "料理チャレンジ", publishedAt: "2026-08-29T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_fubuki_video_4", title: "【告知】記念配信予告", publishedAt: "2026-08-27T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_fubuki_video_5", title: "視聴者コメント返し", publishedAt: "2026-08-25T18:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_fubuki_video_6", title: "今年を振り返る", publishedAt: "2026-08-23T18:00:00+09:00", contentFormat: "normal_video" },
  ],
  ch_gawr_gura: [
    { videoId: "v_gura_karaoke_stream", title: "karaoke time!! feat. new songs", publishedAt: "2026-09-02T10:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_archive_2", title: "chatting about recent news", publishedAt: "2026-08-27T09:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_archive_3", title: "gaming session with viewers", publishedAt: "2026-08-25T09:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_archive_4", title: "late night chill stream", publishedAt: "2026-08-23T09:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_archive_5", title: "collab practice stream", publishedAt: "2026-08-21T09:00:00+09:00", contentFormat: "live_archive" },
    { videoId: "mock_gura_video_1", title: "unboxing merch!", publishedAt: "2026-09-01T15:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_gura_video_2", title: "announcement video", publishedAt: "2026-08-25T15:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_gura_video_3", title: "behind the scenes", publishedAt: "2026-08-24T15:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_gura_video_4", title: "fan art showcase", publishedAt: "2026-08-22T15:00:00+09:00", contentFormat: "normal_video" },
    { videoId: "mock_gura_video_5", title: "year in review", publishedAt: "2026-08-20T15:00:00+09:00", contentFormat: "normal_video" },
  ],
}

/** Empty for a creator this fixture has no entries for, rather than throwing — Home must still render something reasonable. */
export function getRecentVideosForCreator(creatorId: string): RecentVideo[] {
  return mockRecentVideos[creatorId] ?? []
}
