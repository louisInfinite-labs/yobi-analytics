import { useCallback } from "react"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"
import { deleteCreatorReminder, reminderValueToSetting, saveCreatorReminder } from "../api/liveReminderApi"
import { saveNotificationPreference } from "../api/notificationPreferenceApi"
import { getPushSubscriptionStatus } from "../push/pushNotifications"
import { clearNotificationSaveFailed, reportNotificationSaveFailed } from "./notificationSaveStatus"
import {
  ALL_TOPICS_ID,
  isPermanentTopic,
  isShortCard,
  LEGACY_TOPIC_ID_ALIASES,
  PERMANENT_TOPIC_IDS,
  RETIRED_TOPIC_IDS,
  SHORT_TOPIC_ID,
  type TopicCatalogId,
} from "../model/notificationTopicCatalog"
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
const INITIAL_SAVED_TOPIC_IDS: readonly TopicCatalogId[] = PERMANENT_TOPIC_IDS

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
  /** Set by the load-time migration when a retired card (see migrateStoredTopicOrder) had members that enabled new videos: the backend
   * still holds those creators' per-creator switches, so the preference must be re-sent once (resyncAfterRetiredMigration) even if the
   * user never opens Settings. Cleared by that re-send; absent otherwise. */
  pendingResync?: boolean
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

/** The one place a stored card list is migrated: ids are mapped to their canonical form (valo -> valorant), and a card for a
 * RETIRED notification-only category (GTA, 7 Days to Die, Mahjong Soul, Endfield -- see RETIRED_TOPIC_IDS) is intentionally dropped.
 * A dropped card takes only its OWN state with it (its members, reminders and type, because the state of an id that is not in the
 * list is not read); every other card, and every Short member, is untouched. Order of the survivors is preserved. */
export function migrateStoredTopicOrder(storedIds: readonly string[]): string[] {
  return storedIds.map(canonicalTopicId).filter((id) => !RETIRED_TOPIC_IDS.has(id))
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
    // The selectable categories are Home's backend-driven list (loaded at runtime), so a stored id is only dropped when it is
    // one of the retired notification-only categories (see migrateStoredTopicOrder).
    const savedTopicOrder = Array.isArray(parsed.topicOrder)
      ? migrateStoredTopicOrder(parsed.topicOrder.filter((id): id is string => typeof id === "string"))
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
    // The backend keeps only per-creator switches (no topic ids), so what a retired card contributed is only cleaned there by a re-send.
    const storedOrder = Array.isArray(parsed.topicOrder) ? parsed.topicOrder.filter((id): id is string => typeof id === "string").map(canonicalTopicId) : []
    const retiredContributedNewVideos = Object.entries(parsed.topics ?? {}).some(([storedId, saved]) => {
      const id = canonicalTopicId(storedId)
      if (!RETIRED_TOPIC_IDS.has(id) || !storedOrder.includes(id) || !saved) return false
      const card = readTopicState(saved)
      return card.notificationType !== "live" && card.newVideo.length > 0
    })
    const pendingResync = retiredContributedNewVideos || (parsed as { pendingResync?: unknown }).pendingResync === true
    return pendingResync ? { topicOrder, topics, pendingResync: true } : { topicOrder, topics }
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

/** Writes ONE creator's reminder for ONE topic to the backend (src/notifications/live_reminder.py): a single
 * backend item per (creator, topic), so it can never touch another topic's, another creator's, or the 全部
 * reminder. `value === null` (unset) deletes just that item. Rejects when the backend rejects. */
function writeReminderToBackend(topicId: TopicCatalogId, creatorId: string, value: ReminderSetting): Promise<void> {
  return value === null ? deleteCreatorReminder(creatorId, topicId) : saveCreatorReminder(creatorId, topicId, reminderValueToSetting(value))
}

// Module-scoped singleton (see lib/sharedState.ts), same reactivity
// reasoning as useFavoriteCreators/useCreatorNotificationPreferences.
// localStorage holds the LAST CONFIRMED state: reminders and the per-creator
// 新片 switches reach it only after the backend accepted the change (see
// runSerialized below), so a reload never resurrects a write that failed.
const topicPreferencesStore = createSharedState(STORAGE_KEY, readState, serializeState)

/** Creators whose new-video notifications are ON: enabled for new video in at least one SAVED topic whose
 * notification type allows new videos (the same rule getEnabledCreatorIds applies to its new-video half).
 * The backend only knows "this creator, yes/no" -- it has no topics for new-video events -- so this union is
 * what gets sent as `newVideoCreatorOverride`. */
export function effectiveNewVideoCreatorIds(state: TopicPreferencesState): Set<string> {
  const ids = new Set<string>()
  for (const topicId of state.topicOrder) {
    if (isShortCard(topicId)) continue // Short is a format, not a topic: its members never enable ordinary new videos
    const topic = state.topics[topicId] ?? emptyTopicState()
    if (topic.notificationType === "live") continue
    for (const creatorId of topic.newVideo) ids.add(creatorId)
  }
  return ids
}

/** The current effective new-video creators (see effectiveNewVideoCreatorIds), for writers outside this hook. */
export function getEffectiveNewVideoCreatorIds(): Set<string> {
  return effectiveNewVideoCreatorIds(topicPreferencesStore.get())
}

/** Creators whose SHORTS notify: the members enabled in the saved Short card. No Short card, or a card with no members, is the empty
 * set -- Short OFF, the default. Sent as the backend's separate `newVideoShortCreatorOverride` field, never as a topic. */
export function effectiveShortCreatorIds(state: TopicPreferencesState): Set<string> {
  if (!state.topicOrder.includes(SHORT_TOPIC_ID)) return new Set()
  return new Set(state.topics[SHORT_TOPIC_ID]?.newVideo ?? [])
}

/** The current effective Short creators (see effectiveShortCreatorIds), for writers outside this hook. */
export function getEffectiveShortCreatorIds(): Set<string> {
  return effectiveShortCreatorIds(topicPreferencesStore.get())
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id))
}

