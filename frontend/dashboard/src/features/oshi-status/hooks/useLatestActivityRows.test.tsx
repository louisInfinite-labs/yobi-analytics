import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLatestActivityRows, type LatestActivityMode } from "./useLatestActivityRows"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

interface Watcher {
  callback: IntersectionObserverCallback
  targets: Element[]
  disconnected: boolean
}
let watchers: Watcher[] = []

beforeEach(() => {
  watchers = []
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      watcher: Watcher
      constructor(callback: IntersectionObserverCallback) {
        this.watcher = { callback, targets: [], disconnected: false }
        watchers.push(this.watcher)
      }
      observe(target: Element) {
        this.watcher.targets.push(target)
      }
      disconnect() {
        this.watcher.disconnected = true
      }
      unobserve() {}
      takeRecords() {
        return []
      }
    },
  )
})

afterEach(() => vi.unstubAllGlobals())

const video = (index: number): RecentVideo => ({ videoId: `v${index}`, title: `Video ${index}`, publishedAt: "2026-10-17T00:00:00Z", contentFormat: "normal_video" })

function feedOf(count: number, overrides: Partial<HomeAllFeed> = {}): HomeAllFeed {
  const page = { videos: Array.from({ length: count }, (_unused, index) => video(index)), loading: false, error: null, loadMore: vi.fn(), hasMore: true }
  return { ...page, page, ...overrides }
}

/** The panel's list in miniature: one child per rendered row, in order. */
function Harness({ creatorId, feed, mode }: { creatorId: string; feed: HomeAllFeed; mode: LatestActivityMode }) {
  const { rows, listRef } = useLatestActivityRows(creatorId, feed, mode)
  return (
    <div ref={listRef} data-testid="list">
      {rows.map((row) => (
        <div key={row.videoId} data-id={row.videoId} />
      ))}
    </div>
  )
}

const ids = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-id]")).map((node) => node.getAttribute("data-id"))

/** Scroll the rendered row at `index` into view: fires every live observer that watches it. */
function scrollTo(container: HTMLElement, index: number) {
  const target = container.querySelector("[data-testid=list]")!.children.item(index)!
  act(() => {
    for (const watcher of watchers.filter((entry) => !entry.disconnected && entry.targets.includes(target))) {
      watcher.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver)
    }
  })
}

