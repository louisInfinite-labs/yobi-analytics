import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamDetailModal } from "./StreamDetailModal"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { ORGANIZATION_LABELS } from "../../../entities/creator/model/domain"
import { formatCountdown } from "../../live-status/model/creatorStatusFormat"
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

  it("the reminder action is enabled and opens the single-stream notification setting", async () => {
    const user = userEvent.setup()
    const onSetReminder = vi.fn()
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} onSetReminder={onSetReminder} />)

    const reminderButton = screen.getByRole("button", { name: "Set Reminder" })
    expect(reminderButton).not.toBeDisabled()
    await user.click(reminderButton)
    expect(onSetReminder).toHaveBeenCalledWith(stream)
  })

  it("shows the upcoming countdown using the existing shared formatCountdown implementation (hours + minutes), not a new/duplicated minutes-only format", () => {
    const upcoming: ScheduledStream = { ...stream, status: "upcoming", scheduledStartMs: 90 * 60_000 }
    const now = new Date(0)
    render(<StreamDetailModal stream={upcoming} locale="en" now={now} onClose={() => {}} onOpenStream={() => {}} onSetReminder={() => {}} />)

    const expected = formatCountdown(new Date(upcoming.scheduledStartMs).toISOString(), now, "en")
    expect(screen.getByText(expected)).toBeInTheDocument()
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