/** Applies `change` to one topic's state against the LATEST store value (an earlier await may have let another
 * change land, so a stale closure copy must never be written back). */
function commitTopic(topicId: TopicCatalogId, change: (topic: TopicPreferenceState) => TopicPreferenceState): void {
  const current = topicPreferencesStore.get()
  const topic = current.topics[topicId] ?? emptyTopicState()
  topicPreferencesStore.set({ ...current, topics: { ...current.topics, [topicId]: change(topic) } })
}

const saveQueues = new Map<string, Promise<boolean>>()

/** Runs `task` -- the backend write followed by the local commit -- after any earlier task with the same key has
 * settled, so two quick changes to the same setting reach the backend (and the local store) in click order.
 * Resolves true when the task committed. If it rejects nothing was committed: the failure is reported (the
 * drawer shows an inline alert) and the local state stays at the last confirmed value. */
function runSerialized(key: string, task: () => Promise<void>, options: { silent?: boolean } = {}): Promise<boolean> {
  const previous = saveQueues.get(key) ?? Promise.resolve(true)
  const result = previous.then(task).then(
    () => {
      if (!options.silent) clearNotificationSaveFailed()
      return true
    },
    () => {
      // A silent (background) task never raises the Settings "couldn't save" banner for a change the user did not make.
      if (!options.silent) reportNotificationSaveFailed()
      return false
    },
  )
  saveQueues.set(key, result)
  return result
}

const NEW_VIDEO_SYNC_KEY = "newVideoSwitches"

/** Pushes the new effective new-video creators to the backend -- but only when this browser has notifications
 * enabled (a push subscription exists). Otherwise there is no backend preference to update, and the enable flow
 * (NotificationToggle) sends the current switches along with the master switch. Rejects when the backend does. */
