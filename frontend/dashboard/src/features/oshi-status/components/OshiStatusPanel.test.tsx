import { getCreatorById } from "../../../entities/creator/data/creatorRegistry"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import { fetchOshiStatus, type OshiStatusData, type OshiStatusRecentItem } from "../data/oshiStatus"
import { ApiError } from "../../../shared/api/apiClient"
import { startOfLocalDay } from "../../../shared/newContent/newContentTracking"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../hooks/useLastVisit", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useLastVisit")>("../hooks/useLastVisit")
  return { ...actual, usePreviousVisit: vi.fn() }
})
vi.mock("../data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiStatus)
const PREVIOUS_VISIT = new Date("2026-09-05T00:00:00+09:00")
// Local-time constructors on purpose: NEW is judged against the browser's own local midnight, so these
// fixtures must mean the same thing whatever time zone the tests run in.
const now = new Date(2026, 8, 10, 12, 0, 0)
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"

const seenItem: OshiStatusRecentItem = {
  videoId: "seen_video_1",
  kind: "upload",
  title: "Seen upload",
  thumbnailUrl: "https://img.youtube.com/vi/seen_video_1/hqdefault.jpg",
  publishedAt: new Date(2026, 8, 1, 12, 0, 0).toISOString(),
  currentViewCount: 100,
}
const unseenItem: OshiStatusRecentItem = {
  ...seenItem,
  videoId: "unseen_video_1",
  title: "Unseen upload",
  thumbnailUrl: null,
  publishedAt: new Date(2026, 8, 10, 9, 0, 0).toISOString(),
}

function status(overrides: Partial<OshiStatusData> = {}): OshiStatusData {
  return {
    subscriberCount: 123_456,
    latestVideo: null,
    thisWeek: { newUploads: 2, newStreams: 3 },
    growth: {
      "1d": { absoluteGrowth: 10, videoCount: 5 },
      "7d": { absoluteGrowth: 12_300, videoCount: 40 },
      "30d": { absoluteGrowth: 99_000, videoCount: 90 },
    },
    recent: [unseenItem, seenItem],
    sinceLastVisit: { newUploads: 4, newStreams: 1, clamped: false },
    ...overrides,
  }
}

function renderPanel(creatorId = "ch_aizawa_ema", onSelectVideo = vi.fn()) {
  const ui = (id: string) => (
    <OshiStatusPanel creatorId={id} status={{ kind: "offline" }} now={now} onSelectVideo={onSelectVideo} nowPlayingTitle={null} />
  )
  const view = render(ui(creatorId))
  return { onSelectVideo, unmount: view.unmount, switchCreator: (id: string) => view.rerender(ui(id)) }
}

/** The label/value pairs of one panel section, e.g. section("This week"). */
function metrics(sectionTitle: string): Record<string, string> {
  const section = screen.getByText(sectionTitle).closest("section") as HTMLElement
  const entries = Array.from(section.querySelectorAll(".oshi-status__metric")).map((metric) => [
    metric.querySelector(".oshi-status__metric-label")!.textContent!,
    metric.querySelector(".oshi-status__metric-value")!.textContent!,
  ])
  return Object.fromEntries(entries)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(status())
  vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(PREVIOUS_VISIT)
  // Tracking began (first use) on 09-10, so the baseline is that day's local 00:00.
  localStorage.setItem(BASELINE_KEY, startOfLocalDay(now).toISOString())
  resetAllSharedStateForTests()
})

