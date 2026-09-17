import { useEffect, useRef, useState } from "react"
import { Button, ConfigProvider, Segmented, Select, Tooltip } from "antd"
import type { ConfigProviderProps, GetProp } from "antd"
import { ChevronRight, Clock3, Gamepad2, Plus, Users } from "lucide-react"
import { useLocale } from "../../hooks/useLocale"
import { useTopicNotificationPreferences } from "../../hooks/useTopicNotificationPreferences"
import { getAllNotificationCreators } from "../../lib/notificationCreatorGrouping"
import { getAvailableTopics, getSelectableTopics, type TopicCatalogId } from "../../lib/notificationTopicCatalog"
import { MEMBER_CHOICE_MODE, REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES, type TopicReminderMode } from "../../lib/notificationTopics"
import { t } from "../../i18n/translations"
import { TopicCreatorManagementDrawer } from "./TopicCreatorManagementDrawer"

const NOTIFICATION_ACCENT = "#c779a3"

/** How many enabled creator names the Notification Members row's own hover
 * tooltip previews before trailing off with "..." -- this feature's own
 * spec worked example (section 3) shows 4 named creators before the
 * ellipsis. The redesigned row itself only shows the count (confirmed by
 * the redesign's own "4 selected >" structure); the full name preview this
 * page used to show inline moved into a Tooltip on that count instead of
 * being dropped, so the information is still one hover away rather than
 * gone. */
const MAX_PREVIEW_NAMES = 4

type WaveConfig = GetProp<ConfigProviderProps, "wave">

/** "Inset" click-wave effect -- copied verbatim from Ant Design's own
 * Button "Custom Wave" doc example (components/button/demo/wave.tsx,
 * `showInsetEffect`): a small white dot grows from the click point to
 * 200px while fading to transparent, instead of antd's default border
 * ripple. Applied only to the Notification Members row (via its own nested
 * ConfigProvider, see MembersRow below) -- every other button on this
 * page, and everywhere else in the app, keeps antd's normal wave effect
 * untouched. */
const showInsetEffect: NonNullable<WaveConfig>["showEffect"] = (node, { event, component }) => {
  if (component !== "Button") return

  const { borderWidth } = getComputedStyle(node)
  const borderWidthNum = Number.parseInt(borderWidth, 10)

  const holder = document.createElement("div")
  holder.style.position = "absolute"
  holder.style.inset = `-${borderWidthNum}px`
  holder.style.borderRadius = "inherit"
  holder.style.background = "transparent"
  holder.style.zIndex = "999"
  holder.style.pointerEvents = "none"
  holder.style.overflow = "hidden"
  node.appendChild(holder)

  const rect = holder.getBoundingClientRect()
  const dot = document.createElement("div")
  dot.style.position = "absolute"
  dot.style.insetInlineStart = `${event.clientX - rect.left}px`
  dot.style.top = `${event.clientY - rect.top}px`
  dot.style.width = "0px"
  dot.style.height = "0px"
  dot.style.borderRadius = "50%"
  dot.style.background = "rgba(255, 255, 255, 0.65)"
  dot.style.transform = "translate3d(-50%, -50%, 0)"
  dot.style.transition = "all 1s ease-out"
  holder.appendChild(dot)

  requestAnimationFrame(() => {
    dot.ontransitionend = () => holder.remove()
    dot.style.width = "200px"
    dot.style.height = "200px"
    dot.style.opacity = "0"
  })
}

/** Every reminder-mode option a topic card's own reminder-time control can
 * show -- shared between TopicCard (real) and DraftTopicCard (preview)
 * once a topic is picked, so the two never drift out of sync. "各成員為準"
 * listed last, per the user's own confirmed ordering. */
function reminderModeOptions(locale: ReturnType<typeof useLocale>[0]) {
  return [
    ...REMINDER_TIME_VALUES.map((value) => ({ value, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) })),
    { value: MEMBER_CHOICE_MODE, label: t(locale, "notificationSettings.topicReminderMode.memberChoice") },
  ]
}

