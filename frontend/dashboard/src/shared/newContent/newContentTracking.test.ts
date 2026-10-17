import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isNewContent,
  isUnseenContent,
  markContentSeen,
  newContentEventTime,
  resetNewContentTracking,
  startOfLocalDay,
  useNewContent,
} from "./newContentTracking"
import { resetAllSharedStateForTests } from "../state/sharedState"
import { selectHomeVideo, resetHomeSelectedVideoForTests } from "../../features/home-room/hooks/useHomeSelectedVideo"

// Captured before any test changes the TZ environment variable, so it can be restored exactly.
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"

/** Local-time instants (the browser's own zone), so every case means the same thing in any CI time zone. */
const local = (month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(2026, month - 1, day, hour, minute, second, ms)

function storedBaseline(): string | null {
  return window.localStorage.getItem(BASELINE_KEY)
}

function storedSeen(): string[] {
  return JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]")
}

/** A browser that has never run the app: nothing stored, then the stores initialise at the faked "now". */
function firstUseAt(now: Date) {
  window.localStorage.clear()
  vi.setSystemTime(now)
  resetAllSharedStateForTests()
}

/** What a page reload does to the in-memory stores: they re-read localStorage. */
function reload() {
  resetAllSharedStateForTests()
}

const video = (videoId: string, publishedAt: Date, extra: Record<string, unknown> = {}) => ({
  videoId,
  publishedAt: publishedAt.toISOString(),
  ...extra,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("tracking baseline (first use)", () => {
  it("first ever use at 18:30:12 sets the baseline to that exact instant, not midnight", () => {
    const instant = local(10, 7, 18, 30, 12, 345)
    firstUseAt(instant)

    expect(storedBaseline()).toBe(instant.toISOString())
  })

  it("is written once: a reload on a later day does not move it", () => {
    const instant = local(10, 7, 18, 30)
    firstUseAt(instant)

    vi.setSystemTime(local(10, 9, 9, 0))
    reload()

    expect(storedBaseline()).toBe(instant.toISOString())
  })

  it("keeps a baseline stored by an earlier version (local midnight) untouched -- the real first-use time was never recorded", () => {
    const legacyMidnight = local(10, 7, 0, 0).toISOString()
    window.localStorage.setItem(BASELINE_KEY, legacyMidnight)
    vi.setSystemTime(local(10, 9, 9, 0))

    reload()

    expect(storedBaseline()).toBe(legacyMidnight)
  })

  it("is not rewritten by a second load on the same day or by many reloads", () => {
    firstUseAt(local(10, 7, 8, 0))
    const first = storedBaseline()

    for (const hour of [9, 12, 23]) {
      vi.setSystemTime(local(10, 7, hour, 0))
      reload()
    }

    expect(storedBaseline()).toBe(first)
  })

  it("replaces an unparseable stored baseline with a first-use one", () => {
    window.localStorage.setItem(BASELINE_KEY, "garbage")
    vi.setSystemTime(local(10, 7, 18, 30))

    reload()

    expect(storedBaseline()).toBe(local(10, 7, 18, 30).toISOString())
  })
})

describe("local midnight is the browser's own, not a hardcoded zone", () => {
  afterEach(() => {
    vi.stubEnv("TZ", SYSTEM_TZ)
  })

  // 2026-10-07T09:30:00Z is 18:30 in Tokyo, 02:30 in Los Angeles (PDT) and 22:30 in Auckland (NZDT).
  it.each([
    ["Asia/Tokyo", "2026-10-06T15:00:00.000Z"],
    ["America/Los_Angeles", "2026-10-07T07:00:00.000Z"],
    ["Pacific/Auckland", "2026-10-06T11:00:00.000Z"],
    ["UTC", "2026-10-07T00:00:00.000Z"],
  ])("the same instant gives local midnight %s -> %s", (zone, expectedUtc) => {
    vi.stubEnv("TZ", zone)

    expect(startOfLocalDay(new Date("2026-10-07T09:30:00Z")).toISOString()).toBe(expectedUtc)
  })

  it("the first-use baseline is the same absolute instant in every zone (it is not a local-midnight construct any more)", () => {
    vi.stubEnv("TZ", "America/Los_Angeles")

    firstUseAt(new Date("2026-10-07T09:30:00Z"))

    expect(storedBaseline()).toBe("2026-10-07T09:30:00.000Z")
  })
})

describe("what counts as NEW", () => {
  const state = (seen: string[] = []) => ({ baseline: local(10, 7, 0, 0).toISOString(), seen: new Set(seen), now: local(10, 7, 20, 0) })

  it("content published before local midnight is not NEW (one millisecond before)", () => {
    expect(isNewContent(video("a", local(10, 6, 23, 59, 59, 999)), state())).toBe(false)
  })

  it("content published exactly at local midnight is NEW (the baseline day starts at 00:00:00.000)", () => {
    expect(isNewContent(video("a", local(10, 7, 0, 0, 0, 0)), state())).toBe(true)
  })

  it("content published after local midnight is NEW", () => {
    expect(isNewContent(video("a", local(10, 7, 0, 0, 0, 1)), state())).toBe(true)
    expect(isNewContent(video("a", local(10, 7, 9, 0)), state())).toBe(true)
  })

  it("content dated in the future is not NEW yet", () => {
    expect(isNewContent(video("a", local(10, 7, 20, 0, 0, 1)), state())).toBe(false)
  })

  it("content published exactly now is NEW (the upper boundary is inclusive)", () => {
    expect(isNewContent(video("a", local(10, 7, 20, 0)), state())).toBe(true)
  })

  it("nothing is NEW when there is no usable baseline (never everything)", () => {
    expect(isNewContent(video("a", local(10, 7, 9, 0)), { ...state(), baseline: "not-a-date" })).toBe(false)
  })

  it("an item already opened is not NEW", () => {
    expect(isNewContent(video("a", local(10, 7, 9, 0)), state(["a"]))).toBe(false)
  })

  it("an unparseable timestamp is never NEW", () => {
    expect(isNewContent({ videoId: "a", publishedAt: "not-a-date" }, state())).toBe(false)
  })

  it("an upcoming stream has not happened, so it is not NEW even when its time has passed", () => {
    expect(isNewContent(video("a", local(10, 7, 9, 0), { contentFormat: "live_upcoming" }), state())).toBe(false)
  })

  it("an item stays NEW on later days: the day it is judged on does not matter, only the baseline", () => {
    const nextDay = { baseline: local(10, 7, 0, 0).toISOString(), seen: new Set<string>(), now: local(10, 9, 8, 0) }

    expect(isNewContent(video("a", local(10, 7, 9, 0)), nextDay)).toBe(true)
  })
})

describe("livestream event time (which timestamp NEW uses)", () => {
  const state = () => ({ baseline: local(10, 7, 0, 0).toISOString(), seen: new Set<string>(), now: local(10, 7, 20, 0) })

  it("prefers the stream's real start (eventAt) over publishedAt", () => {
    const candidate = video("s", local(10, 3, 12, 0), { eventAt: local(10, 7, 14, 0).toISOString() })

    expect(newContentEventTime(candidate)).toBe(local(10, 7, 14, 0).getTime())
  })

  it("falls back to publishedAt when the source exposes no event time", () => {
    expect(newContentEventTime(video("s", local(10, 3, 12, 0)))).toBe(local(10, 3, 12, 0).getTime())
  })

  it("falls back to publishedAt when eventAt is empty or unparseable", () => {
    expect(newContentEventTime(video("s", local(10, 3, 12, 0), { eventAt: "" }))).toBe(local(10, 3, 12, 0).getTime())
    expect(newContentEventTime(video("s", local(10, 3, 12, 0), { eventAt: "nope" }))).toBe(local(10, 3, 12, 0).getTime())
  })

  it("a stream whose publishedAt predates the baseline but which actually started after it IS NEW", () => {
    const created3DaysAgo = video("s", local(10, 4, 12, 0), { eventAt: local(10, 7, 14, 0).toISOString() })

    expect(isNewContent(created3DaysAgo, state())).toBe(true)
  })

  it("a stream scheduled after the baseline that really started BEFORE it is not NEW (event time wins both ways)", () => {
    const startedEarlier = video("s", local(10, 7, 9, 0), { eventAt: local(10, 6, 22, 0).toISOString() })

    expect(isNewContent(startedEarlier, state())).toBe(false)
  })

  it("without an event time the same stream is judged on publishedAt, so it is NOT NEW (documented limitation of archive data)", () => {
    expect(isNewContent(video("s", local(10, 4, 12, 0)), state())).toBe(false)
  })
})

describe("seen state", () => {
  it("opening A clears A but leaves B NEW", () => {
    firstUseAt(local(10, 7, 8, 0))
    const { result } = renderHook(() => useNewContent())
    const now = local(10, 7, 20, 0)
    const a = video("a", local(10, 7, 9, 0))
    const b = video("b", local(10, 7, 10, 0))
    expect(result.current.isNew(a, now)).toBe(true)
    expect(result.current.isNew(b, now)).toBe(true)

    act(() => markContentSeen("a"))

    expect(result.current.isNew(a, now)).toBe(false)
    expect(result.current.isNew(b, now)).toBe(true)
  })

  it("is shared by every consumer: opening in one hook instance updates the other immediately", () => {
    firstUseAt(local(10, 7, 8, 0))
    const listOne = renderHook(() => useNewContent())
    const listTwo = renderHook(() => useNewContent())
    const now = local(10, 7, 20, 0)
    const a = video("a", local(10, 7, 9, 0))

    act(() => listOne.result.current.markSeen("a"))

    expect(listTwo.result.current.isNew(a, now)).toBe(false)
  })

  it("survives a reload and a later day (it is persisted by videoId)", () => {
    firstUseAt(local(10, 7, 8, 0))
    act(() => markContentSeen("a"))
    expect(storedSeen()).toEqual(["a"])

    vi.setSystemTime(local(10, 9, 8, 0))
    reload()
    const { result } = renderHook(() => useNewContent())

    expect(result.current.isNew(video("a", local(10, 7, 9, 0)), local(10, 9, 8, 0))).toBe(false)
    expect(result.current.isNew(video("b", local(10, 7, 9, 0)), local(10, 9, 8, 0))).toBe(true)
  })

  it("an unopened item is still NEW after a reload and on the next calendar day", () => {
    firstUseAt(local(10, 7, 8, 0))
    const b = video("b", local(10, 7, 10, 0))

    vi.setSystemTime(local(10, 8, 9, 0))
    reload()
    const { result } = renderHook(() => useNewContent())

    expect(result.current.isNew(b, local(10, 8, 9, 0))).toBe(true)
  })

  it("marking is idempotent and ignores an empty id", () => {
    firstUseAt(local(10, 7, 8, 0))

    markContentSeen("a")
    markContentSeen("a")
    markContentSeen("")

    expect(storedSeen()).toEqual(["a"])
  })

  it("keeps the remembered ids bounded (20,000), dropping the oldest first", () => {
    firstUseAt(local(10, 7, 8, 0))
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from({ length: 19_998 }, (_unused, index) => `id${index}`)))
    reload()

    for (let index = 19_998; index < 20_003; index += 1) markContentSeen(`id${index}`)

    const seen = storedSeen()
    expect(seen).toHaveLength(20_000)
    expect(seen[0]).toBe("id3")
    expect(seen.at(-1)).toBe("id20002")
  })

  it("no longer forgets a viewed video after 2,000 opens, and keeps every id an earlier version stored", () => {
    firstUseAt(local(10, 7, 8, 0))
    const stored = Array.from({ length: 2000 }, (_unused, index) => `old${index}`)
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(stored))
    reload()

    markContentSeen("the-2001st")

    expect(storedSeen()).toEqual([...stored, "the-2001st"]) // the first id used to be dropped here and could turn NEW again
    expect(isNewContent({ videoId: "old0", publishedAt: "2026-10-07T09:00:00Z", discoveredAt: "2026-10-07T09:00:00Z" }, { baseline: local(10, 7, 8, 0).toISOString(), seen: new Set(storedSeen()), now: local(10, 7, 20, 0) })).toBe(false)
  })

  it("selecting a video through Home's canonical player path counts as opening it", () => {
    firstUseAt(local(10, 7, 8, 0))
    try {
      selectHomeVideo({ videoId: "picked", title: "Picked" }, "aizawa_ema")

      expect(storedSeen()).toEqual(["picked"])
    } finally {
      resetHomeSelectedVideoForTests()
    }
  })
})

