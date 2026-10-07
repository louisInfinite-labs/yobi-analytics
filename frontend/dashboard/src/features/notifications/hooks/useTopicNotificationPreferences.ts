import { useCallback } from "react"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"
import { reminderValueToSetting, saveCreatorLiveReminder } from "../api/liveReminderApi"
import { getAvailableTopics, type TopicCatalogId } from "../model/notificationTopicCatalog"
import {
  INITIAL_MEMBER_REMINDER,
  INITIAL_TOPIC_NOTIFICATION_TYPE,
  INITIAL_TOPIC_REMINDER_MODE,
  MEMBER_CHOICE_MODE,
  type ReminderTimeValue,
  type TopicNotificationType,
  type TopicReminderMode,
} from "../model/notificationTopics"

// Bumped to v2 -- a browser that already used the dynamic-topics feature
// before the 5 permanent defaults (全部/SF6/VALO/APEX/Minecraft) were
// restored would otherwise have a real, valid-shaped topicOrder already
// persisted under the old key (e.g. just ["valo", "seven_days_to_die"]
// from earlier testing), which readState's own validation accepts as-is
// and never replaces with INITIAL_SAVED_TOPIC_IDS below -- changing that
// constant alone silently does nothing for anyone with existing data. A
// new key forces every browser to start fresh from the new defaults once,
// consistent with this feature's own "local-only persistence, no
// migration contract" framing.
const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"

interface TopicPreferenceState {
  reminderMode: TopicReminderMode
  live: string[]
  newVideo: string[]
  reminderOverrides: Record<string, ReminderTimeValue>
  notificationType: TopicNotificationType
}

/** The 5 permanent default cards the page starts with, in this exact order
 * (confirmed with the user: 全部/SF6/VALO/APEX/Minecraft, never reordered or
 * removed) -- everything else is added by the user via "+", appended after
 * these. */
const INITIAL_SAVED_TOPIC_IDS: readonly TopicCatalogId[] = ["all", "sf6", "valo", "apex", "minecraft"]

interface TopicPreferencesState {
  /** Every topic currently rendered as a SAVED grid card, in render order.
   * Append-only (no "remove card" was requested) -- new topics only ever
   * get pushed onto the end, so existing cards never reflow when one is
   * added. */
  topicOrder: TopicCatalogId[]
  /** Per-topic preference data -- deliberately NOT required to have an
   * entry for every id in topicOrder. Every getter below falls back to
   * emptyTopicState() for a missing entry (same fallback shape
   * getMemberReminder already used before this reshape), so a freshly
   * saved topic (see NotificationSettings.tsx's addTopic call) gets no
   * entry at all until the user actually touches something about it (a
   * reminder mode, a Live switch, ...) -- there's nothing to seed. */
  topics: Partial<Record<TopicCatalogId, TopicPreferenceState>>
}

function emptyTopicState(): TopicPreferenceState {
  return { reminderMode: INITIAL_TOPIC_REMINDER_MODE, live: [], newVideo: [], reminderOverrides: {}, notificationType: INITIAL_TOPIC_NOTIFICATION_TYPE }
}

function isValidNotificationType(value: unknown): value is TopicNotificationType {
  return value === "live" || value === "newVideo" || value === "both"
}

function initialState(): TopicPreferencesState {
  return { topicOrder: [...INITIAL_SAVED_TOPIC_IDS], topics: {} }
}

