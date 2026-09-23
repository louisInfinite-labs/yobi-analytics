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
