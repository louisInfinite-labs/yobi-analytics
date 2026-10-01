import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

// Every tag (the quick filters included) is a real backend query now; this file is about
// selection/drag/View All, so the fetch layer is mocked and handed one video per query.
vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))

// jsdom has no Pointer Capture implementation; VideoTrack's own drag-to-scroll
// (unrelated to this task, kept as-is) calls these during a real drag.
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

const video: RecentVideo = {
  videoId: "video_1",
  title: "Test video title",
  publishedAt: "2026-09-10T12:00:00+09:00",
  contentFormat: "normal_video",
}

const streamVideo: RecentVideo = {
  videoId: "video_2",
  title: "Stream video title",
  publishedAt: "2026-09-09T12:00:00+09:00",
  contentFormat: "live_archive",
}

beforeEach(() => {
  // 最新影片 (the default tag) asks for uploads and 最新直播 for live archives: one distinct video each.
  vi.mocked(fetchOshiVideos).mockReset()
  vi.mocked(fetchOshiVideos).mockImplementation(async (query) => ({
    videos: query.contentType === "live" ? [streamVideo] : [video],
    nextOffset: 1,
    hasMore: false,
  }))
})

/** Renders the section and waits for the default tag's card to arrive from the (mocked) backend. */
async function renderSection(onSelectVideo = vi.fn()) {
  render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={onSelectVideo} />)
  await screen.findByRole("button", { name: /Test video title/ })
  return onSelectVideo
}

describe("RecentVideosSection video selection", () => {
  it("a normal card click calls the shared onSelectVideo path, not a modal", async () => {
    const user = userEvent.setup()
    const onSelectVideo = await renderSection()

    await user.click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "video_1", title: "Test video title" })
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })

  it("does not select a video when the pointer moved past the drag threshold first", async () => {
    const onSelectVideo = await renderSection()
    const viewport = document.querySelector(".oshi-videos__viewport") as HTMLElement

    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 0 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40, buttons: 1 })
    fireEvent.pointerUp(viewport, { pointerId: 1 })
    fireEvent.click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("does not start a drag from a stale pointerId once the button is no longer held (button released outside the viewport, before crossing the threshold)", async () => {
    const onSelectVideo = await renderSection()
    const viewport = document.querySelector(".oshi-videos__viewport") as HTMLElement

    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 0 })
    // Sub-threshold move while the button is still down -- capture is not
    // engaged yet, matching the reported repro (button released outside the
    // viewport before dragging ever started, so no pointerup/pointercancel
    // ever reaches endDrag to clear dragRef).
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 3, buttons: 1 })
    expect(viewport.dataset.dragging).toBeUndefined()

    // The pointer returns and moves again, past what would be the drag
    // threshold from the original startX -- but with no button held, this
    // is plain hover and must not be mistaken for a resumed drag.
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 50, buttons: 0 })
    expect(viewport.dataset.dragging).toBeUndefined()

    fireEvent.click(screen.getByRole("button", { name: /Test video title/ }))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "video_1", title: "Test video title" })
  })

  it("still selects a video for a click with no meaningful pointer movement", async () => {
    const onSelectVideo = await renderSection()
    const viewport = document.querySelector(".oshi-videos__viewport") as HTMLElement

    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 0 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 1 })
    fireEvent.pointerUp(viewport, { pointerId: 1 })
    fireEvent.click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "video_1", title: "Test video title" })
  })
})

describe("RecentVideosSection View All", () => {
  it("renders, is disabled, and has no click handler wired", async () => {
    renderSection()
    const viewAll = screen.getByRole("button", { name: /View All/ })

    expect(viewAll).toBeDisabled()
    // A disabled native button dispatches no click at all -- this asserts
    // the actual DOM contract (not just "no visible effect"), so a future
    // onClick={() => {}} regression would still show up as a real click.
    const clickSpy = vi.fn()
    viewAll.addEventListener("click", clickSpy)
    const user = userEvent.setup()
    await user.click(viewAll)
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it("cannot be activated with the keyboard (disabled elements are not tab-focusable)", async () => {
    renderSection()
    const viewAll = screen.getByRole("button", { name: /View All/ })

    viewAll.focus()
    expect(document.activeElement).not.toBe(viewAll)
  })

  it("does not shift the Segmented/Sort cluster's own position when rendered", async () => {
    renderSection()
    const header = document.querySelector(".oshi-videos__header") as HTMLElement
    const viewAll = screen.getByRole("button", { name: /View All/ })

    // margin-left: auto (see home.css) keeps it the header's LAST child --
    // this is what actually pins it to the far right regardless of how wide
    // the Segmented/Sort cluster is, so asserting DOM order here is asserting
    // the geometry contract this task must not disturb.
    expect(header.lastElementChild).toBe(viewAll)
  })
})

describe("RecentVideosSection quick filters and controls", () => {
  it("switching the quick filter changes which backend result is shown (最新直播 = completed live archives)", async () => {
    await renderSection()
    expect(screen.queryByRole("button", { name: /Stream video title/ })).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText("Latest Live"))

    expect(await screen.findByRole("button", { name: /Stream video title/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Test video title/ })).not.toBeInTheDocument()
  })

  it("the Content type, Sort and period dropdowns are hidden for the quick filters and appear once a topic tag is selected", async () => {
    await renderSection()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText("ALL"))

    expect(screen.getByRole("combobox", { name: "Sort videos" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Content type" })).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Period" })).not.toBeInTheDocument() // only for most viewed
  })
})