function readState(): TopicPreferencesState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState()
    const parsed = JSON.parse(raw) as Partial<TopicPreferencesState>
    // Old (pre-dynamic-topics) localStorage was a flat Record<topicId,
    // TopicPreferenceState> with no topicOrder field at all -- this check
    // is what makes reading that shape harmlessly fall back to the default
    // below instead of being misread, no storage-key version bump needed.
    const availableTopicIds = new Set(getAvailableTopics().map((topic) => topic.id))
    const savedTopicOrder = Array.isArray(parsed.topicOrder)
      ? parsed.topicOrder.filter((id): id is TopicCatalogId => typeof id === "string" && availableTopicIds.has(id))
      : []
    const topicOrder = [...INITIAL_SAVED_TOPIC_IDS]
    for (const id of savedTopicOrder) {
      if (!topicOrder.includes(id)) topicOrder.push(id)
    }
    const topics: TopicPreferencesState["topics"] = {}
    for (const id of topicOrder) {
      const saved = parsed.topics?.[id]
      if (!saved) continue
      topics[id] = {
        reminderMode: saved.reminderMode ?? INITIAL_TOPIC_REMINDER_MODE,
        live: Array.isArray(saved.live) ? saved.live : [],
        newVideo: Array.isArray(saved.newVideo) ? saved.newVideo : [],
        reminderOverrides: typeof saved.reminderOverrides === "object" && saved.reminderOverrides ? saved.reminderOverrides : {},
        notificationType: isValidNotificationType(saved.notificationType) ? saved.notificationType : INITIAL_TOPIC_NOTIFICATION_TYPE,
      }
    }
    return { topicOrder, topics }
  } catch {
    return initialState()
  }
}

/** Serializes saved cards only. Draft-topic controls still share their
 * in-memory state across the card and drawer, but nothing reaches storage
 * until addTopic commits that topic ID to topicOrder. */
function serializeState(state: TopicPreferencesState): string {
  const topics: TopicPreferencesState["topics"] = {}
  for (const id of state.topicOrder) {
    if (state.topics[id]) topics[id] = state.topics[id]
  }
  return JSON.stringify({ ...state, topics })
}

// Module-scoped singleton (see lib/sharedState.ts), same reactivity
// reasoning as useFavoriteCreators/useCreatorNotificationPreferences --
// local-only persistence (this feature's own explicit decision: no backend
// contract exists for topic-level defaults or per-creator overrides, and
// introducing one is out of this task's scope).
const topicPreferencesStore = createSharedState(STORAGE_KEY, readState, serializeState)

