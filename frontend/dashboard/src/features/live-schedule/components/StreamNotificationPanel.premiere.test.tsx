import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StreamNotificationPanel } from "./StreamNotificationPanel"
import * as liveReminderApi from "../../notifications/api/liveReminderApi"
import { ensurePushEnabled } from "../../notifications/push/pushGate"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { readStylesheet, ruleBody } from "../../../test/readStylesheet"
import type { ScheduledStream } from "../model/scheduledStream"

// The one-time Premiere reminder in the SAME reminder panel the livestream reminder uses. The push gate is mocked (its own behavior is covered in
// pushGate.test.ts); only the reminder API is faked, so the real hook, cache and panel run.
vi.mock("../../notifications/push/pushGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notifications/push/pushGate")>()),
  ensurePushEnabled: vi.fn(async () => "ready"),
}))
vi.mock("../../notifications/api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notifications/api/liveReminderApi")>()),
  fetchReminderSettings: vi.fn(),
  saveStreamNotificationOverride: vi.fn(),
  deleteStreamNotificationOverride: vi.fn(),
  savePremiereReminder: vi.fn(),
  deletePremiereReminder: vi.fn(),
}))

const creator = getCreatorById("aizawa_ema")!
const premiere: ScheduledStream = {
  id: "s1",
  channelId: toLegacyRosterId(creator),
  videoId: "p1",
  title: "New original song",
  description: "",
  status: "premiere",
  scheduledStartMs: 1_000_000,
  topics: [],
}
const livestream: ScheduledStream = { ...premiere, id: "s2", videoId: "v1", status: "upcoming" }

const CHOICES = ["at_start", "10min", "30min", "1hour"] as const
const LABELS = {
  "zh-TW": ["首播時", "10 分鐘前", "30 分鐘前", "1 小時前"],
  ja: ["プレミア公開時", "10分前", "30分前", "1時間前"],
  en: ["At Premiere start", "10 minutes before", "30 minutes before", "1 hour before"],
} as const
const setting = (advanceReminder: "1min" | "10min" | "30min" | "1hour" | null) => ({ notifyAtStart: true, advanceReminder })

function mockSettings(overrides: Partial<liveReminderApi.ReminderSettingsSnapshot> = {}) {
  vi.mocked(liveReminderApi.fetchReminderSettings).mockResolvedValue({ ...liveReminderApi.emptyReminderSettings(), ...overrides })
}

function checkedLabels() {
  return screen.getAllByRole("radio").filter((radio) => (radio as HTMLInputElement).checked)
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  vi.mocked(ensurePushEnabled).mockReset().mockResolvedValue("ready")
  vi.mocked(liveReminderApi.fetchReminderSettings).mockClear()
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.deleteStreamNotificationOverride).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.savePremiereReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.deletePremiereReminder).mockReset().mockResolvedValue(undefined)
  mockSettings()
})

