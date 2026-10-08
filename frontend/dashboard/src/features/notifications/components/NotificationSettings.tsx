import { useEffect, useMemo, useRef, useState } from "react"
import { Button, ConfigProvider, Segmented, Select } from "antd"
import { Users } from "lucide-react"
// Topic-card-only pass (confirmed with the user): the left topic-list's own
// meta icons and Add Topic icon move to Phosphor for a closer iOS/SF-
// Symbols visual match; the Manage Members button's icon (detail panel,
// out of this pass's scope) stays on lucide-react's Users, hence both
// libraries' icon imports coexisting in this file for now.
import { PlusIcon, SlidersHorizontalIcon, UsersThreeIcon } from "@phosphor-icons/react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useTopicNotificationPreferences } from "../hooks/useTopicNotificationPreferences"
import { getAllNotificationCreators, type NotificationCreator } from "../model/notificationCreatorGrouping"
import { getAvailableTopics, getSelectableTopics, type TopicCatalogId } from "../model/notificationTopicCatalog"
import type { TopicNotificationType } from "../model/notificationTopics"
import { t, type Locale } from "../../../shared/i18n/translations"
import { TopicCreatorManagementDrawer } from "./TopicCreatorManagementDrawer"

const NOTIFICATION_ACCENT = "#5a5261"

/** How many member avatars the Notification Members section previews
 * before folding the rest into a "+N" bubble -- keeps the row bounded on
 * a topic with the whole ~122-creator roster enabled. */
const MAX_AVATAR_PREVIEW = 8

type SortMode = "saved" | "alphabetical"

function topicLabelFor(locale: Locale, topicId: TopicCatalogId): string {
  const topicDef = getAvailableTopics().find((entry) => entry.id === topicId)
  return topicDef ? t(locale, topicDef.labelKey) : ""
}

/** One combined "which kinds of notification this topic sends" control
 * (直播/新片/兩者) -- a topic-level preference alongside, not instead of,
 * each creator's own Live/New Video switches in the management drawer;
 * those keep deciding who is actually notified. */
function NotificationTypeSection({ topicId, topicLabel }: { topicId: TopicCatalogId; topicLabel: string }) {
  const [locale] = useLocale()
  const { getNotificationType, setNotificationType } = useTopicNotificationPreferences()

  return (
    <section className="notification-detail-section">
      <h3 className="notification-detail-section__title">{t(locale, "notificationSettings.notificationTypeLabel")}</h3>
      <p className="notification-detail-section__description">{t(locale, "notificationSettings.notificationTypeSectionHelp")}</p>
      <Segmented
        name={`notification-type-${topicId}`}
        className="notification-type-control"
        value={getNotificationType(topicId)}
        options={[
          // Order confirmed with the user: combined option first, then Live,
          // then New Video -- notificationTypeCombinedLabel is its own key
          // (not the shared notificationTypeBoth) so the drawer's own
          // "Notification type: 兩者" context line, which also reads
          // notificationTypeBoth, is unaffected by this control's label.
          { value: "both", label: t(locale, "notificationSettings.notificationTypeCombinedLabel") },
          { value: "live", label: t(locale, "notificationSettings.liveColumnHeader") },
          { value: "newVideo", label: t(locale, "notificationSettings.newVideoColumnHeader") },
        ]}
        onChange={(value) => setNotificationType(topicId, value as TopicNotificationType)}
        aria-label={`${t(locale, "notificationSettings.notificationTypeLabel")} ${topicLabel}`}
      />
    </section>
  )
}

/** One member's avatar preview tile -- no image asset: this roster
 * (notificationCreatorGrouping's 112-creator Creator Master data) carries
 * no thumbnail field to draw from, so the same initial-letter treatment
 * TopicCreatorManagementDrawer's own creator rows already use is reused
 * here rather than fabricating a remote image URL. */
function MemberAvatarPreview({ creators, locale }: { creators: NotificationCreator[]; locale: Locale }) {
  if (creators.length === 0) {
    return <p className="notification-detail-section__description">{t(locale, "notificationSettings.noSelectedMembers")}</p>
  }

  const shown = creators.slice(0, MAX_AVATAR_PREVIEW)
  const extra = creators.length - shown.length

  return (
    <div className="notification-member-preview">
      {shown.map((creator) => (
        <div key={creator.creatorId} className="notification-member-preview__item">
          <div className="notification-member-preview__avatar" aria-hidden="true">
            {creator.displayName.trim().charAt(0)}
          </div>
          <div className="notification-member-preview__name">{creator.displayName}</div>
        </div>
      ))}
      {extra > 0 && (
        <div className="notification-member-preview__item">
          <div className="notification-member-preview__more">{t(locale, "notificationSettings.memberPreviewMoreLabel", { count: String(extra) })}</div>
        </div>
      )}
    </div>
  )
}

