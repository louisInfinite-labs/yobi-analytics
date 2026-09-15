import { renderHook, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useTopicNotificationPreferences } from "./useTopicNotificationPreferences"

// Each mutation gets its OWN act() call (never batched together) — same
// convention as useFavoriteCreators.test.ts. The hook's setters close over
// the render's own `state` snapshot (see useTopicNotificationPreferences.ts),
// so batching two of them inside one act() would have the second call
// overwrite the first's change rather than build on it; that's not how the
// real UI ever calls them (one Switch/Select onChange per event, each its
// own render cycle), so tests must not do it either.
describe("useTopicNotificationPreferences", () => {
  it("starts with every topic's reminder mode set to the spec's own worked-example value (10 分鐘前) and nobody enabled", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    expect(result.current.getReminderMode("valo")).toBe("10min")
    expect(result.current.isLiveEnabled("valo", "aizawa_ema")).toBe(false)
    expect(result.current.isNewVideoEnabled("valo", "aizawa_ema")).toBe(false)
    expect(result.current.getEnabledCreatorIds("valo").size).toBe(0)
  })

  it("changing one topic's reminder mode leaves every other topic's own mode untouched", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setReminderMode("valo", "1hour"))
    expect(result.current.getReminderMode("valo")).toBe("1hour")
    expect(result.current.getReminderMode("apex")).toBe("10min")
  })

  it("keeps Live and New Video enablement fully independent per creator per topic", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    expect(result.current.isLiveEnabled("valo", "aizawa_ema")).toBe(true)
    expect(result.current.isNewVideoEnabled("valo", "aizawa_ema")).toBe(false)

    act(() => result.current.setNewVideoEnabled("valo", "kaga_sumire", true))
    expect(result.current.isNewVideoEnabled("valo", "kaga_sumire")).toBe(true)
    expect(result.current.isLiveEnabled("valo", "kaga_sumire")).toBe(false)
  })

  it("scopes enablement to one topic only — enabling a creator for one topic doesn't enable them for another", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    expect(result.current.isLiveEnabled("apex", "aizawa_ema")).toBe(false)
  })

  it("getEnabledCreatorIds returns the union of Live- and New-Video-enabled creators, with no duplicates", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    act(() => result.current.setNewVideoEnabled("valo", "aizawa_ema", true))
    act(() => result.current.setNewVideoEnabled("valo", "kaga_sumire", true))
    expect([...result.current.getEnabledCreatorIds("valo")].sort()).toEqual(["aizawa_ema", "kaga_sumire"])
  })

  it("a concrete topic reminder mode forces that time onto every member, ignoring their own stored reminder entirely", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setReminderMode("valo", "30min"))
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    act(() => result.current.setMemberReminder("valo", "aizawa_ema", "at_start"))
    // Her own choice is stored...
    expect(result.current.getMemberReminder("valo", "aizawa_ema")).toBe("at_start")
    // ...but the topic's own concrete mode wins over it.
    expect(result.current.getEffectiveReminder("valo", "aizawa_ema")).toBe("30min")
    expect(result.current.isMemberChoiceMode("valo")).toBe(false)
  })

  it("switching the topic to member_choice mode makes that same stored member reminder take effect, unchanged", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setReminderMode("valo", "30min"))
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    act(() => result.current.setMemberReminder("valo", "aizawa_ema", "at_start"))
    act(() => result.current.setReminderMode("valo", "member_choice"))
    expect(result.current.isMemberChoiceMode("valo")).toBe(true)
    // Never touched in between — same value the member chose earlier.
    expect(result.current.getMemberReminder("valo", "aizawa_ema")).toBe("at_start")
    expect(result.current.getEffectiveReminder("valo", "aizawa_ema")).toBe("at_start")
  })

  it("a member who never touched their own reminder falls back to the initial value once mode is member_choice", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setReminderMode("valo", "member_choice"))
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    expect(result.current.getMemberReminder("valo", "aizawa_ema")).toBe("10min")
    expect(result.current.getEffectiveReminder("valo", "aizawa_ema")).toBe("10min")
  })

  it("turning Live off drops that creator's own stored reminder, not just their Live enablement", () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", true))
    act(() => result.current.setMemberReminder("valo", "aizawa_ema", "1hour"))
    expect(result.current.isLiveEnabled("valo", "aizawa_ema")).toBe(true)
    expect(result.current.getMemberReminder("valo", "aizawa_ema")).toBe("1hour")

    act(() => result.current.setLiveEnabled("valo", "aizawa_ema", false))
    expect(result.current.isLiveEnabled("valo", "aizawa_ema")).toBe(false)
    // Back to the initial fallback — her "1hour" pick was dropped, not kept dormant.
    expect(result.current.getMemberReminder("valo", "aizawa_ema")).toBe("10min")
  })

  it("persists across hook instances (localStorage-backed shared state)", () => {
    const first = renderHook(() => useTopicNotificationPreferences())
    act(() => first.result.current.setReminderMode("sf6", "member_choice"))
    act(() => first.result.current.setLiveEnabled("sf6", "aizawa_ema", true))
    act(() => first.result.current.setMemberReminder("sf6", "aizawa_ema", "1hour"))

    const second = renderHook(() => useTopicNotificationPreferences())
    expect(second.result.current.getReminderMode("sf6")).toBe("member_choice")
    expect(second.result.current.isLiveEnabled("sf6", "aizawa_ema")).toBe(true)
    expect(second.result.current.getEffectiveReminder("sf6", "aizawa_ema")).toBe("1hour")
  })
})
