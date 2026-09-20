/** Per-video game/topic category (this session's own new tag-filter
 * concept for Home's video section) — distinct from ContentFormat (video
 * TYPE: normal_video/live_now/live_archive/shorts, in types/domain.ts) and
 * from Dashboard's own ContentTagKey (a different classification used only
 * on DailyVideoStat for Dashboard's filter panel, domain.ts). Neither of
 * those is reused here since both model different concerns for a different
 * page; this stays its own small, Home-specific taxonomy. */
export type VideoCategory = "sf6" | "valo" | "minecraft" | "apex" | "singing" | "chatting" | "other"
