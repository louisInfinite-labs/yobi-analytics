/** Home's creator header is the page's heading and says who the creator is from the Creator Registry alone (no API data), and "offline" before the live
 * status has answered never reads as "nothing scheduled". The UI strings asserted are the product's own zh-TW texts. */
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import { fetchOshiStatus } from "../data/oshiStatus"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../hooks/useLastVisit", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useLastVisit")>("../hooks/useLastVisit")
  return { ...actual, usePreviousVisit: vi.fn() }
})
vi.mock("../data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))
vi.mock("../data/allCreatorMilestones", async () => {
  const actual = await vi.importActual<typeof import("../data/allCreatorMilestones")>("../data/allCreatorMilestones")
  return { ...actual, getCachedAllCreatorMilestones: vi.fn(() => null), loadAllCreatorMilestones: vi.fn(() => Promise.reject(new Error("not under test"))) }
})

const now = new Date(2026, 8, 10, 12, 0, 0)

function feed(overrides: Partial<HomeAllFeed> = {}): HomeAllFeed {
  const page = { videos: [], loading: false, error: null, loadMore: vi.fn(), hasMore: false }
  return { ...page, page, ...overrides }
}

function renderPanel(creatorId: string, overrides: Partial<HomeAllFeed> = {}) {
  return render(<OshiStatusPanel creatorId={creatorId} status={{ kind: "offline" }} feed={feed(overrides)} now={now} onSelectVideo={vi.fn()} nowPlayingTitle={null} />)
}

beforeEach(() => {
  vi.mocked(fetchOshiStatus).mockReset()
  vi.mocked(fetchOshiStatus).mockReturnValue(new Promise(() => undefined)) // the oshi-status read never answers: nothing below may need it
  vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
  window.localStorage.clear()
  window.localStorage.setItem("yobi.locale", "zh-TW")
  resetAllSharedStateForTests()
})

describe("creator header semantics", () => {
  it("makes the creator's name the page's one h1, keeping the name's own class (and so its look)", () => {
    renderPanel("ch_aizawa_ema")
    const headings = screen.getAllByRole("heading", { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent("藍沢エマ")
    expect(headings[0]).toHaveClass("oshi-status__creator-name")
  })

  it("shows the branch from the Creator Registry before any API data has arrived", () => {
    renderPanel("ch_aizawa_ema")
    expect(document.querySelector(".oshi-status__creator-meta")).toHaveTextContent("VSPO JP")
    expect(document.querySelector(".oshi-status__subscriber-count")).toBeNull()
  })

  it("keeps the caption and adds the subscriber count after it once the read answers", async () => {
    vi.mocked(fetchOshiStatus).mockResolvedValue({
      subscriberCount: 702000,
      latestVideo: null,
      thisWeek: { newUploads: 0, newStreams: 0 },
      growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
      sinceLastVisit: null,
    })
    renderPanel("ch_aizawa_ema")
    await waitFor(() => expect(document.querySelector(".oshi-status__subscriber-count")).not.toBeNull())
    expect(document.querySelector(".oshi-status__creator-meta")).toHaveTextContent("VSPO JP")
    expect(document.querySelector(".oshi-status__subscriber-count")?.textContent).toBe("702.0K 訂閱者")
  })
})

describe("Live / Next before the live status has answered", () => {
  it("shows the placeholder dash, not 'no scheduled stream', while the live status is not settled", () => {
    renderPanel("ch_aizawa_ema", { liveStatusSettled: false })
    expect(screen.queryByText("尚無排定的直播")).toBeNull()
    expect(screen.getByText(/^直播／接下來/).closest("section")).toHaveTextContent("—")
  })

  it("still says 'no scheduled stream' once settled, and for a feed that never reports settling", () => {
    const first = renderPanel("ch_aizawa_ema", { liveStatusSettled: true })
    expect(screen.getByText("尚無排定的直播")).toBeInTheDocument()
    first.unmount()
    renderPanel("ch_aizawa_ema")
    expect(screen.getByText("尚無排定的直播")).toBeInTheDocument()
  })
})