describe("useLatestActivityRows: desktop panel (scroll)", () => {
  it("starts with the first 6 rows of the shared feed, in order", () => {
    const { container } = render(<Harness creatorId="c1" feed={feedOf(20)} mode="scroll" />)

    expect(ids(container)).toEqual(["v0", "v1", "v2", "v3", "v4", "v5"])
  })

  it("reveals 6 more loaded rows each time the last rendered row scrolls into view, with no request and no duplicates", () => {
    const feed = feedOf(20)
    const { container } = render(<Harness creatorId="c1" feed={feed} mode="scroll" />)

    scrollTo(container, 5)
    expect(ids(container)).toHaveLength(12)
    scrollTo(container, 11)

    expect(ids(container)).toHaveLength(18)
    expect(new Set(ids(container)).size).toBe(18)
    expect(feed.loadMore).not.toHaveBeenCalled() // the prefetch row (index 13) was only just rendered, not scrolled to
  })

  it("asks the feed for its next page exactly once when the row at index 13 is scrolled into view", () => {
    const feed = feedOf(20)
    const { container } = render(<Harness creatorId="c1" feed={feed} mode="scroll" />)
    scrollTo(container, 5)
    scrollTo(container, 11)

    scrollTo(container, 13)

    expect(feed.loadMore).toHaveBeenCalledTimes(1)
  })

  it("shows everything loaded once scrolled to the end, then the appended page only as the panel scrolls on; the prefetch point moves to 33", () => {
    const loadMore = vi.fn()
    const { container, rerender } = render(<Harness creatorId="c1" feed={feedOf(20, { loadMore })} mode="scroll" />)
    for (const index of [5, 11, 17]) scrollTo(container, index)
    expect(ids(container)).toHaveLength(20)

    rerender(<Harness creatorId="c1" feed={feedOf(40, { loadMore })} mode="scroll" />)
    expect(ids(container)).toHaveLength(20) // the appended rows appear only as the panel scrolls on
    scrollTo(container, 19)
    expect(ids(container).slice(18, 22)).toEqual(["v18", "v19", "v20", "v21"])
    expect(ids(container)).toHaveLength(26)
    for (const index of [25, 31]) scrollTo(container, index)
    expect(loadMore).not.toHaveBeenCalled() // 13 is no longer the prefetch point once 20 rows are loaded
    scrollTo(container, 33)

    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it("never prefetches once the feed has no more pages, and shows exactly what is loaded when under 6", () => {
    const feed = feedOf(4, { hasMore: false })
    const { container } = render(<Harness creatorId="c1" feed={feed} mode="scroll" />)

    expect(ids(container)).toHaveLength(4)
    expect(watchers.filter((entry) => entry.targets.length > 0)).toHaveLength(0)
    expect(feed.loadMore).not.toHaveBeenCalled()
  })

  it("starts over at 6 rows when the creator changes", () => {
    const feed = feedOf(20)
    const { container, rerender } = render(<Harness creatorId="c1" feed={feed} mode="scroll" />)
    scrollTo(container, 5)
    expect(ids(container)).toHaveLength(12)

    rerender(<Harness creatorId="c2" feed={feed} mode="scroll" />)

    expect(ids(container)).toHaveLength(6)
  })
})

describe("useLatestActivityRows: dedicated full-screen view (full)", () => {
  it("shows every loaded row at once (the first 20), in the feed's order", () => {
    const { container } = render(<Harness creatorId="c1" feed={feedOf(20)} mode="full" />)

    expect(ids(container)).toEqual(Array.from({ length: 20 }, (_unused, index) => `v${index}`))
  })

  it("requests the next page once at row 13, then at 33 and 53 as 20 more land each time, never twice for one point", () => {
    const loadMore = vi.fn()
    const { container, rerender } = render(<Harness creatorId="c1" feed={feedOf(20, { loadMore })} mode="full" />)

    scrollTo(container, 12) // not the prefetch row
    expect(loadMore).not.toHaveBeenCalled()
    scrollTo(container, 13)
    expect(loadMore).toHaveBeenCalledTimes(1)

    rerender(<Harness creatorId="c1" feed={feedOf(40, { loadMore })} mode="full" />)
    expect(ids(container)).toHaveLength(40)
    scrollTo(container, 13) // stale point: it is no longer observed
    expect(loadMore).toHaveBeenCalledTimes(1)
    scrollTo(container, 33)
    expect(loadMore).toHaveBeenCalledTimes(2)

    rerender(<Harness creatorId="c1" feed={feedOf(60, { loadMore })} mode="full" />)
    scrollTo(container, 53)
    expect(loadMore).toHaveBeenCalledTimes(3)
    expect(new Set(ids(container)).size).toBe(60)
  })

  it("stops asking once the feed reports no more pages", () => {
    const loadMore = vi.fn()
    const { container } = render(<Harness creatorId="c1" feed={feedOf(33, { loadMore, hasMore: false })} mode="full" />)

    scrollTo(container, 32)

    expect(loadMore).not.toHaveBeenCalled()
  })
})

describe("useLatestActivityRows: no early or repeated page requests", () => {
  it.each<LatestActivityMode>(["scroll", "full"])("%s: a prefetch point asks once per loaded count even when the observer re-attaches while its row is still on screen", (mode) => {
    const loadMore = vi.fn()
    const { container, rerender } = render(<Harness creatorId="c1" feed={feedOf(20, { loadMore })} mode={mode} />)
    if (mode === "scroll") for (const index of [5, 11, 17]) scrollTo(container, index)

    scrollTo(container, 13)
    rerender(<Harness creatorId="c1" feed={feedOf(20, { loadMore: vi.fn(), hasMore: true })} mode={mode} />) // feed state changed (page in flight): observer re-created
    rerender(<Harness creatorId="c1" feed={feedOf(20, { loadMore })} mode={mode} />)
    scrollTo(container, 13)
    scrollTo(container, 13)

    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it("asks again for the same point only after the retry window, i.e. when its page never landed", () => {
    const now = vi.spyOn(Date, "now")
    now.mockReturnValue(1_000)
    const loadMore = vi.fn()
    const { container } = render(<Harness creatorId="c1" feed={feedOf(20, { loadMore })} mode="full" />)

    scrollTo(container, 13)
    now.mockReturnValue(3_000)
    scrollTo(container, 13)
    expect(loadMore).toHaveBeenCalledTimes(1)
    now.mockReturnValue(6_000)
    scrollTo(container, 13)

    expect(loadMore).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})

describe("useLatestActivityRows: mobile/tablet Home (preview)", () => {
  it("shows only the first 6 rows, watches nothing and never asks the feed for more", () => {
    const feed = feedOf(40)
    const { container } = render(<Harness creatorId="c1" feed={feed} mode="preview" />)

    expect(ids(container)).toHaveLength(6)
    expect(watchers).toHaveLength(0)
    expect(feed.loadMore).not.toHaveBeenCalled()
  })
})
