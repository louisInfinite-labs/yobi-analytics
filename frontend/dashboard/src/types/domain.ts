// Creator/video classification types mirroring the future Roadmap 3.4 Read
// API contract (see dashboard_ui_direction_en.md). Kept isolated from the
// mock data adapter so a later real API client can be swapped in without
// touching any component.

export type OrganizationKey = "hololive" | "vspo"

export type BranchKey = "holo_jp" | "holo_en" | "holo_id" | "vspo_jp" | "vspo_en"

export type ChannelType = "member" | "group" | "staff"

export type LifecycleStage = "active" | "pre_debut" | "graduated" | "retired"

// Free-form generation/unit/staff grouping (Creator Master's groupKey,
// Roadmap 1.3) — not a closed enum. A creator can carry more than one, and
// generations aren't capped at a fixed count.
export type GroupKey = string

export type ContentTagKey =
  | "valorant"
  | "sf6"
  | "karaoke"
  | "chat"
  | "gaming"
  | "collab"
  | "announcement"
  | "3d_live"
  | "clip"
  | "translation"

export type ContentFormat =
  | "shorts"
  | "live_archive"
  | "normal_video"
  | "live_upcoming"
  | "live_now"
  | "premiere"
  | "unknown"

export type GrowthStatus = "ok" | "pending" | "not_available"

export type Period = "1d" | "7d" | "30d"

export interface DailyVideoStat {
  date: string
  channelId: string
  channelName: string
  organization: OrganizationKey
  branch: BranchKey
  groupKey: GroupKey[]
  channelType: ChannelType
  lifecycleStage: LifecycleStage
  videoId: string
  videoTitle: string
  contentFormat: ContentFormat
  contentTags: ContentTagKey[]
  totalViews: number
  dailyIncrease: number
  growthPercent: number | null
  sevenDayAverage?: number
  publishedAt?: string
  collectedAt: string
  status: GrowthStatus
}

export interface AnalyticsRequest {
  timeZone: string
  reportDate: string
  period: Period
  organization?: OrganizationKey
  branch?: BranchKey
  groupKey?: GroupKey[]
  channelType?: ChannelType
  lifecycleStage?: LifecycleStage
  contentFormat?: ContentFormat
  contentTags?: ContentTagKey[]
}

export const CONTENT_TAG_LABELS: Record<ContentTagKey, string> = {
  valorant: "VALORANT",
  sf6: "SF6",
  karaoke: "歌回",
  chat: "雑談",
  gaming: "遊戲",
  collab: "Collab",
  announcement: "重大告知",
  "3d_live": "3D Live",
  clip: "切り抜き",
  translation: "翻譯",
}

export const CONTENT_FORMAT_LABELS: Record<ContentFormat, string> = {
  shorts: "Shorts",
  live_archive: "直播存檔",
  normal_video: "一般影片",
  live_upcoming: "即將直播",
  live_now: "直播中",
  premiere: "Premiere",
  unknown: "未知",
}

export const BRANCH_LABELS: Record<BranchKey, string> = {
  holo_jp: "Hololive JP",
  holo_en: "Hololive EN",
  holo_id: "Hololive ID",
  vspo_jp: "VSPO JP",
  vspo_en: "VSPO EN",
}

export const ORGANIZATION_LABELS: Record<OrganizationKey, string> = {
  hololive: "Hololive",
  vspo: "VSPO",
}

export const LIFECYCLE_STAGE_LABELS: Record<LifecycleStage, string> = {
  active: "活動中",
  pre_debut: "未出道",
  graduated: "卒業",
  retired: "引退",
}
