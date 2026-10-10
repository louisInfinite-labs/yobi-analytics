import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isNewContent,
  markContentSeen,
  markWatchedDuringLive,
  migrateWatchedLiveToSeen,
  resetNewContentTracking,
  useNewContent,
} from "./newContentTracking"
import { resetAllSharedStateForTests } from "../state/sharedState"

const SEEN_KEY = "yobi.newContent.seenVideoIds"
const WATCHED_KEY = "yobi.newContent.watchedDuringLive"
const DAY_MS = 24 * 60 * 60 * 1000

const local = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute)

const storedWatched = (): [string, number][] => JSON.parse(window.localStorage.getItem(WATCHED_KEY) ?? "[]")
const storedSeen = (): string[] => JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]")

function firstUseAt(now: Date) {
  window.localStorage.clear()
  vi.setSystemTime(now)
  resetAllSharedStateForTests()
}

/** What a page reload does to the in-memory stores: they re-read localStorage. */
const reload = () => resetAllSharedStateForTests()

const archive = (videoId: string, publishedAt: Date) => ({ videoId, publishedAt: publishedAt.toISOString(), contentFormat: "live_archive" })
const upload = (videoId: string, publishedAt: Date) => ({ videoId, publishedAt: publishedAt.toISOString(), contentFormat: "normal_video" })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a livestream is never NEW while it is live or upcoming", () => {
  const state = { baseline: local(10, 7).toISOString(), seen: new Set<string>(), now: local(10, 7, 20) }

  it("an upcoming or live-now stream is not NEW even when its event is today and unopened", () => {
    const event = local(10, 7, 12).toISOString()
    expect(isNewContent({ videoId: "u", publishedAt: event, eventAt: event, contentFormat: "live_upcoming" }, state)).toBe(false)
    expect(isNewContent({ videoId: "l", publishedAt: event, eventAt: event, contentFormat: "live_now" }, state)).toBe(false)
  })

  it("the same stream, once it is an archive, can be NEW", () => {
    expect(isNewContent(archive("s", local(10, 7, 12)), state)).toBe(true)
  })
})

describe("watched during live suppresses only that stream's archive NEW", () => {
  it("a watched livestream's archive is not NEW; an unwatched one still is", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    const watched = archive("watched", local(10, 7, 12))
    const unwatched = archive("unwatched", local(10, 7, 13))

    expect(result.current.isNew(watched, local(10, 7, 20))).toBe(true)
    act(() => markWatchedDuringLive("watched"))

    expect(result.current.isNew(watched, local(10, 7, 20))).toBe(false)
    expect(result.current.isNew(unwatched, local(10, 7, 20))).toBe(true)
  })

  it("watching one live video does not suppress NEW for another videoId, including a normal upload", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    act(() => markWatchedDuringLive("live-1"))

    expect(result.current.isNew(archive("live-2", local(10, 7, 12)), local(10, 7, 20))).toBe(true)
    expect(result.current.isNew(upload("video-1", local(10, 7, 12)), local(10, 7, 20))).toBe(true)
  })

  it("normal uploaded videos are unaffected by the marker store", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    const video = upload("video-1", local(10, 7, 12))

    expect(result.current.isNew(video, local(10, 7, 20))).toBe(true)
    act(() => markContentSeen("video-1"))
    expect(result.current.isNew(video, local(10, 7, 20))).toBe(false)
  })

  it("opening an archive still clears its NEW through the shared seen state, and writes no watched marker", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    const opened = archive("opened", local(10, 7, 12))

    act(() => markContentSeen("opened"))

    expect(result.current.isNew(opened, local(10, 7, 20))).toBe(false)
    expect(storedSeen()).toEqual(["opened"])
    expect(storedWatched()).toEqual([])
  })

  it("a watched marker is a separate concept from seen: it writes no seen entry", () => {
    firstUseAt(local(10, 7, 8))

    markWatchedDuringLive("live-1")

    expect(storedWatched().map(([id]) => id)).toEqual(["live-1"])
    expect(storedSeen()).toEqual([])
  })
})

describe("persistence", () => {
  it("survives a reload, so the later archive is still not NEW", () => {
    firstUseAt(local(10, 7, 8))
    markWatchedDuringLive("watched")
    reload()

    const { result } = renderHook(() => useNewContent())
    expect(result.current.isNew(archive("watched", local(10, 7, 12)), local(10, 8, 9))).toBe(false)
  })

  it("is idempotent: the first confirmation wins and its time is never refreshed", () => {
    firstUseAt(local(10, 7, 8))
    markWatchedDuringLive("a")
    const firstTime = storedWatched()[0][1]

    vi.setSystemTime(local(10, 7, 9))
    markWatchedDuringLive("a")

    expect(storedWatched()).toEqual([["a", firstTime]])
  })

  it("ignores an empty id", () => {
    firstUseAt(local(10, 7, 8))
    markWatchedDuringLive("")
    expect(storedWatched()).toEqual([])
  })

  it("ignores malformed stored data instead of failing", () => {
    firstUseAt(local(10, 7, 8))
    window.localStorage.setItem(WATCHED_KEY, JSON.stringify({ not: "an array" }))
    reload()
    expect(renderHook(() => useNewContent()).result.current.isNew(archive("a", local(10, 7, 12)), local(10, 7, 20))).toBe(true)

    window.localStorage.setItem(WATCHED_KEY, JSON.stringify([["ok", Date.now()], ["bad"], [1, 2], ["nan", "x"]]))
    reload()
    const { result } = renderHook(() => useNewContent())
    expect(result.current.isNew(archive("ok", local(10, 7, 12)), local(10, 7, 20))).toBe(false)
    expect(result.current.isNew(archive("bad", local(10, 7, 12)), local(10, 7, 20))).toBe(true)
  })
})

