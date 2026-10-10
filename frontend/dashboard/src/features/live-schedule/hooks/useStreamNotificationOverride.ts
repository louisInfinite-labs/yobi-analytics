import { useCallback, useEffect, useSyncExternalStore } from "react"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import {
  deleteStreamNotificationOverride,
  fetchReminderSettings,
  reminderValueToSetting,
  saveStreamNotificationOverride,
  settingToReminderValue,
  type StreamNotificationOverride,
} from "../../notifications/api/liveReminderApi"
import { ALL_TOPICS_ID } from "../../notifications/model/notificationTopicCatalog"
import type { ReminderSetting, ReminderTimeValue } from "../../notifications/model/notificationTopics"
import type { ScheduledStream } from "../model/scheduledStream"
import { getCache, getGeneration, isFetchStarted, markFetchStarted, resetFetchStarted, setCache, subscribe } from "./streamNotificationOverrideCache"

/** The panel's extra choice besides the five reminder times: an explicit per-stream OFF -- this stream never notifies, even when the
 * creator's 全部 / topic reminder would. Stored as an override with no start and no advance reminder. */
export const STREAM_REMINDER_OFF = "off"
export type StreamReminderChoice = ReminderTimeValue | typeof STREAM_REMINDER_OFF

const OFF_SETTING = { notifyAtStart: false, advanceReminder: null } as const

function ensureLoaded(): void {
  if (isFetchStarted()) return
  markFetchStarted()
  const startedAtGeneration = getGeneration()
  void fetchReminderSettings().then(
    (settings) => {
      if (startedAtGeneration !== getGeneration()) return
      setCache(settings)
    },
    () => {
      // Best-effort initial load: a failed fetch leaves the cache empty, so
      // every lookup below reports "no reminder set" -- a later
      // saveOverride call still attempts its own real backend write
      // regardless of whether this initial read succeeded. The started flag
      // is released (for this generation only) so the next mount retries
      // instead of staying empty until a full page reload.
      if (startedAtGeneration === getGeneration()) resetFetchStarted()
    },
  )
}

function useCache() {
  useEffect(() => {
    ensureLoaded()
  }, [])
  return useSyncExternalStore(subscribe, getCache)
}

/** Schedule's single-stream notification override, backed by the real
 * backend reminder settings -- never localStorage as the source of truth.
 * Precedence (never merged), highest first: this stream's own override >
 * the creator's 全部 reminder > the creator + this stream's topic reminder >
 * unset (no reminder). Mute / Quiet Hours sits above all of these on the
 * backend and is not shown here. */
export function useStreamNotificationOverride() {
  const state = useCache()

  const getOverride = useCallback((videoId: string): StreamNotificationOverride | null => state.streamOverrides[videoId] ?? null, [state])

  /** The single ReminderTimeValue the shared Segmented control shows -- the reminder that
   * actually applies to this stream per the precedence above -- or `null` when none is set
   * (no reminder; never defaulted to a time). */
  const getEffectiveReminderValue = useCallback(
    (stream: ScheduledStream): ReminderSetting | typeof STREAM_REMINDER_OFF => {
      const override = getOverride(stream.videoId)
      if (override) return !override.notifyAtStart && override.advanceReminder === null ? STREAM_REMINDER_OFF : settingToReminderValue(override)
      const creator = resolveCreatorKey(stream.channelId)
      if (!creator) return null
      const all = state.creatorAll[creator.creatorId]
      if (all) return settingToReminderValue(all)
      const topic = stream.topics[0]
      const topicSetting = topic && topic !== ALL_TOPICS_ID ? state.creatorTopics[creator.creatorId]?.[topic] : undefined
      return settingToReminderValue(topicSetting)
    },
    [getOverride, state],
  )

  /** Persists this one stream's override through the real backend API. It outranks the
   * creator's 全部 and topic reminders for THIS stream only, and writes one backend item
   * of its own -- it never changes those settings. Carries no scheduledStartMs: the
   * backend always resolves the CURRENT scheduled start from its own system-wide schedule
   * snapshot at dispatch time, so a later Holodex reschedule is picked up automatically
   * rather than this override freezing the stream's timing as of when it was saved. */
  const saveOverride = useCallback(
    async (stream: ScheduledStream, value: StreamReminderChoice): Promise<void> => {
      const creator = resolveCreatorKey(stream.channelId)
      if (!creator) throw new Error(`Cannot save a reminder for a stream with no resolvable creator (channelId ${stream.channelId})`)
      const setting = value === STREAM_REMINDER_OFF ? OFF_SETTING : reminderValueToSetting(value)
      const override: StreamNotificationOverride = { ...setting, creatorId: creator.creatorId }
      await saveStreamNotificationOverride(stream.videoId, override)
      setCache({ ...getCache(), streamOverrides: { ...getCache().streamOverrides, [stream.videoId]: override } })
    },
    [],
  )

  /** Removes this stream's own override (a real backend DELETE first; the cache only changes once it succeeded), so the stream
   * follows the creator 全部 / topic reminders again. */
  const removeOverride = useCallback(async (stream: ScheduledStream): Promise<void> => {
    await deleteStreamNotificationOverride(stream.videoId)
    const { [stream.videoId]: _removed, ...rest } = getCache().streamOverrides
    setCache({ ...getCache(), streamOverrides: rest })
  }, [])

  return { getOverride, getEffectiveReminderValue, saveOverride, removeOverride }
}