describe("StreamNotificationPanel for a Premiere", () => {
  it.each(Object.entries(LABELS))("offers exactly the four timing choices in order (no 1 minute), in %s", async (locale, labels) => {
    localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests() // the locale is cached by the shared state: re-read what was just stored
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)

    const radios = await screen.findAllByRole("radio")

    expect(radios).toHaveLength(4)
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([...labels])
    expect(screen.queryByRole("radio", { name: /1 分鐘前|1分前|1 minute before/ })).not.toBeInTheDocument()
  })

  it("uses the Premiere wording, not the livestream wording, and the same drawer title and Save action", async () => {
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)

    expect(await screen.findByText("This setting applies only to this Premiere.")).toBeInTheDocument()
    expect(screen.getByText(/one notification at the time you choose/)).toBeInTheDocument()
    expect(screen.getByText(/has no reminder right now/)).toBeInTheDocument()
    expect(screen.queryByText(/livestream/i)).toBeInTheDocument() // only in "your livestream notification settings are not affected"
    expect(screen.queryByText(/replacing the creator's usual/)).not.toBeInTheDocument()
    expect(screen.queryByText(/notification is always sent when the stream starts/)).not.toBeInTheDocument()
    expect(screen.getByText("Set Reminder")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Save/ })).toBeInTheDocument()
  })

  it("the ordinary livestream panel keeps its own first label and wording", async () => {
    render(<StreamNotificationPanel stream={livestream} onClose={() => {}} />)

    expect(await screen.findByRole("radio", { name: "At start" })).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "At Premiere start" })).not.toBeInTheDocument()
    expect(screen.getByText("This setting applies only to this livestream.")).toBeInTheDocument()
  })

  it("shows NO choice selected for a Premiere with no reminder, keeps Save disabled, and never saves by merely opening", async () => {
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")

    expect(checkedLabels()).toHaveLength(0)
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Cancel reminder" })).not.toBeInTheDocument()
    expect(liveReminderApi.savePremiereReminder).not.toHaveBeenCalled()
  })

  it("only ONE choice can be active at a time", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")

    for (const label of LABELS.en) {
      await user.click(screen.getByRole("radio", { name: label }))
      expect(checkedLabels()).toHaveLength(1)
      expect(screen.getByRole("radio", { name: label })).toBeChecked()
    }
  })

  it.each(CHOICES.map((value, index) => [value, LABELS.en[index]] as const))("saving the choice %s stores exactly that one value for this Premiere", async (value, label) => {
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={onClose} />)
    await screen.findAllByRole("radio")

    await user.click(screen.getByRole("radio", { name: label }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(liveReminderApi.savePremiereReminder).toHaveBeenCalledWith("p1", "aizawa_ema", value))
    expect(liveReminderApi.savePremiereReminder).toHaveBeenCalledTimes(1)
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled() // never a livestream override
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("restores the saved reminder when the panel is reopened, and offers cancelling it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    await user.click(screen.getByRole("radio", { name: "30 minutes before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))
    await waitFor(() => expect(liveReminderApi.savePremiereReminder).toHaveBeenCalled())

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByRole("radio", { name: "30 minutes before" })).toBeChecked())
    expect(screen.getByRole("button", { name: "Cancel reminder" })).toBeInTheDocument()
  })

  it("restores a reminder stored on the backend (after a page reload)", async () => {
    mockSettings({ premiereReminders: { p1: "at_start" } })
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByRole("radio", { name: "At Premiere start" })).toBeChecked())
    expect(checkedLabels()).toHaveLength(1)
  })

  it("updating replaces the saved time with the new single choice", async () => {
    mockSettings({ premiereReminders: { p1: "10min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("radio", { name: "1 hour before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(liveReminderApi.savePremiereReminder).toHaveBeenCalledWith("p1", "aizawa_ema", "1hour"))
    expect(liveReminderApi.savePremiereReminder).toHaveBeenCalledTimes(1)
  })

  it("cancelling deletes this Premiere's reminder only and closes the panel", async () => {
    mockSettings({ premiereReminders: { p1: "10min" } })
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked())

    await user.click(screen.getByRole("button", { name: "Cancel reminder" }))

    await waitFor(() => expect(liveReminderApi.deletePremiereReminder).toHaveBeenCalledWith("p1"))
    expect(liveReminderApi.deleteStreamNotificationOverride).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("after cancelling, reopening shows no saved choice", async () => {
    mockSettings({ premiereReminders: { p1: "10min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked())
    await user.click(screen.getByRole("button", { name: "Cancel reminder" }))
    await waitFor(() => expect(liveReminderApi.deletePremiereReminder).toHaveBeenCalled())

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)

    await screen.findAllByRole("radio")
    expect(checkedLabels()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "Cancel reminder" })).not.toBeInTheDocument()
  })

  it("ignores the creator's livestream reminders and a livestream override: a Premiere only ever shows its own reminder", async () => {
    mockSettings({
      creatorAll: { aizawa_ema: setting("30min") },
      streamOverrides: { p1: { creatorId: "aizawa_ema", ...setting("1hour") } },
    })
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")

    expect(checkedLabels()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "Cancel reminder" })).not.toBeInTheDocument()
  })

  it("a saved Premiere reminder never shows up on an ordinary livestream, and the reverse", async () => {
    mockSettings({ premiereReminders: { v1: "10min" }, streamOverrides: { p1: { creatorId: "aizawa_ema", ...setting("1hour") } } })
    const { rerender } = render(<StreamNotificationPanel stream={livestream} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    expect(checkedLabels()).toHaveLength(0)

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    expect(checkedLabels()).toHaveLength(0)
  })

  it.each(["cancelled", "denied", "unavailable", "failed"] as const)("when notification permission/subscription is %s nothing is saved and the panel stays open", async (outcome) => {
    vi.mocked(ensurePushEnabled).mockResolvedValue(outcome)
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={onClose} />)
    await screen.findAllByRole("radio")

    await user.click(screen.getByRole("radio", { name: "10 minutes before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(ensurePushEnabled).toHaveBeenCalled())
    expect(liveReminderApi.savePremiereReminder).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked() // the user's pick is kept
  })

  it("a failed save keeps the panel open with the pick intact and shows the existing error text", async () => {
    vi.mocked(liveReminderApi.savePremiereReminder).mockRejectedValue(new Error("500"))
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={onClose} />)
    await screen.findAllByRole("radio")

    await user.click(screen.getByRole("radio", { name: "10 minutes before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save this reminder. Please try again.")
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked()
  })

  it("a reminder saved earlier with the retired 1-minute choice shows nothing selected plus a retired hint, can be cancelled, and is never converted", async () => {
    mockSettings({ premiereReminders: { p1: "1min" } })
    const onClose = vi.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={onClose} />)
    await screen.findAllByRole("radio")

    expect(checkedLabels()).toHaveLength(0)
    expect(await screen.findByText(/saved 1-minute reminder \(that option has been retired\)/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled() // nothing is sent unless the user picks a new time
    expect(liveReminderApi.savePremiereReminder).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Cancel reminder" }))
    await waitFor(() => expect(liveReminderApi.deletePremiereReminder).toHaveBeenCalledWith("p1"))
    expect(liveReminderApi.savePremiereReminder).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("replacing a retired 1-minute reminder saves only the new time the user picked", async () => {
    mockSettings({ premiereReminders: { p1: "1min" } })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")

    await user.click(screen.getByRole("radio", { name: "10 minutes before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(liveReminderApi.savePremiereReminder).toHaveBeenCalledWith("p1", "aizawa_ema", "10min"))
    expect(liveReminderApi.savePremiereReminder).toHaveBeenCalledTimes(1)
  })

  it("the ordinary livestream panel still offers the 1-minute choice", async () => {
    render(<StreamNotificationPanel stream={livestream} onClose={() => {}} />)

    expect(await screen.findByRole("radio", { name: "1 minute before" })).toBeInTheDocument()
    expect(screen.getAllByRole("radio")).toHaveLength(5)
  })

  it("regression: saving a reminder for an ordinary livestream still writes the livestream override and never a Premiere reminder", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<StreamNotificationPanel stream={livestream} onClose={() => {}} />)
    await screen.findAllByRole("radio")

    await user.click(screen.getByRole("radio", { name: "10 minutes before" }))
    await user.click(screen.getByRole("button", { name: /Save/ }))

    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", { creatorId: "aizawa_ema", notifyAtStart: true, advanceReminder: "10min" }))
    expect(liveReminderApi.savePremiereReminder).not.toHaveBeenCalled()
  })
})

describe("the Premiere reminder's two-by-two option grid", () => {
  it("marks only the Premiere panel's options control with the two-column modifier", async () => {
    const { rerender } = render(<StreamNotificationPanel stream={premiere} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    expect(document.querySelector(".stream-reminder-options")).toHaveClass("stream-reminder-options--premiere")

    rerender(<StreamNotificationPanel stream={null} onClose={() => {}} />)
    rerender(<StreamNotificationPanel stream={livestream} onClose={() => {}} />)
    await screen.findAllByRole("radio")
    expect(document.querySelector(".stream-reminder-options")).not.toHaveClass("stream-reminder-options--premiere")
  })

  it("is a balanced two-column grid of equal-width columns with a 44px touch height, while the livestream grid keeps three columns", async () => {
    const css = await readStylesheet("src/pages/schedule/styles/schedule.css")
    const base = ".stream-reminder-drawer .stream-reminder-options .ant-segmented-group"
    const premiereGroup = ".stream-reminder-drawer .stream-reminder-options--premiere .ant-segmented-group"

    expect(ruleBody(css, premiereGroup)).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(ruleBody(css, ".stream-reminder-drawer .stream-reminder-options--premiere .ant-segmented-item")).toMatch(/min-height:\s*44px/)
    expect(ruleBody(css, base)).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/) // the livestream reminder is unchanged
    expect(css.indexOf(premiereGroup)).toBeGreaterThan(css.indexOf(base)) // equal specificity: the later Premiere rule wins
  })
})
