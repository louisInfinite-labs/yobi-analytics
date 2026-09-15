import { useState } from "react"
import { Button, ConfigProvider, Dropdown, Select } from "antd"
import type { ConfigProviderProps, GetProp } from "antd"
import { DownOutlined, PlusOutlined } from "@ant-design/icons"
import { useLocale } from "../../hooks/useLocale"
import { useTopicNotificationPreferences } from "../../hooks/useTopicNotificationPreferences"
import { getAllNotificationCreators } from "../../lib/notificationCreatorGrouping"
import { getAvailableTopics, getSelectableTopics, type TopicCatalogId } from "../../lib/notificationTopicCatalog"
import { MEMBER_CHOICE_MODE, REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES, type TopicReminderMode } from "../../lib/notificationTopics"
import { t } from "../../i18n/translations"
import { useMemberTheme } from "../../theme/ThemeContext"
import { TopicCreatorManagementDrawer } from "./TopicCreatorManagementDrawer"

/** How many enabled creator names the compact card previews before
 * trailing off with "..." -- this feature's own spec worked example
 * (section 3) shows 4 named creators before the ellipsis. */
const MAX_PREVIEW_NAMES = 4

type WaveConfig = GetProp<ConfigProviderProps, "wave">

/** "Inset" click-wave effect -- copied verbatim from Ant Design's own
 * Button "Custom Wave" doc example (components/button/demo/wave.tsx,
 * `showInsetEffect`): a small white dot grows from the click point to
 * 200px while fading to transparent, instead of antd's default border
 * ripple. Applied only to "成員名單" (via its own nested ConfigProvider,
 * see TopicCard below) -- every other button on this page, and everywhere
 * else in the app, keeps antd's normal wave effect untouched. */
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

/** The reminder-time row -- a real, interactive Dropdown wired straight to
 * useTopicNotificationPreferences for whatever `topicId` it's given.
 * Shared between TopicCard (a saved card) and DraftTopicCard (once a topic
 * is picked, before Save) so the two are pixel- and behavior-identical --
 * confirmed with the user: after picking a topic, the draft card must let
 * the user actually configure Reminder Time, not just preview it. This
 * works safely against a not-yet-saved topicId too: setReminderMode/
 * getReminderMode already read/write lazily (see useTopicNotificationPreferences'
 * own topicState fallback), with no dependency on the id being in
 * savedTopicIds yet. */
function ReminderTimeRow({ topicId, topicLabel }: { topicId: TopicCatalogId; topicLabel: string }) {
  const [locale] = useLocale()
  const { getReminderMode, setReminderMode } = useTopicNotificationPreferences()
  const options = reminderModeOptions(locale)
  const reminderMode = getReminderMode(topicId)
  const reminderModeLabel = options.find((option) => option.value === reminderMode)?.label ?? ""

  return (
    <div className="notification-settings__topic-row">
      <span className="notification-settings__topic-row-label">{t(locale, "notificationSettings.defaultReminderLabel")}</span>
      <Dropdown
        menu={{
          items: options.map((option) => ({ key: option.value, label: option.label })),
          selectedKeys: [reminderMode],
          onClick: ({ key }) => setReminderMode(topicId, key as TopicReminderMode),
        }}
        trigger={["click"]}
        classNames={{ root: "notification-settings__reminder-popup" }}
      >
        <Button
          variant="outlined"
          color="default"
          className="notification-settings__reminder-trigger"
          icon={<DownOutlined />}
          iconPlacement="end"
          aria-label={t(locale, "notificationSettings.defaultReminderLabel") + " " + topicLabel}
        >
          {reminderModeLabel}
        </Button>
      </Dropdown>
    </div>
  )
}

/** The notified-members summary row -- a plain (non-interactive) preview;
 * actual configuration always happens in TopicCreatorManagementDrawer, via
 * the "成員名單"/Members list button next to this row. Shared between
 * TopicCard and DraftTopicCard for the same reason as ReminderTimeRow. */
function NotifiedMembersRow({ topicId }: { topicId: TopicCatalogId }) {
  const [locale] = useLocale()
  const { getEnabledCreatorIds } = useTopicNotificationPreferences()
  const enabledIds = getEnabledCreatorIds(topicId)
  const enabledCreators = getAllNotificationCreators().filter((creator) => enabledIds.has(creator.creatorId))
  const previewNames = enabledCreators.slice(0, MAX_PREVIEW_NAMES).map((creator) => creator.displayName)
  const hasMore = enabledCreators.length > MAX_PREVIEW_NAMES
  const separator = t(locale, "notificationSettings.namePreviewSeparator")

  return (
    <div className="notification-settings__topic-row notification-settings__topic-row--members">
      <span className="notification-settings__topic-row-label">{t(locale, "notificationSettings.notifiedMembersLabel")}</span>
      <div className="notification-settings__member-summary">
        <span className="notification-settings__member-count">
          {t(locale, "notificationSettings.selectedCountLabel", { count: String(enabledCreators.length) })}
        </span>
        {enabledCreators.length > 0 ? (
          <span className="notification-settings__member-preview">
            {previewNames.join(separator)}
            {hasMore ? `${separator}...` : ""}
          </span>
        ) : (
          <span className="notification-settings__member-preview notification-settings__member-preview--empty">
            {t(locale, "notificationSettings.noSelectedMembers")}
          </span>
        )}
      </div>
    </div>
  )
}

