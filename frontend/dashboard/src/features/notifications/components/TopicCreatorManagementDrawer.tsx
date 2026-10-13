import { useMemo, useState, type CSSProperties } from "react"
import { ConfigProvider, Drawer, Switch } from "antd"
import { Heart, Search } from "lucide-react"
import { CreatorAvatarImage } from "../../../entities/creator/components/CreatorAvatarImage"
import { creatorMatchesNameQuery } from "../../../entities/creator/utils/creatorNameSearch"
import { LiveStatusGroups } from "../../live-status/components/LiveStatusGroups"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
import { clearNotificationSaveFailed, useNotificationSaveFailed } from "../hooks/notificationSaveStatus"
import { useReminderTopicSupport } from "../hooks/useReminderTopicSupport"
import { useTopicNotificationPreferences } from "../hooks/useTopicNotificationPreferences"
import { ensurePushEnabled } from "../push/pushGate"
import { isFavoriteCreatorId } from "../../favorites/utils/creatorFavoriteBridge"
import {
  getAllNotificationCreators,
  groupCreatorsForNotificationSettings,
  sortCreatorsLikeLiveStatus,
  type NotificationBranchGroup,
  type NotificationCreator,
} from "../model/notificationCreatorGrouping"
import type { TopicCatalogId } from "../model/notificationTopicCatalog"
import { REMINDER_TIME_LABEL_KEYS, REMINDER_TIME_VALUES, type ReminderTimeValue, type TopicNotificationType } from "../model/notificationTopics"
import { t, type Locale } from "../../../shared/i18n/translations"
import { getMemberAccent } from "../../../shared/theme/memberAccent"

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

/** Instant, no-Enter search through the shared creator-name matcher (creatorNameSearch.ts). Exported (along with filterBranchGroups/
 * excludeFavorites below) purely so this feature's own tests can exercise the actual filtering/grouping logic directly against the real
 * roster, without needing to mount antd's Drawer. */
export function filterCreatorList(creators: NotificationCreator[], query: string): NotificationCreator[] {
  return creators.filter((creator) => creatorMatchesNameQuery(creator, query))
}

/** Filters the WHOLE branch > subgroup > creator hierarchy (Live Status' grouping) so an empty subgroup/branch never leaves a bare
 * heading on screen once a search narrows results down. */
export function filterBranchGroups(groups: NotificationBranchGroup[], query: string): NotificationBranchGroup[] {
  return groups
    .map((group) => ({
      ...group,
      subgroups: group.subgroups
        .map((subgroup) => ({ ...subgroup, creators: filterCreatorList(subgroup.creators, query) }))
        .filter((subgroup) => subgroup.creators.length > 0),
    }))
    .filter((group) => group.subgroups.length > 0)
}

