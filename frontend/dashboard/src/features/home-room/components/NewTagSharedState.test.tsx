import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { OshiStatusPanel } from "../../oshi-status/components/OshiStatusPanel"
import { fetchOshiVideos } from "../data/oshiVideos"
import { fetchOshiStatus, type OshiStatusData } from "../../oshi-status/data/oshiStatus"
import { useHomeAllFeed } from "../hooks/useHomeAllFeed"
import { startOfLocalDay } from "../../../shared/newContent/newContentTracking"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

// Video List (RecentVideosSection) and Oshi Status (Latest Activity) are two views of the SAME ALL dataset (Home's shared useHomeAllFeed):
// they must also share ONE NEW/seen state, keyed by videoId.
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
function statusData(): OshiStatusData {
  return {
    subscriberCount: null,
    latestVideo: null,
    thisWeek: { newUploads: 0, newStreams: 0 },
    growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
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
  vi.mocked(fetchOshiStatus).mockReset().mockResolvedValue(statusData())
})

afterEach(() => {
  vi.useRealTimers()
})

function Both({ now = NOW }: { now?: Date }) {
  const feed = useHomeAllFeed("ch_aizawa_ema")
  return (
    <>
      <RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={vi.fn()} allFeed={feed} />
      <OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} feed={feed} now={now} onSelectVideo={vi.fn()} nowPlayingTitle={null} />
    </>
  )
}

const inList = () => within(document.querySelector(".oshi-videos") as HTMLElement)
const inPanel = () => within(document.querySelector(".oshi-status") as HTMLElement)

async function renderBoth(firstTitle = "X in video list") {
  const view = render(<Both />)
  await inList().findByRole("button", { name: new RegExp(firstTitle) })
  await within(document.querySelector(".oshi-status") as HTMLElement).findByRole("button", { name: firstTitle })
  return view
}

/** The NEW badge element, if any, on the Video List card with this title (the list must never render one). */
const listBadge = (title: RegExp) => inList().getByRole("button", { name: title }).querySelector(".oshi-video-card__new-badge")
/** The NEW badge element, if any, on the Oshi Status row with this title. */
const activityBadge = (title: string) => inPanel().getByRole("button", { name: title }).closest(".oshi-status__recent-row")!.querySelector(".oshi-status__recent-new-badge")
const anyListNewBadge = () => document.querySelectorAll(".oshi-video-card__new-badge, .oshi-videos__viewport [class*='new-badge']")

