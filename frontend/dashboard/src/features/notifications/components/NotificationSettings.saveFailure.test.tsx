import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import * as liveReminderApi from "../api/liveReminderApi"
import * as notificationPreferenceApi from "../api/notificationPreferenceApi"
import * as pushNotifications from "../push/pushNotifications"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn(),
  deleteCreatorReminder: vi.fn(),
}))
vi.mock("../api/notificationPreferenceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/notificationPreferenceApi")>()),
  saveNotificationPreference: vi.fn(),
}))
vi.mock("../push/pushNotifications", () => ({ getPushSubscriptionStatus: vi.fn() }))

// Opening the member drawer renders the whole creator roster, so a multi-step interaction here is slow in jsdom.
vi.setConfig({ testTimeout: 30000 })

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const BACKEND_TOPICS = ["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"].map((id) => ({ id, labels: { en: id } }))
const SAVE_FAILED = /Couldn't save to the server/

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue(BACKEND_TOPICS)
  vi.mocked(liveReminderApi.saveCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
}

/** Opens the "All" topic's member drawer (the creator-wide 全部 scope). */
async function openAllDrawer(user: ReturnType<typeof userEvent.setup>) {
  render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
  const detail = document.querySelector(".notification-detail-panel") as HTMLElement
  await user.click(within(detail).getAllByRole("button", { name: /Manage Members/ })[0])
}

describe("Settings drawer when a notification write is rejected", () => {
  it("a failed reminder save shows the error, keeps the old reminder, and writes nothing to storage", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await openAllDrawer(user)
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ })[0])
    const trigger = screen.getAllByRole("button", { name: /'s reminder time/ })[0]
    expect(trigger).toHaveTextContent("No reminder")
    vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(new Error("HTTP 500"))

    await user.click(trigger)
    await user.click(screen.getByRole("menuitem", { name: "10 minutes before" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED)
    expect(screen.getAllByRole("button", { name: /'s reminder time/ })[0]).toHaveTextContent("No reminder")
    expect(storedState().topics.all.reminderOverrides).toEqual({})
  })

  it("the error clears after the next successful save", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await openAllDrawer(user)
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ })[0])
    vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(new Error("HTTP 500"))
    await user.click(screen.getAllByRole("button", { name: /'s reminder time/ })[0])
    await user.click(screen.getByRole("menuitem", { name: "10 minutes before" }))
    await screen.findByRole("alert")

    await user.click(screen.getAllByRole("button", { name: /'s reminder time/ })[0])
    await user.click(screen.getByRole("menuitem", { name: "10 minutes before" }))

    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getAllByRole("button", { name: /'s reminder time/ })[0]).toHaveTextContent("10 minutes before")
  })

  it("a failed new-video switch shows the error and leaves the switch OFF", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await openAllDrawer(user)
    const [firstSwitch] = screen.getAllByRole("switch", { name: /new video notifications/ })
    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockRejectedValueOnce(new Error("HTTP 403"))

    await user.click(firstSwitch)

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED)
    expect(screen.getAllByRole("switch", { name: /new video notifications/ })[0]).not.toBeChecked()
    expect(storedState().topics?.all?.newVideo ?? []).toEqual([])
  })

  it("a successful new-video switch writes the creator preference through the backend path", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await openAllDrawer(user)

    await user.click(screen.getAllByRole("switch", { name: /new video notifications/ })[0])

    await vi.waitFor(() => expect(screen.getAllByRole("switch", { name: /new video notifications/ })[0]).toBeChecked())
    expect(notificationPreferenceApi.saveNotificationPreference).toHaveBeenCalledTimes(1)
    const [enabled, ids] = vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls[0]
    expect(enabled).toBe(true)
    expect(ids.size).toBe(1)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("a reload after a failed save shows the last confirmed state", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await openAllDrawer(user)
    await user.click(screen.getAllByRole("switch", { name: /live notifications/ })[0])
    vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(new Error("HTTP 500"))
    await user.click(screen.getAllByRole("button", { name: /'s reminder time/ })[0])
    await user.click(screen.getByRole("menuitem", { name: "1 hour before" }))
    await screen.findByRole("alert")

    resetAllSharedStateForTests() // what a page reload does to the in-memory stores

    expect(screen.getAllByRole("button", { name: /'s reminder time/ })[0]).toHaveTextContent("No reminder")
  })
})