/** Removes every Favorite creator from the normal branch groups so no creator ever renders twice (this feature's own spec section 7). */
export function excludeFavorites(groups: NotificationBranchGroup[], favoriteIds: ReadonlySet<string>): NotificationBranchGroup[] {
  return groups
    .map((group) => ({
      ...group,
      subgroups: group.subgroups
        .map((subgroup) => ({ ...subgroup, creators: subgroup.creators.filter((creator) => !favoriteIds.has(creator.creatorId)) }))
        .filter((subgroup) => subgroup.creators.length > 0),
    }))
    .filter((group) => group.subgroups.length > 0)
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

/** Turning a notification ON (a creator's Live or New Video switch, a reminder time) goes through the push gate first: the change is only
 * applied once this device can really deliver Web Push -- after the explanation + browser prompt on first use, or straight away when
 * permission and the subscription already exist. A cancelled/denied/unavailable outcome leaves the control exactly as it was. Turning
 * a notification OFF never needs permission and bypasses the gate. */
async function applyWhenPushReady(apply: () => void): Promise<void> {
  if ((await ensurePushEnabled()) === "ready") apply()
}

/** What the closed select shows while this creator has no reminder time yet. It is a placeholder, NOT an option: the open list holds only the
 * real timings (whether notifications are on at all is the switch's job). */
const UNSET_REMINDER_PLACEHOLDER = "—"

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

  const options = REMINDER_TIME_VALUES.map((value) => ({ value: value as string, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) }))
  const memberReminder = getMemberReminder(topicId, creator.creatorId)
  const shadowed = reminderSupported && isReminderShadowedByAll(topicId, creator.creatorId)

  return (
    <span className="topic-creator-drawer__reminder-cell-content">
      {/* Home's own dropdown, verbatim: the same native <select> and .oshi-videos__sort class Home's sort / content-type controls use, so its
          height, padding, border, radius, colors, chevron, hover/focus and OPEN list are Home's by construction. */}
      <select
        className="oshi-videos__sort topic-creator-drawer__reminder-select"
        disabled={!reminderSupported}
        value={memberReminder ?? ""}
        onChange={(event) => {
          const value = event.target.value as ReminderTimeValue
          void applyWhenPushReady(() => setMemberReminder(topicId, creator.creatorId, value))
        }}
        aria-label={t(locale, "notificationSettings.reminderSelectAriaLabel", { name: creator.displayName })}
      >
        {memberReminder === null && (
          <option value="" disabled hidden>
            {UNSET_REMINDER_PLACEHOLDER}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {shadowed && <span className="topic-creator-drawer__reminder-not-in-effect">{t(locale, "notificationSettings.reminderNotInEffectHint")}</span>}
    </span>
  )
}

function CreatorRow({
  topicId,
  creator,
  notificationType,
  reminderSupported,
  favorite = false,
}: {
  topicId: TopicCatalogId
  creator: NotificationCreator
  notificationType: TopicNotificationType
  reminderSupported: boolean
  /** A favorite creator's avatar carries the shared favorite heart (the same one Live Status / 收藏名單 / the Schedule filter use). */
  favorite?: boolean
}) {
  const [locale] = useLocale()
  const { isLiveEnabled, setLiveEnabled, isNewVideoEnabled, setNewVideoEnabled } = useTopicNotificationPreferences()
  const { showLive, showNewVideo, showReminder } = drawerColumnFlags(notificationType)
  const modifier = drawerColumnModifier(notificationType)
  const className = modifier ? `topic-creator-drawer__row topic-creator-drawer__row--${modifier}` : "topic-creator-drawer__row"

  return (
    <div className={className} style={creatorAccentStyle(creator)}>
      <span className="creator-tile__avatar-wrap">
        <CreatorAvatarImage avatarUrl={creator.avatarUrl} displayName={creator.displayName} className="topic-creator-drawer__avatar" />
        {favorite && <Heart className="creator-avatar-heart" aria-hidden="true" fill="currentColor" />}
      </span>
      <span className="topic-creator-drawer__creator-name">{creator.displayName}</span>
      {showLive && (
        <span className="topic-creator-drawer__switch-cell">
          <Switch
            checked={isLiveEnabled(topicId, creator.creatorId)}
            onChange={(checked) => (checked ? void applyWhenPushReady(() => setLiveEnabled(topicId, creator.creatorId, true)) : setLiveEnabled(topicId, creator.creatorId, false))}
            aria-label={t(locale, "notificationSettings.liveSwitchAriaLabel", { name: creator.displayName })}
          />
        </span>
      )}
      {showNewVideo && (
        <span className="topic-creator-drawer__switch-cell">
          <Switch
            checked={isNewVideoEnabled(topicId, creator.creatorId)}
            onChange={(checked) => (checked ? void applyWhenPushReady(() => setNewVideoEnabled(topicId, creator.creatorId, true)) : setNewVideoEnabled(topicId, creator.creatorId, false))}
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
  const baseGroups = useMemo(() => groupCreatorsForNotificationSettings(), [])

  const favoriteIds = useMemo(
    () => new Set(allCreators.filter((creator) => isFavoriteCreatorId(creator.creatorId, favorites)).map((creator) => creator.creatorId)),
    [allCreators, favorites],
  )
  const favoriteCreators = useMemo(
    () => sortCreatorsLikeLiveStatus(allCreators.filter((creator) => favoriteIds.has(creator.creatorId))),
    [allCreators, favoriteIds],
  )
  const nonFavoriteGroups = useMemo(() => excludeFavorites(baseGroups, favoriteIds), [baseGroups, favoriteIds])

  const filteredFavorites = filterCreatorList(favoriteCreators, searchQuery)
  const filteredGroups = filterBranchGroups(nonFavoriteGroups, searchQuery)
  const hasResults = filteredFavorites.length > 0 || filteredGroups.length > 0

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
        : "notificationSettings.notificationTypeCombinedLabel"

  return (
    <ConfigProvider
      theme={{
        components: {
          Drawer: {
            colorBgElevated: "#0b1521",
            colorText: "rgba(255, 255, 255, 0.94)",
            colorIcon: "rgba(255, 255, 255, 0.42)",
            colorIconHover: "rgba(255, 255, 255, 0.94)",
          },
          Switch: {
            colorTextQuaternary: "#4a4452",
          },
        },
      }}
    >
      <Drawer open={topicId !== null} onClose={handleClose} title={drawerTitle} size={600} className="topic-creator-drawer">
        {topicId && (
          <div className="topic-creator-drawer__content" data-locale={locale}>
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
            <label className="live-status-search topic-creator-drawer__search">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                placeholder={t(locale, "notificationSettings.searchPlaceholder")}
                aria-label={t(locale, "notificationSettings.searchPlaceholder")}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>
            {!hasResults && <p className="topic-creator-drawer__empty-state">{t(locale, "notificationSettings.noResults")}</p>}
            {filteredFavorites.length > 0 && (
              <section className="topic-creator-drawer__group">
                <h3 className="live-status-group__heading topic-creator-drawer__favorites-heading">
                  <span>
                    <Heart className="creator-avatar-heart creator-avatar-heart--inline" aria-hidden="true" fill="currentColor" />{" "}
                    {t(locale, "notificationSettings.favoritesGroupLabel")}
                  </span>
                </h3>
                <ColumnHeader locale={locale} notificationType={notificationType} />
                <div className="topic-creator-drawer__list">
                  {filteredFavorites.map((creator) => (
                    <CreatorRow key={creator.creatorId} topicId={topicId} creator={creator} notificationType={notificationType} reminderSupported={reminderSupported} favorite />
                  ))}
                </div>
              </section>
            )}
            <LiveStatusGroups
              groups={filteredGroups}
              locale={locale}
              renderSubgroup={(creators) => (
                <div className="topic-creator-drawer__subgroup">
                  <ColumnHeader locale={locale} notificationType={notificationType} />
                  <div className="topic-creator-drawer__list">
                    {creators.map((creator) => (
                      <CreatorRow key={creator.creatorId} topicId={topicId} creator={creator} notificationType={notificationType} reminderSupported={reminderSupported} />
                    ))}
                  </div>
                </div>
              )}
            />
          </div>
        )}
      </Drawer>
    </ConfigProvider>
  )
}
