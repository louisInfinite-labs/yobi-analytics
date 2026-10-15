/** The Home video shelf must be swipeable with a finger. Root cause of the report: `touch-action: pan-y` on the horizontally scrolling
 * viewport forbade horizontal touch panning, so native scrolling (the thing a finger relies on) could never start. The fix is the CSS
 * (`pan-x pan-y`), with the custom pointer drag staying mouse-only -- these tests pin both halves. */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import { readStylesheet, ruleBody } from "../../../test/readStylesheet"

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

beforeEach(() => {
  vi.mocked(fetchOshiVideos).mockReset()
  vi.mocked(fetchOshiVideos).mockResolvedValue({
    videos: [{ videoId: "video_1", title: "Test video title", publishedAt: "2026-09-10T12:00:00+09:00", contentFormat: "normal_video" }],
    nextOffset: 1,
    hasMore: false,
  })
})

async function renderSection() {
  const onSelectVideo = vi.fn()
  render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={onSelectVideo} />)
  await screen.findByRole("button", { name: /Test video title/ })
  return { onSelectVideo, viewport: document.querySelector(".oshi-videos__viewport") as HTMLElement }
}

describe("the shelf's CSS lets a finger pan it", () => {
  it("allows touch panning on BOTH axes: horizontal scrolling for the shelf, vertical for the page behind it", async () => {
    const body = ruleBody(await readStylesheet("src/pages/home/styles/home.css"), ".oshi-videos__viewport")

    expect(body).toMatch(/touch-action:\s*pan-x pan-y\s*;/)
    expect(body).not.toMatch(/touch-action:\s*pan-y\s*;/) // pan-y alone is the bug: it disables horizontal touch scrolling
    expect(body).toMatch(/overflow-x:\s*auto/)
    expect(body).toMatch(/overflow-y:\s*hidden/)
  })

  it("keeps a sideways swipe at the row's ends from turning into browser history navigation", async () => {
    const body = ruleBody(await readStylesheet("src/pages/home/styles/home.css"), ".oshi-videos__viewport")

    expect(body).toMatch(/overscroll-behavior-x:\s*contain/)
  })
})

describe("touch and pen are left to native scrolling; only the mouse drags", () => {
  it.each(["touch", "pen"])("a %s pointer moving across the row never starts the custom drag or moves the scroll position", async (pointerType) => {
    const { viewport } = await renderSection()
    viewport.scrollLeft = 120

    fireEvent.pointerDown(viewport, { pointerId: 7, button: 0, pointerType, clientX: 200 })
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 20, buttons: 1 })
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: -80, buttons: 1 })

    expect(viewport.dataset.dragging).toBeUndefined()
    expect(viewport.scrollLeft).toBe(120) // untouched by script: the browser's own pan moves it
  })

  it("a touch swipe is cancelled by the browser (no click follows), so it opens nothing", async () => {
    const { onSelectVideo, viewport } = await renderSection()

    fireEvent.pointerDown(viewport, { pointerId: 7, pointerType: "touch", clientX: 200 })
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 40, buttons: 1 })
    fireEvent.pointerCancel(viewport, { pointerId: 7 }) // what a browser sends when it takes the gesture over to scroll

    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it("a plain tap still opens the video", async () => {
    const { onSelectVideo } = await renderSection()

    await userEvent.setup().click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "video_1", title: "Test video title" })
  })

  it("mouse grab-to-scroll keeps working and still suppresses the click that ends a real drag", async () => {
    const { onSelectVideo, viewport } = await renderSection()
    viewport.scrollLeft = 100

    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 100 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 60, buttons: 1 })
    expect(viewport.dataset.dragging).toBe("true")
    expect(viewport.scrollLeft).toBe(140) // startScrollLeft 100 - (60 - 100)
    fireEvent.pointerUp(viewport, { pointerId: 1 })
    fireEvent.click(screen.getByRole("button", { name: /Test video title/ }))

    expect(onSelectVideo).not.toHaveBeenCalled()
  })
})
