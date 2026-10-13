import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StreamNotificationPanel } from "./StreamNotificationPanel"
import { PushPermissionHost } from "../../notifications/components/PushPermissionHost"
import * as liveReminderApi from "../../notifications/api/liveReminderApi"
import * as apiClient from "../../../shared/api/apiClient"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetPushGateForTests } from "../../notifications/push/pushGate"
import { resetPushStateForTests } from "../../notifications/push/pushState"
import { installFakePushDevice } from "../../../test/fakePushDevice"
import type { ScheduledStream } from "../model/scheduledStream"

// The REAL push gate (no mock of pushGate): the production path from a Schedule reminder's Save button to Web Push. Only the network
// (apiClient, the reminder API) and the browser's push APIs (fakePushDevice) are faked.
vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))
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

let fake: ReturnType<typeof installFakePushDevice> | undefined

beforeEach(() => {
  vi.stubEnv("VITE_API_BASE_URL", "") // never reach the real API (the test env loads .env.local)
  resetPushGateForTests()
  resetPushStateForTests()
  localStorage.setItem("yobi.locale", "en")
  vi.mocked(apiClient.apiRequest).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.fetchReminderSettings).mockResolvedValue(liveReminderApi.emptyReminderSettings())
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fake?.restore()
  fake = undefined
})

async function pickTenMinutesAndSave(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByRole("radio")
  await user.click(screen.getByRole("radio", { name: "10 minutes before" }))
  await user.click(screen.getByRole("button", { name: /Save/ }))
}

describe("Schedule one-time reminder reaches Web Push through the gate", () => {
  it("first use (permission undecided): Save shows the explanation; only Continue raises the browser prompt, then the reminder is saved", async () => {
    fake = installFakePushDevice({ permission: "default" })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      <>
        <StreamNotificationPanel stream={stream} onClose={() => {}} />
        <PushPermissionHost />
      </>,
    )

    await pickTenMinutesAndSave(user)

    expect(await screen.findByRole("dialog", { name: "Allow OshiYobi to send notifications" })).toBeInTheDocument()
    expect(fake.requestPermission).not.toHaveBeenCalled()
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", expect.objectContaining({ advanceReminder: "10min" })))
    expect(fake.requestPermission).toHaveBeenCalledTimes(1)
    expect(fake.subscribe).toHaveBeenCalledTimes(1) // a real PushSubscription now exists...
    const writes = vi.mocked(apiClient.apiRequest).mock.calls.map(([path, init]) => `${(init as { method?: string }).method} ${String(path).replace(/\/clients\/[^/]+/, "")}`)
    expect(writes).toEqual(expect.arrayContaining(["PUT /push-subscription", "PUT /notification-preference"])) // ...and is registered with the backend
  })

  it("cancelling the explanation saves nothing and keeps the drawer (and the user's pick) as it was", async () => {
    fake = installFakePushDevice({ permission: "default" })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onClose = vi.fn()
    render(
      <>
        <StreamNotificationPanel stream={stream} onClose={onClose} />
        <PushPermissionHost />
      </>,
    )

    await pickTenMinutesAndSave(user)
    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(fake.requestPermission).not.toHaveBeenCalled()
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("radio", { name: "10 minutes before" })).toBeChecked()
  })

  it("permission already denied: Save saves nothing, never re-requests permission, and shows the denied help", async () => {
    fake = installFakePushDevice({ permission: "denied" })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onClose = vi.fn()
    render(
      <>
        <StreamNotificationPanel stream={stream} onClose={onClose} />
        <PushPermissionHost />
      </>,
    )

    await pickTenMinutesAndSave(user)

    expect(await screen.findByRole("dialog", { name: "Notification permission is off" })).toBeInTheDocument()
    expect(fake.requestPermission).not.toHaveBeenCalled()
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("permission granted and subscribed: Save goes straight through -- no explanation, no prompt", async () => {
    fake = installFakePushDevice({ permission: "granted", subscribed: true })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onClose = vi.fn()
    render(
      <>
        <StreamNotificationPanel stream={stream} onClose={onClose} />
        <PushPermissionHost />
      </>,
    )

    await pickTenMinutesAndSave(user)

    await waitFor(() => expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalled()
    expect(fake.requestPermission).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog", { name: "Allow OshiYobi to send notifications" })).not.toBeInTheDocument()
  })

  it("removing a reminder never needs notification permission", async () => {
    fake = installFakePushDevice({ permission: "denied" })
    vi.mocked(liveReminderApi.fetchReminderSettings).mockResolvedValue({
      ...liveReminderApi.emptyReminderSettings(),
      streamOverrides: { v1: { creatorId: creator.creatorId, notifyAtStart: true, advanceReminder: "10min" } },
    })
    vi.mocked(liveReminderApi.deleteStreamNotificationOverride).mockResolvedValue(undefined)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      <>
        <StreamNotificationPanel stream={stream} onClose={() => {}} />
        <PushPermissionHost />
      </>,
    )

    await user.click(await screen.findByRole("button", { name: /Remove/ }))

    await waitFor(() => expect(liveReminderApi.deleteStreamNotificationOverride).toHaveBeenCalledWith("v1"))
    expect(screen.queryByRole("dialog", { name: "Notification permission is off" })).not.toBeInTheDocument()
    expect(fake?.requestPermission).not.toHaveBeenCalled()
  })
})
