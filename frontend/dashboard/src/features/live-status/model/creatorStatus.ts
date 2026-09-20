/** Spec's normalized per-creator Holodex status (VTUBER_HOME_V1_IMPLEMENTATION_SPEC.md
 * "Shared Holodex Status Model"). Priority when multiple videos exist: live
 * first, otherwise the nearest upcoming stream, otherwise offline. */
export type CreatorStatus =
  | { kind: "live"; videoId: string; title: string }
  | { kind: "upcoming"; videoId: string; title: string; scheduledStart: string }
  | { kind: "offline" }
