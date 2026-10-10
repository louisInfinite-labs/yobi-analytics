import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  effectiveNewVideoCreatorIds,
  getEffectiveNewVideoCreatorIds,
  useTopicNotificationPreferences,
} from "./useTopicNotificationPreferences"
import { useNotificationSaveFailed } from "./notificationSaveStatus"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import * as liveReminderApi from "../api/liveReminderApi"
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

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
}

/** Simulates a page reload: shared stores re-read localStorage, nothing else survives. */
function reload() {
  resetAllSharedStateForTests()
}

beforeEach(() => {
  vi.mocked(liveReminderApi.saveCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

/** A rejected backend request, shaped like what apiClient throws for a 4xx / 5xx. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe("reminders are saved backend-first (B5)", () => {
  it.each([400, 403, 404, 500, 503])("a %i from the backend leaves no persisted false-success for a creator + topic reminder", async (status) => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(httpError(status))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
    })

    expect(saved).toBe(false)
    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBeNull()
    expect(storedState().topics?.sf6?.reminderOverrides ?? {}).toEqual({})

    reload()
    const { result: afterReload } = renderHook(() => useTopicNotificationPreferences())
    expect(afterReload.current.getMemberReminder("sf6", "aizawa_ema")).toBeNull()
  })

  it("the creator-wide (全部) reminder is backend-first too, and a reload does not resurrect a failed value", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setMemberReminder("all", "aizawa_ema", "30min")
    })
    vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(httpError(500))

    await act(async () => {
      await result.current.setMemberReminder("all", "aizawa_ema", "1hour")
    })

    expect(result.current.getMemberReminder("all", "aizawa_ema")).toBe("30min")
    reload()
    const { result: afterReload } = renderHook(() => useTopicNotificationPreferences())
    expect(afterReload.current.getMemberReminder("all", "aizawa_ema")).toBe("30min")
  })

  it("a failed UNSET keeps the existing reminder", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
    })
    vi.mocked(liveReminderApi.deleteCreatorReminder).mockRejectedValueOnce(httpError(500))

    await act(async () => {
      await result.current.setMemberReminder("sf6", "aizawa_ema", null)
    })

    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("10min")
    expect(storedState().topics.sf6.reminderOverrides).toEqual({ aizawa_ema: "10min" })
  })

  it("commits locally only after the backend write resolved", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    let release!: () => void
    vi.mocked(liveReminderApi.saveCreatorReminder).mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)))

    let pending!: Promise<boolean>
    act(() => {
      pending = result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
    })
    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBeNull()
    expect(storedState().topics?.sf6).toBeUndefined()

    await act(async () => {
      release()
      await pending
    })
    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("10min")
    expect(storedState().topics.sf6.reminderOverrides).toEqual({ aizawa_ema: "10min" })
  })

  it("turning Live OFF deletes the reminder on the backend first; if that fails Live and the reminder both stay", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setLiveEnabled("sf6", "aizawa_ema", true)
    })
    await act(async () => {
      await result.current.setMemberReminder("sf6", "aizawa_ema", "1hour")
    })
    vi.mocked(liveReminderApi.deleteCreatorReminder).mockRejectedValueOnce(httpError(500))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.setLiveEnabled("sf6", "aizawa_ema", false)
    })

    expect(saved).toBe(false)
    expect(result.current.isLiveEnabled("sf6", "aizawa_ema")).toBe(true)
    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("1hour")
  })

  it("two quick changes to the same reminder reach the backend, and the store, in click order", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    const order: string[] = []
    let releaseFirst!: () => void
    vi.mocked(liveReminderApi.saveCreatorReminder)
      .mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirst = () => (order.push("first-done"), resolve()))))
      .mockImplementationOnce(async () => {
        order.push("second-sent")
      })

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
      second = result.current.setMemberReminder("sf6", "aizawa_ema", "1hour")
    })
    await act(async () => {
      // The first backend request is only issued on a later microtask; wait for it before releasing it.
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"))
      expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledTimes(1) // the second is still queued behind it
      releaseFirst()
      await Promise.all([first, second])
    })

    expect(order).toEqual(["first-done", "second-sent"])
    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("1hour")
  })

  it("a failure raises the save-failed flag and the next success clears it", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    const { result: flag } = renderHook(() => useNotificationSaveFailed())
    vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(httpError(500))

    await act(async () => {
      await result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
    })
    expect(flag.current).toBe(true)

    await act(async () => {
      await result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
    })
    expect(flag.current).toBe(false)
  })
})

describe("per-creator new-video switches write the backend preference (B17)", () => {
  it("enabling a creator sends the full effective set to the backend, then commits locally", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())

    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", true)
    })

    expect(notificationPreferenceApi.saveNotificationPreference).toHaveBeenCalledTimes(1)
    const [enabled, ids] = vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls[0]
    expect(enabled).toBe(true)
    expect([...ids]).toEqual(["aizawa_ema"])
    expect(result.current.isNewVideoEnabled("all", "aizawa_ema")).toBe(true)
  })

  it("turning a creator OFF removes them from the set the backend receives", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", true)
    })
    await act(async () => {
      await result.current.setNewVideoEnabled("all", "kaga_sumire", true)
    })

    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", false)
    })

    const lastIds = vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls.at(-1)![1]
    expect([...lastIds]).toEqual(["kaga_sumire"])
  })

  it("a backend failure leaves the switch where it was, shows the failure, and a reload does not resurrect it", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    const { result: flag } = renderHook(() => useNotificationSaveFailed())
    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockRejectedValueOnce(httpError(500))

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.setNewVideoEnabled("all", "aizawa_ema", true)
    })

    expect(saved).toBe(false)
    expect(flag.current).toBe(true)
    expect(result.current.isNewVideoEnabled("all", "aizawa_ema")).toBe(false)
    expect(storedState().topics?.all?.newVideo ?? []).toEqual([])
    reload()
    const { result: afterReload } = renderHook(() => useTopicNotificationPreferences())
    expect(afterReload.current.isNewVideoEnabled("all", "aizawa_ema")).toBe(false)
  })

  it("a failed switch-OFF stays ON", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", true)
    })
    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockRejectedValueOnce(httpError(403))

    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", false)
    })

    expect(result.current.isNewVideoEnabled("all", "aizawa_ema")).toBe(true)
  })

  it("makes no backend call while notifications are not enabled on this browser, but still saves the switch locally", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    const { result } = renderHook(() => useTopicNotificationPreferences())

    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", true)
    })

    expect(notificationPreferenceApi.saveNotificationPreference).not.toHaveBeenCalled()
    expect(result.current.isNewVideoEnabled("all", "aizawa_ema")).toBe(true)
  })

  it("makes no backend call when the effective set does not change (same creator already ON in another saved topic)", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setNewVideoEnabled("all", "aizawa_ema", true)
    })
    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockClear()

    await act(async () => {
      await result.current.setNewVideoEnabled("sf6", "aizawa_ema", true)
    })

    expect(notificationPreferenceApi.saveNotificationPreference).not.toHaveBeenCalled()
    expect(result.current.isNewVideoEnabled("sf6", "aizawa_ema")).toBe(true)
  })

  it("switching a topic to Live-only removes its new-video creators from the backend set (and a failure keeps the type)", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setNewVideoEnabled("sf6", "aizawa_ema", true)
    })

    await act(async () => {
      await result.current.setNotificationType("sf6", "live")
    })
    expect([...vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls.at(-1)![1]]).toEqual([])
    expect(result.current.getNotificationType("sf6")).toBe("live")

    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockRejectedValueOnce(httpError(500))
    await act(async () => {
      await result.current.setNotificationType("sf6", "both")
    })
    expect(result.current.getNotificationType("sf6")).toBe("live")
  })

  it("an unsaved draft topic never contributes to the backend set", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())

    await act(async () => {
      await result.current.setNewVideoEnabled("singing", "aizawa_ema", true)
    })

    expect(notificationPreferenceApi.saveNotificationPreference).not.toHaveBeenCalled()
    expect([...getEffectiveNewVideoCreatorIds()]).toEqual([])
  })

  it("is unaffected by Live switches and reminders, which never write the preference", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())

    await act(async () => {
      await result.current.setLiveEnabled("sf6", "aizawa_ema", true)
    })
    await act(async () => {
      await result.current.setMemberReminder("sf6", "aizawa_ema", "10min")
    })

    expect(notificationPreferenceApi.saveNotificationPreference).not.toHaveBeenCalled()
  })
})

describe("effectiveNewVideoCreatorIds", () => {
  const topic = (newVideo: string[], notificationType: "live" | "newVideo" | "both") => ({
    live: [],
    newVideo,
    reminderOverrides: {},
    notificationType,
  })

  it("unions new-video creators over saved topics whose type allows new videos", () => {
    const ids = effectiveNewVideoCreatorIds({
      topicOrder: ["all", "sf6", "apex"],
      topics: { all: topic(["a"], "both"), sf6: topic(["b"], "newVideo"), apex: topic(["c"], "live") },
    })

    expect([...ids].sort()).toEqual(["a", "b"])
  })

  it("ignores topics that are not saved", () => {
    const ids = effectiveNewVideoCreatorIds({ topicOrder: ["all"], topics: { all: topic([], "both"), singing: topic(["z"], "both") } })

    expect(ids.size).toBe(0)
  })
})
