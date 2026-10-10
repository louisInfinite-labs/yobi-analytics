import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamNotificationPanel } from "./StreamNotificationPanel"
import * as liveReminderApi from "../../notifications/api/liveReminderApi"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { REMINDER_TIME_VALUES } from "../../notifications/model/notificationTopics"
import type { ScheduledStream } from "../model/scheduledStream"

vi.mock("../../notifications/api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notifications/api/liveReminderApi")>()),
  fetchReminderSettings: vi.fn(),
  saveStreamNotificationOverride: vi.fn(),
  deleteStreamNotificationOverride: vi.fn(),
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
const sf6Stream: ScheduledStream = { ...stream, id: "s3", videoId: "v3", topics: ["sf6"] }

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

const setting = (advanceReminder: "1min" | "10min" | "30min" | "1hour" | null) => ({ notifyAtStart: true, advanceReminder })

function mockSettings(overrides: Partial<liveReminderApi.ReminderSettingsSnapshot> = {}) {
  vi.mocked(liveReminderApi.fetchReminderSettings).mockResolvedValue({ ...liveReminderApi.emptyReminderSettings(), ...overrides })
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  // Call counts persist across tests unless cleared (the mocks are module-level).
  vi.mocked(liveReminderApi.fetchReminderSettings).mockClear()
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockClear()
  vi.mocked(liveReminderApi.deleteStreamNotificationOverride).mockReset().mockResolvedValue(undefined)
  mockSettings()
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

  it("the timing choices are the existing shared REMINDER_TIME_VALUES (those 5, in that order) followed by ONE explicit per-stream OFF", async () => {
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    const radios = await screen.findAllByRole("radio")
    expect(radios).toHaveLength(REMINDER_TIME_VALUES.length + 1)
    REMINDER_TIME_VALUES.forEach((value, index) => {
      expect(radios[index]).toBe(screen.getByRole("radio", { name: LABEL_FOR[value] }))
    })
    expect(radios[REMINDER_TIME_VALUES.length]).toBe(screen.getByRole("radio", { name: "No reminder for this stream" }))
  })

  describe("a stream with no reminder at all", () => {
    it("shows NO option selected (never a pre-picked default time) and says so", async () => {
      render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)

      expect(await screen.findByText(/has no reminder right now/)).toBeInTheDocument()
      for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked()
    })

    it("keeps Save disabled until a time is picked, then saves exactly that one choice", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
      await screen.findAllByRole("radio")

      expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled()
      await user.click(screen.getByRole("radio", { name: "10 minutes before" }))
      expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled()
      await user.click(screen.getByRole("button", { name: /Save/ }))

      await waitFor(() =>
        expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", {
          creatorId: "aizawa_ema",
          notifyAtStart: true,
          advanceReminder: "10min",
        }),
      )
    })
  })

  it("on first opening, shows the creator's 全部 reminder (the one that actually applies)", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
  })

  it("shows the creator + topic reminder for a stream of that topic when 全部 is unset", async () => {
    mockSettings({ creatorTopics: { aizawa_ema: { sf6: setting("10min") } } })
    render(<StreamNotificationPanel stream={sf6Stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked())
  })

  it("shows 全部 rather than the topic reminder when both are set (全部 shadows the topic)", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") }, creatorTopics: { aizawa_ema: { sf6: setting("10min") } } })
    render(<StreamNotificationPanel stream={sf6Stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
  })

  it("opening the panel alone does not save an override", async () => {
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()
  })

  it("saving posts the stream override to the real backend API, replacing the creator's 30min 全部 setting with 1hour for this stream", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() =>
      expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", {
        creatorId: "aizawa_ema",
        notifyAtStart: true,
        advanceReminder: "1hour",
      }),
    )
  })

  it("a failed save keeps the drawer open, shows an error, and does not close", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
    vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockRejectedValue(new Error("500"))
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={stream} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save this reminder. Please try again.")
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked()
    // Save is usable again so the user can retry. Matched loosely: in jsdom antd's
    // loading-icon exit motion never finishes, so the name stays "loading Save".
    await waitFor(() => expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled())
  })

  it("reopening the panel for the same stream shows the saved override, not the creator's 全部 setting", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalled())

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked())
  })

  it("other streams from the same creator stay on the creator's 全部 setting, unaffected by one stream's saved override", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalled())

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={otherStream} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
  })

  describe("per-stream OFF and removing the override", () => {
    const own = (advanceReminder: "1hour" | null, notifyAtStart = true) => ({ creatorId: "aizawa_ema", notifyAtStart, advanceReminder })

    it("saving 'No reminder for this stream' stores an explicit OFF override that replaces the creator's 30min 全部 setting for this stream only", async () => {
      mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      const { rerender } = render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

      await user.click(screen.getByRole("radio", { name: "No reminder for this stream" }))
      await user.click(screen.getByRole("button", { name: /Save/ }))

      await waitFor(() =>
        expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", { creatorId: "aizawa_ema", notifyAtStart: false, advanceReminder: null }),
      )
      rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
      rerender(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "No reminder for this stream" })).toBeChecked())
      rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
      rerender(<StreamNotificationPanel stream={otherStream} onClose={() => {}} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
    })

    it("an already-stored OFF override opens with 'No reminder for this stream' selected, not a time", async () => {
      mockSettings({ creatorAll: { aizawa_ema: setting("30min") }, streamOverrides: { v1: own(null, false) } })
      render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)

      await waitFor(() => expect(screen.getByRole("radio", { name: "No reminder for this stream" })).toBeChecked())
      expect(screen.getByRole("radio", { name: "At start" })).not.toBeChecked()
    })

    it("a stream with its own override shows 'Remove', which deletes only that override on the backend and falls back to the creator setting", async () => {
      mockSettings({ creatorAll: { aizawa_ema: setting("30min") }, streamOverrides: { v1: own("1hour") } })
      const onClose = vi.fn()
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      const { rerender } = render(<StreamNotificationPanel stream={stream} onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked())

      await user.click(screen.getByRole("button", { name: "Remove (use creator settings)" }))

      await waitFor(() => expect(liveReminderApi.deleteStreamNotificationOverride).toHaveBeenCalledWith("v1"))
      expect(liveReminderApi.deleteStreamNotificationOverride).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()
      rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
      rerender(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
      expect(screen.queryByRole("button", { name: "Remove (use creator settings)" })).not.toBeInTheDocument()
    })

    it("offers no Remove when the stream has no override of its own", async () => {
      mockSettings({ creatorAll: { aizawa_ema: setting("30min") } })
      render(<StreamNotificationPanel stream={stream} onClose={() => {}} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())

      expect(screen.queryByRole("button", { name: "Remove (use creator settings)" })).not.toBeInTheDocument()
    })

    it("a failed Remove shows the error, keeps the drawer open and does NOT pretend the override is gone", async () => {
      mockSettings({ creatorAll: { aizawa_ema: setting("30min") }, streamOverrides: { v1: own("1hour") } })
      vi.mocked(liveReminderApi.deleteStreamNotificationOverride).mockRejectedValue(new Error("500"))
      const onClose = vi.fn()
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      render(<StreamNotificationPanel stream={stream} onClose={onClose} />)
      await waitFor(() => expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked())

      await user.click(screen.getByRole("button", { name: "Remove (use creator settings)" }))

      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save this reminder. Please try again.")
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole("radio", { name: "1 hour before" })).toBeChecked()
      expect(screen.getByRole("button", { name: "Remove (use creator settings)" })).toBeInTheDocument()
    })
  })
})
