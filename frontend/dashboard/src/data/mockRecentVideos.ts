import type { ContentFormat } from "../types/domain"
import type { VideoCategory } from "../lib/videoCategories"

export interface RecentVideo {
  videoId: string
  title: string
  publishedAt: string
  contentFormat: ContentFormat
  /** Home's video-section tag filter (this session's spec) — optional
   * since real/Holodex-fetched videos (holodexClient.ts's mapVideo) don't
   * derive this; treat a missing value as "other" wherever this is read. */
  category?: VideoCategory
  /** Backs the video-section sort dropdown's "most views" option — optional
   * for the same reason as `category` (holodexClient.ts's mapVideo doesn't
   * derive this either); treat a missing value as 0 wherever this is read
   * (see recentVideosSelection.ts's sortVideos). */
  viewCount?: number
}

/** A real, permanently-public, always-embeddable YouTube video, used below
 * ONLY as a placeholder thumbnail/player source for mock catalog entries
 * whose videoId isn't a real one -- so the dev-mode thumbnail
 * (img.youtube.com) and click-to-play modal (VideoPlayerModal) actually
 * render something instead of YouTube's own bland "thumbnail not
 * available" gray placeholder image -- an invalid videoId doesn't 404 the
 * thumbnail request, it just silently serves that generic gray image, so
 * the existing onError-based placeholder fallback in VideoThumbCard never
 * even fires. This is the industry's own standard "always embeds" demo video
 * ID, chosen for exactly that reason -- not a real upload from any of
 * these creators.
 *
 * IMPORTANT: this is only ever used as a *display* source (see
 * resolvePlaybackVideoId below) -- never assigned as an entry's own
 * `videoId`. Every mock entry keeps its own unique fake id
 * (mock_ema_video_1, etc.) because `videoId` also doubles as the React
 * list key AND the identity `recentVideosSelection.ts`'s mergeAndDedupe
 * dedupes by; giving every entry the SAME real id here made dedup collapse
 * the entire "ALL"/category-tag pool down to a single card. */
const MOCK_THUMBNAIL_VIDEO_ID = "dQw4w9WgXcQ"

/** Real YouTube video ids are always exactly 11 characters -- a fixed,
 * documented format, not a heuristic guess. Every mock id here is
 * deliberately longer (`mock_ema_video_1`, `v_gura_karaoke_stream`, ...),
 * so this reliably tells "has a real id" (real/Holodex-fetched entries)
 * apart from "still a mock placeholder" without needing a second field. */
