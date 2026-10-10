import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getEffectiveNewVideoCreatorIds, resyncAfterRetiredMigration } from "./useTopicNotificationPreferences"
import { useRetiredTopicResync } from "./useRetiredTopicResync"
import { useNotificationSaveFailed } from "./notificationSaveStatus"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import * as notificationPreferenceApi from "../api/notificationPreferenceApi"
import * as pushNotifications from "../push/pushNotifications"

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

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const DEFAULTS = ["all", "sf6", "valorant", "apex", "minecraft"]
const card = (over: Record<string, unknown> = {}) => ({ live: [], newVideo: [], reminderOverrides: {}, notificationType: "both", ...over })
const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
const save = vi.mocked(notificationPreferenceApi.saveNotificationPreference)

function seed(value: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  resetAllSharedStateForTests() // what loading the page does: the store migrates what it reads
}

/** What the backend holds for a user who had VALO + a retired GTA card, both with new-video members. */
const STALE = {
  topicOrder: [...DEFAULTS, "gta", "short"],
  topics: {
    valorant: card({ newVideo: ["kaga_sumire"] }),
    gta: card({ newVideo: ["only_in_gta"] }),
    short: card({ newVideo: ["aizawa_ema"], notificationType: "newVideo" }),
  },
}

beforeEach(() => {
  save.mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

describe("re-sending the preference after a retired card was migrated away", () => {
  it("re-sends once at startup without Settings: the retired card's creator is gone, valid and Short members are kept", async () => {
    seed(STALE)

    expect(await resyncAfterRetiredMigration()).toBe(true)

    expect(save).toHaveBeenCalledTimes(1)
    const [enabled, newVideoIds, shortIds] = save.mock.calls[0]
    expect(enabled).toBe(true)
    expect([...newVideoIds]).toEqual(["kaga_sumire"]) // VALO's member stays, GTA's creator no longer enables new videos
    expect([...shortIds]).toEqual(["aizawa_ema"]) // Short members unaffected
    expect([...getEffectiveNewVideoCreatorIds()]).toEqual(["kaga_sumire"])
  })

  it("clears the pending flag and rewrites the stored copy without the retired card, and never sends a second time", async () => {
    seed(STALE)
    await resyncAfterRetiredMigration()

    expect(stored().pendingResync).toBeUndefined()
    expect(stored().topicOrder).not.toContain("gta")
    expect(stored().topics.gta).toBeUndefined()
    expect(stored().topics.valorant.newVideo).toEqual(["kaga_sumire"])

    await resyncAfterRetiredMigration()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("runs from the app root hook", async () => {
    seed(STALE)

    renderHook(() => useRetiredTopicResync())

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  })

  it("does not write when the retired card had no new-video members (the backend never saw it)", async () => {
    seed({ topicOrder: [...DEFAULTS, "gta"], topics: { gta: card({ live: ["z"], newVideo: ["z"], notificationType: "live" }) } })

    expect(await resyncAfterRetiredMigration()).toBe(true)

    expect(save).not.toHaveBeenCalled()
  })

  it("does not write when nothing was retired", async () => {
    seed({ topicOrder: [...DEFAULTS, "singing"], topics: { singing: card({ newVideo: ["z"] }) } })

    await resyncAfterRetiredMigration()

    expect(save).not.toHaveBeenCalled()
  })

  it("without a push subscription there is no backend preference to clean: nothing is sent and the migrated state is what enabling will send", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    seed(STALE)

    await resyncAfterRetiredMigration()

    expect(save).not.toHaveBeenCalled()
    expect(stored().pendingResync).toBeUndefined()
    expect([...getEffectiveNewVideoCreatorIds()]).toEqual(["kaga_sumire"])
  })

  it("when the push status cannot even be read, nothing was cleaned, so it stays pending for the next start (silently)", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockRejectedValue(new Error("service worker unavailable"))
    seed(STALE)
    const { result } = renderHook(() => useNotificationSaveFailed())

    expect(await resyncAfterRetiredMigration()).toBe(false)

    expect(save).not.toHaveBeenCalled()
    expect(result.current).toBe(false)

    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
    resetAllSharedStateForTests() // next app start: the stored copy still has the retired card, so it is detected again
    expect(await resyncAfterRetiredMigration()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(stored().pendingResync).toBeUndefined()
  })

  it("a failed re-send keeps it pending for the next start and stays silent (no Settings error banner)", async () => {
    seed(STALE)
    save.mockRejectedValueOnce(new Error("HTTP 500"))
    const { result } = renderHook(() => useNotificationSaveFailed())

    expect(await resyncAfterRetiredMigration()).toBe(false)

    expect(result.current).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)

    resetAllSharedStateForTests() // next app start: the stored copy still has the retired card, so it is detected again
    expect(await resyncAfterRetiredMigration()).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
