import { describe, expect, it } from "vitest"
import { composeLatestLiveShelf } from "./latestLiveShelf"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

const at = (hour: number, minute = 0, day = 9) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

const live = (videoId: string, startedAt: string): RecentVideo => ({ videoId, title: videoId, publishedAt: startedAt, eventAt: startedAt, contentFormat: "live_now" })
const upcoming = (videoId: string, scheduledAt: string): RecentVideo => ({ videoId, title: videoId, publishedAt: scheduledAt, eventAt: scheduledAt, contentFormat: "live_upcoming" })
const archive = (videoId: string, publishedAt: string): RecentVideo => ({ videoId, title: videoId, publishedAt, contentFormat: "live_archive" })

const ids = (videos: RecentVideo[]) => videos.map((video) => video.videoId)

describe("composeLatestLiveShelf: status priority LIVE > UPCOMING > ARCHIVED", () => {
  it("a LIVE stream comes before archives", () => {
    expect(ids(composeLatestLiveShelf([live("L", at(20))], [archive("A", at(19)), archive("B", at(18))]))).toEqual(["L", "A", "B"])
  })

  it("an UPCOMING stream comes before archives", () => {
    expect(ids(composeLatestLiveShelf([upcoming("U", at(22))], [archive("A", at(19))]))).toEqual(["U", "A"])
  })

  it("LIVE, then UPCOMING, then ARCHIVED -- the spec's example", () => {
    const current = [upcoming("Upcoming C 21:00", at(21)), live("Live B", at(15)), upcoming("Upcoming E 22:00", at(22))]
    const archives = [archive("Archive A 20:00", at(20)), archive("Archive D 19:00", at(19))]

    expect(ids(composeLatestLiveShelf(current, archives))).toEqual([
      "Live B",
      "Upcoming C 21:00",
      "Upcoming E 22:00",
      "Archive A 20:00",
      "Archive D 19:00",
    ])
  })

  it("is independent of the order the inputs arrive in", () => {
    const current = [upcoming("E", at(22)), upcoming("C", at(21)), live("B", at(15))]
    const archives = [archive("D", at(19)), archive("A", at(20))]

    expect(ids(composeLatestLiveShelf([...current].reverse(), [...archives].reverse()))).toEqual(ids(composeLatestLiveShelf(current, archives)))
  })

  it("with no LIVE or UPCOMING the archive list works as usual, newest first", () => {
    expect(ids(composeLatestLiveShelf([], [archive("old", at(8, 0, 1)), archive("new", at(8, 0, 8)), archive("mid", at(8, 0, 4))]))).toEqual(["new", "mid", "old"])
  })

  it("with only LIVE/UPCOMING and no archives it still lists them", () => {
    expect(ids(composeLatestLiveShelf([upcoming("U", at(22)), live("L", at(20))], []))).toEqual(["L", "U"])
  })

  it("an empty input is an empty list", () => {
    expect(composeLatestLiveShelf([], [])).toEqual([])
  })
})

describe("composeLatestLiveShelf: the timestamp inside each group", () => {
  it("UPCOMING: the nearest scheduledStart first", () => {
    const current = [upcoming("late", at(23)), upcoming("soon", at(10)), upcoming("middle", at(16))]
    expect(ids(composeLatestLiveShelf(current, []))).toEqual(["soon", "middle", "late"])
  })

  it("UPCOMING sorts by scheduledStart, not by publishedAt", () => {
    const early = { ...upcoming("scheduled-early", at(9)), publishedAt: at(23, 0, 1) }
    const late = { ...upcoming("scheduled-late", at(18)), publishedAt: at(1, 0, 1) }
    expect(ids(composeLatestLiveShelf([late, early], []))).toEqual(["scheduled-early", "scheduled-late"])
  })

  it("ARCHIVED: the newest first, by publishedAt", () => {
    expect(ids(composeLatestLiveShelf([], [archive("a", at(1)), archive("c", at(3)), archive("b", at(2))]))).toEqual(["c", "b", "a"])
  })

  it("LIVE: the most recently started first, and equal times fall back to videoId", () => {
    expect(ids(composeLatestLiveShelf([live("started-early", at(8)), live("started-late", at(12))], []))).toEqual(["started-late", "started-early"])
    expect(ids(composeLatestLiveShelf([live("b", at(8)), live("a", at(8))], []))).toEqual(["a", "b"])
  })

  it("an unknown/unparseable time sorts last inside its own group only", () => {
    const noTime = { ...upcoming("no-time", at(1)), eventAt: undefined, publishedAt: "not-a-date" }
    const result = composeLatestLiveShelf([noTime, upcoming("known", at(20))], [archive("bad", "nope"), archive("good", at(5))])
    expect(ids(result)).toEqual(["known", "no-time", "good", "bad"])
  })
})

describe("composeLatestLiveShelf: one row per videoId", () => {
  it("the same videoId in current and archive data renders once", () => {
    const result = composeLatestLiveShelf([live("same", at(20))], [archive("same", at(19)), archive("other", at(18))])
    expect(ids(result)).toEqual(["same", "other"])
  })

  it("the current LIVE representation wins over the stale archive one", () => {
    const stale = { ...archive("same", at(19)), title: "stale archive title" }
    const current = { ...live("same", at(20)), title: "current live title" }

    const [row] = composeLatestLiveShelf([current], [stale])

    expect(row).toMatchObject({ contentFormat: "live_now", title: "current live title" })
  })

  it("the current UPCOMING representation also wins over a stale archive copy", () => {
    const [row] = composeLatestLiveShelf([upcoming("same", at(22))], [archive("same", at(19))])
    expect(row.contentFormat).toBe("live_upcoming")
  })

  it("a live stream wins over an upcoming copy of itself, and duplicate archives collapse", () => {
    const result = composeLatestLiveShelf([upcoming("same", at(20)), live("same", at(20))], [archive("dup", at(5)), archive("dup", at(5))])
    expect(result.map((video) => [video.videoId, video.contentFormat])).toEqual([
      ["same", "live_now"],
      ["dup", "live_archive"],
    ])
  })
})

describe("composeLatestLiveShelf: archive paging cannot bury LIVE/UPCOMING", () => {
  it("10 archives plus 1 LIVE: the LIVE stream is still first, and nothing is dropped", () => {
    const archives = Array.from({ length: 10 }, (_, index) => archive(`a${index}`, at(10, index)))

    const result = composeLatestLiveShelf([live("L", at(20))], archives)

    expect(result).toHaveLength(11)
    expect(result[0].videoId).toBe("L")
  })

  it("a later archive page appended afterwards keeps LIVE and UPCOMING on top", () => {
    const current = [live("L", at(20)), upcoming("U", at(23))]
    const firstPage = Array.from({ length: 20 }, (_, index) => archive(`p1-${index}`, at(10, 59 - index)))
    const secondPage = Array.from({ length: 20 }, (_, index) => archive(`p2-${index}`, at(9, 59 - index)))

    const result = composeLatestLiveShelf(current, [...firstPage, ...secondPage])

    expect(ids(result).slice(0, 3)).toEqual(["L", "U", "p1-0"])
    expect(result).toHaveLength(42)
  })

  it("does not mutate its inputs", () => {
    const current = [upcoming("b", at(22)), live("a", at(20))]
    const archives = [archive("y", at(1)), archive("z", at(2))]

    composeLatestLiveShelf(current, archives)

    expect(ids(current)).toEqual(["b", "a"])
    expect(ids(archives)).toEqual(["y", "z"])
  })
})
