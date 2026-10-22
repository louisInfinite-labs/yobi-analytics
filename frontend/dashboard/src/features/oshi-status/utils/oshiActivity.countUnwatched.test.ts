import { describe, expect, it } from "vitest"
import { countUnwatched, unwatchedVideoIds } from "./oshiActivity"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

const NOW = new Date("2026-10-17T03:00:00Z")
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_unused, index) => `${prefix}${index}`)
const never = () => false
const state = (seen: string[] = [], isNew: (c: { videoId: string }) => boolean = never) => ({ isNew, isUnseen: (id: string) => !seen.includes(id) })

describe("countUnwatched", () => {
  it("counts every eligible id exactly -- far beyond 6 rows, 20 per page and 2,000 -- with no cap", () => {
    const eligibility = { videoIds: ids("v", 2300), livestreamIds: ids("s", 450), unclassifiedIds: ids("x", 25) }

    expect(countUnwatched(eligibility, [], state(), NOW)).toEqual({ videos: 2325, livestreams: 450 }) // unclassified counted as videos, never reclassified
  })

  it("subtracts exactly what was opened, once per videoId, and ignores opened ids that are not eligible", () => {
    const eligibility = { videoIds: ["a", "b", "c"], livestreamIds: ["s1"], unclassifiedIds: ["x1"] }

    expect(countUnwatched(eligibility, [], state(["a", "a", "s1", "x1", "not-eligible", "another-creators"]), NOW)).toEqual({ videos: 2, livestreams: 0 })
  })

  it("counts a loaded NEW row the eligibility lacks once, and an id present in both once", () => {
    const row = (videoId: string, contentFormat: RecentVideo["contentFormat"]): RecentVideo => ({ videoId, title: videoId, publishedAt: "2026-10-17T01:00:00Z", contentFormat })
    const eligibility = { videoIds: ["a"], livestreamIds: [], unclassifiedIds: [] }

    const result = countUnwatched(eligibility, [row("a", "normal_video"), row("late_stream", "live_archive")], state([], () => true), NOW)

    expect(result).toEqual({ videos: 1, livestreams: 1 })
  })

  it("an id the backend lists in two groups still counts once", () => {
    expect(countUnwatched({ videoIds: ["a"], livestreamIds: ["a"], unclassifiedIds: ["a"] }, [], state(), NOW)).toEqual({ videos: 1, livestreams: 0 })
  })

  it("without an eligibility from the backend only loaded NEW rows can count", () => {
    expect(countUnwatched(undefined, [], state(), NOW)).toEqual({ videos: 0, livestreams: 0 })
  })

  it("a Premiere that is not a confirmed archive yet is never counted, whatever the NEW judgement says -- and counts as a VIDEO (never a livestream) once archived", () => {
    const row = (contentFormat: RecentVideo["contentFormat"]): RecentVideo => ({ videoId: "p", title: "p", publishedAt: "2026-10-17T01:00:00Z", contentFormat })

    expect(countUnwatched(undefined, [row("premiere")], state([], () => true), NOW)).toEqual({ videos: 0, livestreams: 0 })
    expect(countUnwatched(undefined, [row("normal_video")], state([], () => true), NOW)).toEqual({ videos: 1, livestreams: 0 })
  })

  it("the backend eligibility lists a Premiere from DISCOVERY, but its still-upcoming row keeps it out of the count until the archive is confirmed", () => {
    const eligibility = { videoIds: [], livestreamIds: [], unclassifiedIds: ["upcoming-premiere"] }
    const upcoming: RecentVideo = { videoId: "upcoming-premiere", title: "p", publishedAt: "2026-10-25T10:00:00Z", eventAt: "2026-10-25T10:00:00Z", contentFormat: "premiere" }

    expect(countUnwatched(eligibility, [upcoming], state(), NOW)).toEqual({ videos: 0, livestreams: 0 })
  })

  it("one Premiere keeps one identity through every stage: 0, 0, 0, 0 while upcoming / live / pending / handed off, then exactly 1 once the archive is available, then 0 once watched", () => {
    const eligibility = { videoIds: [], livestreamIds: [], unclassifiedIds: ["p"] } // listed by the backend from the moment it was discovered
    const stage = (contentFormat: RecentVideo["contentFormat"]): RecentVideo => ({ videoId: "p", title: "p", publishedAt: "2026-10-25T10:00:00Z", eventAt: "2026-10-25T10:00:00Z", contentFormat })
    // Like the real judgement, a watched video is never NEW.
    const counts = (format: RecentVideo["contentFormat"], seen: string[] = []) => countUnwatched(eligibility, [stage(format)], state(seen, (candidate) => !seen.includes(candidate.videoId)), NOW)

    expect(counts("premiere")).toEqual({ videos: 0, livestreams: 0 }) // announced / upcoming
    expect(counts("live_now")).toEqual({ videos: 0, livestreams: 0 }) // started
    expect(counts("archive_pending")).toEqual({ videos: 0, livestreams: 0 }) // ended, archive pending
    expect(counts("archive_pending")).toEqual({ videos: 0, livestreams: 0 }) // handed off for processing is the same placeholder
    expect(counts("normal_video")).toEqual({ videos: 1, livestreams: 0 }) // archive confirmed available: one credit, unwatched
    expect(counts("normal_video", ["p"])).toEqual({ videos: 0, livestreams: 0 }) // watched: cleared
  })

  it("a video visited while it was upcoming or pending (opened without marking it watched) becomes NEW once its archive is confirmed", () => {
    const eligibility = { videoIds: [], livestreamIds: [], unclassifiedIds: ["p"] }
    const waitingPage: RecentVideo = { videoId: "p", title: "p", publishedAt: "2026-10-25T10:00:00Z", contentFormat: "premiere" }
    const archive: RecentVideo = { ...waitingPage, contentFormat: "normal_video" }
    const nothingSeen = state([], () => true) // opening the waiting page / a pending entry never touches the seen set

    expect(countUnwatched(eligibility, [waitingPage], nothingSeen, NOW).videos).toBe(0)
    expect(countUnwatched(eligibility, [archive], nothingSeen, NOW).videos).toBe(1)
  })

  it("other rows keep their behavior: a normal upload and a completed livestream archive still count, a transitional row only removes its own id", () => {
    const eligibility = { videoIds: ["upload"], livestreamIds: ["archive"], unclassifiedIds: ["pending-one"] }
    const rows: RecentVideo[] = [
      { videoId: "upload", title: "u", publishedAt: "2026-10-17T01:00:00Z", contentFormat: "normal_video" },
      { videoId: "archive", title: "a", publishedAt: "2026-10-17T01:00:00Z", contentFormat: "live_archive" },
      { videoId: "pending-one", title: "p", publishedAt: "2026-10-17T01:00:00Z", contentFormat: "archive_pending" },
    ]

    expect(countUnwatched(eligibility, rows, state(), NOW)).toEqual({ videos: 1, livestreams: 1 })
    expect(unwatchedVideoIds(eligibility, rows, state(), NOW)).toEqual(["upload"]) // mark-all never marks a transitional video either
  })

  it("an archive-pending placeholder never creates a SECOND unwatched credit once the real archived row replaces it", () => {
    const pendingRow: RecentVideo = { videoId: "e1", title: "e1", publishedAt: "2026-10-17T01:00:00Z", contentFormat: "archive_pending" }
    const archivedRow: RecentVideo = { ...pendingRow, contentFormat: "normal_video" }
    const eligibility = { videoIds: ["e1"], livestreamIds: [], unclassifiedIds: [] }

    // Both representations loaded at once (a brief overlap while the catalog refetch lands) still count the one id once.
    expect(countUnwatched(eligibility, [pendingRow, archivedRow], state([], () => true), NOW)).toEqual({ videos: 1, livestreams: 0 })
  })
})

