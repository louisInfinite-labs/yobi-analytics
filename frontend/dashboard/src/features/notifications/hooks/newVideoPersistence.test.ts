import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { effectiveNewVideoCreatorIds, getEffectiveNewVideoCreatorIds, useTopicNotificationPreferences } from "./useTopicNotificationPreferences"
import { buildNotificationPreference } from "../api/notificationPreferenceApi"
import { getAllNotificationCreators } from "../model/notificationCreatorGrouping"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import * as liveReminderApi from "../api/liveReminderApi"
import * as notificationPreferenceApi from "../api/notificationPreferenceApi"
import * as pushNotifications from "../push/pushNotifications"

// What a client SAVES as its New Video eligibility, traced through the real persistence path: the topic card state (type + member lists) ->
// effectiveNewVideoCreatorIds -> buildNotificationPreference -> the PUT body. Nothing here contacts any API: every network-facing module is mocked.

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

type State = Parameters<typeof effectiveNewVideoCreatorIds>[0]

const SELECTED = ["kaga_nazuna", "kaga_sumire", "kosuzume_toto"] // 花芽なずな / 花芽すみれ / 小雀とと
// Creators the Settings roster deliberately does not list (group channels, staff, graduated): the ones the Android client was wrongly pushed.
const NON_ROSTER = ["unit_b_pre_debut", "achrora", "fuwamoco", "hololive_official"]

function topic(overrides: Partial<State["topics"][string]> = {}) {
  return { live: [] as string[], newVideo: [] as string[], reminderOverrides: {}, notificationType: "both" as const, ...overrides }
}

const enabledNewVideoIds = (body: ReturnType<typeof buildNotificationPreference>) =>
  Object.entries(body.newVideoCreatorOverride)
    .filter(([, on]) => on)
    .map(([id]) => id)
    .sort()

/** The New Video creators in the LAST preference write the hook sent to the (mocked) backend, sorted. */
function lastSentNewVideoIds(): string[] {
  const call = vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls.at(-1)
  expect(call).toBeDefined()
  return [...(call![1] as Set<string>)].sort()
}

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  vi.mocked(liveReminderApi.saveCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(liveReminderApi.deleteCreatorReminder).mockReset().mockResolvedValue(undefined)
  vi.mocked(notificationPreferenceApi.saveNotificationPreference).mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

describe("the New Video map a client sends", () => {
  it("serializes the three selected members as exactly those three New Video creators ON, and every other current member OFF", () => {
    const roster = getAllNotificationCreators()
    const state = { topicOrder: ["all"], topics: { all: topic({ newVideo: SELECTED }) } } as unknown as State

    const body = buildNotificationPreference(true, effectiveNewVideoCreatorIds(state), new Set())

    expect(enabledNewVideoIds(body)).toEqual([...SELECTED].sort())
    expect(Object.values(body.newVideoCreatorOverride).filter((on) => !on)).toHaveLength(roster.length - SELECTED.length)
    for (const id of SELECTED) expect(roster.some((creator) => creator.creatorId === id)).toBe(true) // they are real roster members
  })

  it("never needs the non-roster creators in the UI roster or in the map: they are simply absent (the backend reads absent as OFF)", () => {
    const roster = getAllNotificationCreators().map((creator) => creator.creatorId)
    const body = buildNotificationPreference(true, new Set(SELECTED), new Set())

    for (const id of NON_ROSTER) {
      expect(roster).not.toContain(id)
      expect(Object.keys(body.newVideoCreatorOverride)).not.toContain(id)
      expect(Object.keys(body.newVideoShortCreatorOverride)).not.toContain(id)
    }
    expect(Object.keys(body.newVideoCreatorOverride).sort()).toEqual([...roster].sort())
  })
})

describe("a topic's notification type decides which member lists feed New Video eligibility", () => {
  const live = ["aizawa_ema", "kaga_sumire"]
  const newVideo = SELECTED
  const stateOf = (notificationType: "live" | "newVideo" | "both") =>
    ({ topicOrder: ["all"], topics: { all: topic({ live, newVideo, notificationType }) } }) as unknown as State

  it("直播+新片 (both): the New Video members are eligible, and the Live-only members are not made eligible by being selected for Live", () => {
    expect([...effectiveNewVideoCreatorIds(stateOf("both"))].sort()).toEqual([...newVideo].sort())
  })

  it("新片 (newVideo) only: the same New Video members are eligible", () => {
    expect([...effectiveNewVideoCreatorIds(stateOf("newVideo"))].sort()).toEqual([...newVideo].sort())
  })

  it("直播 (live) only: nobody is eligible for New Video, though the members stay stored", () => {
    expect([...effectiveNewVideoCreatorIds(stateOf("live"))]).toEqual([])
  })

  it("the Short card never makes its members eligible for ordinary New Video", () => {
    const state = { topicOrder: ["all", "short"], topics: { short: topic({ newVideo: ["aizawa_ema"], notificationType: "newVideo" }) } } as unknown as State
    expect([...effectiveNewVideoCreatorIds(state)]).toEqual([])
  })
})

describe("save -> reload keeps the same selection", () => {
  it("three members switched on for New Video are what is sent, and what survives a reload", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    expect(result.current.getNotificationType("all")).toBe("both") // 直播+新片 is the starting type of every card

    for (const id of SELECTED) {
      await act(async () => {
        expect(await result.current.setNewVideoEnabled("all", id, true)).toBe(true)
      })
    }

    expect(lastSentNewVideoIds()).toEqual([...SELECTED].sort())

    resetAllSharedStateForTests() // a page reload: only localStorage survives
    const reloaded = renderHook(() => useTopicNotificationPreferences())
    expect([...getEffectiveNewVideoCreatorIds()].sort()).toEqual([...SELECTED].sort())
    for (const id of SELECTED) expect(reloaded.result.current.isNewVideoEnabled("all", id)).toBe(true)
    expect(enabledNewVideoIds(buildNotificationPreference(true, getEffectiveNewVideoCreatorIds(), new Set()))).toEqual([...SELECTED].sort())
  })

  it("a Live switch is independent: turning Live on for another member changes nothing that is sent for New Video", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    await act(async () => {
      await result.current.setNewVideoEnabled("all", "kosuzume_toto", true)
    })
    const callsBefore = vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls.length

    await act(async () => {
      await result.current.setLiveEnabled("all", "kaga_nazuna", true)
    })

    expect(vi.mocked(notificationPreferenceApi.saveNotificationPreference).mock.calls.length).toBe(callsBefore) // no New Video write at all
    expect([...getEffectiveNewVideoCreatorIds()]).toEqual(["kosuzume_toto"])
  })

  it("switching the card to 直播 turns New Video off on the backend, and back to 直播+新片 restores the same members", async () => {
    const { result } = renderHook(() => useTopicNotificationPreferences())
    for (const id of SELECTED) {
      await act(async () => {
        await result.current.setNewVideoEnabled("all", id, true)
      })
    }

    await act(async () => {
      await result.current.setNotificationType("all", "live")
    })
    expect(lastSentNewVideoIds()).toEqual([])

    await act(async () => {
      await result.current.setNotificationType("all", "both")
    })
    expect(lastSentNewVideoIds()).toEqual([...SELECTED].sort())
  })
})
