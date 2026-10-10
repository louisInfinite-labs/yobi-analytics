import { useMemo, useState, type CSSProperties } from "react"
import { Button, ConfigProvider, Drawer, Dropdown, Input, Switch } from "antd"
import { ChevronDown, Search } from "lucide-react"
import { CreatorAvatarImage } from "../../../entities/creator/components/CreatorAvatarImage"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
import { clearNotificationSaveFailed, useNotificationSaveFailed } from "../hooks/notificationSaveStatus"
import { useReminderTopicSupport } from "../hooks/useReminderTopicSupport"
import { useTopicNotificationPreferences } from "../hooks/useTopicNotificationPreferences"
import { isFavoriteCreatorId } from "../../favorites/utils/creatorFavoriteBridge"
import {
  GAMERS_GROUP_LABEL_KEY,
  getAllNotificationCreators,
  groupCreatorsForNotificationSettings,
  OTHER_GROUP_LABEL_KEY,
  type CreatorAgencyGroup,
  type NotificationCreator,
} from "../model/notificationCreatorGrouping"
import { sortFlatNotificationCreatorsLikeLiveStatus } from "../model/notificationCreatorOrder"
import type { TopicCatalogId } from "../model/notificationTopicCatalog"
import { REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES, type ReminderTimeValue, type TopicNotificationType } from "../model/notificationTopics"
import { t, type Locale } from "../../../shared/i18n/translations"
import { getMemberAccent } from "../../../shared/theme/memberAccent"

const NOTIFICATION_ACCENT = "#c779a3"

type CreatorAccentStyle = CSSProperties & {
  "--creator-accent": string
  "--creator-accent-soft": string
}

function creatorAccentStyle(creator: NotificationCreator): CreatorAccentStyle {
  const accent = getMemberAccent(creator.youtubeChannelId)
  return {
    "--creator-accent": accent.primary,
    "--creator-accent-soft": accent.soft,
  }
}

interface TopicCreatorManagementDrawerProps {
  /** null closes the drawer -- also doubles as "which topic is open". */
  topicId: TopicCatalogId | null
  /** The open card's label, from the shared category list (Home's) -- resolved by the page. */
  topicLabel: string
  onClose: () => void
}

/** Same sentinel-label translation as NotificationSettings' own
 * subgroupTitle. */
function subgroupTitle(locale: Locale, label: string): string {
  if (label === OTHER_GROUP_LABEL_KEY) return t(locale, "notificationSettings.otherGroupLabel")
  if (label === GAMERS_GROUP_LABEL_KEY) return t(locale, "notificationSettings.gamersGroupLabel")
  return label
}

/** Same instant, no-Enter, whole-name-substring search as
 * NotificationSettings' own matchesSearch/filterAgencyGroups (this
 * feature's own spec section 10: reuse the existing search
 * implementation). Exported (along with filterCreatorList/
 * filterAgencyGroups/excludeFavorites below) purely so this feature's own
 * tests can exercise the actual filtering/grouping logic directly against
 * the real roster, without needing to mount antd's Drawer. */
export function matchesSearch(creator: NotificationCreator, query: string): boolean {
  const trimmed = query.trim().toLowerCase()
  return trimmed === "" || creator.displayName.toLowerCase().includes(trimmed)
}

export function filterCreatorList(creators: NotificationCreator[], query: string): NotificationCreator[] {
  return creators.filter((creator) => matchesSearch(creator, query))
}

/** Filters the WHOLE Agency > Region > Subgroup > Creator hierarchy so an
 * empty subgroup/region/agency never leaves a bare heading on screen once
 * a search narrows results down (same reasoning/behavior as
 * NotificationSettings' own filterAgencyGroups). */