describe("OshiStatusPanel: backend request", () => {
  it("asks for the CURRENT creator's canonical id with the stored last visit as `since`", async () => {
    renderPanel("ch_aizawa_ema")

    await screen.findByText("Unseen upload")
    expect(fetchMock).toHaveBeenCalledWith("aizawa_ema", PREVIOUS_VISIT)
  })

  it("a first visit sends no `since` and shows the first-visit message instead of since-last-visit numbers", async () => {
    vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
    fetchMock.mockResolvedValue(status({ sinceLastVisit: null }))
    renderPanel()

    await screen.findByText("Unseen upload")
    expect(fetchMock).toHaveBeenCalledWith("aizawa_ema", null)
    expect(screen.getByText("First visit — nothing to catch up on yet")).toBeInTheDocument()
  })

  it("switching the current Oshi re-requests for the new creator and never keeps the old creator's numbers", async () => {
    const { switchCreator } = renderPanel("ch_aizawa_ema")
    await screen.findByText("Unseen upload")
    fetchMock.mockImplementation(() => new Promise(() => {})) // the new creator's request stays pending

    switchCreator("ch_gawr_gura")

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("gawr_gura", PREVIOUS_VISIT))
    expect(screen.queryByText("Unseen upload")).not.toBeInTheDocument()
    expect(screen.queryByText("123.5K subscribers")).not.toBeInTheDocument()
    expect(metrics("This week")).toEqual({ Streams: "—", Uploads: "—" })
  })

  it("requests nothing for a creator with no canonical id and shows the empty states", async () => {
    renderPanel("ch_hololive_staff")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText("No recent activity")).toBeInTheDocument()
  })
})

describe("OshiStatusPanel: header, metrics and recent rows come from the backend", () => {
  it("shows the backend subscriber count", async () => {
    renderPanel()

    expect(await screen.findByText("123.5K subscribers")).toBeInTheDocument()
  })

  it("omits the subscriber line when the count is null -- never a fabricated 0", async () => {
    fetchMock.mockResolvedValue(status({ subscriberCount: null }))
    renderPanel()

    await screen.findByText("Unseen upload")
    expect(document.querySelector(".oshi-status__subscriber-count")).toBeNull()
  })

  it("Since your last visit shows the backend's new uploads and streams", async () => {
    renderPanel()

    await screen.findByText("Unseen upload")
    const since = metrics("Since your last visit")
    expect(since.Uploads).toBe("4")
    expect(since.Streams).toBe("1")
  })

  it("This week shows only the backend's new uploads and streams", async () => {
    renderPanel()

    await screen.findByText("Unseen upload")
    expect(metrics("This week")).toEqual({ Streams: "3", Uploads: "2" })
  })

  it("shows neither view-growth metric (this week, nor since the last visit) even though the backend still sends it", async () => {
    renderPanel()

    await screen.findByText("Unseen upload")
    expect(metrics("This week")).not.toHaveProperty("View growth")
    expect(metrics("Since your last visit")).not.toHaveProperty("View growth")
    expect(screen.queryByText("View growth")).toBeNull()
    expect(screen.queryByText("12.3K")).toBeNull() // the 7-day growth value that used to be shown
  })

  it("closes the freed space: each metrics row is a two-column grid with exactly its two metrics, no blank card", async () => {
    renderPanel()

    await screen.findByText("Unseen upload")
    for (const row of Array.from(document.querySelectorAll(".oshi-status__metrics"))) {
      expect(row.querySelectorAll(".oshi-status__metric")).toHaveLength(2)
      expect(Array.from(row.querySelectorAll(".oshi-status__metric")).every((metric) => metric.textContent?.trim())).toBe(true)
    }
  })

  it("keeps the other this-week and since-last-visit metrics (uploads, streams) in place", async () => {
    renderPanel()

    await screen.findByText("Unseen upload")
    expect(Object.keys(metrics("This week")).sort()).toEqual(["Streams", "Uploads"])
    expect(Object.keys(metrics("Since your last visit")).sort()).toEqual(["Streams", "Uploads"])
  })

  it("shows placeholders, never a fabricated 0, while the data is not available", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    renderPanel()

    expect(metrics("Since your last visit")).toEqual({ Uploads: "—", Streams: "—" })
    expect(metrics("This week")).toEqual({ Streams: "—", Uploads: "—" })
  })

  it("a failed request shows the normal error state with its code and the placeholders, never old or mock data", async () => {
    fetchMock.mockRejectedValue(new ApiError(503, "Service Unavailable", "RANKING_NOT_READY"))
    renderPanel()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("(Code: 503)")
    expect(screen.queryByText("No recent activity")).toBeNull() // the empty text is for a valid empty result only
    expect(metrics("This week")).toEqual({ Streams: "—", Uploads: "—" })
    expect(document.querySelector(".oshi-status__subscriber-count")).toBeNull()
    expect(document.querySelector(".oshi-status__recent-row")).toBeNull()
  })

  it("a network failure shows the network error state, not the server one", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    renderPanel()

    expect(await screen.findByRole("alert")).toHaveTextContent("(Code: NETWORK)")
  })

  it("an empty backend result (no recent rows) shows the empty state, not an error", async () => {
    fetchMock.mockResolvedValue(status({ recent: [], latestVideo: null }))
    renderPanel()

    expect(await screen.findByText("No recent activity")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(metrics("This week").Uploads).toBe("2") // the rest of the panel still renders
  })
})

