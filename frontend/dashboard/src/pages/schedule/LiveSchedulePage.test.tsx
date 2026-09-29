import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import * as liveStreams from "../../shared/api/liveStreams"

vi.mock("../../shared/api/liveStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/liveStreams")>()),
  fetchLiveStreams: vi.fn(),
}))

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([])
})

describe("LiveSchedulePage", () => {
  it("renders the page title, toolbar, and one column per day of the window", () => {
    const { container } = render(<LiveSchedulePage />)

    expect(screen.getByText("Live Schedule")).toBeInTheDocument()
    expect(screen.getByText("Time")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Previous week" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next week" })).toBeInTheDocument()
    expect(container.querySelectorAll(".day-column")).toHaveLength(7)
  })

  it("renders the week-navigation and filter toolbar controls as disabled -- this phase has no history/beyond-7-day data to page into", () => {
    render(<LiveSchedulePage />)

    expect(screen.getByRole("button", { name: "Previous week" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Next week" })).toBeDisabled()
    expect(screen.getByText("Filter").closest("button")).toBeDisabled()
    expect(screen.queryByText("JST")).not.toBeInTheDocument()
  })
})

describe("LiveSchedulePage timetable", () => {
  beforeEach(() => {
    // Fix "now" (Wed 2026-09-23, local) so the displayed window is
    // deterministic; only Date is faked, real timers keep user-event, the
    // shared live-streams poll, and React scheduling working.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 8, 23, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows today through the next 6 days, not a Sunday-aligned calendar week", () => {
    const { container } = render(<LiveSchedulePage />)

    const dayNames = Array.from(container.querySelectorAll(".day-name")).map((node) => node.textContent)
    expect(dayNames).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"])
    expect(container.querySelector(".week-selector__label")).toHaveTextContent("Sep 23 - Sep 29")
    expect(container.querySelectorAll(".schedule-day-header.is-today")).toHaveLength(1)
    expect(container.querySelector(".schedule-day-header.is-today .day-name")).toHaveTextContent("Wed")
  })

  it("covers the full local day: 24 hourly labels from 00:00 to 23:00 and 48 half-hour rows per day", () => {
    const { container } = render(<LiveSchedulePage />)

    const labels = Array.from(container.querySelectorAll(".time-label"))
      .map((node) => node.textContent)
      .filter(Boolean)
    expect(labels).toHaveLength(24)
    expect(labels[0]).toBe("00:00")
    expect(labels[23]).toBe("23:00")
    for (const timeline of container.querySelectorAll(".day-timeline")) {
      expect(timeline.children).toHaveLength(48)
    }
  })

  it("opens the stream detail dialog from an avatar with creator, title and both actions, and closes it with Escape", async () => {
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([
      {
        videoId: "v1",
        creatorId: "aizawa_ema",
        channelName: "藍沢エマ",
        title: "Ranked grind",
        status: "live",
        scheduledStart: null,
        actualStart: new Date(2026, 8, 23, 12, 0, 0).toISOString(),
        thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      },
    ])
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { container } = render(<LiveSchedulePage />)
    await waitFor(() => expect(container.querySelector(".stream-avatar-button")).toBeInTheDocument())

    await user.click(container.querySelector<HTMLElement>(".stream-avatar-button")!)

    const dialog = screen.getByRole("dialog")
    expect(dialog.querySelector(".creator-detail-name")?.textContent).toBeTruthy()
    expect(dialog.querySelector(".stream-detail-title")?.textContent).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Set Reminder" })).toBeDisabled()
    expect(within(dialog).getByRole("button", { name: "Open Stream" })).toBeEnabled()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("Open Stream swaps the detail dialog for the player-only video modal, which closes on a backdrop click", async () => {
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([
      {
        videoId: "v1",
        creatorId: "aizawa_ema",
        channelName: "藍沢エマ",
        title: "Ranked grind",
        status: "live",
        scheduledStart: null,
        actualStart: new Date(2026, 8, 23, 12, 0, 0).toISOString(),
        thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      },
    ])
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { container } = render(<LiveSchedulePage />)
    await waitFor(() => expect(container.querySelector(".stream-avatar-button")).toBeInTheDocument())
    await user.click(container.querySelector<HTMLElement>(".stream-avatar-button")!)

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Open Stream" }))

    expect(document.querySelector(".stream-detail-content")).toBeNull()
    const backdrop = document.querySelector<HTMLElement>(".video-player-modal__backdrop")!
    expect(backdrop.querySelector("iframe")).toBeInTheDocument()
    expect(within(backdrop).queryByRole("button")).not.toBeInTheDocument()

    await user.click(backdrop)
    expect(document.querySelector(".video-player-modal__backdrop")).toBeNull()
  })
})