describe("unwatchedVideoIds", () => {
  it("is exactly the ids countUnwatched counts as videos: eligible and unclassified ones, never a livestream archive, never one already seen", () => {
    const eligibility = { videoIds: ["v1", "v2", "v_seen"], livestreamIds: ["s1"], unclassifiedIds: ["x1"] }
    const loadedArchive = { videoId: "s_loaded", publishedAt: "2026-10-17T01:00:00Z", discoveredAt: "2026-10-17T01:00:00Z", contentFormat: "live_archive" } as unknown as RecentVideo
    const loadedUpload = { videoId: "v_loaded", publishedAt: "2026-10-17T01:00:00Z", discoveredAt: "2026-10-17T01:00:00Z", contentFormat: "normal_video" } as unknown as RecentVideo
    const flagNew = () => true

    const ids = unwatchedVideoIds(eligibility, [loadedArchive, loadedUpload], state(["v_seen"], flagNew), NOW)

    expect([...ids].sort()).toEqual(["v1", "v2", "v_loaded", "x1"])
    expect(countUnwatched(eligibility, [loadedArchive, loadedUpload], state(["v_seen"], flagNew), NOW).videos).toBe(ids.length)
  })

  it("is empty without eligibility and loaded rows", () => {
    expect(unwatchedVideoIds(undefined, [], state(), NOW)).toEqual([])
  })
})
