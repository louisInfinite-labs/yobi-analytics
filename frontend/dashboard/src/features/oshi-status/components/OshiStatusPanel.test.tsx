import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import { fetchOshiStatus, type OshiStatusData, type OshiStatusRecentItem } from "../data/oshiStatus"

vi.mock("../hooks/useLastVisit", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useLastVisit")>("../hooks/useLastVisit")
  return { ...actual, usePreviousVisit: vi.fn() }
})
vi.mock("../data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiStatus)
const PREVIOUS_VISIT = new Date("2026-09-05T00:00:00+09:00")
const now = new Date("2026-09-10T12:00:00+09:00")

const seenItem: OshiStatusRecentItem = {
  videoId: "seen_video_1",
  kind: "upload",
  title: "Seen upload",
  thumbnailUrl: "https://img.youtube.com/vi/seen_video_1/hqdefault.jpg",
  publishedAt: "2026-09-01T12:00:00+09:00",
  currentViewCount: 100,
}
const unseenItem: OshiStatusRecentItem = {
  ...seenItem,
  videoId: "unseen_video_1",
  title: "Unseen upload",
  thumbnailUrl: null,
  publishedAt: "2026-09-10T00:00:00+09:00",
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
  return { onSelectVideo, switchCreator: (id: string) => view.rerender(ui(id)) }
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
    expect(metrics("This week")).toEqual({ "View growth": "—", Streams: "—", Uploads: "—" })
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

  it("This week shows the backend's new uploads/streams and the 7-day channel view growth", async () => {
    renderPanel()

    await screen.findByText("Unseen upload")
    expect(metrics("This week")).toEqual({ "View growth": "12.3K", Streams: "3", Uploads: "2" })
  })

  it("shows placeholders, never a fabricated 0, while the data is not available", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    renderPanel()

    expect(metrics("Since your last visit")).toEqual({ Uploads: "—", Streams: "—", "View growth": "—" })
    expect(metrics("This week")).toEqual({ "View growth": "—", Streams: "—", Uploads: "—" })
  })

  it("a failed request leaves the placeholders and the empty recent state, with no old or mock data", async () => {
    fetchMock.mockRejectedValue(new Error("503"))
    renderPanel()

    expect(await screen.findByText("No recent activity")).toBeInTheDocument()
    expect(metrics("This week")).toEqual({ "View growth": "—", Streams: "—", Uploads: "—" })
    expect(document.querySelector(".oshi-status__subscriber-count")).toBeNull()
  })

  it("an empty backend result (no recent rows) shows the empty state, not an error", async () => {
    fetchMock.mockResolvedValue(status({ recent: [], latestVideo: null }))
    renderPanel()

    expect(await screen.findByText("No recent activity")).toBeInTheDocument()
    expect(metrics("This week").Uploads).toBe("2") // the rest of the panel still renders
  })
})

describe("OshiStatusPanel Recent Activity", () => {
  it("shows the NEW badge only for a video published after the previous visit", async () => {
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelectorAll(".oshi-status__recent-row")).toHaveLength(2)
    const unseenRow = screen.getByText("Unseen upload").closest(".oshi-status__recent-row")
    const seenRow = screen.getByText("Seen upload").closest(".oshi-status__recent-row")
    expect(unseenRow?.querySelector(".oshi-status__recent-new-badge")).not.toBeNull()
    expect(seenRow?.querySelector(".oshi-status__recent-new-badge")).toBeNull()
  })

  it("shows no NEW badge for any row on a first visit (no previous visit)", async () => {
    vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
    renderPanel()
    await screen.findByText("Unseen upload")

    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(0)
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

  it("clicking reset calls resetPreviousVisit and touches only the visit storage key", async () => {
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
})
