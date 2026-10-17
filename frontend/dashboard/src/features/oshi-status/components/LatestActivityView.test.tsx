import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LatestActivityView } from "./LatestActivityView"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"
const FIRST_VISIT = "2026-10-17T10:00:00.000Z"
const NOW = new Date("2026-10-17T12:00:00.000Z")
const BEFORE = "2026-10-17T09:00:00.000Z" // discovered before the first visit
const AFTER = "2026-10-17T11:00:00.000Z" // discovered after it

let observed: { target: Element; callback: IntersectionObserverCallback }[] = []

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(BASELINE_KEY, FIRST_VISIT)
  resetAllSharedStateForTests()
  observed = []
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
      }
      observe(target: Element) {
        observed.push({ target, callback: this.callback })
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    },
  )
})

afterEach(() => vi.unstubAllGlobals())

/** Row i: every video's NEW state comes only from its own discovery time (and the shared seen set). */
const row = (index: number, discoveredAt: string | null): RecentVideo => ({
  videoId: `v${index}`,
  title: `Video ${index}`,
  publishedAt: "2020-01-01T00:00:00Z", // long published: it must not decide NEW
  discoveredAt,
  contentFormat: index % 4 === 3 ? "live_archive" : "normal_video",
})

function feedWith(videos: RecentVideo[], overrides: Partial<HomeAllFeed> = {}): HomeAllFeed {
  const page = { videos, loading: false, error: null, loadMore: vi.fn(), hasMore: true }
  return { ...page, page, ...overrides }
}

/** 30 rows, loaded across two pages: rows 0, 2, 24 and 29 are NEW; row 1 was discovered before the first visit; row 5 has no discovery time. */
function thirtyRows(): RecentVideo[] {
  const discovered: Record<number, string | null> = { 0: AFTER, 1: BEFORE, 2: AFTER, 5: null, 24: AFTER, 29: AFTER }
  return Array.from({ length: 30 }, (_unused, index) => row(index, index in discovered ? discovered[index] : BEFORE))
}

const rowOf = (title: string) => screen.getByRole("button", { name: title }).closest(".oshi-status__recent-row") as HTMLElement
const isNew = (title: string) => within(rowOf(title)).queryByText("NEW") !== null

function renderView(feed: HomeAllFeed, extra: { onOpen?: (video: { videoId: string; title: string }) => void; onClose?: () => void } = {}) {
  return render(<LatestActivityView creatorId="c1" feed={feed} now={NOW} onOpen={extra.onOpen ?? vi.fn()} onClose={extra.onClose ?? vi.fn()} />)
}

describe("LatestActivityView", () => {
  it("is a dialog that lists every loaded row (not 6) in the feed's order", () => {
    renderView(feedWith(thirtyRows()))

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    const titles = Array.from(document.querySelectorAll(".oshi-status__recent-video-link")).map((node) => node.textContent)
    expect(titles).toEqual(Array.from({ length: 30 }, (_unused, index) => `Video ${index}`))
  })

  it("decides NEW per row from its own discovery time: rows 1, 3.. before the first visit and the unknown-time row 5 get none, rows 0, 2, 24 and 29 do (beyond item 20 too)", () => {
    renderView(feedWith(thirtyRows()))

    expect([0, 2, 24, 29].map((index) => isNew(`Video ${index}`))).toEqual([true, true, true, true])
    expect([1, 3, 4, 5, 6, 20, 25, 28].map((index) => isNew(`Video ${index}`))).toEqual(Array(8).fill(false))
    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(4)
  })

  it("a long-published video discovered after the first visit is NEW; a row already seen is not, whatever its discovery time", () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(["v2"]))
    resetAllSharedStateForTests()
    renderView(feedWith(thirtyRows()))

    expect(isNew("Video 0")).toBe(true) // published in 2020, discovered after the first visit
    expect(isNew("Video 2")).toBe(false)
  })

  it("loading, rendering and scrolling past rows never marks anything seen", () => {
    const feed = feedWith(thirtyRows())
    renderView(feed)

    act(() => {
      for (const { target, callback } of observed) callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver)
    })

    expect(localStorage.getItem(SEEN_KEY)).toBeNull()
    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(4)
  })

  it("opening a NEW row marks it seen once in the shared store, removes its badge, selects it, and leaves the other NEW rows alone", async () => {
    const onOpen = vi.fn()
    renderView(feedWith(thirtyRows()), { onOpen })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Video 24" }))
    await user.click(screen.getByRole("button", { name: "Video 24" })) // again: still one entry, no second effect on the store

    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")).toEqual(["v24"])
    expect(isNew("Video 24")).toBe(false)
    expect([0, 2, 29].map((index) => isNew(`Video ${index}`))).toEqual([true, true, true])
    expect(onOpen).toHaveBeenCalledWith({ videoId: "v24", title: "Video 24" })
  })

  it("requests the next 20 once, when the row near index 13 comes into view, and not before", () => {
    const loadMore = vi.fn()
    renderView(feedWith(thirtyRows().slice(0, 20), { loadMore }))

    expect(loadMore).not.toHaveBeenCalled() // opening the view itself requests nothing
    const prefetch = observed.find(({ target }) => target === document.querySelectorAll(".oshi-status__recent-row")[13])!
    act(() => prefetch.callback([{ isIntersecting: true, target: prefetch.target } as IntersectionObserverEntry], {} as IntersectionObserver))

    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it("closes from the close button and from Escape", async () => {
    const onClose = vi.fn()
    renderView(feedWith(thirtyRows()), { onClose })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Close" }))
    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("shows a loading state, an error state, and the empty state instead of rows", () => {
    const { unmount } = renderView(feedWith([], { loading: true }))
    expect(document.querySelectorAll(".oshi-status__recent-row")).toHaveLength(4)
    unmount()
    const second = renderView(feedWith([], { error: new Error("boom") }))
    expect(screen.getByRole("alert")).toBeInTheDocument()
    second.unmount()
    renderView(feedWith([]))
    expect(screen.getByText("No recent activity")).toBeInTheDocument()
  })
})