async function syncNewVideoSwitchesToBackend(next: TopicPreferencesState, options: { rejectWhenStatusUnreadable?: boolean } = {}): Promise<void> {
  let status: Awaited<ReturnType<typeof getPushSubscriptionStatus>>
  try {
    status = await getPushSubscriptionStatus()
  } catch (error) {
    // An unreadable status normally means "nothing to sync". The one-time clean-up must NOT treat it as done, or the retired creators'
    // backend switches would never be cleared: it rejects so the pending flag survives for the next start.
    if (options.rejectWhenStatusUnreadable) throw error
    return
  }
  if (status !== "subscribed") return
  await saveNotificationPreference(true, effectiveNewVideoCreatorIds(next), effectiveShortCreatorIds(next))
}

/** One-time clean-up after the load-time migration dropped a retired card whose members had enabled new videos: re-sends the current
 * preference so the backend stops holding those creators' per-creator switches, with NO Settings visit needed. Only when this browser
 * has notifications enabled (otherwise the backend preference is OFF and the enable flow sends the migrated state). Silent: a failure
 * keeps the pending flag so the next app start retries, and never shows the Settings error banner. Resolves true when nothing is pending. */
export function resyncAfterRetiredMigration(): Promise<boolean> {
  if (!topicPreferencesStore.get().pendingResync) return Promise.resolve(true)
  return runSerialized(
    NEW_VIDEO_SYNC_KEY,
    async () => {
      const current = topicPreferencesStore.get()
      if (!current.pendingResync) return
      await syncNewVideoSwitchesToBackend(current, { rejectWhenStatusUnreadable: true })
      const { pendingResync: _done, ...rest } = current
      topicPreferencesStore.set(rest)
    },
    { silent: true },
  )
}

/** Changes one topic's state; if that changes which creators are effectively ON for new video, the backend
 * preference is written FIRST and the local state only follows once it succeeded. */
function changeTopicWithNewVideoSync(topicId: TopicCatalogId, change: (topic: TopicPreferenceState) => TopicPreferenceState): Promise<boolean> {
  return runSerialized(NEW_VIDEO_SYNC_KEY, async () => {
    const current = topicPreferencesStore.get()
    const topic = current.topics[topicId] ?? emptyTopicState()
    const proposed = { ...current, topics: { ...current.topics, [topicId]: change(topic) } }
    const changed =
      !sameIds(effectiveNewVideoCreatorIds(current), effectiveNewVideoCreatorIds(proposed)) ||
      !sameIds(effectiveShortCreatorIds(current), effectiveShortCreatorIds(proposed))
    if (changed) await syncNewVideoSwitchesToBackend(proposed)
    commitTopic(topicId, change)
  })
}

