import { useState } from "react"
import { Button, ConfigProvider, Dropdown } from "antd"
import type { ConfigProviderProps, GetProp } from "antd"
import { DownOutlined } from "@ant-design/icons"
import { useLocale } from "../../hooks/useLocale"
import { useTopicNotificationPreferences } from "../../hooks/useTopicNotificationPreferences"
import { getAllNotificationCreators } from "../../lib/notificationCreatorGrouping"
import {
  MEMBER_CHOICE_MODE,
  NOTIFICATION_TOPICS,
  REMINDER_TIME_LABEL_KEYS,
  REMINDER_TIME_VALUES,
  type NotificationTopicId,
  type TopicReminderMode,
} from "../../lib/notificationTopics"
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
 * ripple. Applied only to "管理成員" (via its own nested ConfigProvider,
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

function TopicCard({ topicId, onManage }: { topicId: NotificationTopicId; onManage: () => void }) {
  const [locale] = useLocale()
  const { getReminderMode, setReminderMode, getEnabledCreatorIds } = useTopicNotificationPreferences()
  const topicDef = NOTIFICATION_TOPICS.find((entry) => entry.id === topicId)!

  const enabledIds = getEnabledCreatorIds(topicId)
  const enabledCreators = getAllNotificationCreators().filter((creator) => enabledIds.has(creator.creatorId))
  const previewNames = enabledCreators.slice(0, MAX_PREVIEW_NAMES).map((creator) => creator.displayName)
  const hasMore = enabledCreators.length > MAX_PREVIEW_NAMES
  const separator = t(locale, "notificationSettings.namePreviewSeparator")

  // "各成員為準" listed last, per the user's own confirmed ordering (this
  // feature's own confirmed spec: a topic in a concrete-time mode FORCES
  // that time onto every Live-enabled member, overriding their own
  // individual choice -- only "member_choice" mode lets each member's own
  // reminder (set in the management drawer) actually take effect. See
  // useTopicNotificationPreferences' getEffectiveReminder for the
  // resolution logic itself.
  const reminderModeOptions = [
    ...REMINDER_TIME_VALUES.map((value) => ({ value, label: t(locale, REMINDER_TIME_LABEL_KEYS[value]) })),
    { value: MEMBER_CHOICE_MODE, label: t(locale, "notificationSettings.topicReminderMode.memberChoice") },
  ]
  const topicLabel = t(locale, topicDef.labelKey)
  const reminderMode = getReminderMode(topicId)
  const reminderModeLabel = reminderModeOptions.find((option) => option.value === reminderMode)?.label ?? ""

  return (
    <section className="notification-settings__topic-card">
      <h2 className="notification-settings__topic-title">{topicLabel}</h2>

      <div className="notification-settings__topic-row">
        <span className="notification-settings__topic-row-label">{t(locale, "notificationSettings.defaultReminderLabel")}</span>
        <Dropdown
          menu={{
            items: reminderModeOptions.map((option) => ({ key: option.value, label: option.label })),
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

      {/* Ant Design's own "Inset" Custom Wave example (components/button/demo
       * /wave.tsx) -- scoped to just this Button via its own nested
       * ConfigProvider, so no other button anywhere else in the app is
       * affected. type="primary" reuses this component's own outer
       * ConfigProvider theme (colorPrimary: the member's own accent color,
       * not antd's default blue) -- text/onClick/aria-label/position all
       * unchanged from the plain <button> this replaced. */}
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
    </section>
  )
}

/** Notification Settings' own content: a topic-centered summary per topic
 * (this feature's own spec sections 2/3/14) -- never the full ~122-creator
 * roster permanently on screen. Each topic card shows its own default
 * reminder time and a compact "who's enabled" summary; the full creator
 * roster (Agency > Region > Generation/Unit, Favorites-first, searchable)
 * only ever renders inside TopicCreatorManagementDrawer, opened per topic
 * via "管理成員". */
export function NotificationSettings() {
  const { theme } = useMemberTheme()
  const [managingTopicId, setManagingTopicId] = useState<NotificationTopicId | null>(null)

  return (
    <ConfigProvider theme={{ token: { colorPrimary: theme.primary } }}>
      <div className="notification-settings">
        {NOTIFICATION_TOPICS.map((topic) => (
          <TopicCard key={topic.id} topicId={topic.id} onManage={() => setManagingTopicId(topic.id)} />
        ))}
        <TopicCreatorManagementDrawer topicId={managingTopicId} onClose={() => setManagingTopicId(null)} />
      </div>
    </ConfigProvider>
  )
}
