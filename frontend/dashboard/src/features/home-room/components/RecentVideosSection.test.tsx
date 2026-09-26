import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import type { VideoPage } from "../hooks/useRecentVideos"

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

function makePage(videos: RecentVideo[]): VideoPage {
  return { videos, loading: false, error: null, loadMore: vi.fn(), hasMore: false }
}

function renderSection(onSelectVideo = vi.fn()) {
  render(
    <RecentVideosSection
      creatorId="ch_aizawa_ema"
      latestVideos={makePage([video])}
      streamVideos={makePage([])}
      onSelectVideo={onSelectVideo}
    />,
  )
  return onSelectVideo
}

describe("RecentVideosSection video selection", () => {
  it("a normal card click calls the shared onSelectVideo path, not a modal", async () => {
    const user = userEvent.setup()
    const onSelectVideo = renderSection()

    await user.click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "video_1", title: "Test video title" })
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })

  it("does not select a video when the pointer moved past the drag threshold first", () => {
    const onSelectVideo = renderSection()
    const viewport = document.querySelector(".oshi-videos__viewport") as HTMLElement

    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 0 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40 })
    fireEvent.pointerUp(viewport, { pointerId: 1 })
    fireEvent.click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("still selects a video for a click with no meaningful pointer movement", () => {
    const onSelectVideo = renderSection()
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

  it("cannot be activated with the keyboard (disabled elements are not tab-focusable)", () => {
    renderSection()
    const viewAll = screen.getByRole("button", { name: /View All/ })

    viewAll.focus()
    expect(document.activeElement).not.toBe(viewAll)
  })

  it("does not shift the Segmented/Sort cluster's own position when rendered", () => {
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

describe("RecentVideosSection category filtering and sort, unaffected by the View All change", () => {
  it("switching the Segmented tag still changes which videos are shown", async () => {
    const streamVideo: RecentVideo = {
      videoId: "video_2",
      title: "Stream video title",
      publishedAt: "2026-09-09T12:00:00+09:00",
      contentFormat: "live_archive",
    }
    render(
      <RecentVideosSection
        creatorId="ch_aizawa_ema"
        latestVideos={makePage([video])}
        streamVideos={makePage([streamVideo])}
        onSelectVideo={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: /Test video title/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Stream video title/ })).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText("Latest Live"))

    expect(screen.getByRole("button", { name: /Stream video title/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Test video title/ })).not.toBeInTheDocument()
  })

  it("the Sort dropdown is hidden for the default latest-videos tag and appears once a category tag is selected", async () => {
    renderSection()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText("ALL"))

    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })
})