/** The reminder-time row -- a real, interactive Segmented wired straight to
 * useTopicNotificationPreferences for whatever `topicId` it's given, all
 * choices visible at once instead of behind a menu (presentation change
 * only -- same underlying TopicReminderMode values, same
 * getReminderMode/setReminderMode). Shared between TopicCard (a saved
 * card) and DraftTopicCard (once a topic is picked, before Save) so the
 * two are pixel- and behavior-identical. This works safely against a
 * not-yet-saved topicId too: setReminderMode/getReminderMode already
 * read/write lazily (see useTopicNotificationPreferences' own topicState
 * fallback), with no dependency on the id being in savedTopicIds yet. */
function ReminderTimeRow({ topicId, topicLabel }: { topicId: TopicCatalogId; topicLabel: string }) {
  const [locale] = useLocale()
  const { getReminderMode, setReminderMode } = useTopicNotificationPreferences()
  const options = reminderModeOptions(locale)
  const reminderMode = getReminderMode(topicId)

  return (
    <div className="notification-settings__group">
      <span className="notification-settings__group-label">
        <Clock3 size={14} aria-hidden="true" />
        {t(locale, "notificationSettings.defaultReminderLabel")}
      </span>
      <Segmented
        size="small"
        className="notification-settings__reminder-segmented"
        value={reminderMode}
        options={options}
        onChange={(value) => setReminderMode(topicId, value as TopicReminderMode)}
        aria-label={t(locale, "notificationSettings.defaultReminderLabel") + " " + topicLabel}
      />
    </div>
  )
}

/** The Notification Members entry -- one interactive row (icon, label,
 * selected count, chevron) that IS the "manage members" affordance, not a
 * separate preview row plus a separate button below it (confirmed by the
 * redesign's own "[Users icon] Notification Members    4 selected >"
 * structure). Still a real antd Button under the hood (block, type="text",
 * restyled via .notification-settings__members-row) so it keeps antd's
 * click/focus semantics -- clicking it opens the exact same
 * TopicCreatorManagementDrawer as before, for the same topicId; nothing
 * about the drawer or the underlying enabled-members data changes here.
 * Shared between TopicCard and DraftTopicCard: opening the drawer for a
 * not-yet-saved draft topic works exactly the same way as for a saved one
 * (the drawer/hook already treat any topicId uniformly). */
function MembersRow({ topicId, topicLabel, onManage }: { topicId: TopicCatalogId; topicLabel: string; onManage: () => void }) {
  const [locale] = useLocale()
  const { getEnabledCreatorIds } = useTopicNotificationPreferences()
  const enabledIds = getEnabledCreatorIds(topicId)
  const enabledCreators = getAllNotificationCreators().filter((creator) => enabledIds.has(creator.creatorId))
  const previewNames = enabledCreators.slice(0, MAX_PREVIEW_NAMES).map((creator) => creator.displayName)
  const hasMore = enabledCreators.length > MAX_PREVIEW_NAMES
  const separator = t(locale, "notificationSettings.namePreviewSeparator")
  const previewText = enabledCreators.length > 0 ? `${previewNames.join(separator)}${hasMore ? `${separator}...` : ""}` : t(locale, "notificationSettings.noSelectedMembers")

  return (
    <ConfigProvider wave={{ showEffect: showInsetEffect }}>
      <Tooltip title={previewText} placement="bottom">
        <Button
          type="text"
          block
          className="notification-settings__members-row"
          onClick={onManage}
          aria-label={`${t(locale, "notificationSettings.manageMembersButton")} ${topicLabel}`}
        >
          <span className="notification-settings__group-label">
            <Users size={14} aria-hidden="true" />
            {t(locale, "notificationSettings.notifiedMembersLabel")}
          </span>
          <span className="notification-settings__members-row-value">
            <span className="notification-settings__member-count">
              {t(locale, "notificationSettings.selectedCountLabel", { count: String(enabledCreators.length) })}
            </span>
            <ChevronRight size={16} aria-hidden="true" className="notification-settings__members-row-chevron" />
          </span>
        </Button>
      </Tooltip>
    </ConfigProvider>
  )
}

function TopicCard({ topicId, onManage }: { topicId: TopicCatalogId; onManage: () => void }) {
  const [locale] = useLocale()
  const topicDef = getAvailableTopics().find((entry) => entry.id === topicId)!
  const topicLabel = t(locale, topicDef.labelKey)

  return (
    <section className="notification-settings__topic-card">
      <h2 className="notification-settings__topic-title">
        <Gamepad2 size={16} aria-hidden="true" />
        {topicLabel}
      </h2>
      <ReminderTimeRow topicId={topicId} topicLabel={topicLabel} />
      <MembersRow topicId={topicId} topicLabel={topicLabel} onManage={onManage} />
    </section>
  )
}