export function useTopicNotificationPreferences() {
  const [state, setState] = useSharedState(topicPreferencesStore)

  const topicState = useCallback((topicId: TopicCatalogId) => state.topics[topicId] ?? emptyTopicState(), [state])

  const setTopicState = useCallback(
    (topicId: TopicCatalogId, next: TopicPreferenceState) => {
      setState({ ...state, topics: { ...state.topics, [topicId]: next } })
    },
    [state, setState],
  )

  /** Appends a newly-saved topic to the grid -- confirmed with the user:
   * selecting a topic in the draft card's dropdown only updates that
   * card's own local, unsaved state (see NotificationSettings.tsx); THIS
   * is the only thing an explicit Save action calls, and it's the only
   * way a topic ever becomes a real, persisted card. The `includes` guard
   * is defense-in-depth only -- the draft's own dropdown options
   * (lib/notificationTopicCatalog.ts's getSelectableTopics) are what
   * actually keep a topic from ever being offered twice. */
  const addTopic = useCallback(
    (topicId: TopicCatalogId) => {
      if (state.topicOrder.includes(topicId)) return
      setState({ ...state, topicOrder: [...state.topicOrder, topicId] })
    },
    [state, setState],
  )

  /** Drops transient configuration when a draft changes or is abandoned.
   * Saved topic preferences are protected even if this is called during
   * the same render in which Save commits the draft. */
  const discardUnsavedTopic = useCallback((topicId: TopicCatalogId) => {
    const current = topicPreferencesStore.get()
    if (current.topicOrder.includes(topicId) || !current.topics[topicId]) return
    const topics = { ...current.topics }
    delete topics[topicId]
    topicPreferencesStore.set({ ...current, topics })
  }, [])

  const getReminderMode = useCallback((topicId: TopicCatalogId) => topicState(topicId).reminderMode, [topicState])

  const setReminderMode = useCallback(
    (topicId: TopicCatalogId, mode: TopicReminderMode) => {
      setTopicState(topicId, { ...topicState(topicId), reminderMode: mode })
    },
    [topicState, setTopicState],
  )

  const isMemberChoiceMode = useCallback((topicId: TopicCatalogId) => topicState(topicId).reminderMode === MEMBER_CHOICE_MODE, [topicState])

  const isLiveEnabled = useCallback((topicId: TopicCatalogId, creatorId: string) => topicState(topicId).live.includes(creatorId), [topicState])

  const setLiveEnabled = useCallback(
    (topicId: TopicCatalogId, creatorId: string, enabled: boolean) => {
      const topic = topicState(topicId)
      const live = enabled ? [...topic.live, creatorId] : topic.live.filter((id) => id !== creatorId)
      // Dropping Live also drops this creator's own stored reminder choice
      // — with no Live notification left to remind about, it's orphaned
      // state, not a preference worth keeping around for if Live gets
      // re-enabled later.
      const reminderOverrides = enabled ? topic.reminderOverrides : Object.fromEntries(Object.entries(topic.reminderOverrides).filter(([id]) => id !== creatorId))
      setTopicState(topicId, { ...topic, live, reminderOverrides })
    },
    [topicState, setTopicState],
  )

  const isNewVideoEnabled = useCallback((topicId: TopicCatalogId, creatorId: string) => topicState(topicId).newVideo.includes(creatorId), [topicState])

  const setNewVideoEnabled = useCallback(
    (topicId: TopicCatalogId, creatorId: string, enabled: boolean) => {
      const topic = topicState(topicId)
      const newVideo = enabled ? [...topic.newVideo, creatorId] : topic.newVideo.filter((id) => id !== creatorId)
      setTopicState(topicId, { ...topic, newVideo })
    },
    [topicState, setTopicState],
  )

  /** A member's OWN reminder choice, regardless of whether it's currently
   * in effect (see getEffectiveReminder below for that) -- falls back to
   * INITIAL_MEMBER_REMINDER only for display until they've ever touched
   * their own control; never written to storage just by reading it. */
  const getMemberReminder = useCallback((topicId: TopicCatalogId, creatorId: string): ReminderTimeValue => topicState(topicId).reminderOverrides[creatorId] ?? INITIAL_MEMBER_REMINDER, [topicState])

  const setMemberReminder = useCallback(
    (topicId: TopicCatalogId, creatorId: string, value: ReminderTimeValue) => {
      const topic = topicState(topicId)
      setTopicState(topicId, { ...topic, reminderOverrides: { ...topic.reminderOverrides, [creatorId]: value } })
      // Best-effort write-through to this creator's real backend-persisted
      // recurring live-reminder setting (src/notifications/live_reminder.py),
      // so the notification dispatcher -- and Schedule's single-stream
      // override fallback -- can see it without this browser needing to be
      // open. This local per-topic store remains the Settings page's own
      // display/edit state (unchanged); a write failure here is swallowed
      // rather than surfaced, the same posture NotificationToggle's own
      // backend sync failures take for a non-critical background sync.
      void saveCreatorLiveReminder(creatorId, reminderValueToSetting(value)).catch(() => {})
    },
    [topicState, setTopicState],
  )

  /** The reminder a member ACTUALLY gets notified at: the topic's own
   * forced time whenever its mode isn't "member_choice" (full stop,
   * regardless of that member's own stored choice), otherwise that
   * member's own reminder. Confirmed with the user: this is a MODE SWITCH,
   * not an inheritance fallback -- a concrete topic mode overrides every
   * member's own setting rather than merely being their fallback. */
  const getEffectiveReminder = useCallback(
    (topicId: TopicCatalogId, creatorId: string): ReminderTimeValue => {
      const mode = topicState(topicId).reminderMode
      return mode === MEMBER_CHOICE_MODE ? getMemberReminder(topicId, creatorId) : mode
    },
    [topicState, getMemberReminder],
  )

  /** Whether the topic's own notificationType currently permits each
   * member-level channel -- confirmed with the user: the topic-level
   * notificationType is the single source of truth for which channels are
   * live, gating member-level state rather than sitting alongside it
   * unchecked. Kept private (not returned) since nothing outside this hook
   * needs to ask this directly -- callers needing to know the topic's type
   * for their own rendering decisions already have getNotificationType. */
  const isLiveChannelAllowed = useCallback((topicId: TopicCatalogId) => {
    const type = topicState(topicId).notificationType
    return type === "live" || type === "both"
  }, [topicState])

  const isNewVideoChannelAllowed = useCallback((topicId: TopicCatalogId) => {
    const type = topicState(topicId).notificationType
    return type === "newVideo" || type === "both"
  }, [topicState])

  /** Union of Live- and New-Video-enabled creators for this topic -- the
   * main page's own "已選 N 人" count and name preview don't distinguish
   * which of the two a creator is enabled for (this feature's own spec,
   * section 3: one combined count). Limited to whichever channel(s) the
   * topic's own notificationType currently allows: a creator's own
   * live/newVideo membership stays stored (setLiveEnabled/setNewVideoEnabled
   * never get cleared just because the topic's type changed -- non-
   * destructive, so switching back restores it), but a channel the topic
   * currently excludes must not count as effectively enabled. */
  const getEnabledCreatorIds = useCallback((topicId: TopicCatalogId): Set<string> => {
    const topic = topicState(topicId)
    const live = isLiveChannelAllowed(topicId) ? topic.live : []
    const newVideo = isNewVideoChannelAllowed(topicId) ? topic.newVideo : []
    return new Set([...live, ...newVideo])
  }, [topicState, isLiveChannelAllowed, isNewVideoChannelAllowed])

  const getNotificationType = useCallback((topicId: TopicCatalogId) => topicState(topicId).notificationType, [topicState])

  const setNotificationType = useCallback(
    (topicId: TopicCatalogId, type: TopicNotificationType) => {
      setTopicState(topicId, { ...topicState(topicId), notificationType: type })
    },
    [topicState, setTopicState],
  )

  /** How many creators currently have their OWN explicit reminder override
   * set for this topic (setLiveEnabled already clears a creator's override
   * the moment Live is turned off for them, so every remaining key here
   * belongs to a still-Live-enabled creator) -- drives the Notification
   * Settings detail panel's per-creator override summary. Read-only: it
   * derives from reminderOverrides, never a separate stored value. Reports
   * 0 while the topic's own notificationType excludes Live entirely (a
   * "新片"-only topic sends no live reminder at all) -- the stored
   * overrides themselves are left untouched so they're restored if Live is
   * re-enabled later. */
  const getOverrideCount = useCallback(
    (topicId: TopicCatalogId) => (isLiveChannelAllowed(topicId) ? Object.keys(topicState(topicId).reminderOverrides).length : 0),
    [topicState, isLiveChannelAllowed],
  )

  /** Restores a topic's own reminder mode and notification type to their
   * starting values -- deliberately leaves Live/New Video membership and
   * every member's own reminder override untouched, since those represent
   * who's enabled, not this topic's own defaults, and clearing them from a
   * generic "reset" action would be a surprising, hard-to-undo data loss. */
  const resetTopicDefaults = useCallback(
    (topicId: TopicCatalogId) => {
      setTopicState(topicId, { ...topicState(topicId), reminderMode: INITIAL_TOPIC_REMINDER_MODE, notificationType: INITIAL_TOPIC_NOTIFICATION_TYPE })
    },
    [topicState, setTopicState],
  )

  return {
    savedTopicIds: state.topicOrder,
    addTopic,
    discardUnsavedTopic,
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
    getNotificationType,
    setNotificationType,
    getOverrideCount,
    resetTopicDefaults,
  }
}
