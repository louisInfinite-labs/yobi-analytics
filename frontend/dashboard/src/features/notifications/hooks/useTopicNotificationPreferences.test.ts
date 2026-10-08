import { renderHook, act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useTopicNotificationPreferences } from "./useTopicNotificationPreferences"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import * as liveReminderApi from "../api/liveReminderApi"

vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"

beforeEach(() => {
  vi.mocked(liveReminderApi.saveCreatorReminder).mockClear()
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockClear()
})

function seedStorage(value: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  resetAllSharedStateForTests()
}

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")
}

// Each mutation gets its OWN act() call (never batched together) — same
// convention as useFavoriteCreators.test.ts. The hook's setters close over
// the render's own `state` snapshot (see useTopicNotificationPreferences.ts),
// so batching two of them inside one act() would have the second call
// overwrite the first's change rather than build on it; that's not how the
// real UI ever calls them (one Switch/Select onChange per event, each its
// own render cycle), so tests must not do it either.
describe("useTopicNotificationPreferences", () => {
  it("filters unknown and duplicate saved topic IDs while restoring required defaults", () => {
    seedStorage({
      topicOrder: ["gta", "unknown-topic", "gta", "all"],
      topics: {
        gta: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: {} },
        "unknown-topic": { live: [], newVideo: [], reminderOverrides: {} },
      },
    })

    const { result } = renderHook(() => useTopicNotificationPreferences())
    expect(result.current.savedTopicIds).toEqual(["all", "sf6", "valorant", "apex", "minecraft", "gta"])
    expect(result.current.isLiveEnabled("gta", "aizawa_ema")).toBe(true)
  })

  describe("valo -> valorant migration", () => {
    it("moves a saved VALO card's settings to the canonical valorant id without dropping any of them", () => {
      seedStorage({
        topicOrder: ["all", "sf6", "valo", "apex", "minecraft", "gta"],
        topics: {
          valo: {
            reminderMode: "30min",
            live: ["aizawa_ema", "kaga_sumire"],
            newVideo: ["kaga_sumire"],
            reminderOverrides: { aizawa_ema: "1hour" },
            notificationType: "live",
          },
        },
      })

      const { result } = renderHook(() => useTopicNotificationPreferences())

      expect(result.current.savedTopicIds).toEqual(["all", "sf6", "valorant", "apex", "minecraft", "gta"])
      expect(result.current.isLiveEnabled("valorant", "aizawa_ema")).toBe(true)
      expect(result.current.isLiveEnabled("valorant", "kaga_sumire")).toBe(true)
      expect(result.current.isNewVideoEnabled("valorant", "kaga_sumire")).toBe(true)
      expect(result.current.getMemberReminder("valorant", "aizawa_ema")).toBe("1hour")
      expect(result.current.getNotificationType("valorant")).toBe("live")
      // Nothing is left behind under the old id.
      expect(result.current.isLiveEnabled("valo", "aizawa_ema")).toBe(false)
    })

    it("migrates a VALO card that was added via + (not a permanent default) in the stored order too", () => {
      seedStorage({ topicOrder: ["valo"], topics: { valo: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: {}, notificationType: "both" } } })

      const { result } = renderHook(() => useTopicNotificationPreferences())

      expect(result.current.savedTopicIds.filter((id) => id === "valorant")).toHaveLength(1)
      expect(result.current.isLiveEnabled("valorant", "aizawa_ema")).toBe(true)
    })

    it("merges both entries without losing anything when an old and a canonical entry both exist", () => {
      seedStorage({
        topicOrder: ["all", "sf6", "valo", "valorant", "apex", "minecraft"],
        topics: {
          valo: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: { aizawa_ema: "10min", kaga_sumire: "30min" }, notificationType: "both" },
          valorant: { live: ["kaga_sumire"], newVideo: ["aizawa_ema"], reminderOverrides: { kaga_sumire: "1hour" }, notificationType: "live" },
        },
      })

      const { result } = renderHook(() => useTopicNotificationPreferences())

      expect(result.current.savedTopicIds).toEqual(["all", "sf6", "valorant", "apex", "minecraft"])
      expect(result.current.isLiveEnabled("valorant", "aizawa_ema")).toBe(true)
      expect(result.current.isLiveEnabled("valorant", "kaga_sumire")).toBe(true)
      expect(result.current.isNewVideoEnabled("valorant", "aizawa_ema")).toBe(true)
      expect(result.current.getMemberReminder("valorant", "aizawa_ema")).toBe("10min")
      // Both set kaga_sumire's reminder: the entry already under the canonical id wins.
      expect(result.current.getMemberReminder("valorant", "kaga_sumire")).toBe("1hour")
      expect(result.current.getNotificationType("valorant")).toBe("live")
    })

    it("writes the migrated state back under the canonical id the next time it is saved", () => {
      seedStorage({ topicOrder: ["all", "sf6", "valo"], topics: { valo: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: {} } } })

      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setNewVideoEnabled("valorant", "kaga_sumire", true))

      const stored = storedState()
      expect(Object.keys(stored.topics)).toContain("valorant")
      expect(Object.keys(stored.topics)).not.toContain("valo")
      expect(stored.topics.valorant.live).toEqual(["aizawa_ema"])
      expect(stored.topicOrder).not.toContain("valo")
    })

    it("ignores a removed legacy topic-level reminderMode instead of treating it as anyone's reminder", () => {
      seedStorage({
        topicOrder: ["all", "sf6", "valorant", "apex", "minecraft"],
        topics: { valorant: { reminderMode: "30min", live: ["aizawa_ema"], newVideo: [], reminderOverrides: {} } },
      })

      const { result } = renderHook(() => useTopicNotificationPreferences())

      expect(result.current.getMemberReminder("valorant", "aizawa_ema")).toBeNull()
    })

    it("drops a stored reminder value that is not a real reminder option", () => {
      seedStorage({
        topicOrder: ["all", "sf6", "valorant", "apex", "minecraft"],
        topics: { valorant: { live: ["aizawa_ema"], newVideo: [], reminderOverrides: { aizawa_ema: "2hours", kaga_sumire: "30min" } } },
      })

      const { result } = renderHook(() => useTopicNotificationPreferences())

      expect(result.current.getMemberReminder("valorant", "aizawa_ema")).toBeNull()
      expect(result.current.getMemberReminder("valorant", "kaga_sumire")).toBe("30min")
    })
  })

  it("starts with nobody enabled and every reminder unset", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    expect(result.current.isLiveEnabled("valorant", "aizawa_ema")).toBe(false)
    expect(result.current.isNewVideoEnabled("valorant", "aizawa_ema")).toBe(false)
    expect(result.current.getEnabledCreatorIds("valorant").size).toBe(0)
    expect(result.current.getMemberReminder("valorant", "aizawa_ema")).toBeNull()
    expect(result.current.getMemberReminder("all", "aizawa_ema")).toBeNull()
  })

  it("keeps Live and New Video enablement fully independent per creator per topic", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valorant", "aizawa_ema", true))
    expect(result.current.isLiveEnabled("valorant", "aizawa_ema")).toBe(true)
    expect(result.current.isNewVideoEnabled("valorant", "aizawa_ema")).toBe(false)

    act(() => result.current.setNewVideoEnabled("valorant", "kaga_sumire", true))
    expect(result.current.isNewVideoEnabled("valorant", "kaga_sumire")).toBe(true)
    expect(result.current.isLiveEnabled("valorant", "kaga_sumire")).toBe(false)
  })

  it("scopes enablement to one topic only — enabling a creator for one topic doesn't enable them for another", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valorant", "aizawa_ema", true))
    expect(result.current.isLiveEnabled("apex", "aizawa_ema")).toBe(false)
  })

  it("getEnabledCreatorIds returns the union of Live- and New-Video-enabled creators, with no duplicates", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valorant", "aizawa_ema", true))
    act(() => result.current.setNewVideoEnabled("valorant", "aizawa_ema", true))
    act(() => result.current.setNewVideoEnabled("valorant", "kaga_sumire", true))
    expect([...result.current.getEnabledCreatorIds("valorant")].sort()).toEqual(["aizawa_ema", "kaga_sumire"])
  })

  describe("reminders: unset, per-item sync, shadowing", () => {
    it("setting a creator + topic reminder writes exactly that one (creator, topic) item to the backend", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "10min"))

      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("10min")
      expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledTimes(1)
      expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6", { notifyAtStart: true, advanceReminder: "10min" })
      expect(liveReminderApi.deleteCreatorReminder).not.toHaveBeenCalled()
    })

    it("setting the 全部 reminder writes the creator-level scope `all`, not a topic", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setMemberReminder("all", "aizawa_ema", "30min"))

      expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "all", { notifyAtStart: true, advanceReminder: "30min" })
    })

    it("at_start is a real choice stored as such, distinct from unset", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "at_start"))

      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("at_start")
      expect(liveReminderApi.saveCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6", { notifyAtStart: true, advanceReminder: null })
    })

    it("unsetting a reminder removes only that entry and deletes only that one backend item", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "10min"))
      act(() => result.current.setMemberReminder("sf6", "kaga_sumire", "1hour"))
      act(() => result.current.setMemberReminder("apex", "aizawa_ema", "30min"))

      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", null))

      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBeNull()
      expect(result.current.getMemberReminder("sf6", "kaga_sumire")).toBe("1hour")
      expect(result.current.getMemberReminder("apex", "aizawa_ema")).toBe("30min")
      expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledTimes(1)
      expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6")
    })

    it("setting 全部 never changes or erases the same creator's topic reminders -- they are only shadowed", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "10min"))
      act(() => result.current.setMemberReminder("singing", "aizawa_ema", "1hour"))
      expect(result.current.isReminderShadowedByAll("sf6", "aizawa_ema")).toBe(false)

      act(() => result.current.setMemberReminder("all", "aizawa_ema", "30min"))

      // Still stored, untouched...
      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("10min")
      expect(result.current.getMemberReminder("singing", "aizawa_ema")).toBe("1hour")
      // ...but reported as not in effect while 全部 is set.
      expect(result.current.isReminderShadowedByAll("sf6", "aizawa_ema")).toBe(true)
      expect(result.current.isReminderShadowedByAll("singing", "aizawa_ema")).toBe(true)
      // 全部 itself, and other creators, are not shadowed.
      expect(result.current.isReminderShadowedByAll("all", "aizawa_ema")).toBe(false)
      expect(result.current.isReminderShadowedByAll("sf6", "kaga_sumire")).toBe(false)
      // And the backend was only ever told about the three single items.
      expect(liveReminderApi.deleteCreatorReminder).not.toHaveBeenCalled()
      expect(vi.mocked(liveReminderApi.saveCreatorReminder).mock.calls.map(([, scope]) => scope)).toEqual(["sf6", "singing", "all"])
    })

    it("unsetting 全部 makes the topic reminders take effect again, exactly as they were", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "10min"))
      act(() => result.current.setMemberReminder("singing", "aizawa_ema", "1hour"))
      act(() => result.current.setMemberReminder("all", "aizawa_ema", "30min"))

      act(() => result.current.setMemberReminder("all", "aizawa_ema", null))

      expect(result.current.getMemberReminder("all", "aizawa_ema")).toBeNull()
      expect(result.current.isReminderShadowedByAll("sf6", "aizawa_ema")).toBe(false)
      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("10min")
      expect(result.current.getMemberReminder("singing", "aizawa_ema")).toBe("1hour")
      expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledTimes(1)
      expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "all")
    })

    it("a failed backend write is swallowed and the local choice is kept", async () => {
      vi.mocked(liveReminderApi.saveCreatorReminder).mockRejectedValueOnce(new Error("offline"))
      const { result } = renderHook(() => useTopicNotificationPreferences())

      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "10min"))
      await Promise.resolve()

      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("10min")
    })
  })

  describe("turning Live off", () => {
    it("deletes only that one creator + topic reminder, locally and on the backend", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", true))
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "1hour"))
      act(() => result.current.setLiveEnabled("sf6", "kaga_sumire", true))
      act(() => result.current.setMemberReminder("sf6", "kaga_sumire", "10min"))
      act(() => result.current.setLiveEnabled("apex", "aizawa_ema", true))
      act(() => result.current.setMemberReminder("apex", "aizawa_ema", "30min"))
      act(() => result.current.setLiveEnabled("all", "aizawa_ema", true))
      act(() => result.current.setMemberReminder("all", "aizawa_ema", "at_start"))
      vi.mocked(liveReminderApi.deleteCreatorReminder).mockClear()

      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", false))

      expect(result.current.isLiveEnabled("sf6", "aizawa_ema")).toBe(false)
      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBeNull()
      // Nothing else was touched: another creator, another topic, and the creator's 全部.
      expect(result.current.getMemberReminder("sf6", "kaga_sumire")).toBe("10min")
      expect(result.current.getMemberReminder("apex", "aizawa_ema")).toBe("30min")
      expect(result.current.getMemberReminder("all", "aizawa_ema")).toBe("at_start")
      expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledTimes(1)
      expect(liveReminderApi.deleteCreatorReminder).toHaveBeenCalledWith("aizawa_ema", "sf6")
    })

    it("makes no backend call when that creator + topic had no reminder", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", true))

      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", false))

      expect(liveReminderApi.deleteCreatorReminder).not.toHaveBeenCalled()
    })

    it("turning Live back ON does not bring a dropped reminder back, and writes nothing", () => {
      const { result } = renderHook(() => useTopicNotificationPreferences())
      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", true))
      act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "1hour"))
      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", false))
      vi.mocked(liveReminderApi.saveCreatorReminder).mockClear()

      act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", true))

      expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBeNull()
      expect(liveReminderApi.saveCreatorReminder).not.toHaveBeenCalled()
    })
  })

  it("excludes a channel the topic's own notificationType no longer allows from getEnabledCreatorIds, without deleting the stored membership", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valorant", "aizawa_ema", true))
    act(() => result.current.setNewVideoEnabled("valorant", "kaga_sumire", true))
    expect([...result.current.getEnabledCreatorIds("valorant")].sort()).toEqual(["aizawa_ema", "kaga_sumire"])

    act(() => result.current.setNotificationType("valorant", "newVideo"))
    // Her stored Live membership is still there (isLiveEnabled unchanged)...
    expect(result.current.isLiveEnabled("valorant", "aizawa_ema")).toBe(true)
    // ...but she does not count as effectively enabled while Live is excluded.
    expect([...result.current.getEnabledCreatorIds("valorant")]).toEqual(["kaga_sumire"])

    // Switching back to "both" restores her without ever having touched her stored value.
    act(() => result.current.setNotificationType("valorant", "both"))
    expect([...result.current.getEnabledCreatorIds("valorant")].sort()).toEqual(["aizawa_ema", "kaga_sumire"])
  })

  it("reports 0 reminder overrides while the topic's notificationType excludes Live, without clearing the stored override", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valorant", "aizawa_ema", true))
    act(() => result.current.setMemberReminder("valorant", "aizawa_ema", "1hour"))
    expect(result.current.getOverrideCount("valorant")).toBe(1)

    act(() => result.current.setNotificationType("valorant", "newVideo"))
    expect(result.current.getOverrideCount("valorant")).toBe(0)
    // Still stored underneath -- not destructively cleared.
    expect(result.current.getMemberReminder("valorant", "aizawa_ema")).toBe("1hour")

    act(() => result.current.setNotificationType("valorant", "live"))
    expect(result.current.getOverrideCount("valorant")).toBe(1)
  })

  it("Reset restores only the notification type -- members and their reminders stay", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("sf6", "aizawa_ema", true))
    act(() => result.current.setMemberReminder("sf6", "aizawa_ema", "1hour"))
    act(() => result.current.setNotificationType("sf6", "live"))

    act(() => result.current.resetTopicDefaults("sf6"))

    expect(result.current.getNotificationType("sf6")).toBe("both")
    expect(result.current.isLiveEnabled("sf6", "aizawa_ema")).toBe(true)
    expect(result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("1hour")
  })

  it("persists across hook instances (localStorage-backed shared state)", () => {
    const first = renderHook(() => useTopicNotificationPreferences())
    act(() => first.result.current.setLiveEnabled("sf6", "aizawa_ema", true))
    act(() => first.result.current.setMemberReminder("sf6", "aizawa_ema", "1hour"))

    const second = renderHook(() => useTopicNotificationPreferences())
    expect(second.result.current.isLiveEnabled("sf6", "aizawa_ema")).toBe(true)
    expect(second.result.current.getMemberReminder("sf6", "aizawa_ema")).toBe("1hour")
  })
})