/** The one card in "draft" state at a time (see NotificationSettings' own
 * `draft` state below) -- occupies the exact next grid slot a saved
 * TopicCard would, same box/row styling, but its topic identity is still
 * being picked (confirmed with the user: selection only, no free text) and
 * the CARD ITSELF isn't persisted (added to savedTopicIds) until Save.
 *
 * Once a topic is picked, the rest of the card is the real thing, not a
 * preview -- confirmed with the user: Reminder Time and Notification
 * Members must be genuinely configurable here (ReminderTimeRow/MembersRow
 * reused verbatim from TopicCard), not disabled/inert. This is safe
 * against a not-yet-saved topicId (see those components' own comments) --
 * Save's only actual job is to add this topicId to savedTopicIds, making
 * the card permanent; whatever reminder/member config was already made
 * stays exactly as configured. */
function DraftTopicCard({
  selectedTopicId,
  selectableTopics,
  onSelectTopic,
  onManage,
  onSave,
}: {
  selectedTopicId: TopicCatalogId | null
  selectableTopics: ReturnType<typeof getSelectableTopics>
  onSelectTopic: (topicId: TopicCatalogId) => void
  onManage: () => void
  onSave: () => void
}) {
  const [locale] = useLocale()
  const selectOptions = selectableTopics.map((topic) => ({ value: topic.id, label: t(locale, topic.labelKey) }))
  const selectedTopicLabel = selectedTopicId === null ? "" : t(locale, getAvailableTopics().find((entry) => entry.id === selectedTopicId)!.labelKey)

  return (
    <section className="notification-settings__topic-card notification-settings__topic-card--draft">
      <Select
        className="notification-settings__topic-select"
        placeholder={t(locale, "notificationSettings.topicSelectPlaceholder")}
        aria-label={t(locale, "notificationSettings.topicSelectAriaLabel")}
        value={selectedTopicId ?? undefined}
        options={selectOptions}
        onChange={(value: TopicCatalogId) => onSelectTopic(value)}
      />

      {selectedTopicId !== null && (
        <>
          <ReminderTimeRow topicId={selectedTopicId} topicLabel={selectedTopicLabel} />
          <MembersRow topicId={selectedTopicId} topicLabel={selectedTopicLabel} onManage={onManage} />

          <div className="notification-settings__topic-card-actions">
            <Button type="primary" size="small" onClick={onSave}>
              {t(locale, "notificationSettings.saveTopicButton")}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

/** The "+" tile -- confirmed with the user: renders AS a grid item, in the
 * next open slot right after the last saved card, same box styling as a
 * real card (not a separate toolbar). Still an antd Button (variant=
 * "dashed"), preserving antd's own click/focus/wave interaction untouched
 * -- only the visual treatment (icon-in-a-ring + label, esports-card
 * accent) changes, matching the redesigned cards instead of a generic
 * dashed admin box. */
function AddTopicTile({ onClick }: { onClick: () => void }) {
  const [locale] = useLocale()
  return (
    <Button
      variant="dashed"
      block
      className="notification-settings__topic-card notification-settings__add-topic-tile"
      onClick={onClick}
      aria-label={t(locale, "notificationSettings.addTopicButtonAriaLabel")}
    >
      <span className="notification-settings__add-topic-icon">
        <Plus size={18} aria-hidden="true" />
      </span>
      {t(locale, "notificationSettings.addTopicButtonAriaLabel")}
    </Button>
  )
}

/** Notification Settings' own content: a topic-centered summary per topic
 * (this feature's own spec sections 2/3/14) -- never the full ~122-creator
 * roster permanently on screen. Each topic card shows its own default
 * reminder time and a compact "who's enabled" summary; the full creator
 * roster (Agency > Region > Generation/Unit, Favorites-first, searchable)
 * only ever renders inside TopicCreatorManagementDrawer, opened per topic
 * via the Notification Members row.
 *
 * Topics are now a dynamic, user-added list (confirmed with the user,
 * replacing the old fixed 8-topic set): the page starts with 5 permanent
 * default cards, and "+"/Save (below) let the user add more from a
 * catalog, one at a time, no duplicates. This redesign only restyles this
 * component -- topic ordering, reminder values, member-selection logic,
 * Local Storage behavior, and the Drawer itself are all unchanged. */
export function NotificationSettings() {
  const [managingTopicId, setManagingTopicId] = useState<TopicCatalogId | null>(null)
  const { savedTopicIds, addTopic, discardUnsavedTopic } = useTopicNotificationPreferences()

  // At most one draft at a time (confirmed with the user) -- plain
  // component state, not shared/persisted: an in-progress, not-yet-saved
  // pick has no reason to survive a reload. `topicId: null` distinguishes
  // "a draft card is open, nothing picked yet" from "no draft at all"
  // (the `active` flag) -- see saveDraft's own guard below.
  const [draft, setDraft] = useState<{ active: boolean; topicId: TopicCatalogId | null }>({ active: false, topicId: null })
  const draftTopicIdRef = useRef<TopicCatalogId | null>(null)
  const selectableTopics = getSelectableTopics(savedTopicIds)

  useEffect(
    () => () => {
      if (draftTopicIdRef.current !== null) discardUnsavedTopic(draftTopicIdRef.current)
    },
    [discardUnsavedTopic],
  )

  const startDraft = () => {
    draftTopicIdRef.current = null
    setDraft({ active: true, topicId: null })
  }
  // Only ever updates the LOCAL draft -- never calls addTopic. Picking an
  // option must not immediately persist (confirmed with the user); only
  // the explicit Save action below does.
  const selectDraftTopic = (topicId: TopicCatalogId) => {
    if (draft.topicId !== null && draft.topicId !== topicId) discardUnsavedTopic(draft.topicId)
    draftTopicIdRef.current = topicId
    setDraft({ active: true, topicId })
  }
  const saveDraft = () => {
    if (draft.topicId === null) return
    addTopic(draft.topicId)
    draftTopicIdRef.current = null
    setDraft({ active: false, topicId: null }) // clears the draft and re-enables "+" together
  }

  return (
    <ConfigProvider
      theme={{
        token: { colorPrimary: NOTIFICATION_ACCENT },
        components: {
          // Segmented/Select popups are portaled outside this page's own
          // dark-scoped DOM subtree, so the --notif-page-* CSS custom
          // properties (settings.css) can't reach them -- themed here via
          // antd's own component tokens instead, matching the same dark,
          // single-accent palette as Main Oshi Settings.
          Segmented: {
            trackBg: "#211d29",
            itemColor: "#b9b1c5",
            itemHoverColor: "#f3eff7",
            itemHoverBg: "color-mix(in srgb, #f3eff7 8%, transparent)",
            itemSelectedBg: "#684052",
            itemSelectedColor: "#f7edf3",
          },
          Select: {
            colorBgContainer: "#292432",
            colorBorder: "#393342",
            colorText: "#f3eff7",
            colorTextPlaceholder: "#948b9f",
            colorBgElevated: "#211d29",
            optionSelectedBg: "rgba(199, 121, 163, 0.18)",
            colorTextQuaternary: "#948b9f",
          },
        },
      }}
    >
      <div className="notification-settings">
        {savedTopicIds.map((topicId) => (
          <TopicCard key={topicId} topicId={topicId} onManage={() => setManagingTopicId(topicId)} />
        ))}
        {/* Exactly one of these renders in the next grid slot -- this
         * ternary alone guarantees only one draft can ever exist and that
         * "+" is unusable while one does (no separate `disabled` flag
         * needed: there's simply nothing to click). */}
        {draft.active ? (
          <DraftTopicCard
            selectedTopicId={draft.topicId}
            selectableTopics={selectableTopics}
            onSelectTopic={selectDraftTopic}
            onManage={() => setManagingTopicId(draft.topicId)}
            onSave={saveDraft}
          />
        ) : selectableTopics.length > 0 ? (
          <AddTopicTile onClick={startDraft} />
        ) : null}
        <TopicCreatorManagementDrawer topicId={managingTopicId} onClose={() => setManagingTopicId(null)} />
      </div>
    </ConfigProvider>
  )
}