export function useTopicNotificationPreferences() {
  const [state, setState] = useSharedState(topicPreferencesStore)

  const topicState = useCallback(
    (topicId: TopicCatalogId): TopicPreferenceState => {
      const topic = state.topics[topicId] ?? emptyTopicState()
      // A Shorts card has no live channel (a Short is a video), so it is always "new video" only.
      return isShortCard(topicId) ? { ...topic, notificationType: "newVideo" } : topic
    },
    [state],
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

  /** Removes a card the user added (never one of the permanent defaults). Everything the card owned goes with it, backend FIRST:
   * its per-creator reminders are deleted from the backend, and when its members were what enabled new videos (or, for the
   * Short card, Shorts) the preference is rewritten without them, so "no Short card" really means Short OFF. A rejected write
   * leaves the card in place and is reported; re-adding the card later starts empty. */
  const removeTopic = useCallback((topicId: TopicCatalogId): Promise<boolean> => {
    if (isPermanentTopic(topicId)) return Promise.resolve(false)
    return runSerialized(NEW_VIDEO_SYNC_KEY, async () => {
      const current = topicPreferencesStore.get()
      if (!current.topicOrder.includes(topicId)) return
      for (const creatorId of Object.keys(current.topics[topicId]?.reminderOverrides ?? {})) {
        await writeReminderToBackend(topicId, creatorId, null)
      }
      const topics = { ...current.topics }
      delete topics[topicId]
      const proposed: TopicPreferencesState = { topicOrder: current.topicOrder.filter((id) => id !== topicId), topics }
      const changed =
        !sameIds(effectiveNewVideoCreatorIds(current), effectiveNewVideoCreatorIds(proposed)) ||
        !sameIds(effectiveShortCreatorIds(current), effectiveShortCreatorIds(proposed))
      if (changed) await syncNewVideoSwitchesToBackend(proposed)
      topicPreferencesStore.set(proposed)
    })
  }, [])

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
   * creators. When a reminder has to be deleted that happens on the backend
   * FIRST: if it fails, Live stays ON and the failure is reported. */
  const setLiveEnabled = useCallback((topicId: TopicCatalogId, creatorId: string, enabled: boolean): Promise<boolean> => {
    const change = (topic: TopicPreferenceState): TopicPreferenceState => ({
      ...topic,
      live: enabled ? [...new Set([...topic.live, creatorId])] : topic.live.filter((id) => id !== creatorId),
      reminderOverrides: enabled ? topic.reminderOverrides : Object.fromEntries(Object.entries(topic.reminderOverrides).filter(([id]) => id !== creatorId)),
    })
    const hadReminder = creatorId in (topicPreferencesStore.get().topics[topicId]?.reminderOverrides ?? {})
    if (enabled || !hadReminder) {
      commitTopic(topicId, change)
      return Promise.resolve(true)
    }
    return runSerialized(`reminder:${topicId}:${creatorId}`, async () => {
      await writeReminderToBackend(topicId, creatorId, null)
      commitTopic(topicId, change)
    })
  }, [])

  const isNewVideoEnabled = useCallback((topicId: TopicCatalogId, creatorId: string) => topicState(topicId).newVideo.includes(creatorId), [topicState])

  /** Turns this creator's new-video notification ON/OFF for this topic. The backend preference is written first
   * (when notifications are enabled on this browser); a rejected write leaves the switch where it was. */
  const setNewVideoEnabled = useCallback(
    (topicId: TopicCatalogId, creatorId: string, enabled: boolean): Promise<boolean> =>
      changeTopicWithNewVideoSync(topicId, (topic) => ({
        ...topic,
        newVideo: enabled ? [...new Set([...topic.newVideo, creatorId])] : topic.newVideo.filter((id) => id !== creatorId),
      })),
    [],
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
   * merely shadowed (see isReminderShadowedByAll) until 全部 is unset. The backend write
   * comes first; a rejected write leaves the previous (last confirmed) reminder in place. */
  const setMemberReminder = useCallback(
    (topicId: TopicCatalogId, creatorId: string, value: ReminderSetting): Promise<boolean> =>
      runSerialized(`reminder:${topicId}:${creatorId}`, async () => {
        await writeReminderToBackend(topicId, creatorId, value)
        commitTopic(topicId, (topic) => {
          const reminderOverrides = { ...topic.reminderOverrides }
          if (value === null) delete reminderOverrides[creatorId]
          else reminderOverrides[creatorId] = value
          return { ...topic, reminderOverrides }
        })
      }),
    [],
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

  /** Changing a topic's notification type can switch its new-video half on/off, so it goes through the same
   * backend-first path as the per-creator 新片 switches. */
  const setNotificationType = useCallback(
    (topicId: TopicCatalogId, type: TopicNotificationType): Promise<boolean> =>
      changeTopicWithNewVideoSync(topicId, (topic) => ({ ...topic, notificationType: type })),
    [],
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
    (topicId: TopicCatalogId): Promise<boolean> =>
      changeTopicWithNewVideoSync(topicId, (topic) => ({ ...topic, notificationType: INITIAL_TOPIC_NOTIFICATION_TYPE })),
    [],
  )

  return {
    savedTopicIds: state.topicOrder,
    addTopic,
    removeTopic,
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
