import { describe, expect, it } from "vitest"
import { countUnwatched } from "./oshiActivity"
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

  it("a Premiere counts as a VIDEO, never a livestream -- only contentFormat live_archive is a livestream here", () => {
    const row: RecentVideo = { videoId: "p", title: "p", publishedAt: "2026-10-17T01:00:00Z", contentFormat: "premiere" }

    expect(countUnwatched(undefined, [row], state([], () => true), NOW)).toEqual({ videos: 1, livestreams: 0 })
  })

  it("the backend eligibility set counts a Premiere from DISCOVERY, even before its scheduled start -- never gated by isNew (which is itself gated by scheduledStart/eventAt)", () => {
    const eligibility = { videoIds: ["upcoming-premiere"], livestreamIds: [], unclassifiedIds: [] }
    // isNew would say false for a still-upcoming Premiere (its own eventAt/scheduledStart is in the future) -- the eligibility path
    // never consults it at all, so the count is correct the moment the backend's discovery-time eligibility includes the id.
    const never_new = state([], () => false)

    expect(countUnwatched(eligibility, [], never_new, NOW)).toEqual({ videos: 1, livestreams: 0 })
  })

  it("an archive-pending placeholder never creates a SECOND unwatched credit once the real archived row replaces it", () => {
    const pendingRow: RecentVideo = { videoId: "e1", title: "e1", publishedAt: "2026-10-17T01:00:00Z", contentFormat: "archive_pending" }
    const archivedRow: RecentVideo = { ...pendingRow, contentFormat: "normal_video" }
    const eligibility = { videoIds: ["e1"], livestreamIds: [], unclassifiedIds: [] }

    // Both representations loaded at once (a brief overlap while the catalog refetch lands) still count the one id once.
    expect(countUnwatched(eligibility, [pendingRow, archivedRow], state([], () => true), NOW)).toEqual({ videos: 1, livestreams: 0 })
  })
})