export function filterAgencyGroups(agencyGroups: CreatorAgencyGroup[], query: string): CreatorAgencyGroup[] {
  return agencyGroups
    .map((agency) => ({
      ...agency,
      regions: agency.regions
        .map((region) => ({
          ...region,
          subgroups: region.subgroups
            .map((subgroup) => ({ ...subgroup, creators: filterCreatorList(subgroup.creators, query) }))
            .filter((subgroup) => subgroup.creators.length > 0),
        }))
        .filter((region) => region.subgroups.length > 0),
    }))
    .filter((agency) => agency.regions.length > 0)
}

/** Removes every Favorite creator from the normal Agency/Region groups so
 * no creator ever renders twice (this feature's own spec section 7). */
export function excludeFavorites(agencyGroups: CreatorAgencyGroup[], favoriteIds: ReadonlySet<string>): CreatorAgencyGroup[] {
  return agencyGroups
    .map((agency) => ({
      ...agency,
      regions: agency.regions
        .map((region) => ({
          ...region,
          subgroups: region.subgroups
            .map((subgroup) => ({
              ...subgroup,
              creators: subgroup.creators.filter((creator) => !favoriteIds.has(creator.creatorId)),
            }))
            .filter((subgroup) => subgroup.creators.length > 0),
        }))
        .filter((region) => region.subgroups.length > 0),
    }))
    .filter((agency) => agency.regions.length > 0)
}

/** Which member-level columns a topic's own notificationType allows --
 * confirmed with the user: the topic-level type is the single source of
 * truth for which notification channels this topic can ever send, so the
 * drawer must not show (even disabled) a switch for an excluded channel --
 * that would visually suggest the channel is still part of this topic.
 * Reminder-time is Live-specific (see notificationTopics.ts), so it only
 * ever shows alongside the Live column. */
function drawerColumnFlags(notificationType: TopicNotificationType) {
  const showLive = notificationType !== "newVideo"
  const showNewVideo = notificationType !== "live"
  return { showLive, showNewVideo, showReminder: showLive }
}

/** The grid-template-columns modifier this notificationType needs (see
 * settings.css's own .topic-creator-drawer__row/__column-header rules) --
 * "" for "both", which keeps the existing 5-column default unmodified. */
function drawerColumnModifier(notificationType: TopicNotificationType): string {
  if (notificationType === "live") return "live-only"
  if (notificationType === "newVideo") return "newvideo-only"
  return ""
}

function ColumnHeader({ locale, notificationType }: { locale: Locale; notificationType: TopicNotificationType }) {
  const { showLive, showNewVideo, showReminder } = drawerColumnFlags(notificationType)
  const modifier = drawerColumnModifier(notificationType)
  const className = modifier ? `topic-creator-drawer__column-header topic-creator-drawer__column-header--${modifier}` : "topic-creator-drawer__column-header"
  return (
    <div className={className}>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      {showLive && <span className="topic-creator-drawer__column-header-label">{t(locale, "notificationSettings.liveColumnHeader")}</span>}
      {showNewVideo && <span className="topic-creator-drawer__column-header-label">{t(locale, "notificationSettings.newVideoColumnHeader")}</span>}
      {showReminder && <span className="topic-creator-drawer__column-header-label">{t(locale, "notificationSettings.reminderColumnHeader")}</span>}
    </div>
  )
}

/** The dropdown key of the "no reminder" option (a real reminder value never equals it). */
const UNSET_REMINDER_KEY = "__unset__"

/** Live's own reminder-time cell -- only shown once Live is enabled for
 * this creator+topic (New Video has no reminder-time concept at all -- see
 * notificationTopics.ts). The value is this creator's own reminder for this
 * topic, or "no reminder" (unset -- never silently defaulted to a time).
 *
 * Two states stop it being a plain editable control:
 * - `reminderSupported` is false: the backend has no canonical topic for this
 *   category, so it cannot have its own reminder; the control is disabled and
 *   the drawer says the topic follows the 全部 setting.
 * - the creator's 全部 reminder is set (and this isn't the 全部 topic): the
 *   backend applies 全部 over this topic's reminder, so a small hint says this
 *   value is not in effect -- it stays stored and takes effect again if 全部 is
 *   unset. */
