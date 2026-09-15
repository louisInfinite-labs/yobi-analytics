import { useCallback } from "react"
import { createSharedState, useSharedState } from "../lib/sharedState"
import {
  INITIAL_MEMBER_REMINDER,
  INITIAL_TOPIC_REMINDER_MODE,
  MEMBER_CHOICE_MODE,
  NOTIFICATION_TOPICS,
  type NotificationTopicId,
  type ReminderTimeValue,
  type TopicReminderMode,
} from "../lib/notificationTopics"

const STORAGE_KEY = "yobi.topicNotificationPreferences"

interface TopicPreferenceState {
  /** "member_choice", or a concrete time that's forced onto every
   * Live-enabled member of this topic (see notificationTopics.ts's own
   * TopicReminderMode doc). */
  reminderMode: TopicReminderMode
  /** creatorIds enabled for this topic's Live (stream-start) notification. */
  live: string[]
  /** creatorIds enabled for this topic's New Video notification -- kept
   * fully independent from `live` (this feature's own spec: both switches
   * can be set per creator per topic, not one combined "selected" flag). */
  newVideo: string[]
  /** creatorId -> that member's OWN reminder choice, Live-only (New Video
   * has no reminder-time concept -- see notificationTopics.ts). Always
   * present once a member has touched their own control; never cleared by
   * `reminderMode` switching away from "member_choice" -- only dropped
   * when Live itself is turned off for that member (see setLiveEnabled). */
  reminderOverrides: Record<string, ReminderTimeValue>
}

type TopicPreferencesState = Record<NotificationTopicId, TopicPreferenceState>

function emptyTopicState(): TopicPreferenceState {
  return { reminderMode: INITIAL_TOPIC_REMINDER_MODE, live: [], newVideo: [], reminderOverrides: {} }
}

function initialState(): TopicPreferencesState {
  const state = {} as TopicPreferencesState
  for (const topic of NOTIFICATION_TOPICS) state[topic.id] = emptyTopicState()
  return state
}

function readState(): TopicPreferencesState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState()
    const parsed = JSON.parse(raw) as Partial<TopicPreferencesState>
    const state = initialState()
    for (const topic of NOTIFICATION_TOPICS) {
      const saved = parsed[topic.id]
      if (!saved) continue
      state[topic.id] = {
        reminderMode: saved.reminderMode ?? INITIAL_TOPIC_REMINDER_MODE,
        live: Array.isArray(saved.live) ? saved.live : [],
        newVideo: Array.isArray(saved.newVideo) ? saved.newVideo : [],
        reminderOverrides: typeof saved.reminderOverrides === "object" && saved.reminderOverrides ? saved.reminderOverrides : {},
      }
    }
    return state
  } catch {
    return initialState()
  }
}

// Module-scoped singleton (see lib/sharedState.ts), same reactivity
// reasoning as useFavoriteCreators/useCreatorNotificationPreferences --
// local-only persistence (this feature's own explicit decision: no backend
// contract exists for topic-level defaults or per-creator overrides, and
// introducing one is out of this task's scope).
const topicPreferencesStore = createSharedState(STORAGE_KEY, readState, (state) => JSON.stringify(state))

/** Topic-centered notification preferences: for each topic (see
 * lib/notificationTopics.ts), a reminder MODE (either a concrete time
 * forced onto everyone, or "member_choice" letting each member's own
 * setting apply), an independent Live-enabled and New-Video-enabled
 * creator set, and each member's own individually-stored reminder choice.
 * Entirely separate from both Favorites (useFavoriteCreators) and the
 * pre-existing global per-creator Live/New Video mute switches
 * (useCreatorNotificationPreferences) -- this hook owns only the new topic
 * dimension. */
