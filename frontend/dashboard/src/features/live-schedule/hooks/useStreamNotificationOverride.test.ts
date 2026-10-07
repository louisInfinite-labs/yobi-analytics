import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useStreamNotificationOverride } from "./useStreamNotificationOverride"
import * as liveReminderApi from "../../notifications/api/liveReminderApi"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import type { ScheduledStream } from "../model/scheduledStream"

vi.mock("../../notifications/api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../notifications/api/liveReminderApi")>()),
  fetchReminderSettings: vi.fn(),
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
const sf6Stream: ScheduledStream = { ...stream, id: "s2", videoId: "v2", topics: ["sf6"] }
const singingStream: ScheduledStream = { ...stream, id: "s3", videoId: "v3", topics: ["singing"] }

const setting = (advanceReminder: "1min" | "10min" | "30min" | "1hour" | null) => ({ notifyAtStart: true, advanceReminder })

function mockSettings(overrides: Partial<liveReminderApi.ReminderSettingsSnapshot> = {}) {
  vi.mocked(liveReminderApi.fetchReminderSettings).mockResolvedValue({ ...liveReminderApi.emptyReminderSettings(), ...overrides })
}

beforeEach(() => {
  // Call counts persist across tests unless cleared (the mocks are module-level).
  vi.mocked(liveReminderApi.fetchReminderSettings).mockClear()
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockClear()
  mockSettings()
  vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockResolvedValue(undefined)
})

describe("useStreamNotificationOverride", () => {
  it("has no override for a stream that was never saved", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalled())
    expect(result.current.getOverride("v1")).toBeNull()
  })

  describe("effective reminder: stream override > 全部 > creator + topic > unset", () => {
    it("is unset (null) -- never a default time -- when nothing is stored", async () => {
      const { result } = renderHook(() => useStreamNotificationOverride())
      await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalled())

      expect(result.current.getEffectiveReminderValue(stream)).toBeNull()
      expect(result.current.getEffectiveReminderValue(sf6Stream)).toBeNull()
    })

    it("uses the creator + matched topic reminder when 全部 is unset", async () => {
      mockSettings({ creatorTopics: { aizawa_ema: { sf6: setting("10min"), singing: setting("1hour") } } })
      const { result } = renderHook(() => useStreamNotificationOverride())

      await waitFor(() => expect(result.current.getEffectiveReminderValue(sf6Stream)).toBe("10min"))
      expect(result.current.getEffectiveReminderValue(singingStream)).toBe("1hour")
      // A stream whose topic has no setting (or no topic at all) gets nothing.
      expect(result.current.getEffectiveReminderValue(stream)).toBeNull()
    })

    it("creator 全部 shadows every topic reminder, including streams with no matched topic", async () => {
      mockSettings({
        creatorAll: { aizawa_ema: setting("30min") },
        creatorTopics: { aizawa_ema: { sf6: setting("10min"), singing: setting("1hour") } },
      })
      const { result } = renderHook(() => useStreamNotificationOverride())

      await waitFor(() => expect(result.current.getEffectiveReminderValue(sf6Stream)).toBe("30min"))
      expect(result.current.getEffectiveReminderValue(singingStream)).toBe("30min")
      expect(result.current.getEffectiveReminderValue(stream)).toBe("30min")
    })

    it("a stream override beats 全部 for that stream only; the next stream still gets 全部", async () => {
      mockSettings({
        creatorAll: { aizawa_ema: setting("30min") },
        creatorTopics: { aizawa_ema: { sf6: setting("10min") } },
        streamOverrides: { v2: { creatorId: "aizawa_ema", ...setting("1hour") } },
      })
      const { result } = renderHook(() => useStreamNotificationOverride())

      await waitFor(() => expect(result.current.getEffectiveReminderValue(sf6Stream)).toBe("1hour"))
      expect(result.current.getEffectiveReminderValue({ ...sf6Stream, videoId: "v_next" })).toBe("30min")
    })

    it("a stream override reports at_start as its own value (not unset)", async () => {
      mockSettings({ streamOverrides: { v1: { creatorId: "aizawa_ema", ...setting(null) } } })
      const { result } = renderHook(() => useStreamNotificationOverride())

      await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("at_start"))
    })

    it("ignores another creator's settings", async () => {
      mockSettings({ creatorAll: { someone_else: setting("30min") }, creatorTopics: { someone_else: { sf6: setting("10min") } } })
      const { result } = renderHook(() => useStreamNotificationOverride())
      await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalled())

      expect(result.current.getEffectiveReminderValue(sf6Stream)).toBeNull()
    })
  })

  it("saveOverride persists through the real backend API, not localStorage, and carries no scheduledStartMs of its own", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalled())

    await result.current.saveOverride(stream, "1hour")

    expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledWith("v1", {
      creatorId: "aizawa_ema",
      notifyAtStart: true,
      advanceReminder: "1hour",
    })
    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("1hour"))
  })

  it("saving a stream override never changes the creator's 全部 or topic reminders", async () => {
    mockSettings({ creatorAll: { aizawa_ema: setting("30min") }, creatorTopics: { aizawa_ema: { sf6: setting("10min") } } })
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(result.current.getEffectiveReminderValue(sf6Stream)).toBe("30min"))

    await result.current.saveOverride(sf6Stream, "1hour")

    await waitFor(() => expect(result.current.getEffectiveReminderValue(sf6Stream)).toBe("1hour"))
    // Another stream of the same creator is unaffected: still 全部.
    expect(result.current.getEffectiveReminderValue({ ...sf6Stream, videoId: "v_other" })).toBe("30min")
    expect(liveReminderApi.saveStreamNotificationOverride).toHaveBeenCalledTimes(1)
  })

  it("keeps a saved override isolated to its own videoId -- another stream is unaffected", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalled())

    await result.current.saveOverride(stream, "1hour")

    await waitFor(() => expect(result.current.getEffectiveReminderValue(stream)).toBe("1hour"))
    expect(result.current.getEffectiveReminderValue({ ...stream, videoId: "v_other" })).toBeNull()
  })

  it("retries the initial load on the next mount after a failed fetch, instead of staying empty for the rest of the session", async () => {
    vi.mocked(liveReminderApi.fetchReminderSettings).mockClear()
    vi.mocked(liveReminderApi.fetchReminderSettings).mockRejectedValueOnce(new Error("403"))
    const first = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalledTimes(1))
    // Let the rejection handler release the started flag before the next mount.
    await waitFor(() => expect(first.result.current.getOverride("v1")).toBeNull())
    first.unmount()

    mockSettings({ streamOverrides: { v1: { creatorId: "aizawa_ema", ...setting("1hour") } } })
    const second = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(second.result.current.getEffectiveReminderValue(stream)).toBe("1hour"))
    expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalledTimes(2)
  })

  it("saveOverride rejects (and never calls the backend) for a stream whose creator cannot be resolved", async () => {
    const { result } = renderHook(() => useStreamNotificationOverride())
    await waitFor(() => expect(liveReminderApi.fetchReminderSettings).toHaveBeenCalled())
    vi.mocked(liveReminderApi.saveStreamNotificationOverride).mockClear()

    await expect(result.current.saveOverride({ ...stream, channelId: "unknown-channel" }, "1hour")).rejects.toThrow()
    expect(liveReminderApi.saveStreamNotificationOverride).not.toHaveBeenCalled()
  })
})