/** The Notification Members section -- summary count, an avatar preview,
 * and the "管理成員" entry point into TopicCreatorManagementDrawer (the
 * same drawer as before this redesign; only this row's own presentation
 * changes). */
function MembersSection({ topicId, topicLabel, onManage }: { topicId: TopicCatalogId; topicLabel: string; onManage: () => void }) {
  const [locale] = useLocale()
  const { getEnabledCreatorIds } = useTopicNotificationPreferences()
  const enabledIds = getEnabledCreatorIds(topicId)
  const enabledCreators = getAllNotificationCreators().filter((creator) => enabledIds.has(creator.creatorId))

  return (
    <section className="notification-detail-section">
      <div className="notification-members-heading">
        <div>
          <h3 className="notification-detail-section__title">{t(locale, "notificationSettings.notifiedMembersLabel")}</h3>
          <p className="notification-detail-section__description">
            {t(locale, "notificationSettings.selectedCountLabel", { count: String(enabledCreators.length) })}
          </p>
        </div>
        <Button
          className="notification-members-manage"
          onClick={onManage}
          aria-label={`${t(locale, "notificationSettings.manageMembersButton")} ${topicLabel}`}
        >
          <Users size={16} aria-hidden="true" />
          {t(locale, "notificationSettings.manageMembersButton")}
        </Button>
      </div>
      <MemberAvatarPreview creators={enabledCreators} locale={locale} />
    </section>
  )
}

/** One left-panel row -- the whole row is a real <button>, so it's
 * natively focusable with Enter/Space already selecting it (section 20).
 * The meta row previews this topic's own effective reminder, member
 * count, and whether any per-member override is currently set, so this
 * information is visible without opening the topic at all. */
