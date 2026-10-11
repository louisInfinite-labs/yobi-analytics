import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamDetailModal } from "./StreamDetailModal"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { ORGANIZATION_LABELS } from "../../../entities/creator/model/domain"
import { formatAbsoluteTime, formatCountdown } from "../../live-status/model/creatorStatusFormat"
import { useUpcomingDisplayMode } from "../../live-status/hooks/useUpcomingDisplayMode"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { ScheduledStream } from "../model/scheduledStream"

const creator = mockCreators.find((candidate) => candidate.kana)!
const stream: ScheduledStream = {
  id: "s1",
  channelId: creator.channelId,
  videoId: "v1",
  title: "Apex ranked grind",
  description: "unique-description-text Come hang out!",
  status: "upcoming",
  scheduledStartMs: 0,
  topics: ["unique-topic-chip"],
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
})

describe("StreamDetailModal", () => {
  it("shows the creator name and stream title", () => {
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)
    expect(screen.getByText(creator.channelName)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Apex ranked grind" })).toBeInTheDocument()
  })

  it("does not render the kana reading, organization tag, description, or topic chip", () => {
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)
    expect(screen.queryByText(creator.kana!)).not.toBeInTheDocument()
    expect(screen.queryByText(ORGANIZATION_LABELS[creator.organization])).not.toBeInTheDocument()
    expect(screen.queryByText(/unique-description-text/)).not.toBeInTheDocument()
    expect(screen.queryByText("unique-topic-chip")).not.toBeInTheDocument()
  })

  it("keeps the reminder and open-stream actions", () => {
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)
    expect(screen.getAllByRole("button").filter((button) => button.classList.contains("reminder-button") || button.classList.contains("open-stream-button"))).toHaveLength(2)
  })

  it("a currently live stream has NO reminder action at all (not disabled, not a placeholder); the open-stream action remains", () => {
    const live: ScheduledStream = { ...stream, status: "live" }
    render(<StreamDetailModal stream={live} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)
    expect(screen.queryByRole("button", { name: "Set Reminder" })).not.toBeInTheDocument()
    expect(document.querySelector(".reminder-button")).toBeNull()
    expect(document.querySelector(".stream-modal-actions")!.children).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Open Stream" })).toBeInTheDocument()
  })

  it("the reminder action is enabled and opens the single-stream notification setting", async () => {
    const user = userEvent.setup()
    const onSetReminder = vi.fn()
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={onSetReminder} />)

    const reminderButton = screen.getByRole("button", { name: "Set Reminder" })
    expect(reminderButton).not.toBeDisabled()
    await user.click(reminderButton)
    expect(onSetReminder).toHaveBeenCalledWith(stream)
  })

  it("shows the upcoming start the way the user's display setting says, through the shared formatter: countdown mode = the shared formatCountdown (hours + minutes)", () => {
    window.localStorage.setItem("yobi.upcomingDisplayMode", "countdown")
    resetAllSharedStateForTests()
    const upcoming: ScheduledStream = { ...stream, status: "upcoming", scheduledStartMs: 90 * 60_000 }
    const now = new Date(0)
    render(<StreamDetailModal stream={upcoming} locale="en" now={now} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)

    const expected = formatCountdown(new Date(upcoming.scheduledStartMs).toISOString(), now, "en")
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it.each(["24h", "12h"] as const)("absolute mode shows the clock time in the %s format (the same value the Home dock shows)", (timeFormat) => {
    window.localStorage.setItem("yobi.upcomingDisplayMode", "absolute")
    window.localStorage.setItem("yobi.timeFormat", timeFormat)
    resetAllSharedStateForTests()
    const upcoming: ScheduledStream = { ...stream, status: "upcoming", scheduledStartMs: Date.UTC(2026, 8, 23, 6, 30) }
    const now = new Date(Date.UTC(2026, 8, 23, 5, 0))
    render(<StreamDetailModal stream={upcoming} locale="en" now={now} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)

    expect(screen.getByText(formatAbsoluteTime(new Date(upcoming.scheduledStartMs).toISOString(), timeFormat))).toBeInTheDocument()
    expect(screen.queryByText(/^In \d+h:\d+m$/)).not.toBeInTheDocument()
  })

  it.each([
    ["en", "No thumbnail"],
    ["zh-TW", "沒有縮圖"],
    ["ja", "サムネイルなし"],
  ] as const)("localizes the thumbnail fallback for %s", (locale, expected) => {
    render(<StreamDetailModal stream={stream} locale={locale} now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)

    fireEvent.error(document.querySelector(".stream-detail-thumbnail")!)

    expect(document.querySelector(".schedule-thumbnail-placeholder")).toHaveTextContent(expected)
    if (locale !== "en") expect(screen.queryByText("No thumbnail")).not.toBeInTheDocument()
  })
})

