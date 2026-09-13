import type { BranchKey, ChannelType, GroupKey, LifecycleStage, OrganizationKey } from "../types/domain"

export interface MockCreator {
  channelId: string
  channelName: string
  organization: OrganizationKey
  branch: BranchKey
  groupKey: GroupKey[]
  channelType: ChannelType
  lifecycleStage: LifecycleStage
  /** Real YouTube channel avatar thumbnail URL. No creator-master/YouTube
   * data source exposes this yet (see this task's completion report's data
   * dependency note), so every mock entry below leaves it unset and the UI
   * falls back to a generated colored-circle/initial placeholder. */
  avatarUrl?: string
  /** The creator's own Japanese reading (Hiragana or Katakana), used only as
   * a gojuon sort key (see lib/japaneseReading.ts) — never derived from the
   * displayed Kanji name at runtime. Left unset for group/staff/placeholder
   * channels and non-Japanese-branch creators, whose name isn't an
   * individual's own pronunciation to begin with (see this task's
   * completion report's kana-coverage note); sorting falls back to stable
   * roster order for any creator missing it. */
  kana?: string
}

// Covers: hololive + VSPO, JP/EN/ID branches, active/graduated/pre-debut,
// member/group/staff channels, and creators carrying more than one group tag
// — see dashboard_ui_direction_en.md section 4/8 for the required scenarios.
export const mockCreators: MockCreator[] = [
  {
    channelId: "ch_aizawa_ema",
    channelName: "藍沢エマ",
    organization: "vspo",
    branch: "vspo_jp",
    groupKey: ["1期生"],
    channelType: "member",
    lifecycleStage: "active",
    kana: "あいざわえま",
  },
  {
    channelId: "ch_shirakami_fubuki",
    channelName: "白上フブキ",
    organization: "hololive",
    branch: "holo_jp",
    groupKey: ["1期生", "ゲーマーズ"],
    channelType: "member",
    lifecycleStage: "active",
    kana: "しらかみふぶき",
  },
  {
    channelId: "ch_usada_pekora",
    channelName: "兎田ぺこら",
    organization: "hololive",
    branch: "holo_jp",
    groupKey: ["3期生"],
    channelType: "member",
    lifecycleStage: "active",
    kana: "うさだぺこら",
  },
  {
    channelId: "ch_gawr_gura",
    channelName: "Gawr Gura",
    organization: "hololive",
    branch: "holo_en",
    groupKey: ["Myth"],
    channelType: "member",
    lifecycleStage: "active",
  },
  {
    channelId: "ch_iofi",
    channelName: "Airani Iofifteen",
    organization: "hololive",
    branch: "holo_id",
    groupKey: ["1期生"],
    channelType: "member",
    lifecycleStage: "active",
  },
  {
    channelId: "ch_kiryu_coco",
    channelName: "桐生ココ",
    organization: "hololive",
    branch: "holo_jp",
    // Shares a Gen 1 tag with other active Gen 1 creators so a graduated
    // creator still retaining an active generation tag is a real, testable
    // fixture case (dashboard_ui_direction_en.md's Hololive + JP + Gen 1 +
    // graduated example).
    groupKey: ["1期生"],
    channelType: "member",
    lifecycleStage: "graduated",
    kana: "きりゅうここ",
  },
  {
    channelId: "ch_amelia_myth_graduated",
    channelName: "Watson Amelia",
    organization: "hololive",
    branch: "holo_en",
    groupKey: ["Myth"],
    channelType: "member",
    lifecycleStage: "graduated",
  },
  {
    channelId: "ch_new_unit_predebut",
    channelName: "New Generation (Pre-Debut)",
    organization: "hololive",
    branch: "holo_jp",
    groupKey: ["7期生"],
    channelType: "group",
    lifecycleStage: "pre_debut",
  },
  {
    channelId: "ch_holox_group",
    channelName: "holoX",
    organization: "hololive",
    branch: "holo_jp",
    groupKey: ["holoX"],
    channelType: "group",
    lifecycleStage: "active",
  },
  {
    channelId: "ch_hololive_staff",
    channelName: "hololive Production Staff",
    organization: "hololive",
    branch: "holo_jp",
    groupKey: ["NO"],
    channelType: "staff",
    lifecycleStage: "active",
  },
  {
    channelId: "ch_vspo_en_member",
    channelName: "Kurara Nyx",
    organization: "vspo",
    branch: "vspo_en",
    groupKey: ["2期生"],
    channelType: "member",
    lifecycleStage: "active",
  },
  {
    channelId: "ch_vspo_group",
    channelName: "VSPO! Official",
    organization: "vspo",
    branch: "vspo_jp",
    groupKey: ["NO"],
    channelType: "group",
    lifecycleStage: "active",
  },
]