function TopicListItem({
  topicId,
  isSelected,
  onSelect,
}: {
  topicId: TopicCatalogId
  isSelected: boolean
  onSelect: () => void
}) {
  const [locale] = useLocale()
  const { getEnabledCreatorIds, getOverrideCount } = useTopicNotificationPreferences()
  const topicLabel = topicLabelFor(locale, topicId)
  const memberCount = getEnabledCreatorIds(topicId).size
  const overrideCount = getOverrideCount(topicId)

  return (
    <button
      type="button"
      className={`notification-topic-item${isSelected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-current={isSelected ? "true" : undefined}
    >
      <span className="notification-topic-item__body">
        <span className="notification-topic-item__name">{topicLabel}</span>
        <span className="notification-topic-item__meta">
          <span className="notification-topic-item__meta-label notification-topic-item__members">
            <UsersThreeIcon size={14} weight="regular" aria-hidden="true" />
            {t(locale, "notificationSettings.selectedCountLabel", { count: String(memberCount) })}
          </span>
          <span className={`notification-topic-item__override${overrideCount > 0 ? " is-active" : ""}`}>
            <SlidersHorizontalIcon size={14} weight="regular" aria-hidden="true" />
            {overrideCount > 0 ? t(locale, "notificationSettings.overrideBadgeCount", { count: String(overrideCount) }) : t(locale, "notificationSettings.overrideSectionTitle")}
          </span>
        </span>
      </span>
    </button>
  )
}

interface DetailPanelProps {
  isDraft: boolean
  topicId: TopicCatalogId | null
  selectableTopics: ReturnType<typeof getSelectableTopics>
  onSelectDraftTopic: (topicId: TopicCatalogId) => void
  onManage: () => void
  onSave: () => void
  onReset: () => void
}

/** The right-hand editor -- one continuous surface for whichever topic is
 * selected on the left, or the draft's own topic picker while "+" is
 * active. Selecting a topic never navigates away or opens a second panel
 * (section 19): everything here is the SAME component tree, just re-keyed
 * to a different topicId. */
function DetailPanel({ isDraft, topicId, selectableTopics, onSelectDraftTopic, onManage, onSave, onReset }: DetailPanelProps) {
  const [locale] = useLocale()

  if (topicId === null) {
    if (isDraft) {
      const selectOptions = selectableTopics.map((topic) => ({ value: topic.id, label: t(locale, topic.labelKey) }))
      return (
        <div className="notification-detail-panel">
          <div className="notification-detail-header notification-detail-header--draft">
            <Select
              className="notification-detail-topic-select"
              placeholder={t(locale, "notificationSettings.topicSelectPlaceholder")}
              aria-label={t(locale, "notificationSettings.topicSelectAriaLabel")}
              value={undefined}
              options={selectOptions}
              onChange={(value: TopicCatalogId) => onSelectDraftTopic(value)}
            />
          </div>
        </div>
      )
    }
    return (
      <div className="notification-detail-panel">
        <p className="notification-detail-panel__empty">{t(locale, "notificationSettings.emptySelection")}</p>
      </div>
    )
  }

  const topicLabel = topicLabelFor(locale, topicId)

  return (
    <div className="notification-detail-panel">
      <div className="notification-detail-header">
        <h2 className="notification-detail-header__title">{topicLabel}</h2>
        <p className="notification-detail-header__description">{t(locale, "notificationSettings.detailDescription", { topic: topicLabel })}</p>
      </div>

      <NotificationTypeSection topicId={topicId} topicLabel={topicLabel} />
      <MembersSection topicId={topicId} topicLabel={topicLabel} onManage={onManage} />

      <div className="notification-detail-actions">
        {isDraft ? (
          <Button type="primary" className="notification-save-button" onClick={onSave}>
            {t(locale, "notificationSettings.saveTopicButton")}
          </Button>
        ) : (
          <Button
            className="notification-reset-button"
            onClick={onReset}
            aria-label={t(locale, "notificationSettings.resetButtonAriaLabel", { topic: topicLabel })}
          >
            {t(locale, "notificationSettings.resetButton")}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Notification Settings' own content: a single vertical topic list on the
 * left, one large detail editor on the right for whichever topic is
 * selected (this feature's redesign, replacing the old per-topic card
 * grid). Topics are still a dynamic, user-added list: the page starts with
 * 5 permanent default cards, and "+"/Save let the user add more from a
 * catalog, one at a time, no duplicates -- unchanged from before this
 * redesign, only how a topic is browsed and edited changes. */
export function NotificationSettings() {
  const [locale] = useLocale()
  const [managingTopicId, setManagingTopicId] = useState<TopicCatalogId | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>("saved")
  const { savedTopicIds, addTopic, discardUnsavedTopic, resetTopicDefaults } = useTopicNotificationPreferences()

  const [selectedTopicId, setSelectedTopicId] = useState<TopicCatalogId | null>(savedTopicIds[0] ?? null)

  // At most one draft at a time (unchanged from before this redesign) --
  // plain component state, not shared/persisted.
  const [draft, setDraft] = useState<{ active: boolean; topicId: TopicCatalogId | null }>({ active: false, topicId: null })
  const draftTopicIdRef = useRef<TopicCatalogId | null>(null)
  const selectableTopics = getSelectableTopics(savedTopicIds)

  useEffect(
    () => () => {
      if (draftTopicIdRef.current !== null) discardUnsavedTopic(draftTopicIdRef.current)
    },
    [discardUnsavedTopic],
  )

  const orderedTopicIds = useMemo(() => {
    if (sortMode === "saved") return savedTopicIds
    return [...savedTopicIds].sort((a, b) => topicLabelFor(locale, a).localeCompare(topicLabelFor(locale, b), locale))
  }, [savedTopicIds, sortMode, locale])

  const startDraft = () => {
    draftTopicIdRef.current = null
    setDraft({ active: true, topicId: null })
  }
  // Only ever updates the LOCAL draft -- never calls addTopic. Picking an
  // option must not immediately persist; only the explicit Save action
  // below does (unchanged from before this redesign).
  const selectDraftTopic = (topicId: TopicCatalogId) => {
    if (draft.topicId !== null && draft.topicId !== topicId) discardUnsavedTopic(draft.topicId)
    draftTopicIdRef.current = topicId
    setDraft({ active: true, topicId })
  }
  const saveDraft = () => {
    if (draft.topicId === null) return
    addTopic(draft.topicId)
    const savedTopicId = draft.topicId
    draftTopicIdRef.current = null
    setDraft({ active: false, topicId: null }) // clears the draft and re-enables "+" together
    setSelectedTopicId(savedTopicId) // the newly saved card becomes the one shown on the right
  }
  // Selecting an already-saved topic while a draft is open abandons that
  // draft -- the same "discard on reselect" path selectDraftTopic already
  // exercises, just triggered by the list instead of the topic dropdown.
  const selectTopic = (topicId: TopicCatalogId) => {
    if (draft.active) {
      if (draft.topicId !== null) discardUnsavedTopic(draft.topicId)
      draftTopicIdRef.current = null
      setDraft({ active: false, topicId: null })
    }
    setSelectedTopicId(topicId)
  }

  const sortOptions = [
    { value: "saved", label: t(locale, "notificationSettings.topicSortSaved") },
    { value: "alphabetical", label: t(locale, "notificationSettings.topicSortAlphabetical") },
  ]

  return (
    <ConfigProvider
      theme={{
        token: { colorPrimary: NOTIFICATION_ACCENT },
        components: {
          // Segmented/Select popups are portaled outside this page's own
          // dark-scoped DOM subtree, so the .notification-settings-page
          // CSS custom properties can't reach them -- themed here via
          // antd's own component tokens instead.
          Segmented: {
            trackBg: "#211d29",
            itemColor: "#b9b1c5",
            itemHoverColor: "#f3eff7",
            itemHoverBg: "color-mix(in srgb, #f3eff7 8%, transparent)",
            itemSelectedBg: "#332d38",
            itemSelectedColor: "#f3eff7",
          },
          Select: {
            colorBgContainer: "#292432",
            colorBorder: "#393342",
            colorText: "#f3eff7",
            colorTextPlaceholder: "#948b9f",
            colorBgElevated: "#211d29",
            optionSelectedBg: "rgba(90, 82, 97, 0.35)",
            colorTextQuaternary: "#948b9f",
          },
        },
      }}
    >
      <header className="settings-page-header">
        <h1 className="settings-page-title">{t(locale, "notificationSettings.pageTitle")}</h1>
        <p className="settings-page-description">{t(locale, "notificationSettings.pageDescription")}</p>
      </header>

      <section className="notification-settings-page">
        <div className="notification-settings-content">
          <div className="notification-settings-main">
            <div className="notification-topic-panel">
              <div className="notification-topic-panel__header">
                <h2 className="notification-topic-panel__title">{t(locale, "notificationSettings.topicListPanelTitle")}</h2>
                <Select
                  className="notification-topic-sort"
                  aria-label={t(locale, "notificationSettings.topicSortAriaLabel")}
                  value={sortMode}
                  options={sortOptions}
                  onChange={(value) => setSortMode(value as SortMode)}
                  popupMatchSelectWidth={false}
                />
              </div>
              {/* .notification-topic-list-scroll is the OUTER scroller (its total
                  width = the locked card width + gap + scrollbar reservation,
                  via .notification-settings-main's own widened fixed column --
                  see settings.css). .notification-topic-list-content is the
                  INNER, genuinely fixed-width column the cards actually live
                  in: it never changes size, so the scrollbar (which belongs to
                  the outer scroller, rendering in whatever trailing space the
                  inner content doesn't fill) can appear or disappear without
                  ever touching a single card's width (confirmed with the
                  user). */}
              <div className="notification-topic-list-scroll">
                <div className="notification-topic-list-content">
                  <div className="notification-topic-list">
                    {orderedTopicIds.map((topicId) => (
                      <TopicListItem
                        key={topicId}
                        topicId={topicId}
                        isSelected={!draft.active && selectedTopicId === topicId}
                        onSelect={() => selectTopic(topicId)}
                      />
                    ))}
                  </div>
                  {draft.active ? null : selectableTopics.length > 0 ? (
                    <Button variant="dashed" block className="notification-add-topic" onClick={startDraft}>
                      <span className="notification-add-topic__icon" aria-hidden="true">
                        <PlusIcon size={16} weight="regular" />
                      </span>
                      {t(locale, "notificationSettings.addTopicButtonAriaLabel")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <DetailPanel
              isDraft={draft.active}
              topicId={draft.active ? draft.topicId : selectedTopicId}
              selectableTopics={selectableTopics}
              onSelectDraftTopic={selectDraftTopic}
              onManage={() => setManagingTopicId(draft.active ? draft.topicId : selectedTopicId)}
              onSave={saveDraft}
              onReset={() => selectedTopicId !== null && resetTopicDefaults(selectedTopicId)}
            />
          </div>
        </div>
      </section>

      <TopicCreatorManagementDrawer topicId={managingTopicId} onClose={() => setManagingTopicId(null)} />
    </ConfigProvider>
  )
}