describe("StreamDetailModal start text follows the global time-display setting", () => {
  const modalProps = { onClose: () => {}, onOpenStream: () => {}, onSetReminder: () => {} }
  const MIN = 60_000
  // A fixed "now"; the live stream's ACTUAL start is deliberately different from its scheduled start so the wrong field would show.
  const NOW = new Date(2026, 8, 23, 13, 34, 0)
  const live = (minutesAgo: number): ScheduledStream => ({
    ...stream,
    status: "live",
    scheduledStartMs: NOW.getTime() - (minutesAgo + 90) * MIN,
    actualStartMs: NOW.getTime() - minutesAgo * MIN,
  })
  const upcoming = (minutesAhead: number): ScheduledStream => ({ ...stream, status: "upcoming", scheduledStartMs: NOW.getTime() + minutesAhead * MIN })
  const setMode = (mode: "countdown" | "absolute") => {
    window.localStorage.setItem("yobi.upcomingDisplayMode", mode)
    window.localStorage.setItem("yobi.timeFormat", "24h")
    resetAllSharedStateForTests()
  }

  it.each([
    [5, "5分鐘後"],
    [65, "1小時5分鐘後"],
    [150, "2小時30分鐘後"],
  ])("relative mode, upcoming in %i min -> %s (never 65分鐘後 / 150分鐘後)", (minutes, expected) => {
    setMode("countdown")
    render(<StreamDetailModal stream={upcoming(minutes)} locale="zh-TW" now={NOW} {...modalProps} />)

    expect(screen.getByText(expected)).toBeInTheDocument()
    if (minutes >= 60) expect(screen.queryByText(`${minutes}分鐘後`)).not.toBeInTheDocument()
  })

  it.each([
    [5, "5分鐘前開始"],
    [65, "1小時5分鐘前開始"],
    [349, "5小時49分鐘前開始"],
  ])("relative mode, live for %i min -> %s (not the old minute-only text)", (minutes, expected) => {
    setMode("countdown")
    render(<StreamDetailModal stream={live(minutes)} locale="zh-TW" now={NOW} {...modalProps} />)

    expect(screen.getByText(expected)).toBeInTheDocument()
    expect(screen.queryByText("349 分鐘前開始")).not.toBeInTheDocument()
  })

  it("relative mode counts from the ACTUAL start, not the scheduled start", () => {
    setMode("countdown")
    render(<StreamDetailModal stream={live(5)} locale="zh-TW" now={NOW} {...modalProps} />)

    expect(screen.getByText("5分鐘前開始")).toBeInTheDocument() // scheduledStartMs is 95 minutes earlier -> would read 1小時35分鐘前開始
  })

  it("HH:MM mode: upcoming shows the scheduled start time, live shows the actual start time, never elapsed minutes", () => {
    setMode("absolute")
    const { unmount } = render(<StreamDetailModal stream={upcoming(65)} locale="zh-TW" now={NOW} {...modalProps} />)
    expect(screen.getByText(formatAbsoluteTime(new Date(NOW.getTime() + 65 * MIN).toISOString(), "24h"))).toBeInTheDocument()
    expect(screen.queryByText(/後/)).not.toBeInTheDocument()
    unmount()

    render(<StreamDetailModal stream={live(349)} locale="zh-TW" now={NOW} {...modalProps} />)
    expect(screen.getByText(formatAbsoluteTime(new Date(NOW.getTime() - 349 * MIN).toISOString(), "24h"))).toBeInTheDocument()
    expect(screen.queryByText(/前開始/)).not.toBeInTheDocument()
  })

  it("a live stream the backend gave no actual start for falls back to its scheduled start, never to a published time", () => {
    setMode("countdown")
    const noActual: ScheduledStream = { ...live(0), actualStartMs: undefined, scheduledStartMs: NOW.getTime() - 65 * MIN }
    render(<StreamDetailModal stream={noActual} locale="zh-TW" now={NOW} {...modalProps} />)

    expect(screen.getByText("1小時5分鐘前開始")).toBeInTheDocument()
  })

  it.each([
    ["zh-TW", "5小時49分鐘前開始"],
    ["ja", "5時間49分前に開始"],
    ["en", "Started 5h 49m ago"],
  ] as const)("localizes the started-ago text for %s through the shared formatter", (locale, expected) => {
    setMode("countdown")
    render(<StreamDetailModal stream={live(349)} locale={locale} now={NOW} {...modalProps} />)

    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it("changing the global setting updates the open popup immediately, both ways", async () => {
    setMode("countdown")
    function Harness() {
      const [mode, setDisplayMode] = useUpcomingDisplayMode()
      return (
        <>
          <button type="button" onClick={() => setDisplayMode(mode === "countdown" ? "absolute" : "countdown")}>
            toggle-mode
          </button>
          <StreamDetailModal stream={live(349)} locale="zh-TW" now={NOW} {...modalProps} />
        </>
      )
    }
    render(<Harness />)
    expect(screen.getByText("5小時49分鐘前開始")).toBeInTheDocument()

    await userEvent.setup().click(screen.getByText("toggle-mode"))
    expect(screen.getByText(formatAbsoluteTime(new Date(NOW.getTime() - 349 * MIN).toISOString(), "24h"))).toBeInTheDocument()
    expect(screen.queryByText("5小時49分鐘前開始")).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByText("toggle-mode"))
    expect(screen.getByText("5小時49分鐘前開始")).toBeInTheDocument()
  })

  it("minute-boundary updates still work: a new `now` re-renders the text", () => {
    setMode("countdown")
    const { rerender } = render(<StreamDetailModal stream={upcoming(5)} locale="zh-TW" now={NOW} {...modalProps} />)
    expect(screen.getByText("5分鐘後")).toBeInTheDocument()

    rerender(<StreamDetailModal stream={upcoming(5)} locale="zh-TW" now={new Date(NOW.getTime() + MIN)} {...modalProps} />)
    expect(screen.getByText("4分鐘後")).toBeInTheDocument()

    rerender(<StreamDetailModal stream={live(64)} locale="zh-TW" now={NOW} {...modalProps} />)
    expect(screen.getByText("1小時4分鐘前開始")).toBeInTheDocument()
    rerender(<StreamDetailModal stream={live(64)} locale="zh-TW" now={new Date(NOW.getTime() + MIN)} {...modalProps} />)
    expect(screen.getByText("1小時5分鐘前開始")).toBeInTheDocument()
  })
})
