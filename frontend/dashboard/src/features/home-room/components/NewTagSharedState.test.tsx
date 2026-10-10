import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { OshiStatusPanel } from "../../oshi-status/components/OshiStatusPanel"
import { fetchOshiVideos } from "../data/oshiVideos"
import { fetchOshiStatus, type OshiStatusData, type OshiStatusRecentItem } from "../../oshi-status/data/oshiStatus"
import { startOfLocalDay } from "../../../shared/newContent/newContentTracking"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

// Video List (RecentVideosSection) and Oshi Status (recent activity) are two views of the same content: they
// must share ONE NEW/seen state, keyed by videoId.
vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../../oshi-status/data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const NOW = new Date(2026, 9, 9, 15, 0, 0)
const TODAY_MORNING = new Date(2026, 9, 9, 10, 0, 0).toISOString()
const YESTERDAY = new Date(2026, 9, 8, 21, 0, 0).toISOString()

const listVideo = (videoId: string, title: string, publishedAt = TODAY_MORNING): RecentVideo => ({
  videoId,
  title,
  publishedAt,
  contentFormat: "normal_video",
})
const activityItem = (videoId: string, title: string, publishedAt = TODAY_MORNING): OshiStatusRecentItem => ({
  videoId,
  kind: "upload",
  title,
  thumbnailUrl: null,
  publishedAt,
  currentViewCount: 1,
})

function statusData(recent: OshiStatusRecentItem[]): OshiStatusData {
  return {
    subscriberCount: null,
    latestVideo: null,
    thisWeek: { newUploads: 0, newStreams: 0 },
    growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
    recent,
    sinceLastVisit: null,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  window.localStorage.setItem(BASELINE_KEY, startOfLocalDay(NOW).toISOString())
  resetAllSharedStateForTests()
  // X and Y are NEW in both views; Z is yesterday's, so before the baseline.
  vi.mocked(fetchOshiVideos).mockReset().mockResolvedValue({
    videos: [listVideo("vid_x", "X in video list"), listVideo("vid_y", "Y in video list"), listVideo("vid_z", "Z in video list", YESTERDAY)],
    nextOffset: 3,
    hasMore: false,
  })
  vi.mocked(fetchOshiStatus)
    .mockReset()
    .mockResolvedValue(
      statusData([activityItem("vid_x", "X in activity"), activityItem("vid_y", "Y in activity"), activityItem("vid_z", "Z in activity", YESTERDAY)]),
    )
})

afterEach(() => {
  vi.useRealTimers()
})

function Both() {
  return (
    <>
      <RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={vi.fn()} />
      <OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} now={NOW} onSelectVideo={vi.fn()} nowPlayingTitle={null} />
    </>
  )
}

async function renderBoth() {
  const view = render(<Both />)
  await screen.findByRole("button", { name: /X in video list/ })
  await screen.findByRole("button", { name: "X in activity" })
  return view
}

/** The NEW badge element, if any, on the Video List card with this title (the list must never render one). */
const listBadge = (title: RegExp) => screen.getByRole("button", { name: title }).querySelector(".oshi-video-card__new-badge")
/** The NEW badge element, if any, on the Oshi Status row with this title. */
const activityBadge = (title: string) => screen.getByRole("button", { name: title }).closest(".oshi-status__recent-row")!.querySelector(".oshi-status__recent-new-badge")
const anyListNewBadge = () => document.querySelectorAll(".oshi-video-card__new-badge, .oshi-videos__viewport [class*='new-badge']")

