import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OshiStatusPanel } from "./OshiStatusPanel"
import * as useLastVisit from "../hooks/useLastVisit"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

vi.mock("../hooks/useLastVisit", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useLastVisit")>("../hooks/useLastVisit")
  return { ...actual, usePreviousVisit: vi.fn() }
})

const now = new Date("2026-09-10T12:00:00+09:00")

const seenVideo: RecentVideo = {
  videoId: "seen_video_1",
  title: "Seen upload",
  publishedAt: "2026-09-01T12:00:00+09:00",
  contentFormat: "normal_video",
}

const unseenVideo: RecentVideo = {
  videoId: "unseen_video_1",
  title: "Unseen upload",
  publishedAt: "2026-09-10T00:00:00+09:00",
  contentFormat: "normal_video",
}

function renderPanel(uploads: RecentVideo[], onSelectVideo = vi.fn()) {
  render(
    <OshiStatusPanel
      creatorId="ch_aizawa_ema"
      status={{ kind: "offline" }}
      now={now}
      uploads={uploads}
      streams={[]}
      loading={false}
      onSelectVideo={onSelectVideo}
    />,
  )
  return onSelectVideo
}

describe("OshiStatusPanel Recent Activity", () => {
  beforeEach(() => {
    vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(new Date("2026-09-05T00:00:00+09:00"))
  })

  it("shows the NEW badge only for a video published after the previous visit", () => {
    renderPanel([seenVideo, unseenVideo])

    const rows = document.querySelectorAll(".oshi-status__recent-row")
    expect(rows).toHaveLength(2)

    const unseenRow = screen.getByText("Unseen upload").closest(".oshi-status__recent-row")
    const seenRow = screen.getByText("Seen upload").closest(".oshi-status__recent-row")
    expect(unseenRow?.querySelector(".oshi-status__recent-new-badge")).not.toBeNull()
    expect(seenRow?.querySelector(".oshi-status__recent-new-badge")).toBeNull()
  })

  it("shows no NEW badge for any row on a first visit (no previous visit)", () => {
    vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(null)
    renderPanel([seenVideo, unseenVideo])

    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(0)
  })

  it("keeps time, title and thumbnail as exactly 3 grid columns with no icon between them", () => {
    renderPanel([unseenVideo])

    const row = screen.getByText("Unseen upload").closest(".oshi-status__recent-row") as HTMLElement
    expect(row.children).toHaveLength(3)
    expect(row.querySelector(".oshi-status__recent-time-column")).not.toBeNull()
    expect(row.querySelector(".oshi-status__recent-content")).not.toBeNull()
    expect(row.querySelector(".oshi-status__recent-thumbnail")).not.toBeNull()
  })

  it("calls the shared onSelectVideo path (not a modal) for both seen and unseen rows", async () => {
    const user = userEvent.setup()
    const onSelectVideo = renderPanel([seenVideo, unseenVideo])

    await user.click(screen.getByRole("button", { name: "Unseen upload" }))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "unseen_video_1", title: "Unseen upload" })

    await user.click(screen.getByRole("button", { name: "Seen upload" }))
    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "seen_video_1", title: "Seen upload" })

    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })
})

describe("OshiStatusPanel DEV reset", () => {
  beforeEach(() => {
    vi.mocked(useLastVisit.usePreviousVisit).mockReturnValue(new Date("2026-09-05T00:00:00+09:00"))
  })

  it("renders a reset control in the header (DEV mode, as in this test run)", () => {
    renderPanel([seenVideo, unseenVideo])

    expect(document.querySelector(".oshi-status__dev-reset")).not.toBeNull()
  })

  it("clicking reset calls resetPreviousVisit and touches only the visit storage key", async () => {
    const user = userEvent.setup()
    const resetSpy = vi.spyOn(useLastVisit, "resetPreviousVisit")
    localStorage.setItem("yobi.defaultOshiCreatorId", "ch_aizawa_ema")
    localStorage.setItem("yobi.locale", "en")

    renderPanel([seenVideo, unseenVideo])
    const resetButton = document.querySelector(".oshi-status__dev-reset") as HTMLButtonElement
    await user.click(resetButton)

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("yobi.home.lastVisitAt")).not.toBeNull()
    expect(localStorage.getItem("yobi.defaultOshiCreatorId")).toBe("ch_aizawa_ema")
    expect(localStorage.getItem("yobi.locale")).toBe("en")
  })
})
