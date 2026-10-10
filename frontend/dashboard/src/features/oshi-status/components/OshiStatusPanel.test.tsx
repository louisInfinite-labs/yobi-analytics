import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
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

    await user.click(screen.getByRole("button", { name: "Unseen upload" }))

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

  it("keeps time, title and thumbnail as exactly 3 grid columns with no icon between them", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")

    const row = screen.getByText("Unseen upload").closest(".oshi-status__recent-row") as HTMLElement
    expect(row.children).toHaveLength(3)
    expect(row.querySelector(".oshi-status__recent-time-column")).not.toBeNull()
    expect(row.querySelector(".oshi-status__recent-content")).not.toBeNull()
    expect(row.querySelector(".oshi-status__recent-thumbnail")).not.toBeNull()
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

    await user.click(within(document.body).getByRole("button", { name: "Unseen upload" }))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "unseen_video_1", title: "Unseen upload" })

    await user.click(screen.getByRole("button", { name: "Seen upload" }))
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
  it("天音かなた's avatar fallback uses the canonical #76c0ea, not a frontend-owned color", () => {
    renderPanel("ch_amane_kanata")

    const avatar = document.querySelector<HTMLElement>(".oshi-status__creator-avatar")!

    expect(avatar.style.background).toBe("rgb(118, 192, 234)")
  })
})