describe("NEW is shown in Oshi Status only; Video List and Oshi Status still share one seen state", () => {
  it("Oshi Status tags today's content NEW (and not yesterday's); the Video List shows no NEW badge on any card", async () => {
    await renderBoth()

    expect(activityBadge("X in activity")).not.toBeNull()
    expect(activityBadge("Y in activity")).not.toBeNull()
    expect(activityBadge("Z in activity")).toBeNull()
    // The same eligible videos (X, Y) in the list: no badge, and no NEW text on any card.
    expect(listBadge(/X in video list/)).toBeNull()
    expect(listBadge(/Y in video list/)).toBeNull()
    expect(listBadge(/Z in video list/)).toBeNull()
    expect(anyListNewBadge()).toHaveLength(0)
    expect(within(screen.getByRole("button", { name: /X in video list/ })).queryByText("NEW")).toBeNull()
  })

  it("an eligible archive in the Video List shows no NEW badge while the same video is NEW in Oshi Status", async () => {
    vi.mocked(fetchOshiVideos).mockResolvedValue({
      videos: [{ ...listVideo("vid_x", "X in video list"), contentFormat: "live_archive" }],
      nextOffset: 1,
      hasMore: false,
    })
    await renderBoth()

    expect(listBadge(/X in video list/)).toBeNull()
    expect(activityBadge("X in activity")).not.toBeNull()
  })

  it("opening X in the Video List still clears X's NEW in Oshi Status, and leaves Y NEW there", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth()
    expect(activityBadge("X in activity")).not.toBeNull()

    await user.click(screen.getByRole("button", { name: /X in video list/ }))

    await waitFor(() => expect(activityBadge("X in activity")).toBeNull())
    expect(activityBadge("Y in activity")).not.toBeNull()
    expect(anyListNewBadge()).toHaveLength(0)
  })

  it("opening Y in Oshi Status clears Y there and leaves X NEW; the list stays badge-free", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth()

    await user.click(screen.getByRole("button", { name: "Y in activity" }))

    await waitFor(() => expect(activityBadge("Y in activity")).toBeNull())
    expect(activityBadge("X in activity")).not.toBeNull()
    expect(anyListNewBadge()).toHaveLength(0)
  })

  it("just rendering, remounting and reloading never clears NEW in Oshi Status", async () => {
    const first = await renderBoth()
    first.unmount()
    resetAllSharedStateForTests() // reload

    await renderBoth()

    expect(activityBadge("X in activity")).not.toBeNull()
    expect(activityBadge("Y in activity")).not.toBeNull()
  })

  it("an item opened from the Video List stays cleared in Oshi Status after a reload while the unopened one stays NEW", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    const first = await renderBoth()
    await user.click(screen.getByRole("button", { name: /X in video list/ }))
    await waitFor(() => expect(activityBadge("X in activity")).toBeNull())
    first.unmount()
    resetAllSharedStateForTests() // reload

    await renderBoth()

    expect(activityBadge("X in activity")).toBeNull()
    expect(activityBadge("Y in activity")).not.toBeNull()
  })

  it("the next calendar day: an unopened item is still NEW in Oshi Status", async () => {
    const first = await renderBoth()
    first.unmount()
    vi.setSystemTime(new Date(2026, 9, 10, 9, 0, 0))
    resetAllSharedStateForTests() // reload the next morning

    render(
      <>
        <RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={vi.fn()} />
        <OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} now={new Date(2026, 9, 10, 9, 0, 0)} onSelectVideo={vi.fn()} nowPlayingTitle={null} />
      </>,
    )
    await screen.findByRole("button", { name: /X in video list/ })
    await screen.findByRole("button", { name: "X in activity" })

    expect(activityBadge("X in activity")).not.toBeNull()
    expect(listBadge(/X in video list/)).toBeNull()
    expect(window.localStorage.getItem(BASELINE_KEY)).toBe(startOfLocalDay(NOW).toISOString())
  })

  it("a currently LIVE card in the Video List shows the 直播中 badge and no NEW; an upcoming card shows neither", async () => {
    vi.mocked(fetchOshiVideos).mockResolvedValue({
      videos: [
        { ...listVideo("vid_live", "Live in video list"), contentFormat: "live_now" },
        { ...listVideo("vid_up", "Upcoming in video list"), contentFormat: "live_upcoming" },
      ],
      nextOffset: 2,
      hasMore: false,
    })
    window.localStorage.setItem("yobi.locale", "zh-TW")
    resetAllSharedStateForTests()
    render(<Both />)
    await screen.findByRole("button", { name: /Live in video list/ })

    const live = screen.getByRole("button", { name: /Live in video list/ })
    expect(live.querySelector(".oshi-video-card__live-badge")).toHaveTextContent("直播中")
    expect(listBadge(/Live in video list/)).toBeNull()
    const upcoming = screen.getByRole("button", { name: /Upcoming in video list/ })
    expect(upcoming.querySelector(".oshi-video-card__live-badge")).toBeNull()
    expect(listBadge(/Upcoming in video list/)).toBeNull()
  })
})