describe("retention", () => {
  it("a marker never expires: months later the stream's archive is still not NEW", () => {
    firstUseAt(local(10, 7, 8))
    markWatchedDuringLive("old")
    const watchedAt = storedWatched()[0][1]
    const muchLater = new Date(watchedAt + 400 * DAY_MS)

    vi.setSystemTime(muchLater)
    reload()

    expect(storedWatched().map(([id]) => id)).toEqual(["old"])
    expect(renderHook(() => useNewContent()).result.current.isNew(archive("old", new Date(watchedAt)), muchLater)).toBe(false)
  })

  it("keeps the count bounded, dropping the oldest first", () => {
    firstUseAt(local(10, 7, 8))

    for (let index = 0; index < 505; index += 1) markWatchedDuringLive(`id${index}`)

    const ids = storedWatched().map(([id]) => id)
    expect(ids).toHaveLength(500)
    expect(ids[0]).toBe("id5")
    expect(ids.at(-1)).toBe("id504")
  })
})

describe("watched live -> archive transition migrates into the permanent seen state", () => {
  it("the archive appearing moves the video into seen, removes the marker, and it is never NEW", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    const stream = archive("stream", local(10, 7, 12))
    act(() => markWatchedDuringLive("stream"))
    expect(storedSeen()).toEqual([])

    act(() => migrateWatchedLiveToSeen(["stream"]))

    expect(storedSeen()).toEqual(["stream"])
    expect(storedWatched()).toEqual([])
    expect(result.current.isNew(stream, local(10, 7, 20))).toBe(false)
  })

  it("never shows NEW at any render during the migration", () => {
    firstUseAt(local(10, 7, 8))
    const stream = archive("stream", local(10, 7, 12))
    const evaluations: boolean[] = []
    renderHook(() => {
      const { isNew } = useNewContent()
      evaluations.push(isNew(stream, local(10, 7, 20)))
    })
    act(() => markWatchedDuringLive("stream"))

    act(() => migrateWatchedLiveToSeen(["stream"]))

    expect(evaluations.length).toBeGreaterThan(1)
    expect(evaluations.slice(1).every((isNew) => !isNew)).toBe(true) // (the first render predates the marker)
  })

  it("survives a reload before the archive appears, and again after the migration", () => {
    firstUseAt(local(10, 7, 8))
    markWatchedDuringLive("stream")
    reload() // still live / archive not listed yet
    expect(storedWatched().map(([id]) => id)).toEqual(["stream"])
    expect(renderHook(() => useNewContent()).result.current.isNew(archive("stream", local(10, 7, 12)), local(10, 7, 20))).toBe(false)

    migrateWatchedLiveToSeen(["stream"])
    reload()

    expect(storedSeen()).toEqual(["stream"])
    expect(storedWatched()).toEqual([])
    expect(renderHook(() => useNewContent()).result.current.isNew(archive("stream", local(10, 7, 12)), local(10, 7, 20))).toBe(false)
  })

  it("months after the migration the archive still does not become NEW", () => {
    firstUseAt(local(10, 7, 8))
    markWatchedDuringLive("stream")
    migrateWatchedLiveToSeen(["stream"])
    const muchLater = new Date(local(10, 7, 8).getTime() + 400 * DAY_MS)

    vi.setSystemTime(muchLater)
    reload()

    expect(renderHook(() => useNewContent()).result.current.isNew(archive("stream", local(10, 7, 12)), muchLater)).toBe(false)
  })

  it("only migrates videos that carry a marker: an unwatched archive stays NEW and is not added to seen", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    act(() => markWatchedDuringLive("watched"))

    act(() => migrateWatchedLiveToSeen(["watched", "unwatched", "other-upload"]))

    expect(storedSeen()).toEqual(["watched"])
    expect(result.current.isNew(archive("unwatched", local(10, 7, 12)), local(10, 7, 20))).toBe(true)
  })

  it("is a no-op without markers and idempotent when repeated", () => {
    firstUseAt(local(10, 7, 8))
    migrateWatchedLiveToSeen(["a", "b"])
    expect(storedSeen()).toEqual([])
    expect(window.localStorage.getItem(WATCHED_KEY)).toBeNull()

    markWatchedDuringLive("a")
    migrateWatchedLiveToSeen(["a"])
    migrateWatchedLiveToSeen(["a"])

    expect(storedSeen()).toEqual(["a"])
    expect(storedWatched()).toEqual([])
  })

  it("a video that is already seen just loses its marker", () => {
    firstUseAt(local(10, 7, 8))
    markContentSeen("a")
    markWatchedDuringLive("a")

    migrateWatchedLiveToSeen(["a"])

    expect(storedSeen()).toEqual(["a"])
    expect(storedWatched()).toEqual([])
  })
})

describe("dev reset", () => {
  it("forgets watched markers too, so today's content can be NEW again", () => {
    firstUseAt(local(10, 7, 8))
    const { result } = renderHook(() => useNewContent())
    act(() => markWatchedDuringLive("a"))
    expect(result.current.isNew(archive("a", local(10, 7, 9)), local(10, 7, 20))).toBe(false)

    act(() => resetNewContentTracking())

    expect(storedWatched()).toEqual([])
    expect(result.current.isNew(archive("a", local(10, 7, 9)), local(10, 7, 20))).toBe(true)
  })
})
