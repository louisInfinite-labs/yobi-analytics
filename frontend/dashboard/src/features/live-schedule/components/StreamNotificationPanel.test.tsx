import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamNotificationPanel } from "./StreamNotificationPanel"
import * as liveReminderApi from "../../notifications/api/liveReminderApi"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { INITIAL_MEMBER_REMINDER, REMINDER_TIME_VALUES } from "../../notifications/model/notificationTopics"
import type { ScheduledStream } from "../model/scheduledStream"

vi.mock("../../notifications/api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notifications/api/liveReminderApi")>()),
  fetchCreatorLiveReminders: vi.fn(),
  fetchStreamNotificationOverrides: vi.fn(),
  saveStreamNotificationOverride: vi.fn(),
}))

const creator = getCreatorById("aizawa_ema")!
const stream: ScheduledStream = {
  id: "s1",
  channelId: toLegacyRosterId(creator),
  videoId: "v1",
  title: "Apex ranked grind",
  description: "",
  status: "upcoming",
  scheduledStartMs: 1_000_000,
  topics: [],
}
const otherStream: ScheduledStream = { ...stream, id: "s2", videoId: "v2" }

/** English label for each REMINDER_TIME_VALUE, matching translations.ts exactly
 * -- used to assert against the control by its real accessible name, not a
 * hardcoded id, so this test fails loudly if that shared label set ever changes. */
const LABEL_FOR: Record<string, string> = {
  at_start: "At start",
  "1min": "1 minute before",
  "10min": "10 minutes before",
  "30min": "30 minutes before",
  "1hour": "1 hour before",
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({})
  vi.mocked(liveReminderApi.fetchStreamNotificationOverrides).mockResolvedValue({})
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockResolvedValue(undefined)
})

describe("StreamNotificationPanel", () => {
  it("renders nothing when no stream is given", () => {
    const { container } = render(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    expect(container.querySelector(".stream-reminder-drawer")).not.toBeInTheDocument()
  })

  it("shows the required single-stream explanation text", async () => {
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    expect(await screen.findByText("This setting applies only to this livestream.")).toBeInTheDocument()
    expect(
      screen.getByText("Once saved, this livestream will use the notification setting here, replacing the creator's usual live notification setting for this stream only."),
    ).toBeInTheDocument()
  })

  it("the timing choices come from the existing shared REMINDER_TIME_VALUES source (exactly those 5, in that order, no member_choice sentinel)", async () => {
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    const radios = await screen.findAllByRole("radio")
    expect(radios).toHaveLength(REMINDER_TIME_VALUES.length)
    REMINDER_TIME_VALUES.forEach((value, index) => {
      expect(radios[index]).toBe(screen.getByRole("radio", { name: LABEL_FOR[value] }))
    })
  })

  it("a stream with no override or creator setting shows the existing system default (INITIAL_MEMBER_REMINDER)", async () => {
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: LABEL_FOR[INITIAL_MEMBER_REMINDER] })).toBeChecked())
  })

  it("on first opening, shows the creator's real recurring setting (not a fabricated Schedule-specific default)", async () => {
    vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({
      aizawa_ema: { notifyAtStart: true, advanceReminder: "30min" },
    })
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
  })

  it("opening the panel alone does not save an override", async () => {
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()
  })

  it("saving posts the stream override to the real backend API, replacing the creator's 30min recurring setting with 1hour", async () => {
    vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({
      aizawa_ema: { notifyAtStart: true, advanceReminder: "30min" },
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", {
        creatorId: "aizawa_ema",
        notifyAtStart: true,
        advanceReminder: "1hour",
      }),
    )
  })

  it("a failed save keeps the drawer open, shows an error, and does not close", async () => {
    vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockRejectedValue(new Error("500"))
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={stream} onClose={onClose} />)
    await screen.findAllByRole("radio")

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save this reminder. Please try again.")
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked()
    // Save is usable again so the user can retry. Matched loosely: in jsdom antd's
    // loading-icon exit motion never finishes, so the name stays "loading Save".
    await waitFor(() => expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled())
  })

  it("reopening the panel for the same stream shows the saved override, not the creator's recurring setting", async () => {
    vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({
      aizawa_ema: { notifyAtStart: true, advanceReminder: "30min" },
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalled())

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked())
  })

  it("other streams from the same creator stay on the creator's recurring setting, unaffected by one stream's saved override", async () => {
    vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({
      aizawa_ema: { notifyAtStart: true, advanceReminder: "30min" },
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalled())

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={otherStream} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
  })
})
