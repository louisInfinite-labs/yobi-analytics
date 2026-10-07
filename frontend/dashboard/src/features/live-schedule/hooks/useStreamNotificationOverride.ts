import { useCallback, useEffect, useSyncExternalStore } from "react"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import {
  fetchCreatorLiveReminders,
  fetchStreamNotificationOverrides,
  reminderValueToSetting,
  saveStreamNotificationOverride,
  settingToReminderValue,
  type LiveReminderSetting,
  type StreamNotificationOverride,
} from "../../notifications/api/liveReminderApi"
import { INITIAL_MEMBER_REMINDER, type ReminderTimeValue } from "../../notifications/model/notificationTopics"
import type { ScheduledStream } from "../model/scheduledStream"
import { getCache, getGeneration, isFetchStarted, markFetchStarted, setCache, subscribe } from "./streamNotificationOverrideCache"

function ensureLoaded(): void {
  if (isFetchStarted()) return
  markFetchStarted()
  const startedAtGeneration = getGeneration()
  void Promise.all([fetchCreatorLiveReminders(), fetchStreamNotificationOverrides()]).then(
    ([creatorReminders, streamOverrides]) => {
      if (startedAtGeneration !== getGeneration()) return
      setCache({ creatorReminders, streamOverrides })
    },
    () => {
      // Best-effort initial load: a failed fetch leaves the cache empty, so
      // every lookup below falls back to the system default -- a later
      // saveOverride call still attempts its own real backend write
      // regardless of whether this initial read succeeded.
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
 * backend creator-recurring-reminder / stream-override records -- never
 * localStorage as the source of truth. Precedence (never merged): stream
 * override > creator recurring setting > system default
 * (INITIAL_MEMBER_REMINDER). */
export function useStreamNotificationOverride() {
  const state = useCache()

  const getOverride = useCallback((videoId: string): StreamNotificationOverride | null => state.streamOverrides[videoId] ?? null, [state])

  const getCreatorRecurring = useCallback(
    (creatorId: string): LiveReminderSetting | null => state.creatorReminders[creatorId] ?? null,
    [state],
  )

  /** The single ReminderTimeValue the shared Segmented control shows: this
   * stream's own saved override if one exists, else its creator's recurring
   * setting, else the existing system default -- never a merge of the two. */
  const getEffectiveReminderValue = useCallback(
    (stream: ScheduledStream): ReminderTimeValue => {
      const override = getOverride(stream.videoId)
      if (override) return settingToReminderValue(override) ?? INITIAL_MEMBER_REMINDER
      const creator = resolveCreatorKey(stream.channelId)
      const recurring = creator ? getCreatorRecurring(creator.creatorId) : null
      return settingToReminderValue(recurring) ?? INITIAL_MEMBER_REMINDER
    },
    [getOverride, getCreatorRecurring],
  )

  /** Persists this one stream's override through the real backend API --
   * replaces, never combines with, the creator's recurring setting. Carries
   * no scheduledStartMs: the backend always resolves the CURRENT scheduled
   * start from its own system-wide schedule snapshot at dispatch time, so a
   * later Holodex reschedule is picked up automatically rather than this
   * override freezing the stream's timing as of when it was saved. */
  const saveOverride = useCallback(
    async (stream: ScheduledStream, value: ReminderTimeValue): Promise<void> => {
      const creator = resolveCreatorKey(stream.channelId)
      if (!creator) return
      const override: StreamNotificationOverride = { ...reminderValueToSetting(value), creatorId: creator.creatorId }
      await saveStreamNotificationOverride(stream.videoId, override)
      setCache({ ...getCache(), streamOverrides: { ...getCache().streamOverrides, [stream.videoId]: override } })
    },
    [],
  )

  return { getOverride, getCreatorRecurring, getEffectiveReminderValue, saveOverride }
}
