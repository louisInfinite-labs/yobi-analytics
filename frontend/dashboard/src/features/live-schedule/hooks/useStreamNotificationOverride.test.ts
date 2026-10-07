import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useStreamNotificationOverride } from "./useStreamNotificationOverride"
import * as liveReminderApi from "../../notifications/api/liveReminderApi"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { INITIAL_MEMBER_REMINDER } from "../../notifications/model/notificationTopics"
import type { ScheduledStream } from "../model/scheduledStream"

vi.mock("../../notifications/api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notifications/api/liveReminderApi")>()),
  fetchCreatorLiveReminders: vi.fn(),
  fetchStreamNotificationOverrides: vi.fn(),
  saveStreamNotificationOverride: vi.fn(),
}))

const creator = getCreatorById("aizawa_ema")!
const stream: ScheduledStream = {
  id: "s1",
  channelId: toLegacyRosterId(creator),
  videoId: "v1",
  title: "Ranked grind",
  description: "",
  status: "upcoming",
  scheduledStartMs: 1_000_000,
  topics: [],
}
const otherStream: ScheduledStream = { ...stream, id: "s2", videoId: "v2" }

beforeEach(() => {
  vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({})
  vi.mocked(liveReminderApi.fetchStreamNotificationOverrides).mockResolvedValue({})
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockResolvedValue(undefined)
})

describe("useStreamNotificationOverride", () => {
  it("has no override for a stream that was never saved", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchStreamNotificationOverrides).toHaveBeenCalled())
    expect(result.current.getOverride("v1")).toBeNull()
  })

  it("falls back to the system default when neither an override nor a creator recurring setting exists", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe(INITIAL_MEMBER_REMINDER))
  })

  it("uses the creator's real backend recurring setting when no stream override exists", async () => {
    vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({
      aizawa_ema: { notifyAtStart: true, advanceReminder: "30min" },
    })
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("30min"))
  })

  it("a stream override replaces (never combines with) the creator's recurring setting", async () => {
    vi.mocked(liveReminderApi.fetchCreatorLiveReminders).mockResolvedValue({
      aizawa_ema: { notifyAtStart: true, advanceReminder: "30min" },
    })
    vi.mocked(liveReminderApi.fetchStreamNotificationOverrides).mockResolvedValue({
      v1: { creatorId: "aizawa_ema", notifyAtStart: true, advanceReminder: "1hour" },
    })
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("1hour"))
    // Not "1hour and 30min and start" -- getOverride/getCreatorRecurring each
    // report their own independent, unmerged value.
    expect(result.current.getCreatorRecurring("aizawa_ema")?.advanceReminder).toBe("30min")
  })

  it("saveOverride persists through the real backend API, not localStorage, and carries no scheduledStartMs of its own", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchStreamNotificationOverrides).toHaveBeenCalled())

    await result.current.saveOverride(stream, "1hour")

    expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", {
      creatorId: "aizawa_ema",
      notifyAtStart: true,
      advanceReminder: "1hour",
    })
    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("1hour"))
  })

  it("keeps a saved override isolated to its own videoId -- another stream is unaffected", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchStreamNotificationOverrides).toHaveBeenCalled())

    await result.current.saveOverride(stream, "1hour")

    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("1hour"))
    expect(result.current.getEffectiveReminderValue(otherStream)).toBe(INITIAL_MEMBER_REMINDER)
  })
})