function ReminderCell({
  topicId,
  creator,
  locale,
  reminderSupported,
}: {
  topicId: TopicCatalogId
  creator: NotificationCreator
  locale: Locale
  reminderSupported: boolean
}) {
  const { isLiveEnabled, getMemberReminder, setMemberReminder, isReminderShadowedByAll } = useTopicNotificationPreferences()

  if (!isLiveEnabled(topicId, creator.creatorId)) {
    return (
      <span className="topic-creator-drawer__reminder-empty" aria-hidden="true">
        —
      </span>
    )
  }

  const unsetLabel = t(locale, "notificationSettings.reminder.unset")
  const options = [
    { value: UNSET_REMINDER_KEY, label: unsetLabel },
    ...REMINDER_TIME_VALUES.map((value) => ({ value: value as string, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) })),
  ]
  const memberReminder = getMemberReminder(topicId, creator.creatorId)
  const selectedKey = memberReminder ?? UNSET_REMINDER_KEY
  const memberReminderLabel = options.find((option) => option.value === selectedKey)?.label ?? unsetLabel
  const shadowed = reminderSupported && isReminderShadowedByAll(topicId, creator.creatorId)

  return (
    <span className="topic-creator-drawer__reminder-cell-content">
      <Dropdown
        disabled={!reminderSupported}
        menu={{
          items: options.map((option) => ({ key: option.value, label: option.label })),
          selectedKeys: [selectedKey],
          onClick: ({ key }) => setMemberReminder(topicId, creator.creatorId, key === UNSET_REMINDER_KEY ? null : (key as ReminderTimeValue)),
        }}
        trigger={["click"]}
      >
        <Button
          variant="outlined"
          color="default"
          size="small"
          className="topic-creator-drawer__reminder-trigger"
          disabled={!reminderSupported}
          icon={<ChevronDown size={14} aria-hidden="true" />}
          iconPlacement="end"
          aria-label={t(locale, "notificationSettings.reminderSelectAriaLabel", { name: creator.displayName })}
        >
          {memberReminderLabel}
        </Button>
      </Dropdown>
      {shadowed && <span className="topic-creator-drawer__reminder-not-in-effect">{t(locale, "notificationSettings.reminderNotInEffectHint")}</span>}
    </span>
  )
}

function CreatorRow({
  topicId,
  creator,
  notificationType,
  reminderSupported,
}: {
  topicId: TopicCatalogId
  creator: NotificationCreator
  notificationType: TopicNotificationType
  reminderSupported: boolean
}) {
  const [locale] = useLocale()
  const { isLiveEnabled, setLiveEnabled, isNewVideoEnabled, setNewVideoEnabled } = useTopicNotificationPreferences()
  const { showLive, showNewVideo, showReminder } = drawerColumnFlags(notificationType)
  const modifier = drawerColumnModifier(notificationType)
  const className = modifier ? `topic-creator-drawer__row topic-creator-drawer__row--${modifier}` : "topic-creator-drawer__row"

  return (
    <div className={className} style={creatorAccentStyle(creator)}>
      <CreatorAvatarImage avatarUrl={creator.avatarUrl} displayName={creator.displayName} className="topic-creator-drawer__avatar" />
      <span className="topic-creator-drawer__creator-name">{creator.displayName}</span>
      {showLive && (
        <span className="topic-creator-drawer__switch-cell">
          <Switch
            checked={isLiveEnabled(topicId, creator.creatorId)}
            onChange={(checked) => setLiveEnabled(topicId, creator.creatorId, checked)}
            aria-label={t(locale, "notificationSettings.liveSwitchAriaLabel", { name: creator.displayName })}
          />
        </span>
      )}
      {showNewVideo && (
        <span className="topic-creator-drawer__switch-cell">
          <Switch
            checked={isNewVideoEnabled(topicId, creator.creatorId)}
            onChange={(checked) => setNewVideoEnabled(topicId, creator.creatorId, checked)}
            aria-label={t(locale, "notificationSettings.newVideoSwitchAriaLabel", { name: creator.displayName })}
          />
        </span>
      )}
      {showReminder && (
        <span className="topic-creator-drawer__reminder-cell">
          <ReminderCell topicId={topicId} creator={creator} locale={locale} reminderSupported={reminderSupported} />
        </span>
      )}
    </div>
  )
}