/** "成員名單"/Members list -- Ant Design's own "Inset" Custom Wave example
 * (components/button/demo/wave.tsx), scoped to just this Button via its
 * own nested ConfigProvider so no other button anywhere else in the app is
 * affected. Shared between TopicCard and DraftTopicCard: opening the
 * drawer for a not-yet-saved draft topic works exactly the same way as for
 * a saved one (the drawer/hook already treat any topicId uniformly). */
function ManageMembersButton({ topicLabel, onManage }: { topicLabel: string; onManage: () => void }) {
  const [locale] = useLocale()
  return (
    <ConfigProvider wave={{ showEffect: showInsetEffect }}>
      <Button
        type="primary"
        size="small"
        className="notification-settings__manage-button"
        onClick={onManage}
        aria-label={`${t(locale, "notificationSettings.manageMembersButton")} ${topicLabel}`}
      >
        {t(locale, "notificationSettings.manageMembersButton")} <span aria-hidden="true">›</span>
      </Button>
    </ConfigProvider>
  )
}

function TopicCard({ topicId, onManage }: { topicId: TopicCatalogId; onManage: () => void }) {
  const [locale] = useLocale()
  const topicDef = getAvailableTopics().find((entry) => entry.id === topicId)!
  const topicLabel = t(locale, topicDef.labelKey)

  return (
    <section className="notification-settings__topic-card">
      <h2 className="notification-settings__topic-title">{topicLabel}</h2>
      <ReminderTimeRow topicId={topicId} topicLabel={topicLabel} />
      <NotifiedMembersRow topicId={topicId} />
      <ManageMembersButton topicLabel={topicLabel} onManage={onManage} />
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
 * Members must be genuinely configurable here (ReminderTimeRow/
 * ManageMembersButton reused verbatim from TopicCard), not disabled/inert.
 * This is safe against a not-yet-saved topicId (see those components' own
 * comments) -- Save's only actual job is to add this topicId to
 * savedTopicIds, making the card permanent; whatever reminder/member
 * config was already made stays exactly as configured. */
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
          <NotifiedMembersRow topicId={selectedTopicId} />

          {/* Members list on the left, Save on the right (confirmed with
           * the user) -- same button size/style as everywhere else on this
           * page, just laid out as a row instead of one lone button. */}
          <div className="notification-settings__topic-card-actions">
            <ManageMembersButton topicLabel={selectedTopicLabel} onManage={onManage} />
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
 * real card (not a separate toolbar). An antd Button (variant="dashed"),
 * matching antd's own established "add new item" look, rather than a
 * hand-built control. */
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
      <PlusOutlined aria-hidden="true" />
    </Button>
  )
}

/** Notification Settings' own content: a topic-centered summary per topic
 * (this feature's own spec sections 2/3/14) -- never the full ~122-creator
 * roster permanently on screen. Each topic card shows its own default
 * reminder time and a compact "who's enabled" summary; the full creator
 * roster (Agency > Region > Generation/Unit, Favorites-first, searchable)
 * only ever renders inside TopicCreatorManagementDrawer, opened per topic
 * via "成員名單".
 *
 * Topics are now a dynamic, user-added list (confirmed with the user,
 * replacing the old fixed 8-topic set): the page starts with one
 * pre-existing saved card (VALO), and "+"/Save (below) let the user add
 * more from a catalog, one at a time, no duplicates. */
export function NotificationSettings() {
  const { theme } = useMemberTheme()
  const [managingTopicId, setManagingTopicId] = useState<TopicCatalogId | null>(null)
  const { savedTopicIds, addTopic } = useTopicNotificationPreferences()

  // At most one draft at a time (confirmed with the user) -- plain
  // component state, not shared/persisted: an in-progress, not-yet-saved
  // pick has no reason to survive a reload. `topicId: null` distinguishes
  // "a draft card is open, nothing picked yet" from "no draft at all"
  // (the `active` flag) -- see saveDraft's own guard below.
  const [draft, setDraft] = useState<{ active: boolean; topicId: TopicCatalogId | null }>({ active: false, topicId: null })

  const startDraft = () => setDraft({ active: true, topicId: null })
  // Only ever updates the LOCAL draft -- never calls addTopic. Picking an
  // option must not immediately persist (confirmed with the user); only
  // the explicit Save action below does.
  const selectDraftTopic = (topicId: TopicCatalogId) => setDraft({ active: true, topicId })
  const saveDraft = () => {
    if (draft.topicId === null) return
    addTopic(draft.topicId)
    setDraft({ active: false, topicId: null }) // clears the draft and re-enables "+" together
  }

  return (
    <ConfigProvider theme={{ token: { colorPrimary: theme.primary } }}>
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
            selectableTopics={getSelectableTopics(savedTopicIds)}
            onSelectTopic={selectDraftTopic}
            onManage={() => setManagingTopicId(draft.topicId)}
            onSave={saveDraft}
          />
        ) : (
          <AddTopicTile onClick={startDraft} />
        )}
        <TopicCreatorManagementDrawer topicId={managingTopicId} onClose={() => setManagingTopicId(null)} />
      </div>
    </ConfigProvider>
  )
}
