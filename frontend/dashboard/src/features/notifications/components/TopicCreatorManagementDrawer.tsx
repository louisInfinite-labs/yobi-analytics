import { useMemo, useState, type CSSProperties } from "react"
import { Button, ConfigProvider, Drawer, Dropdown, Input, Switch } from "antd"
import { ChevronDown, Search } from "lucide-react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
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
import { getAvailableTopics, type TopicCatalogId } from "../model/notificationTopicCatalog"
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

/** Live's own reminder-time cell -- only shown once Live is enabled for
 * this creator+topic (New Video has no reminder-time concept at all -- see
 * notificationTopics.ts). Always a concrete, editable value: a member's own
 * reminder is stored independently of the topic's own mode (confirmed with
 * the user), so this control stays interactive even while the topic mode
 * is currently forcing everyone to a different, shared time -- a small
 * hint below it says so, so the value on screen never gets mistaken for
 * what this member is actually being notified at right now (see
 * getEffectiveReminder for the resolution itself). */
function ReminderCell({ topicId, creator, locale }: { topicId: TopicCatalogId; creator: NotificationCreator; locale: Locale }) {
  const { isLiveEnabled, isMemberChoiceMode, getMemberReminder, setMemberReminder } = useTopicNotificationPreferences()

  if (!isLiveEnabled(topicId, creator.creatorId)) {
    return (
      <span className="topic-creator-drawer__reminder-empty" aria-hidden="true">
        —
      </span>
    )
  }

  const options = REMINDER_TIME_VALUES.map((value) => ({ value, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) }))
  const inEffect = isMemberChoiceMode(topicId)
  const memberReminder = getMemberReminder(topicId, creator.creatorId)
  const memberReminderLabel = options.find((option) => option.value === memberReminder)?.label ?? ""

  return (
    <span className="topic-creator-drawer__reminder-cell-content">
      <Dropdown
        menu={{
          items: options.map((option) => ({ key: option.value, label: option.label })),
          selectedKeys: [memberReminder],
          onClick: ({ key }) => setMemberReminder(topicId, creator.creatorId, key as ReminderTimeValue),
        }}
        trigger={["click"]}
      >
        <Button
          variant="outlined"
          color="default"
          size="small"
          className="topic-creator-drawer__reminder-trigger"
          icon={<ChevronDown size={14} aria-hidden="true" />}
          iconPlacement="end"
          aria-label={t(locale, "notificationSettings.reminderSelectAriaLabel", { name: creator.displayName })}
        >
          {memberReminderLabel}
        </Button>
      </Dropdown>
      {!inEffect && <span className="topic-creator-drawer__reminder-not-in-effect">{t(locale, "notificationSettings.reminderNotInEffectHint")}</span>}
    </span>
  )
}

function CreatorRow({ topicId, creator, notificationType }: { topicId: TopicCatalogId; creator: NotificationCreator; notificationType: TopicNotificationType }) {
  const [locale] = useLocale()
  const { isLiveEnabled, setLiveEnabled, isNewVideoEnabled, setNewVideoEnabled } = useTopicNotificationPreferences()
  const { showLive, showNewVideo, showReminder } = drawerColumnFlags(notificationType)
  const modifier = drawerColumnModifier(notificationType)
  const className = modifier ? `topic-creator-drawer__row topic-creator-drawer__row--${modifier}` : "topic-creator-drawer__row"

  return (
    <div className={className} style={creatorAccentStyle(creator)}>
      <span className="topic-creator-drawer__avatar" aria-hidden="true">
        {creator.displayName.trim().charAt(0)}
      </span>
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
          <ReminderCell topicId={topicId} creator={creator} locale={locale} />
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
export function TopicCreatorManagementDrawer({ topicId, onClose }: TopicCreatorManagementDrawerProps) {
  const [locale] = useLocale()
  const { favorites } = useFavoriteCreators()
  const { getNotificationType } = useTopicNotificationPreferences()
  const [searchQuery, setSearchQuery] = useState("")

  const handleClose = () => {
    setSearchQuery("")
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

  const topicDef = getAvailableTopics().find((entry) => entry.id === topicId)
  const drawerTitle = topicDef ? t(locale, "notificationSettings.managementDrawerTitle", { topic: t(locale, topicDef.labelKey) }) : ""

  // Falls back to "both" only for the brief render where topicId is null
  // (drawer closing) -- content below is gated on {topicId && ...} anyway.
  const notificationType = topicId ? getNotificationType(topicId) : "both"
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
                    <CreatorRow key={creator.creatorId} topicId={topicId} creator={creator} notificationType={notificationType} />
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
                            <CreatorRow key={creator.creatorId} topicId={topicId} creator={creator} notificationType={notificationType} />
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