/** A single topic's detailed creator management surface (this feature's
 * own spec section 4) -- opened from NotificationSettings' compact topic
 * cards. Reuses the project's existing antd (already a dependency) for the
 * overlay itself: no Modal/Drawer pattern existed anywhere in the app
 * before this (confirmed by inspection), so this is the first one,
 * introducing no new dependency. Content: search (section 10), a
 * Favorites-first section excluding duplicates from the normal groups
 * (sections 6/7), then the existing Agency/Region/Subgroup hierarchy
 * (section 11) -- each creator row carries this topic's own Live/New Video
 * switches and optional reminder override (sections 8/9), independent of
 * every other topic and of the app's existing global per-creator
 * Live/New Video switches (useCreatorNotificationPreferences, untouched). */
export function TopicCreatorManagementDrawer({ topicId, topicLabel, onClose }: TopicCreatorManagementDrawerProps) {
  const [locale] = useLocale()
  const { favorites } = useFavoriteCreators()
  const { getNotificationType } = useTopicNotificationPreferences()
  const { isReminderTopicSupported, isSupportKnown } = useReminderTopicSupport()
  const [searchQuery, setSearchQuery] = useState("")
  const saveFailed = useNotificationSaveFailed()

  const handleClose = () => {
    setSearchQuery("")
    clearNotificationSaveFailed()
    onClose()
  }

  const allCreators = useMemo(() => getAllNotificationCreators(), [])
  const baseAgencyGroups = useMemo(() => groupCreatorsForNotificationSettings(), [])

  const favoriteIds = useMemo(
    () => new Set(allCreators.filter((creator) => isFavoriteCreatorId(creator.creatorId, favorites)).map((creator) => creator.creatorId)),
    [allCreators, favorites],
  )
  const favoriteCreators = useMemo(
    () => sortFlatNotificationCreatorsLikeLiveStatus(allCreators.filter((creator) => favoriteIds.has(creator.creatorId))),
    [allCreators, favoriteIds],
  )
  const nonFavoriteAgencyGroups = useMemo(() => excludeFavorites(baseAgencyGroups, favoriteIds), [baseAgencyGroups, favoriteIds])

  const filteredFavorites = filterCreatorList(favoriteCreators, searchQuery)
  const filteredAgencyGroups = filterAgencyGroups(nonFavoriteAgencyGroups, searchQuery)
  const hasResults = filteredFavorites.length > 0 || filteredAgencyGroups.length > 0

  const drawerTitle = topicId ? t(locale, "notificationSettings.managementDrawerTitle", { topic: topicLabel }) : ""

  // Falls back to "both" only for the brief render where topicId is null
  // (drawer closing) -- content below is gated on {topicId && ...} anyway.
  const notificationType = topicId ? getNotificationType(topicId) : "both"
  const reminderSupported = topicId ? isReminderTopicSupported(topicId) : true
  const notificationTypeLabelKey =
    notificationType === "live"
      ? "notificationSettings.liveColumnHeader"
      : notificationType === "newVideo"
        ? "notificationSettings.newVideoColumnHeader"
        : "notificationSettings.notificationTypeBoth"

  return (
    <ConfigProvider
      theme={{
        token: { colorPrimary: NOTIFICATION_ACCENT },
        components: {
          Drawer: {
            colorBgElevated: "#17141d",
            colorText: "#f3eff7",
            colorIcon: "#b9b1c5",
            colorIconHover: "#f3eff7",
          },
          Input: {
            colorBgContainer: "#211d29",
            colorBorder: "#393342",
            colorText: "#f3eff7",
            colorTextPlaceholder: "#948b9f",
          },
          Switch: {
            colorPrimary: NOTIFICATION_ACCENT,
            colorPrimaryHover: "#d28db2",
            colorTextQuaternary: "#4a4452",
          },
          Button: {
            defaultBg: "#211d29",
            defaultBorderColor: "#4a4352",
            defaultColor: "#f3eff7",
            defaultHoverBg: "#292432",
            defaultHoverBorderColor: NOTIFICATION_ACCENT,
            defaultHoverColor: "#f3eff7",
          },
          Dropdown: {
            colorBgElevated: "#211d29",
            colorText: "#f3eff7",
            controlItemBgActive: "rgba(199, 121, 163, 0.18)",
            controlItemBgActiveHover: "rgba(199, 121, 163, 0.24)",
          },
        },
      }}
    >
      <Drawer open={topicId !== null} onClose={handleClose} title={drawerTitle} size={480} className="topic-creator-drawer">
        {topicId && (
          <div className="topic-creator-drawer__content">
            <p className="topic-creator-drawer__notification-type-context">
              {t(locale, "notificationSettings.managementDrawerNotificationType", { type: t(locale, notificationTypeLabelKey) })}
            </p>
            {saveFailed && (
              <p className="topic-creator-drawer__save-error" role="alert">
                {t(locale, "notificationSettings.saveFailed")}
              </p>
            )}
            {isSupportKnown && !reminderSupported && drawerColumnFlags(notificationType).showReminder && (
              <p className="topic-creator-drawer__notification-type-context" role="note">
                {t(locale, "notificationSettings.reminderUnsupportedTopic")}
              </p>
            )}
            <Input
              className="topic-creator-drawer__search"
              prefix={<Search size={14} aria-hidden="true" />}
              placeholder={t(locale, "notificationSettings.searchPlaceholder")}
              allowClear
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {!hasResults && <p className="topic-creator-drawer__empty-state">{t(locale, "notificationSettings.noResults")}</p>}
            {filteredFavorites.length > 0 && (
              <section className="topic-creator-drawer__group">
                <h3 className="topic-creator-drawer__group-title">
                  <span aria-hidden="true">★</span> {t(locale, "notificationSettings.favoritesGroupLabel")}
                </h3>
                <ColumnHeader locale={locale} notificationType={notificationType} />
                <div className="topic-creator-drawer__list">
                  {filteredFavorites.map((creator) => (
                    <CreatorRow key={creator.creatorId} topicId={topicId} creator={creator} notificationType={notificationType} reminderSupported={reminderSupported} />
                  ))}
                </div>
              </section>
            )}
            {filteredAgencyGroups.map((agency) => (
              <section key={agency.agencyLabel} className="topic-creator-drawer__group">
                <h3 className="topic-creator-drawer__group-title">{agency.agencyLabel}</h3>
                {agency.regions.map((region) => (
                  <div key={region.branch} className="topic-creator-drawer__region">
                    <h4 className="topic-creator-drawer__region-title">{region.regionLabel}</h4>
                    {region.subgroups.map((subgroup) => (
                      <div key={subgroup.label ?? "__flat__"} className="topic-creator-drawer__subgroup">
                        {subgroup.label && (
                          <h5 className="topic-creator-drawer__subgroup-title">{subgroupTitle(locale, subgroup.label)}</h5>
                        )}
                        <ColumnHeader locale={locale} notificationType={notificationType} />
                        <div className="topic-creator-drawer__list">
                          {subgroup.creators.map((creator) => (
                            <CreatorRow key={creator.creatorId} topicId={topicId} creator={creator} notificationType={notificationType} reminderSupported={reminderSupported} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </Drawer>
    </ConfigProvider>
  )
}
