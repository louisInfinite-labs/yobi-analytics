import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getEffectiveNewVideoCreatorIds,
  getEffectiveShortCreatorIds,
  migrateStoredTopicOrder,
  useTopicNotificationPreferences,
} from "./useTopicNotificationPreferences"
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
const DEFAULTS = ["all", "sf6", "valorant", "apex", "minecraft"]

function seed(value: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  resetAllSharedStateForTests()
}
const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
const card = (over: Record<string, unknown> = {}) => ({ live: [], newVideo: [], reminderOverrides: {}, notificationType: "both", ...over })

beforeEach(() => {
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

describe("retired notification-only cards (GTA, 7 Days to Die, Mahjong Soul, Endfield)", () => {
  it("migrateStoredTopicOrder drops exactly the retired ids, maps valo -> valorant and keeps the order of the rest", () => {
    expect(migrateStoredTopicOrder(["valo", "gta", "minecraft", "seven_days_to_die", "mahjong_soul", "endfield", "singing", "short"])).toEqual([
      "valorant",
      "minecraft",
      "singing",
      "short",
    ])
  })

  it("saved VALO, GTA, Minecraft -> VALO and Minecraft remain, GTA is gone, and everything else valid survives", () => {
    seed({
      topicOrder: ["all", "valorant", "gta", "minecraft", "singing", "short"],
      topics: {
        all: card({ live: ["aizawa_ema"], reminderOverrides: { aizawa_ema: "30min" } }),
        valorant: card({ newVideo: ["kaga_sumire"], notificationType: "newVideo" }),
        gta: card({ live: ["z"], newVideo: ["z"], reminderOverrides: { z: "10min" } }),
        minecraft: card({ live: ["shirakami_fubuki"], reminderOverrides: { shirakami_fubuki: "1hour" }, notificationType: "live" }),
        singing: card({ newVideo: ["hakos_baelz"] }),
        short: card({ newVideo: ["aizawa_ema", "kaga_nazuna"] }),
      },
    })

    const { result } = renderHook(() => useTopicNotificationPreferences())

    // the permanent defaults are restored in place, VALO and Minecraft are among them, GTA is not; added cards keep their order
    expect(result.current.savedTopicIds).toEqual([...DEFAULTS, "singing", "short"])
    expect(result.current.savedTopicIds).not.toContain("gta")
    // valid settings survive
    expect(result.current.isLiveEnabled("all", "aizawa_ema")).toBe(true)
    expect(result.current.getMemberReminder("all", "aizawa_ema")).toBe("30min")
    expect(result.current.isNewVideoEnabled("valorant", "kaga_sumire")).toBe(true)
    expect(result.current.getNotificationType("valorant")).toBe("newVideo")
    expect(result.current.isLiveEnabled("minecraft", "shirakami_fubuki")).toBe(true)
    expect(result.current.getMemberReminder("minecraft", "shirakami_fubuki")).toBe("1hour")
    expect(result.current.getNotificationType("minecraft")).toBe("live")
    expect(result.current.isNewVideoEnabled("singing", "hakos_baelz")).toBe(true)
    // the Short card and its members survive, and Short stays a separate field (not a topic)
    expect([...getEffectiveShortCreatorIds()].sort()).toEqual(["aizawa_ema", "kaga_nazuna"])
    // the retired card's own state is gone with it: its creator no longer enables ordinary new videos
    expect(result.current.isLiveEnabled("gta", "z")).toBe(false)
    expect(getEffectiveNewVideoCreatorIds().has("z")).toBe(false)
    expect([...getEffectiveNewVideoCreatorIds()].sort()).toEqual(["hakos_baelz", "kaga_sumire"])
  })

  it("the retired card state is not carried into the next write either", async () => {
    seed({ topicOrder: [...DEFAULTS, "gta"], topics: { gta: card({ newVideo: ["z"] }) } })
    const { result } = renderHook(() => useTopicNotificationPreferences())

    await act(async () => {
      await result.current.setNewVideoEnabled("sf6", "aizawa_ema", true)
    })

    expect(stored().topicOrder).not.toContain("gta")
    expect(stored().topics.gta).toBeUndefined()
  })
})

describe("removeTopic", () => {
  it("never removes a permanent default card", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())

    for (const id of DEFAULTS) {
      let removed = true
      await act(async () => {
        removed = await result.current.removeTopic(id)
      })
      expect(removed).toBe(false)
    }
    expect(result.current.savedTopicIds).toEqual(DEFAULTS)
  })

  it("removing the Short card clears the Short members on the backend first, and Short stays OFF after a reload", async () => {
    seed({ topicOrder: [...DEFAULTS, "short"], topics: { short: card({ newVideo: ["aizawa_ema", "kaga_nazuna"], notificationType: "newVideo" }) } })
    const { result } = renderHook(() => useTopicNotificationPreferences())
    expect(getEffectiveShortCreatorIds().size).toBe(2)

    await act(async () => {
      expect(await result.current.removeTopic("short")).toBe(true)
    })

    const [enabled, newVideoIds, shortIds] = vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls[0]
    expect(enabled).toBe(true)
    expect(newVideoIds.size).toBe(0)
    expect(shortIds.size).toBe(0)
    expect(result.current.savedTopicIds).not.toContain("short")
    expect(getEffectiveShortCreatorIds().size).toBe(0)
    expect(stored().topicOrder).not.toContain("short")
    expect(stored().topics.short).toBeUndefined()

    resetAllSharedStateForTests() // reload
    expect(getEffectiveShortCreatorIds().size).toBe(0)
    expect(renderHook(() => useTopicNotificationPreferences()).result.current.savedTopicIds).not.toContain("short")
  })

  it("re-adding Short after removal starts clean: no members, Short still OFF", async () => {
    seed({ topicOrder: [...DEFAULTS, "short"], topics: { short: card({ newVideo: ["aizawa_ema"], notificationType: "newVideo" }) } })
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.removeTopic("short")
    })

    act(() => result.current.addTopic("short"))

    expect(result.current.savedTopicIds).toContain("short")
    expect(result.current.isNewVideoEnabled("short", "aizawa_ema")).toBe(false)
    expect(getEffectiveShortCreatorIds().size).toBe(0)
  })

  it("removing an added topic deletes its creator reminders on the backend and stops its members enabling new videos", async () => {
    seed({
      topicOrder: [...DEFAULTS, "singing"],
      topics: { singing: card({ live: ["aizawa_ema"], newVideo: ["kaga_nazuna"], reminderOverrides: { aizawa_ema: "10min" } }) },
    })
    const { result } = renderHook(() => useTopicNotificationPreferences())
    expect(getEffectiveNewVideoCreatorIds().has("kaga_nazuna")).toBe(true)

    await act(async () => {
      await result.current.removeTopic("singing")
    })

    expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "singing")
    expect(getEffectiveNewVideoCreatorIds().has("kaga_nazuna")).toBe(false)
    expect(vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls[0][1].size).toBe(0)
    expect(result.current.savedTopicIds).not.toContain("singing")
  })

  it("a rejected backend write keeps the card and its members (nothing local changes)", async () => {
    seed({ topicOrder: [...DEFAULTS, "short"], topics: { short: card({ newVideo: ["aizawa_ema"], notificationType: "newVideo" }) } })
    vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockRejectedValueOnce(new Error("HTTP 403"))
    const { result } = renderHook(() => useTopicNotificationPreferences())

    await act(async () => {
      expect(await result.current.removeTopic("short")).toBe(false)
    })

    expect(result.current.savedTopicIds).toContain("short")
    expect([...getEffectiveShortCreatorIds()]).toEqual(["aizawa_ema"])
  })
})