describe("dev reset (simulate first use today)", () => {
  it("sets the baseline to today's LOCAL 00:00, not now minus 24 hours, and forgets every opened id", () => {
    firstUseAt(local(10, 1, 8, 0))
    markContentSeen("a")
    vi.setSystemTime(local(10, 7, 18, 30))

    resetNewContentTracking()

    expect(storedBaseline()).toBe(local(10, 7, 0, 0).toISOString())
    expect(storedBaseline()).not.toBe(new Date(local(10, 7, 18, 30).getTime() - 24 * 60 * 60 * 1000).toISOString())
    expect(storedSeen()).toEqual([])
  })

  it("makes today's already-opened content NEW again and updates mounted consumers without a reload", () => {
    firstUseAt(local(10, 7, 8, 0))
    const { result } = renderHook(() => useNewContent())
    const today = video("a", local(10, 7, 9, 0))
    const yesterday = video("old", local(10, 6, 23, 0))
    act(() => markContentSeen("a"))
    expect(result.current.isNew(today, local(10, 7, 20, 0))).toBe(false)

    act(() => resetNewContentTracking())

    expect(result.current.isNew(today, local(10, 7, 20, 0))).toBe(true)
    expect(result.current.isNew(yesterday, local(10, 7, 20, 0))).toBe(false)
  })
})