describe("NEW is shown in Oshi Status only; Video List and Oshi Status still share one seen state", () => {
  it("Oshi Status tags today's content NEW (and not yesterday's); the Video List shows no NEW badge on any card", async () => {
    await renderBoth()

    expect(activityBadge("X in video list")).not.toBeNull()
    expect(activityBadge("Y in video list")).not.toBeNull()
    expect(activityBadge("Z in video list")).toBeNull()
    // The same eligible videos (X, Y) in the list: no badge, and no NEW text on any card.
    expect(listBadge(/X in video list/)).toBeNull()
    expect(listBadge(/Y in video list/)).toBeNull()
    expect(listBadge(/Z in video list/)).toBeNull()
    expect(anyListNewBadge()).toHaveLength(0)
    expect(within(inList().getByRole("button", { name: /X in video list/ })).queryByText("NEW")).toBeNull()
  })

  it("an eligible archive in the Video List shows no NEW badge while the same video is NEW in Oshi Status", async () => {
    vi.mocked(fetchOshiVideos).mockResolvedValue({
      videos: [{ ...listVideo("vid_x", "X in video list"), contentFormat: "live_archive" }],
      nextOffset: 1,
      hasMore: false,
    })
    await renderBoth()

    expect(listBadge(/X in video list/)).toBeNull()
    expect(activityBadge("X in video list")).not.toBeNull()
  })

  it("opening X in the Video List still clears X's NEW in Oshi Status, and leaves Y NEW there", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth()
    expect(activityBadge("X in video list")).not.toBeNull()

    await user.click(inList().getByRole("button", { name: /X in video list/ }))

    await waitFor(() => expect(activityBadge("X in video list")).toBeNull())
    expect(activityBadge("Y in video list")).not.toBeNull()
    expect(anyListNewBadge()).toHaveLength(0)
  })

  it("opening Y in Oshi Status clears Y there and leaves X NEW; the list stays badge-free", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth()

    await user.click(inPanel().getByRole("button", { name: "Y in video list" }))

    await waitFor(() => expect(activityBadge("Y in video list")).toBeNull())
    expect(activityBadge("X in video list")).not.toBeNull()
    expect(anyListNewBadge()).toHaveLength(0)
  })

  it("just rendering, remounting and reloading never clears NEW in Oshi Status", async () => {
    const first = await renderBoth()
    first.unmount()
    resetAllSharedStateForTests() // reload

    await renderBoth()

    expect(activityBadge("X in video list")).not.toBeNull()
    expect(activityBadge("Y in video list")).not.toBeNull()
  })

  it("an item opened from the Video List stays cleared in Oshi Status after a reload while the unopened one stays NEW", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} })
    const first = await renderBoth()
    await user.click(inList().getByRole("button", { name: /X in video list/ }))
    await waitFor(() => expect(activityBadge("X in video list")).toBeNull())
    first.unmount()
    resetAllSharedStateForTests() // reload

    await renderBoth()

    expect(activityBadge("X in video list")).toBeNull()
    expect(activityBadge("Y in video list")).not.toBeNull()
  })

  it("the next calendar day: an unopened item is still NEW in Oshi Status", async () => {
    const first = await renderBoth()
    first.unmount()
    vi.setSystemTime(new Date(2026, 9, 10, 9, 0, 0))
    resetAllSharedStateForTests() // reload the next morning

    render(<Both now={new Date(2026, 9, 10, 9, 0, 0)} />)
    await inList().findByRole("button", { name: /X in video list/ })
    await inPanel().findByRole("button", { name: "X in video list" })

    expect(activityBadge("X in video list")).not.toBeNull()
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
    await inList().findByRole("button", { name: /Live in video list/ })

    const live = inList().getByRole("button", { name: /Live in video list/ })
    expect(live.querySelector(".oshi-video-card__live-badge")).toHaveTextContent("直播中")
    expect(listBadge(/Live in video list/)).toBeNull()
    const upcoming = inList().getByRole("button", { name: /Upcoming in video list/ })
    expect(upcoming.querySelector(".oshi-video-card__live-badge")).toBeNull()
    expect(listBadge(/Upcoming in video list/)).toBeNull()
  })
})