describe("OshiStatusPanel Recent Activity", () => {
  it("shows the NEW badge only for content published on/after the tracking baseline", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelectorAll(".oshi-status__recent-row")).toHaveLength(2)
    const unseenRow = screen.getByText("Unseen upload").closest(".oshi-status__recent-row")
    const seenRow = screen.getByText("Seen upload").closest(".oshi-status__recent-row")
    expect(unseenRow?.querySelector(".oshi-status__recent-new-badge")).not.toBeNull()
    expect(seenRow?.querySelector(".oshi-status__recent-new-badge")).toBeNull()
  })

  it("still shows NEW for today's content on a first visit -- the old 'no previous visit means nothing is new' rule is gone", async () => {
    vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(1)
  })

  it("opening a NEW row clears only that row's badge and still selects the video", async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(status({ recent: [unseenItem, { ...unseenItem, videoId: "unseen_video_2", title: "Second unseen upload" }, seenItem] }))
    const { onSelectVideo } = renderPanel()
    await screen.findByText("Unseen upload")
    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(2)

    await user.click(screen.getByText("Unseen upload"))

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "unseen_video_1", title: "Unseen upload" })
    expect(screen.getByText("Unseen upload").closest(".oshi-status__recent-row")?.querySelector(".oshi-status__recent-new-badge")).toBeNull()
    expect(screen.getByText("Second unseen upload").closest(".oshi-status__recent-row")?.querySelector(".oshi-status__recent-new-badge")).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")).toEqual(["unseen_video_1"])
  })

  it("keeps an unopened row NEW across a reload and a later render (visiting never clears it)", async () => {
    const first = renderPanel()
    await screen.findByText("Unseen upload")
    first.unmount()

    resetAllSharedStateForTests() // what a reload does: the stores re-read localStorage
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(1)
  })

  it("keeps a row NEW on a later day when it was never opened (the baseline is not re-stamped)", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")
    const nextDay = new Date(2026, 8, 11, 8, 0, 0)

    const { unmount } = render(
      <OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} now={nextDay} onSelectVideo={vi.fn()} nowPlayingTitle={null} />,
    )
    await waitFor(() => expect(document.querySelectorAll(".oshi-status__recent-new-badge").length).toBeGreaterThan(0))
    unmount()

    expect(localStorage.getItem(BASELINE_KEY)).toBe(startOfLocalDay(now).toISOString())
  })

  it("keeps time and title on the first line with the thumbnail below, and no icon between them", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")

    const row = screen.getByText("Unseen upload").closest(".oshi-status__recent-row") as HTMLElement
    expect(row.children).toHaveLength(3)
    expect(row.querySelector(".oshi-status__recent-time-column")).not.toBeNull()
    expect(row.querySelector(".oshi-status__recent-content")).not.toBeNull()
    expect(row.querySelector(".oshi-status__thumb")).not.toBeNull()
  })

  it("uses the backend thumbnail when there is one, else YouTube's own thumbnail for the video id", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")

    const seenImg = screen.getByText("Seen upload").closest(".oshi-status__recent-row")!.querySelector("img")!
    const unseenImg = screen.getByText("Unseen upload").closest(".oshi-status__recent-row")!.querySelector("img")!
    expect(seenImg.getAttribute("src")).toBe(seenItem.thumbnailUrl)
    expect(unseenImg.getAttribute("src")).toContain("img.youtube.com/vi/")
  })

  it("calls the shared onSelectVideo path (not a modal) for both seen and unseen rows", async () => {
    const user = userEvent.setup()
    const { onSelectVideo } = renderPanel()
    await screen.findByText("Unseen upload")

    await user.click(screen.getByText("Unseen upload"))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "unseen_video_1", title: "Unseen upload" })

    await user.click(screen.getByText("Seen upload"))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "seen_video_1", title: "Seen upload" })

    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })
})

