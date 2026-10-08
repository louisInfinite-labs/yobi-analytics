import { useCallback } from "react"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"
import { deleteCreatorReminder, reminderValueToSetting, saveCreatorReminder } from "../api/liveReminderApi"
import { ALL_TOPICS_ID, getAvailableTopics, LEGACY_TOPIC_ID_ALIASES, type TopicCatalogId } from "../model/notificationTopicCatalog"
import {
  INITIAL_TOPIC_NOTIFICATION_TYPE,
  REMINDER_TIME_VALUES,
  type ReminderSetting,
  type ReminderTimeValue,
  type TopicNotificationType,
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
// migration contract" framing. (Topic ids renamed since -- valo ->
// valorant -- are migrated in place by readState instead, never dropped.)
const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"

interface TopicPreferenceState {
  live: string[]
  newVideo: string[]
  /** creatorId -> that creator's reminder for this topic. A creator with no
   * entry has NO reminder ("unset") -- there is no default value. For the
   * "all" topic this is the creator-level 全部 reminder. */
  reminderOverrides: Record<string, ReminderTimeValue>
  notificationType: TopicNotificationType
}

/** The 5 permanent default cards the page starts with, in this exact order
 * (confirmed with the user: 全部/SF6/VALO/APEX/Minecraft, never reordered or
 * removed) -- everything else is added by the user via "+", appended after
 * these. */
const INITIAL_SAVED_TOPIC_IDS: readonly TopicCatalogId[] = [ALL_TOPICS_ID, "sf6", "valorant", "apex", "minecraft"]

interface TopicPreferencesState {
  /** Every topic currently rendered as a SAVED grid card, in render order.
   * Append-only (no "remove card" was requested) -- new topics only ever
   * get pushed onto the end, so existing cards never reflow when one is
   * added. */
  topicOrder: TopicCatalogId[]
  /** Per-topic preference data -- deliberately NOT required to have an
   * entry for every id in topicOrder. Every getter below falls back to
   * emptyTopicState() for a missing entry, so a freshly saved topic (see
   * NotificationSettings.tsx's addTopic call) gets no entry at all until the
   * user actually touches something about it (a Live switch, a reminder,
   * ...) -- there's nothing to seed. */
  topics: Partial<Record<TopicCatalogId, TopicPreferenceState>>
}

function emptyTopicState(): TopicPreferenceState {
  return { live: [], newVideo: [], reminderOverrides: {}, notificationType: INITIAL_TOPIC_NOTIFICATION_TYPE }
}

function isValidNotificationType(value: unknown): value is TopicNotificationType {
  return value === "live" || value === "newVideo" || value === "both"
}

function isReminderTimeValue(value: unknown): value is ReminderTimeValue {
  return typeof value === "string" && (REMINDER_TIME_VALUES as readonly string[]).includes(value)
}

function initialState(): TopicPreferencesState {
  return { topicOrder: [...INITIAL_SAVED_TOPIC_IDS], topics: {} }
}

function canonicalTopicId(id: string): string {
  return LEGACY_TOPIC_ID_ALIASES[id] ?? id
}

type StoredTopicState = Partial<Record<keyof TopicPreferenceState, unknown>>

/** Normalises one stored topic entry; a legacy `reminderMode` field (the removed topic-level
 * "forced time" mode) is simply not read -- only each creator's own explicit choice is kept. */
function readTopicState(saved: StoredTopicState): TopicPreferenceState {
  const reminderOverrides: Record<string, ReminderTimeValue> = {}
  if (typeof saved.reminderOverrides === "object" && saved.reminderOverrides) {
    for (const [creatorId, value] of Object.entries(saved.reminderOverrides)) {
      if (isReminderTimeValue(value)) reminderOverrides[creatorId] = value
    }
  }
  return {
    live: Array.isArray(saved.live) ? saved.live : [],
    newVideo: Array.isArray(saved.newVideo) ? saved.newVideo : [],
    reminderOverrides,
    notificationType: isValidNotificationType(saved.notificationType) ? saved.notificationType : INITIAL_TOPIC_NOTIFICATION_TYPE,
  }
}

/** Combines two stored entries that migrate to the same topic id (an old and a
 * renamed id both present): nothing either one had enabled or set is lost; where both
 * set the same creator's reminder, the entry already under the canonical id wins. */
function mergeTopicStates(legacy: TopicPreferenceState, canonical: TopicPreferenceState): TopicPreferenceState {
  return {
    live: [...new Set([...canonical.live, ...legacy.live])],
    newVideo: [...new Set([...canonical.newVideo, ...legacy.newVideo])],
    reminderOverrides: { ...legacy.reminderOverrides, ...canonical.reminderOverrides },
    notificationType: canonical.notificationType,
  }
}

function readState(): TopicPreferencesState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState()
    const parsed = JSON.parse(raw) as { topicOrder?: unknown; topics?: Record<string, StoredTopicState> }
    // Old (pre-dynamic-topics) localStorage was a flat Record<topicId,
    // TopicPreferenceState> with no topicOrder field at all -- this check
    // is what makes reading that shape harmlessly fall back to the default
    // below instead of being misread, no storage-key version bump needed.
    const availableTopicIds = new Set(getAvailableTopics().map((topic) => topic.id))
    const savedTopicOrder = Array.isArray(parsed.topicOrder)
      ? parsed.topicOrder
          .filter((id): id is string => typeof id === "string")
          .map(canonicalTopicId)
          .filter((id) => availableTopicIds.has(id))
      : []
    const topicOrder = [...INITIAL_SAVED_TOPIC_IDS]
    for (const id of savedTopicOrder) {
      if (!topicOrder.includes(id)) topicOrder.push(id)
    }
    const topics: TopicPreferencesState["topics"] = {}
    for (const [storedId, saved] of Object.entries(parsed.topics ?? {})) {
      const id = canonicalTopicId(storedId)
      if (!topicOrder.includes(id) || !saved) continue
      const next = readTopicState(saved)
      const existing = topics[id]
      // `existing` came from the other of the two ids that map to `id`; the entry stored under the canonical id wins ties.
      topics[id] = existing ? (storedId === id ? mergeTopicStates(existing, next) : mergeTopicStates(next, existing)) : next
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

/** Best-effort write-through of ONE creator's reminder for ONE topic to the backend
 * (src/notifications/live_reminder.py): a single backend item per (creator, topic),
 * so it can never touch another topic's, another creator's, or the 全部 reminder.
 * `value === null` (unset) deletes just that item. A failed write is swallowed -- the
 * same posture NotificationToggle's own background syncs take. */
function syncReminderToBackend(topicId: TopicCatalogId, creatorId: string, value: ReminderSetting): void {
  const request = value === null ? deleteCreatorReminder(creatorId, topicId) : saveCreatorReminder(creatorId, topicId, reminderValueToSetting(value))
  void request.catch(() => {})
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

  const isLiveEnabled = useCallback((topicId: TopicCatalogId, creatorId: string) => topicState(topicId).live.includes(creatorId), [topicState])

  /** Turning Live OFF for a creator + topic also unsets (deletes) that ONE
   * creator + topic reminder, locally and on the backend -- with no Live
   * notification left to remind about, it's orphaned state. Nothing else is
   * touched: not the creator's 全部 reminder, not other topics, not other
   * creators. */
  const setLiveEnabled = useCallback(
    (topicId: TopicCatalogId, creatorId: string, enabled: boolean) => {
      const topic = topicState(topicId)
      const live = enabled ? [...topic.live, creatorId] : topic.live.filter((id) => id !== creatorId)
      const hadReminder = creatorId in topic.reminderOverrides
      const reminderOverrides = enabled || !hadReminder ? topic.reminderOverrides : Object.fromEntries(Object.entries(topic.reminderOverrides).filter(([id]) => id !== creatorId))
      setTopicState(topicId, { ...topic, live, reminderOverrides })
      if (!enabled && hadReminder) syncReminderToBackend(topicId, creatorId, null)
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

  /** This creator's own reminder for this topic -- `null` (unset, no reminder)
   * until they've chosen one. Never defaulted to any value, and reading it never
   * writes anything. For the "all" topic this is the creator-level 全部 reminder. */
  const getMemberReminder = useCallback(
    (topicId: TopicCatalogId, creatorId: string): ReminderSetting => topicState(topicId).reminderOverrides[creatorId] ?? null,
    [topicState],
  )

  /** Sets (or, with `null`, unsets) one creator's reminder for one topic -- only that one
   * (creator, topic) entry changes, here and on the backend. Setting the 全部 reminder
   * never edits or erases the same creator's topic reminders: they stay stored and are
   * merely shadowed (see isReminderShadowedByAll) until 全部 is unset. */
  const setMemberReminder = useCallback(
    (topicId: TopicCatalogId, creatorId: string, value: ReminderSetting) => {
      const topic = topicState(topicId)
      const reminderOverrides = { ...topic.reminderOverrides }
      if (value === null) delete reminderOverrides[creatorId]
      else reminderOverrides[creatorId] = value
      setTopicState(topicId, { ...topic, reminderOverrides })
      syncReminderToBackend(topicId, creatorId, value)
    },
    [topicState, setTopicState],
  )

  /** Whether this creator + topic reminder is currently shadowed (not in effect) because the
   * same creator has a 全部 reminder set -- the backend's precedence is 全部 over creator + topic.
   * Only a display fact: the topic reminder itself stays stored untouched. */
  const isReminderShadowedByAll = useCallback(
    (topicId: TopicCatalogId, creatorId: string): boolean => topicId !== ALL_TOPICS_ID && getMemberReminder(ALL_TOPICS_ID, creatorId) !== null,
    [getMemberReminder],
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

  /** How many creators currently have their OWN reminder set for this topic
   * (setLiveEnabled already clears a creator's reminder the moment Live is
   * turned off for them, so every remaining key here belongs to a still-Live-
   * enabled creator) -- drives the Notification Settings detail panel's
   * per-creator reminder summary. Read-only: it derives from reminderOverrides,
   * never a separate stored value. Reports 0 while the topic's own
   * notificationType excludes Live entirely (a "新片"-only topic sends no live
   * reminder at all) -- the stored reminders themselves are left untouched so
   * they're restored if Live is re-enabled later. */
  const getOverrideCount = useCallback(
    (topicId: TopicCatalogId) => (isLiveChannelAllowed(topicId) ? Object.keys(topicState(topicId).reminderOverrides).length : 0),
    [topicState, isLiveChannelAllowed],
  )

  /** Restores a topic's own notification type to its starting value --
   * deliberately leaves Live/New Video membership and every member's own
   * reminder untouched, since those represent who's enabled and what they
   * chose, and clearing them from a generic "reset" action would be a
   * surprising, hard-to-undo data loss. */
  const resetTopicDefaults = useCallback(
    (topicId: TopicCatalogId) => {
      setTopicState(topicId, { ...topicState(topicId), notificationType: INITIAL_TOPIC_NOTIFICATION_TYPE })
    },
    [topicState, setTopicState],
  )

  return {
    savedTopicIds: state.topicOrder,
    addTopic,
    discardUnsavedTopic,
    isLiveEnabled,
    setLiveEnabled,
    isNewVideoEnabled,
    setNewVideoEnabled,
    getMemberReminder,
    setMemberReminder,
    isReminderShadowedByAll,
    getEnabledCreatorIds,
    getNotificationType,
    setNotificationType,
    getOverrideCount,
    resetTopicDefaults,
  }
}