describe("尚未觀看 counts every eligible NEW item of the whole ALL list, not the 6 shown rows nor the loaded pages", () => {
  /** What the backend reports for the whole list: exact id groups of everything first discovered since the first visit. */
  const eligibility = (groups: { videos?: string[]; livestreams?: string[]; unclassified?: string[] }) => ({
    videoIds: groups.videos ?? [],
    livestreamIds: groups.livestreams ?? [],
    unclassifiedIds: groups.unclassified ?? [],
  })
  const unwatched = () => {
    const section = screen.getByText("Not watched yet").closest("section") as HTMLElement
    return Object.fromEntries(
      Array.from(section.querySelectorAll(".oshi-status__metric")).map((metric) => [
        metric.querySelector(".oshi-status__metric-label")!.textContent!,
        metric.querySelector(".oshi-status__metric-value")!.textContent!,
      ]),
    )
  }
  const panelTitles = () => Array.from(document.querySelectorAll(".oshi-status__recent-video-link")).map((node) => node.textContent)
  const listTitles = () => Array.from(document.querySelectorAll(".oshi-video-card__title")).map((node) => node.textContent)

  /** Eight loaded NEW videos + three NEW records that are not loaded at all (one livestream, one with no contentType yet). */
  function mockEightLoadedPlusUnloaded() {
    const loaded = Array.from({ length: 8 }, (_unused, index) => listVideo(`vid_${index}`, `Video ${index} in video list`))
    vi.mocked(fetchOshiVideos).mockResolvedValue({
      videos: loaded,
      nextOffset: 8,
      hasMore: true,
      newContent: eligibility({
        videos: [...loaded.map((video) => video.videoId), "unloaded_up"],
        livestreams: ["unloaded_live"],
        unclassified: ["unloaded_null"],
      }),
    })
  }

  it("Home shows at most 6 rows -- the first 6 of the list, same order -- while the count exceeds 6 and includes unloaded and no-contentType items", async () => {
    mockEightLoadedPlusUnloaded()
    await renderBoth("Video 0 in video list")

    expect(panelTitles()).toEqual(listTitles().slice(0, 6))
    expect(panelTitles()).toHaveLength(6)
    // 8 loaded videos + unloaded upload + unloaded no-contentType (shown as a video) = 10 videos; 1 unloaded livestream.
    await waitFor(() => expect(unwatched()).toEqual({ Videos: "10", Livestreams: "1" }))
  })

  it("opening a NEW item in the Video List immediately lowers the count and clears the same item's badge on Home; a row that is not shown still counts down", async () => {
    mockEightLoadedPlusUnloaded()
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth("Video 0 in video list")
    await waitFor(() => expect(unwatched().Videos).toBe("10"))
    expect(activityBadge("Video 0 in video list")).not.toBeNull()

    await user.click(inList().getByRole("button", { name: /Video 0 in video list/ })) // one of the 6 shown on Home
    await waitFor(() => expect(unwatched().Videos).toBe("9"))
    expect(activityBadge("Video 0 in video list")).toBeNull()
    expect(JSON.parse(window.localStorage.getItem("yobi.newContent.seenVideoIds") ?? "[]")).toEqual(["vid_0"])

    await user.click(inList().getByRole("button", { name: /Video 7 in video list/ })) // NOT among Home's 6 rows
    await waitFor(() => expect(unwatched().Videos).toBe("8"))
    expect(panelTitles()).not.toContain("Video 7 in video list")
  })

  it("opening from Home updates the same count and persists the seen id; merely rendering never marks anything seen", async () => {
    mockEightLoadedPlusUnloaded()
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth("Video 0 in video list")
    await waitFor(() => expect(unwatched().Videos).toBe("10"))
    expect(window.localStorage.getItem("yobi.newContent.seenVideoIds")).toBeNull()

    await user.click(inPanel().getByRole("button", { name: "Video 1 in video list" }))

    await waitFor(() => expect(unwatched().Videos).toBe("9"))
    expect(JSON.parse(window.localStorage.getItem("yobi.newContent.seenVideoIds") ?? "[]")).toEqual(["vid_1"])
  })

  it("a loaded NEW row the backend's list lacks still counts once, and an item in both counts once", async () => {
    vi.mocked(fetchOshiVideos).mockResolvedValue({
      videos: [listVideo("vid_a", "A in video list"), listVideo("vid_b", "B in video list")],
      nextOffset: 2,
      hasMore: false,
      newContent: eligibility({ videos: ["vid_a"] }),
    })
    await renderBoth("A in video list")

    await waitFor(() => expect(unwatched()).toEqual({ Videos: "2", Livestreams: "0" }))
  })

  it("opening the same item twice, or watching a stream while live, never decrements twice or twice-counts", async () => {
    mockEightLoadedPlusUnloaded()
    const user = userEvent.setup({ advanceTimers: () => {} })
    await renderBoth("Video 0 in video list")
    await waitFor(() => expect(unwatched().Videos).toBe("10"))

    await user.click(inList().getByRole("button", { name: /Video 0 in video list/ }))
    await user.click(inPanel().getByRole("button", { name: "Video 0 in video list" }))
    await user.click(inList().getByRole("button", { name: /Video 0 in video list/ }))

    await waitFor(() => expect(unwatched().Videos).toBe("9"))
    expect(JSON.parse(window.localStorage.getItem("yobi.newContent.seenVideoIds") ?? "[]")).toEqual(["vid_0"])
  })

  it("a seen id from another creator or an old video never lowers this creator's count", async () => {
    window.localStorage.setItem("yobi.newContent.seenVideoIds", JSON.stringify(["someone_elses_video", "old_video"]))
    resetAllSharedStateForTests()
    vi.mocked(fetchOshiVideos).mockResolvedValue({
      videos: [listVideo("vid_a", "A in video list")],
      nextOffset: 1,
      hasMore: false,
      newContent: eligibility({ videos: ["vid_a", "vid_b"] }),
    })
    await renderBoth("A in video list")

    await waitFor(() => expect(unwatched()).toEqual({ Videos: "2", Livestreams: "0" }))
  })

  it("asks for the unwatched eligibility on the ONE first-page request only, with the tracking baseline, and the panel never pages", async () => {
    await renderBoth()

    expect(fetchOshiVideos).toHaveBeenCalledTimes(1)
    expect(fetchOshiVideos).toHaveBeenCalledWith(expect.objectContaining({ topic: "all", contentType: "all", sort: "newest" }), 0, { newSince: startOfLocalDay(NOW).toISOString() })
  })
})