describe("OshiStatusPanel DEV reset", () => {
  it("renders a reset control in the header (DEV mode, as in this test run)", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelector(".oshi-status__dev-reset")).not.toBeNull()
  })

  it("clicking reset calls resetPreviousVisit and touches only the visit and NEW-tracking storage keys", async () => {
    const user = userEvent.setup()
    const resetSpy = vi.spyOn(useLastVisit, "resetPreviousVisit")
    localStorage.setItem("yobi.defaultOshiCreatorId", "ch_aizawa_ema")
    localStorage.setItem("yobi.locale", "en")

    renderPanel()
    await screen.findByText("Unseen upload")
    const resetButton = document.querySelector(".oshi-status__dev-reset") as HTMLButtonElement
    await user.click(resetButton)

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("yobi.home.lastVisitAt")).not.toBeNull()
    expect(localStorage.getItem("yobi.defaultOshiCreatorId")).toBe("ch_aizawa_ema")
    expect(localStorage.getItem("yobi.locale")).toBe("en")
  })

  it("reset simulates first use TODAY: the baseline becomes today's local 00:00 (not now-24h) and opened ids are forgotten", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    try {
      const user = userEvent.setup({ advanceTimers: () => {} })
      localStorage.setItem(BASELINE_KEY, new Date(2026, 8, 5, 0, 0, 0).toISOString())
      localStorage.setItem(SEEN_KEY, JSON.stringify(["unseen_video_1"]))
      resetAllSharedStateForTests()
      renderPanel()
      await screen.findByText("Unseen upload")
      expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(0) // already opened

      await user.click(document.querySelector(".oshi-status__dev-reset") as HTMLButtonElement)

      expect(localStorage.getItem(BASELINE_KEY)).toBe(startOfLocalDay(now).toISOString())
      expect(localStorage.getItem(BASELINE_KEY)).not.toBe(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
      expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")).toEqual([])
      await waitFor(() => expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(1))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("OshiStatusPanel: accent color is the canonical creator color", () => {
  it("天音かなた's avatar fallback (shown when her icon fails to load) uses the canonical #76c0ea, not a frontend-owned color", async () => {
    renderPanel("ch_amane_kanata")
    fireEvent.error(document.querySelector(".oshi-status__creator-avatar img")!)

    const avatar = document.querySelector<HTMLElement>(".oshi-status__creator-avatar")!
    await waitFor(() => expect(avatar.querySelector("img")).toBeNull())

    expect(avatar.style.background).toBe("rgb(118, 192, 234)")
  })
})

describe("OshiStatusPanel DEV reset in a production build", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("renders no reset control, hidden or otherwise, in any language", async () => {
    vi.stubEnv("DEV", false)
    vi.stubEnv("PROD", true)
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelector(".oshi-status__dev-reset")).toBeNull()
    for (const label of ["重置造訪", "Reset visit", "訪問をリセット"]) expect(document.body.textContent).not.toContain(label)
  })

  it("the reset functions themselves are no-ops outside development", async () => {
    window.localStorage.setItem("yobi.newContent.seenVideoIds", JSON.stringify(["a"]))
    vi.stubEnv("DEV", false)
    vi.stubEnv("PROD", true)
    const { resetNewContentTracking } = await import("../../../shared/newContent/newContentTracking")
    const { resetPreviousVisit } = await import("../hooks/useLastVisit")
    const before = JSON.stringify(window.localStorage)

    resetNewContentTracking()
    resetPreviousVisit()

    expect(JSON.stringify(window.localStorage)).toBe(before)
  })
})

describe("OshiStatusPanel creator avatar", () => {
  const avatarImg = () => document.querySelector(".oshi-status__creator-avatar img") as HTMLImageElement | null
  const avatarFallback = () => document.querySelector(".oshi-status__creator-avatar")?.textContent

  it.each([
    ["ch_aizawa_ema", "aizawa_ema", "藍"],
    ["ch_shirakami_fubuki", "shirakami_fubuki", "白"],
  ])("%s shows the registry channel icon, not the initial", async (legacyId, creatorId, initial) => {
    renderPanel(legacyId)
    await screen.findByText("Unseen upload")

    const expected = getCreatorById(creatorId)?.avatarUrl
    expect(expected).toBeTruthy()
    expect(avatarImg()?.getAttribute("src")).toBe(expected)
    expect(avatarFallback()).not.toBe(initial)
  })

  it("switching creator swaps the icon to the new creator's own", async () => {
    const { switchCreator } = renderPanel("ch_aizawa_ema")
    await screen.findByText("Unseen upload")

    switchCreator("ch_shirakami_fubuki")

    await waitFor(() => expect(avatarImg()?.getAttribute("src")).toBe(getCreatorById("shirakami_fubuki")?.avatarUrl))
  })

  it("shows the initial when the icon URL fails to load", async () => {
    renderPanel("ch_aizawa_ema")
    await screen.findByText("Unseen upload")

    fireEvent.error(avatarImg()!)

    await waitFor(() => expect(avatarImg()).toBeNull())
    expect(avatarFallback()).toBe("藍")
  })

  it("falls back to the initial only when the creator has no registry icon", async () => {
    renderPanel("ch_not_in_registry")

    await waitFor(() => expect(avatarImg()).toBeNull())
  })
})

describe("OshiStatusPanel thumbnails", () => {
  const WATCHED_KEY = "yobi.newContent.watchedDuringLive"
  const LIVE = { kind: "live", videoId: "live_video_1", title: "Live right now", thumbnailUrl: "https://img.example/live_video_1.jpg" } as const
  const UPCOMING = {
    kind: "upcoming",
    videoId: "upcoming_video_1",
    title: "Starts soon",
    scheduledStart: new Date(2026, 8, 10, 20, 0, 0).toISOString(),
    thumbnailUrl: "https://img.example/upcoming_video_1.jpg",
  } as const

  function renderThumbs(props: Partial<React.ComponentProps<typeof OshiStatusPanel>> = {}) {
    const onSelectVideo = vi.fn()
    render(<OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} now={now} onSelectVideo={onSelectVideo} nowPlayingTitle={null} {...props} />)
    return { onSelectVideo }
  }
  const thumbImg = (scope: string) => document.querySelector<HTMLImageElement>(`${scope} .oshi-status__thumb img`)

  describe("最近動態 (Recent Activity)", () => {
    it("shows the backend thumbnail field, and the app's videoId fallback only when there is none", async () => {
      renderThumbs()
      await screen.findByText("Unseen upload")

      const seen = screen.getByText("Seen upload").closest(".oshi-status__recent-row")!.querySelector("img")!
      const unseen = screen.getByText("Unseen upload").closest(".oshi-status__recent-row")!.querySelector("img")!
      expect(seen.getAttribute("src")).toBe(seenItem.thumbnailUrl)
      expect(unseen.getAttribute("src")).toBe("https://img.youtube.com/vi/unseen_video_1/hqdefault.jpg")
    })

    it("clicking the thumbnail does exactly what clicking the title does: same selection, same seen marking, that videoId only", async () => {
      const user = userEvent.setup()
      const { onSelectVideo } = renderThumbs()
      await screen.findByText("Unseen upload")
      const row = screen.getByText("Unseen upload").closest(".oshi-status__recent-row") as HTMLElement

      await user.click(row.querySelector(".oshi-status__thumb") as HTMLElement)

      expect(onSelectVideo).toHaveBeenCalledTimes(1)
      expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "unseen_video_1", title: "Unseen upload" })
      expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")).toEqual(["unseen_video_1"])
      expect(row.querySelector(".oshi-status__recent-new-badge")).toBeNull()
    })

    it("the title and the thumbnail are two entry points to one action: neither selects any other video", async () => {
      const user = userEvent.setup()
      const { onSelectVideo } = renderThumbs()
      await screen.findByText("Seen upload")
      const row = screen.getByText("Seen upload").closest(".oshi-status__recent-row") as HTMLElement

      await user.click(screen.getByText("Seen upload"))
      const viaTitle = onSelectVideo.mock.calls[0][0]
      await user.click(row.querySelector(".oshi-status__thumb") as HTMLElement)

      expect(onSelectVideo.mock.calls[1][0]).toEqual(viaTitle)
    })

    it("falls back to the app's videoId thumbnail when the backend image fails, then to a neutral placeholder", async () => {
      renderThumbs()
      await screen.findByText("Seen upload")
      const rowOf = () => screen.getByText("Seen upload").closest(".oshi-status__recent-row") as HTMLElement

      fireEvent.error(rowOf().querySelector("img")!)
      await waitFor(() => expect(rowOf().querySelector("img")?.getAttribute("src")).toBe("https://img.youtube.com/vi/seen_video_1/hqdefault.jpg"))

      fireEvent.error(rowOf().querySelector("img")!)
      await waitFor(() => expect(rowOf().querySelector("img")).toBeNull())
      expect(rowOf().querySelector(".oshi-status__thumb-placeholder")?.textContent).toBeTruthy()
    })
  })

  describe("直播中 (live)", () => {
    it("shows the live stream's own backend thumbnail", () => {
      renderThumbs({ status: LIVE })

      expect(thumbImg(".oshi-status__next")?.getAttribute("src")).toBe(LIVE.thumbnailUrl)
    })

    it("falls back to the videoId thumbnail when the status carries none", () => {
      renderThumbs({ status: { kind: "live", videoId: "live_video_2", title: "No thumb live" } })

      expect(thumbImg(".oshi-status__next")?.getAttribute("src")).toBe("https://img.youtube.com/vi/live_video_2/hqdefault.jpg")
    })

    it("a thumbnail click selects that exact live video like the title does, and by itself marks nothing watched or seen", async () => {
      const user = userEvent.setup()
      const { onSelectVideo } = renderThumbs({ status: LIVE })
      const before = [localStorage.getItem(SEEN_KEY), localStorage.getItem(WATCHED_KEY)]

      await user.click(document.querySelector(".oshi-status__next .oshi-status__thumb") as HTMLElement)
      await user.click(screen.getByText("Live right now"))

      expect(onSelectVideo).toHaveBeenNthCalledWith(1, { videoId: "live_video_1", title: "Live right now" })
      expect(onSelectVideo).toHaveBeenNthCalledWith(2, { videoId: "live_video_1", title: "Live right now" })
      expect([localStorage.getItem(SEEN_KEY), localStorage.getItem(WATCHED_KEY)]).toEqual(before)
    })
  })

  describe("接下來 (upcoming)", () => {
    it("shows the upcoming stream's own backend thumbnail", () => {
      renderThumbs({ status: UPCOMING })

      expect(thumbImg(".oshi-status__next")?.getAttribute("src")).toBe(UPCOMING.thumbnailUrl)
    })

    it("a thumbnail click selects that exact scheduled video like the title does, and by itself marks nothing watched or seen", async () => {
      const user = userEvent.setup()
      const { onSelectVideo } = renderThumbs({ status: UPCOMING })
      const before = [localStorage.getItem(SEEN_KEY), localStorage.getItem(WATCHED_KEY)]

      await user.click(document.querySelector(".oshi-status__next .oshi-status__thumb") as HTMLElement)

      expect(onSelectVideo).toHaveBeenCalledTimes(1)
      expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "upcoming_video_1", title: "Starts soon" })
      expect([localStorage.getItem(SEEN_KEY), localStorage.getItem(WATCHED_KEY)]).toEqual(before)
    })

    it("offline shows the empty state and no thumbnail", () => {
      renderThumbs({ status: { kind: "offline" } })

      expect(document.querySelector(".oshi-status__next")).toBeNull()
      expect(document.querySelector(".oshi-status__next-thumb")).toBeNull()
    })
  })

  describe("正在播放 (now playing)", () => {
    it("shows the playing video's thumbnail, display-only (the title has no action, so there is nothing to mirror)", async () => {
      const { onSelectVideo } = renderThumbs({ nowPlayingTitle: "Playing title", nowPlayingVideoId: "playing_video_1" })

      const thumb = document.querySelector(".oshi-status__now-playing .oshi-status__thumb") as HTMLElement
      expect(thumb.querySelector("img")?.getAttribute("src")).toBe("https://img.youtube.com/vi/playing_video_1/hqdefault.jpg")
      expect(thumb.tagName).not.toBe("BUTTON")
      await userEvent.setup().click(thumb)
      expect(onSelectVideo).not.toHaveBeenCalled()
    })

    it("uses the backend thumbnail the panel already holds for that video (the live status, or a recent row)", async () => {
      renderThumbs({ status: LIVE, nowPlayingTitle: "Live right now", nowPlayingVideoId: LIVE.videoId })
      expect(thumbImg(".oshi-status__now-playing")?.getAttribute("src")).toBe(LIVE.thumbnailUrl)
    })

    it("uses a recent row's backend thumbnail for the same video", async () => {
      renderThumbs({ nowPlayingTitle: "Seen upload", nowPlayingVideoId: "seen_video_1" })
      await screen.findAllByText("Seen upload")

      await waitFor(() => expect(thumbImg(".oshi-status__now-playing")?.getAttribute("src")).toBe(seenItem.thumbnailUrl))
    })

    it("shows no thumbnail when only a title is known (no videoId to key it by)", () => {
      renderThumbs({ nowPlayingTitle: "Some title" })

      expect(document.querySelector(".oshi-status__now-playing-thumb")).toBeNull()
    })
  })

  it("each thumbnail has its own accessible name, distinct from its title's, so one item never exposes two controls with the same name", async () => {
    renderThumbs({ status: LIVE })
    await screen.findByText("Unseen upload")

    expect(screen.getByRole("button", { name: "Unseen upload" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Thumbnail: Unseen upload" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Thumbnail: Live right now" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Live right now" })).toBeInTheDocument()
  })

  it("every thumbnail is 16:9 and cover-fit with a 377px desktop width that never exceeds its container", async () => {
    renderThumbs({ status: LIVE, nowPlayingTitle: "Live right now", nowPlayingVideoId: LIVE.videoId })
    await screen.findByText("Unseen upload")

    const thumbs = document.querySelectorAll(".oshi-status__thumb")
    expect(thumbs.length).toBeGreaterThanOrEqual(4) // now playing + live + two recent rows
    const css = readFileSync(resolve(__dirname, "../../../pages/home/styles/home.css"), "utf-8").replace(/\r\n/g, "\n")
    const block = /\.oshi-status__thumb \{([^}]*)\}/.exec(css)![1]
    expect(block).toContain("width: 377px")
    expect(block).toContain("max-width: 100%")
    expect(block).toContain("aspect-ratio: 16 / 9")
    expect(/\.oshi-status__thumb img \{([^}]*)\}/.exec(css)![1]).toContain("object-fit: cover")
  })
})

describe("the Oshi Status 'live / next' section title (display text only)", () => {
  it.each([
    ["zh-TW", "直播／接下來 24小時內"],
    ["ja", "ライブ／今後24時間以内"],
    ["en", "Live / Next 24 Hours"],
  ] as const)("%s reads %s", async (locale, expected) => {
    localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    render(<OshiStatusPanel creatorId="ch_aizawa_ema" status={{ kind: "offline" }} now={now} onSelectVideo={vi.fn()} nowPlayingTitle={null} />)

    const titles = Array.from(document.querySelectorAll(".oshi-status__section-title")).map((element) => element.textContent)
    expect(titles).toContain(expected)
  })

  it("is the only place that wording is used: Schedule's own strings do not carry it", () => {
    const schedule = readFileSync(resolve(process.cwd(), "src/pages/schedule/LiveSchedulePage.tsx"), "utf-8")
    expect(schedule).not.toContain("oshiStatus.liveNext")
  })
})