describe("NEW counts from AWS's first-discovery time (discoveredAt), at the exact first-visit instant", () => {
  // First visit 08:00:00.500 JST on 10/07; everything below is judged at 20:00 the same day.
  const firstVisit = new Date("2026-10-06T23:00:00.500Z")
  const state = (seen: string[] = []) => ({ baseline: firstVisit.toISOString(), seen: new Set(seen), now: new Date("2026-10-07T11:00:00Z") })
  const candidate = (discoveredAt: string | null | undefined, publishedAt = "2020-01-01T00:00:00Z") => ({ videoId: "v", publishedAt, discoveredAt })

  it("a video discovered at 09:00 JST (after the 08:00 visit) is NEW even though it was published long ago", () => {
    expect(isNewContent(candidate("2026-10-07T00:00:00Z"), state())).toBe(true)
  })

  it("discovered exactly at the first-visit instant is NEW; one millisecond before is not", () => {
    expect(isNewContent(candidate("2026-10-06T23:00:00.500Z"), state())).toBe(true)
    expect(isNewContent(candidate("2026-10-06T23:00:00.499Z"), state())).toBe(false)
  })

  it("published after the first visit but discovered before it is not NEW: discovery time wins over publishedAt", () => {
    expect(isNewContent(candidate("2026-10-06T22:59:59Z", "2026-10-07T01:00:00Z"), state())).toBe(false)
  })

  it("an unknown discovery time (null) is never NEW -- it is not replaced by publishedAt -- while a source without the field keeps the old rule", () => {
    expect(isNewContent(candidate(null, "2026-10-07T01:00:00Z"), state())).toBe(false)
    expect(isNewContent(candidate(undefined, "2026-10-07T01:00:00Z"), state())).toBe(true)
  })

  it("is not NEW once opened, or while in the future, and stays NEW across reclassification (it keys on videoId alone)", () => {
    expect(isNewContent(candidate("2026-10-07T00:00:00Z"), state(["v"]))).toBe(false)
    expect(isNewContent(candidate("2026-10-07T11:00:00.001Z"), state())).toBe(false)
    expect(isNewContent({ ...candidate("2026-10-07T00:00:00Z"), contentFormat: "live_archive" }, state())).toBe(true)
    expect(isNewContent({ ...candidate("2026-10-07T00:00:00Z"), contentFormat: "normal_video" }, state())).toBe(true)
  })

  it("isUnseenContent ignores time: not opened and not watched while live", () => {
    expect(isUnseenContent("v", { seen: new Set(), watchedDuringLive: new Set() })).toBe(true)
    expect(isUnseenContent("v", { seen: new Set(["v"]) })).toBe(false)
    expect(isUnseenContent("v", { seen: new Set(), watchedDuringLive: new Set(["v"]) })).toBe(false)
  })
})