export function useTopicNotificationPreferences() {
  const [state, setState] = useSharedState(topicPreferencesStore)

  const getReminderMode = useCallback((topicId: NotificationTopicId) => state[topicId].reminderMode, [state])

  const setReminderMode = useCallback(
    (topicId: NotificationTopicId, mode: TopicReminderMode) => {
      setState({ ...state, [topicId]: { ...state[topicId], reminderMode: mode } })
    },
    [state, setState],
  )

  const isMemberChoiceMode = useCallback((topicId: NotificationTopicId) => state[topicId].reminderMode === MEMBER_CHOICE_MODE, [state])

  const isLiveEnabled = useCallback(
    (topicId: NotificationTopicId, creatorId: string) => state[topicId].live.includes(creatorId),
    [state],
  )

  const setLiveEnabled = useCallback(
    (topicId: NotificationTopicId, creatorId: string, enabled: boolean) => {
      const topic = state[topicId]
      const live = enabled ? [...topic.live, creatorId] : topic.live.filter((id) => id !== creatorId)
      // Dropping Live also drops this creator's own stored reminder choice
      // — with no Live notification left to remind about, it's orphaned
      // state, not a preference worth keeping around for if Live gets
      // re-enabled later.
      const reminderOverrides = enabled
        ? topic.reminderOverrides
        : Object.fromEntries(Object.entries(topic.reminderOverrides).filter(([id]) => id !== creatorId))
      setState({ ...state, [topicId]: { ...topic, live, reminderOverrides } })
    },
    [state, setState],
  )

  const isNewVideoEnabled = useCallback(
    (topicId: NotificationTopicId, creatorId: string) => state[topicId].newVideo.includes(creatorId),
    [state],
  )

  const setNewVideoEnabled = useCallback(
    (topicId: NotificationTopicId, creatorId: string, enabled: boolean) => {
      const topic = state[topicId]
      const newVideo = enabled ? [...topic.newVideo, creatorId] : topic.newVideo.filter((id) => id !== creatorId)
      setState({ ...state, [topicId]: { ...topic, newVideo } })
    },
    [state, setState],
  )

  /** A member's OWN reminder choice, regardless of whether it's currently
   * in effect (see getEffectiveReminder below for that) -- falls back to
   * INITIAL_MEMBER_REMINDER only for display until they've ever touched
   * their own control; never written to storage just by reading it. */
  const getMemberReminder = useCallback(
    (topicId: NotificationTopicId, creatorId: string): ReminderTimeValue => state[topicId].reminderOverrides[creatorId] ?? INITIAL_MEMBER_REMINDER,
    [state],
  )

  const setMemberReminder = useCallback(
    (topicId: NotificationTopicId, creatorId: string, value: ReminderTimeValue) => {
      const topic = state[topicId]
      setState({ ...state, [topicId]: { ...topic, reminderOverrides: { ...topic.reminderOverrides, [creatorId]: value } } })
    },
    [state, setState],
  )

  /** The reminder a member ACTUALLY gets notified at: the topic's own
   * forced time whenever its mode isn't "member_choice" (full stop,
   * regardless of that member's own stored choice), otherwise that
   * member's own reminder. Confirmed with the user: this is a MODE SWITCH,
   * not an inheritance fallback -- a concrete topic mode overrides every
   * member's own setting rather than merely being their fallback. */
  const getEffectiveReminder = useCallback(
    (topicId: NotificationTopicId, creatorId: string): ReminderTimeValue => {
      const mode = state[topicId].reminderMode
      return mode === MEMBER_CHOICE_MODE ? getMemberReminder(topicId, creatorId) : mode
    },
    [state, getMemberReminder],
  )

  /** Union of Live- and New-Video-enabled creators for this topic -- the
   * main page's own "已選 N 人" count and name preview don't distinguish
   * which of the two a creator is enabled for (this feature's own spec,
   * section 3: one combined count). */
  const getEnabledCreatorIds = useCallback((topicId: NotificationTopicId): Set<string> => {
    const topic = state[topicId]
    return new Set([...topic.live, ...topic.newVideo])
  }, [state])

  return {
    getReminderMode,
    setReminderMode,
    isMemberChoiceMode,
    isLiveEnabled,
    setLiveEnabled,
    isNewVideoEnabled,
    setNewVideoEnabled,
    getMemberReminder,
    setMemberReminder,
    getEffectiveReminder,
    getEnabledCreatorIds,
  }
}