export function resolvePlaybackVideoId(videoId: string): string {
  return videoId.length === 11 ? videoId : MOCK_THUMBNAIL_VIDEO_ID
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
    { videoId: "mock_ema_live_now", title: "【VALORANT】ランクを本気で上げる配信", publishedAt: "2026-09-03T12:00:00+09:00", contentFormat: "live_now", category: "valo", viewCount: 12000 },
    { videoId: "mock_ema_archive_1", title: "【雑談】最近あったこと話す", publishedAt: "2026-09-02T21:00:00+09:00", contentFormat: "live_archive", category: "chatting", viewCount: 45000 },
    { videoId: "mock_ema_archive_2", title: "【歌枠】久しぶりの歌配信", publishedAt: "2026-08-30T20:00:00+09:00", contentFormat: "live_archive", category: "singing", viewCount: 180000 },
    { videoId: "mock_ema_archive_3", title: "【VALORANT】視聴者参加型配信", publishedAt: "2026-08-28T20:00:00+09:00", contentFormat: "live_archive", category: "valo", viewCount: 62000 },
    { videoId: "mock_ema_archive_4", title: "【雑談】質問コーナー", publishedAt: "2026-08-26T20:00:00+09:00", contentFormat: "live_archive", category: "chatting", viewCount: 38000 },
    { videoId: "mock_ema_video_1", title: "自己紹介ムービー2026", publishedAt: "2026-09-01T18:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 250000 },
    { videoId: "mock_ema_video_2", title: "【告知】今週の配信スケジュール", publishedAt: "2026-08-29T12:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 21000 },
    { videoId: "mock_ema_video_3", title: "衣装お披露目ムービー", publishedAt: "2026-08-27T12:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 310000 },
    { videoId: "mock_ema_video_4", title: "【告知】コラボ企画予告", publishedAt: "2026-08-24T12:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 54000 },
    { videoId: "mock_ema_video_5", title: "ファンアート紹介", publishedAt: "2026-08-22T12:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 27000 },
    { videoId: "mock_ema_sf6_1", title: "【スト6】ランクマッチ耐久配信", publishedAt: "2026-08-20T20:00:00+09:00", contentFormat: "live_archive", category: "sf6", viewCount: 41000 },
    { videoId: "mock_ema_minecraft_1", title: "【マイクラ】新エリア開拓", publishedAt: "2026-08-19T20:00:00+09:00", contentFormat: "live_archive", category: "minecraft", viewCount: 33000 },
    { videoId: "mock_ema_apex_1", title: "【Apex】ランク上げ雑談配信", publishedAt: "2026-08-18T20:00:00+09:00", contentFormat: "live_archive", category: "apex", viewCount: 57000 },
  ],
  ch_shirakami_fubuki: [
    { videoId: "mock_fubuki_archive_1", title: "歌回", publishedAt: "2026-09-01T21:00:00+09:00", contentFormat: "live_archive", category: "singing", viewCount: 420000 },
    { videoId: "mock_fubuki_archive_2", title: "【ゲーマーズ】久々コラボ雑談", publishedAt: "2026-08-28T20:00:00+09:00", contentFormat: "live_archive", category: "chatting", viewCount: 96000 },
    { videoId: "mock_fubuki_archive_3", title: "作業配信", publishedAt: "2026-08-26T20:00:00+09:00", contentFormat: "live_archive", category: "other", viewCount: 31000 },
    { videoId: "mock_fubuki_archive_4", title: "視聴者ゲーム大会", publishedAt: "2026-08-24T20:00:00+09:00", contentFormat: "live_archive", category: "other", viewCount: 88000 },
    { videoId: "mock_fubuki_archive_5", title: "深夜雑談", publishedAt: "2026-08-22T22:00:00+09:00", contentFormat: "live_archive", category: "chatting", viewCount: 59000 },
    { videoId: "mock_fubuki_video_1", title: "フブキ的今週のハイライト", publishedAt: "2026-09-02T18:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 143000 },
    { videoId: "mock_fubuki_video_2", title: "Shorts: 今日のひとこと", publishedAt: "2026-08-30T12:00:00+09:00", contentFormat: "shorts", category: "other", viewCount: 510000 },
    { videoId: "mock_fubuki_video_3", title: "料理チャレンジ", publishedAt: "2026-08-29T18:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 76000 },
    { videoId: "mock_fubuki_video_4", title: "【告知】記念配信予告", publishedAt: "2026-08-27T18:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 19000 },
    { videoId: "mock_fubuki_video_5", title: "視聴者コメント返し", publishedAt: "2026-08-25T18:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 40000 },
    { videoId: "mock_fubuki_video_6", title: "今年を振り返る", publishedAt: "2026-08-23T18:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 220000 },
    { videoId: "mock_fubuki_sf6_1", title: "【スト6】格ゲー初心者卒業なるか", publishedAt: "2026-08-21T20:00:00+09:00", contentFormat: "live_archive", category: "sf6", viewCount: 68000 },
    { videoId: "mock_fubuki_minecraft_1", title: "【マイクラ】ゲーマーズ鯖建築", publishedAt: "2026-08-19T20:00:00+09:00", contentFormat: "live_archive", category: "minecraft", viewCount: 120000 },
    { videoId: "mock_fubuki_apex_1", title: "【Apex】リスナーとカジュアル", publishedAt: "2026-08-17T20:00:00+09:00", contentFormat: "live_archive", category: "apex", viewCount: 45000 },
  ],
  ch_gawr_gura: [
    { videoId: "v_gura_karaoke_stream", title: "karaoke time!! feat. new songs", publishedAt: "2026-09-02T10:00:00+09:00", contentFormat: "live_archive", category: "singing", viewCount: 890000 },
    { videoId: "mock_gura_archive_2", title: "chatting about recent news", publishedAt: "2026-08-27T09:00:00+09:00", contentFormat: "live_archive", category: "chatting", viewCount: 210000 },
    { videoId: "mock_gura_archive_3", title: "gaming session with viewers", publishedAt: "2026-08-25T09:00:00+09:00", contentFormat: "live_archive", category: "other", viewCount: 305000 },
    { videoId: "mock_gura_archive_4", title: "late night chill stream", publishedAt: "2026-08-23T09:00:00+09:00", contentFormat: "live_archive", category: "chatting", viewCount: 150000 },
    { videoId: "mock_gura_archive_5", title: "collab practice stream", publishedAt: "2026-08-21T09:00:00+09:00", contentFormat: "live_archive", category: "other", viewCount: 98000 },
    { videoId: "mock_gura_video_1", title: "unboxing merch!", publishedAt: "2026-09-01T15:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 620000 },
    { videoId: "mock_gura_video_2", title: "announcement video", publishedAt: "2026-08-25T15:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 175000 },
    { videoId: "mock_gura_video_3", title: "behind the scenes", publishedAt: "2026-08-24T15:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 430000 },
    { videoId: "mock_gura_video_4", title: "fan art showcase", publishedAt: "2026-08-22T15:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 112000 },
    { videoId: "mock_gura_video_5", title: "year in review", publishedAt: "2026-08-20T15:00:00+09:00", contentFormat: "normal_video", category: "other", viewCount: 980000 },
    { videoId: "mock_gura_sf6_1", title: "trying out Street Fighter 6", publishedAt: "2026-08-19T09:00:00+09:00", contentFormat: "live_archive", category: "sf6", viewCount: 260000 },
    { videoId: "mock_gura_minecraft_1", title: "minecraft base tour", publishedAt: "2026-08-17T09:00:00+09:00", contentFormat: "live_archive", category: "minecraft", viewCount: 540000 },
    { videoId: "mock_gura_apex_1", title: "apex ranked grind with chumbuds", publishedAt: "2026-08-15T09:00:00+09:00", contentFormat: "live_archive", category: "apex", viewCount: 310000 },
  ],
}

/** Empty for a creator this fixture has no entries for, rather than throwing — Home must still render something reasonable. */
export function getRecentVideosForCreator(creatorId: string): RecentVideo[] {
  return mockRecentVideos[creatorId] ?? []
}
