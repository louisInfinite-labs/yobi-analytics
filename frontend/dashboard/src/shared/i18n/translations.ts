/** Smallest reusable locale-text structure (no i18n library dependency) —
 * this session's own requirement that any newly added user-facing text
 * prepare zh-TW/en/ja versions ahead of a future language-settings UI,
 * without introducing a large i18n framework just for one dialog. New
 * features should add their own keys here rather than hard-coding text. */
export type Locale = "zh-TW" | "en" | "ja"

export type TranslationKey =
  | "common.cancel"
  | "oshiSwitch.confirmMessage"
  | "oshiSwitch.confirmAction"
  | "oshiSwitch.dontAskAgain"
  | "favorite.add"
  | "favorite.remove"
  | "creatorStatusList.emptyFavorites"
  | "creatorStatusList.emptySearch"
  | "creatorStatusList.switchOshiTo"
  | "creatorStatusList.otherGroupLabel"
  | "creatorStatusList.gamersGroupLabel"
  | "creatorStatusList.mainBadge"
  | "recentVideos.tag.latestVideos"
  | "recentVideos.tag.latestLive"
  | "recentVideos.tag.short"
  | "recentVideos.liveBadge"
  | "recentVideos.tag.all"
  | "recentVideos.tag.sf6"
  | "recentVideos.tag.valo"
  | "recentVideos.tag.minecraft"
  | "recentVideos.tag.apex"
  | "recentVideos.tag.chatting"
  | "recentVideos.tag.singing"
  | "recentVideos.tag.mv"
  | "recentVideos.sort.newest"
  | "recentVideos.sort.oldest"
  | "recentVideos.sort.mostViews"
  | "recentVideos.sortAriaLabel"
  | "recentVideos.windowAriaLabel"
  | "recentVideos.window.total"
  | "recentVideos.window.1d"
  | "recentVideos.window.7d"
  | "recentVideos.window.30d"
  | "recentVideos.contentType.all"
  | "recentVideos.contentType.live"
  | "recentVideos.contentType.video"
  | "recentVideos.contentTypeAriaLabel"
  | "recentVideos.empty.latestVideos"
  | "recentVideos.empty.latestLive"
  | "recentVideos.empty.other"
  | "recentVideos.viewAll"
  | "videoSearch.placeholder"
  | "videoSearch.empty"
  | "liveScheduleDock.title"
  | "liveScheduleDock.close"
  | "liveScheduleDock.panelAriaLabel"
  | "liveScheduleDock.resize.shrink"
  | "liveScheduleDock.resize.expand"
  | "liveScheduleDock.resize.shrinkAria"
  | "liveScheduleDock.resize.expandAria"
  | "oshiStatus.liveNext"
  | "oshiStatus.noScheduledStream"
  | "oshiStatus.liveNow"
  | "oshiStatus.unseen"
  | "oshiStatus.unseenVideos"
  | "oshiStatus.unseenLive"
  | "oshiStatus.uploads"
  | "oshiStatus.streams"
  | "oshiStatus.thisWeek"
  | "oshiStatus.recent"
  | "oshiStatus.noRecentActivity"
  | "oshiStatus.viewAll"
  | "oshiStatus.markAllWatched"
  | "oshiStatus.markAllWatched.confirmMessage"
  | "oshiStatus.markAllWatched.confirmAction"
  | "oshiStatus.closeActivity"
  | "oshiStatus.newBadge"
  | "oshiStatus.subscribers"
  | "oshiStatus.nowPlaying"
  | "oshiStatus.thumbnailLabel"
  | "oshiStatus.devResetVisit"
  | "oshiStatus.milestones.open"
  | "oshiStatus.milestones.dialogLabel"
  | "oshiStatus.milestones.birthday"
  | "oshiStatus.milestones.anniversary"
  | "oshiStatus.milestones.anniversaryUnknown"
  | "oshiStatus.milestones.date"
  | "oshiStatus.milestones.unit.month"
  | "oshiStatus.milestones.unit.day"
  | "oshiStatus.milestones.unit.hour"
  | "oshiStatus.milestones.unit.minute"
  | "oshiStatus.milestones.unit.second"
  | "oshiStatus.milestones.unavailable"
  | "oshiStatus.milestones.loading"
  | "oshiStatus.milestones.today"
  | "oshiStatus.milestones.caption"
  | "liveStatus.milestone.birthday"
  | "liveStatus.milestone.debut"
  | "liveStatus.milestone.both"
  | "liveStatus.milestone.today"
  | "errorState.code"
  | "errorState.defaultMessage"
  | "errorState.retry"
  | "apiError.config"
  | "apiError.network"
  | "apiError.rateLimited"
  | "apiError.serverError"
  | "apiError.generic"
  | "mainNavbar.navAriaLabel"
  | "mainNavbar.dashboard"
  | "mainNavbar.home"
  | "mainNavbar.settings"
  | "mainNavbar.schedule"
  | "mainNavbar.about"
  | "mainNavbar.openNavAriaLabel"
  | "mainNavbar.closeNavAriaLabel"
  | "settingsSecondaryNavbar.title"
  | "settingsSecondaryNavbar.navAriaLabel"
  | "settingsSecondaryNavbar.myOshiSettings"
  | "settingsSecondaryNavbar.oshiSettings"
  | "settingsSecondaryNavbar.notificationSettings"
  | "settingsSecondaryNavbar.displaySettings"
  | "aboutSecondaryNavbar.title"
  | "aboutSecondaryNavbar.navAriaLabel"
  | "myOshiSettings.selectAria"
  | "myOshiSettings.pageTitle"
  | "myOshiSettings.pageDescription"
  | "myOshiSettings.statusMarker"
  | "myOshiSettings.presentationAria"
  | "myOshiSettings.rosterAria"
  | "oshiSettings.searchPlaceholder"
  | "oshiSettings.noResults"
  | "oshiSettings.addFavoriteAria"
  | "oshiSettings.removeFavoriteAria"
  | "oshiSettings.otherGroupLabel"
  | "oshiSettings.gamersGroupLabel"
  | "oshiSettings.pageTitle"
  | "oshiSettings.pageDescription"
  | "oshiSettings.selectedCountLabel"
  | "oshiSettings.viewFilter.favoritesOnly"
  | "notificationSettings.pageTitle"
  | "notificationSettings.pageDescription"
  | "notificationSettings.deliveryTimes.title"
  | "notificationSettings.deliveryTimes.description"
  | "notificationSettings.deliveryTimes.listAriaLabel"
  | "notificationSettings.deliveryTimes.timeAriaLabel"
  | "notificationSettings.deliveryTimes.removeAriaLabel"
  | "notificationSettings.deliveryTimes.addAriaLabel"
  | "notificationSettings.simultaneousLive.title"
  | "notificationSettings.simultaneousLive.description"
  | "notificationSettings.liveColumnHeader"
  | "notificationSettings.newVideoColumnHeader"
  | "notificationSettings.liveSwitchAriaLabel"
  | "notificationSettings.newVideoSwitchAriaLabel"
  | "notificationSettings.otherGroupLabel"
  | "notificationSettings.gamersGroupLabel"
  | "notificationSettings.searchPlaceholder"
  | "notificationSettings.noResults"
  | "notificationSettings.defaultReminderLabel"
  | "notificationSettings.reminder.atStart"
  | "notificationSettings.reminder.10min"
  | "notificationSettings.reminder.30min"
  | "notificationSettings.reminder.1hour"
  | "notificationSettings.reminderColumnHeader"
  | "notificationSettings.drawerReminderColumnHeader"
  | "notificationSettings.reminderSelectAriaLabel"
  | "notificationSettings.topicReminderMode.memberChoice"
  | "notificationSettings.reminderNotInEffectHint"
  | "notificationSettings.saveFailed"
  | "notificationSettings.reminder.unset"
  | "notificationSettings.reminderUnsupportedTopic"
  | "notificationSettings.notifiedMembersLabel"
  | "notificationSettings.selectedCountLabel"
  | "notificationSettings.namePreviewSeparator"
  | "notificationSettings.noSelectedMembers"
  | "notificationSettings.manageMembersButton"
  | "notificationSettings.managementDrawerTitle"
  | "notificationSettings.managementDrawerNotificationType"
  | "notificationSettings.favoritesGroupLabel"
  | "notificationSettings.topic.all"
  | "notificationSettings.saveTopicButton"
  | "notificationSettings.topicSelectPlaceholder"
  | "notificationSettings.topicSelectAriaLabel"
  | "notificationSettings.addTopicButtonAriaLabel"
  | "notificationSettings.reminder.1min"
  | "notificationSettings.notificationTypeLabel"
  | "notificationSettings.notificationTypeCombinedLabel"
  | "notificationSettings.notificationTypeSectionHelp"
  | "notificationSettings.topicListPanelTitle"
  | "notificationSettings.topicSortAriaLabel"
  | "notificationSettings.topicSortSaved"
  | "notificationSettings.topicSortAlphabetical"
  | "notificationSettings.detailDescription"
  | "notificationSettings.reminderSectionHelp"
  | "notificationSettings.reminderSectionHelpDisabledNewVideo"
  | "notificationSettings.overrideSectionTitle"
  | "notificationSettings.overrideBadgeCount"
  | "notificationSettings.removeTopicButton"
  | "notificationSettings.removeTopicButtonAriaLabel"
  | "notificationSettings.memberPreviewMoreLabel"
  | "notificationSettings.emptySelection"
  | "languageSettings.picker.zhTW"
  | "languageSettings.picker.en"
  | "languageSettings.picker.ja"
  | "classificationFilterBar.title"
  | "classificationFilterBar.noActiveFilters"
  | "classificationFilterBar.activeFilterCount"
  | "classificationFilterBar.clearFilters"
  | "classificationFilterBar.creatorScopeGroup"
  | "classificationFilterBar.contentScopeGroup"
  | "contributionBarChart.title"
  | "contributionBarChart.shareOf"
  | "contributionBarChart.periodLabel.day"
  | "contributionBarChart.periodLabel.multiDay"
  | "contributionBarChart.empty"
  | "contributionBarChart.ariaLabel"
  | "displaySettings.title"
  | "displaySettings.description"
  | "displaySettings.timeFormatLabel"
  | "displaySettings.timeFormatHelp"
  | "displaySettings.timeFormat24h"
  | "displaySettings.timeFormat12h"
  | "displaySettings.upcomingLabel"
  | "displaySettings.upcomingHelp"
  | "displaySettings.languageLabel"
  | "displaySettings.languageHelp"
  | "displaySettings.upcomingCountdownOption"
  | "notificationToggle.enable"
  | "notificationToggle.on"
  | "notificationToggle.unavailable"
  | "notificationToggle.unsupportedTooltip"
  | "settingsSecondaryNavbar.openMenuAriaLabel"
  | "settingsSecondaryNavbar.closeMenuAriaLabel"
  | "push.explainTitle"
  | "push.explainBody"
  | "push.explainContinue"
  | "push.deniedTitle"
  | "push.deniedDescription"
  | "push.deniedAction"
  | "push.deniedHelpIos"
  | "push.deniedHelpInstalled"
  | "push.deniedHelpBrowser"
  | "push.deniedReturnHint"
  | "push.unsupportedTitle"
  | "push.unsupportedBody"
  | "push.unsupportedIosBody"
  | "push.failedTitle"
  | "push.failedBody"
  | "push.failedDiagnosticLabel"
  | "push.close"
  | "videoLink.titleUnavailable"
  | "videoLink.titleUnknown"
  | "videoLink.membersOnly"
  | "videoLink.privateOrDeleted"
  | "videoLink.unavailable"
  | "videoLink.unknown"
  | "videoLink.retry"
  | "videoLink.close"
  | "pwa.installLabel"
  | "pwa.installHelp"
  | "pwa.installButton"
  | "pwa.howButton"
  | "pwa.iosTitle"
  | "pwa.iosStep1"
  | "pwa.iosStep2"
  | "pwa.iosStep3"
  | "pwa.menuTitle"
  | "pwa.menuStep1"
  | "pwa.menuStep2"
  | "pwa.dataWarningTitle"
  | "pwa.dataWarningBody"
  | "liveSchedule.pageTitle"
  | "liveSchedule.pageSubtitle"
  | "liveSchedule.timeColumnHeader"
  | "liveSchedule.prevWeekAria"
  | "liveSchedule.nextWeekAria"
  | "liveSchedule.filterLabel"
  | "liveSchedule.removeStreamReminderButton"
  | "liveSchedule.filterAriaLabel"
  | "liveSchedule.organizationFilterAriaLabel"
  | "liveSchedule.organizationAll"
  | "liveSchedule.organizationVspo"
  | "liveSchedule.organizationHololive"
  | "liveSchedule.filterFavoritesGroup"
  | "liveSchedule.filterAllGroup"
  | "liveSchedule.filterAddFavorites"
  | "liveSchedule.filterClear"
  | "liveSchedule.filterNoMatch"
  | "liveSchedule.filterSelectedCount"
  | "liveSchedule.liveBadge"
  | "liveSchedule.premiereBadge"
  | "liveSchedule.noThumbnail"
  | "liveSchedule.moreStreamsAria"
  | "liveSchedule.dayNavAria"
  | "liveSchedule.previousDayAria"
  | "liveSchedule.nextDayAria"
  | "liveSchedule.closeAria"
  | "liveSchedule.setReminderButton"
  | "liveSchedule.openStreamButton"
  | "videoPlayer.rotateHint"
  | "liveSchedule.startsInMinutes"
  | "liveSchedule.streamReminderExplanationLine1"
  | "liveSchedule.streamReminderExplanationLine2"
  | "liveSchedule.saveReminderButton"
  | "liveSchedule.saveReminderFailed"
  | "liveSchedule.streamReminderUnsetHint"

const TRANSLATIONS: Record<Locale, Record<TranslationKey, string>> = {
  "zh-TW": {
    "common.cancel": "取消",
    "oshiSwitch.confirmMessage": "要將畫面切換到「{{creatorName}}」嗎？",
    "oshiSwitch.confirmAction": "切換",
    "oshiSwitch.dontAskAgain": "以後不再提示",
    "favorite.add": "加入收藏",
    "favorite.remove": "移除收藏",
    "creatorStatusList.emptyFavorites": "尚未有收藏。",
    "creatorStatusList.emptySearch": "找不到符合的創作者。",
    "creatorStatusList.switchOshiTo": "切換推し為 {{creatorName}}",
    "creatorStatusList.otherGroupLabel": "其他",
    "creatorStatusList.gamersGroupLabel": "Gamers",
    "creatorStatusList.mainBadge": "MAIN",
    "recentVideos.tag.latestVideos": "最新影片",
    "recentVideos.tag.latestLive": "最新直播",
    "recentVideos.tag.short": "Short",
    "recentVideos.liveBadge": "直播中",
    "recentVideos.tag.all": "ALL",
    "recentVideos.tag.sf6": "SF6",
    "recentVideos.tag.valo": "VALO",
    "recentVideos.tag.minecraft": "Minecraft",
    "recentVideos.tag.apex": "Apex",
    "recentVideos.tag.chatting": "雜談",
    "recentVideos.tag.singing": "歌回",
    "recentVideos.tag.mv": "MV",
    "recentVideos.sort.newest": "最新上架",
    "recentVideos.sort.oldest": "最舊上架",
    "recentVideos.sort.mostViews": "最多觀看次數",
    "recentVideos.sortAriaLabel": "排序影片",
    "recentVideos.windowAriaLabel": "期間",
    "recentVideos.window.total": "全部",
    "recentVideos.window.1d": "1d",
    "recentVideos.window.7d": "7d",
    "recentVideos.window.30d": "30d",
    "recentVideos.contentType.all": "全部",
    "recentVideos.contentType.live": "直播",
    "recentVideos.contentType.video": "影片",
    "recentVideos.contentTypeAriaLabel": "內容類型",
    "recentVideos.empty.latestVideos": "尚無最新影片",
    "recentVideos.empty.latestLive": "尚無最新直播",
    "recentVideos.empty.other": "沒有影片",
    "recentVideos.viewAll": "查看全部",
    "videoSearch.placeholder": "搜尋影片",
    "videoSearch.empty": "沒有符合的影片",
    "liveScheduleDock.title": "直播狀態",
    "liveScheduleDock.close": "關閉",
    "liveScheduleDock.panelAriaLabel": "直播排程搜尋",
    "liveScheduleDock.resize.shrink": "縮小",
    "liveScheduleDock.resize.expand": "放大",
    "liveScheduleDock.resize.shrinkAria": "縮小面板",
    "liveScheduleDock.resize.expandAria": "展開面板至全高",
    "oshiStatus.liveNext": "直播／接下來 24小時內",
    "oshiStatus.noScheduledStream": "尚無排定的直播",
    "oshiStatus.liveNow": "直播中",
    "oshiStatus.unseen": "尚未觀看",
    "oshiStatus.unseenVideos": "影片",
    "oshiStatus.unseenLive": "直播",
    "oshiStatus.uploads": "上傳影片",
    "oshiStatus.streams": "直播場次",
    "oshiStatus.thisWeek": "本週",
    "oshiStatus.recent": "最近動態",
    "oshiStatus.noRecentActivity": "尚無最近動態",
    "oshiStatus.viewAll": "查看全部",
    "oshiStatus.markAllWatched": "已觀看全部",
    "oshiStatus.markAllWatched.confirmMessage": "已觀看全部新影片嗎?",
    "oshiStatus.markAllWatched.confirmAction": "確定",
    "oshiStatus.closeActivity": "關閉",
    "oshiStatus.newBadge": "NEW",
    "oshiStatus.subscribers": "訂閱者",
    "oshiStatus.nowPlaying": "正在播放",
    "oshiStatus.thumbnailLabel": "縮圖：{{title}}",
    "oshiStatus.devResetVisit": "重置造訪",
    "oshiStatus.milestones.open": "開啟生日與出道紀念日",
    "oshiStatus.milestones.dialogLabel": "生日與出道紀念日",
    "oshiStatus.milestones.birthday": "生日",
    "oshiStatus.milestones.anniversary": "{{ordinal}}周年紀念日",
    "oshiStatus.milestones.anniversaryUnknown": "周年紀念日",
    "oshiStatus.milestones.date": "{{month}}月{{day}}日",
    "oshiStatus.milestones.unit.month": "個月",
    "oshiStatus.milestones.unit.day": "天",
    "oshiStatus.milestones.unit.hour": "小時",
    "oshiStatus.milestones.unit.minute": "分",
    "oshiStatus.milestones.unit.second": "秒",
    "oshiStatus.milestones.unavailable": "資料暫時無法載入",
    "oshiStatus.milestones.loading": "載入中",
    "oshiStatus.milestones.today": "當日",
    "oshiStatus.milestones.caption": "以 JST 00:00 為準",
    "liveStatus.milestone.birthday": "生日",
    "liveStatus.milestone.debut": "出道日",
    "liveStatus.milestone.both": "生日&出道日",
    "liveStatus.milestone.today": "當日",
    "errorState.code": "(代碼: {{code}})",
    "errorState.defaultMessage": "載入資料時發生錯誤。",
    "errorState.retry": "重試",
    "apiError.config": "應用程式設定錯誤,請聯絡管理員。",
    "apiError.network": "無法連線到伺服器,請檢查你的網絡連線後重試。",
    "apiError.rateLimited": "現在使用人數較多,伺服器暫時限制請求 (429)。系統已自動重試但仍未成功,請稍後再重新整理。",
    "apiError.serverError": "AWS 伺服器發生錯誤 ({{status}}),並非你的網絡問題,請稍後再試。",
    "apiError.generic": "請求失敗 ({{status}}):{{message}}",
    "mainNavbar.navAriaLabel": "主導覽",
    "mainNavbar.dashboard": "影片數據",
    "mainNavbar.home": "首頁",
    "mainNavbar.settings": "設定",
    "mainNavbar.schedule": "時間表",
    "mainNavbar.about": "關於",
    "mainNavbar.openNavAriaLabel": "開啟導覽",
    "mainNavbar.closeNavAriaLabel": "關閉導覽",
    "settingsSecondaryNavbar.title": "設定",
    "settingsSecondaryNavbar.navAriaLabel": "設定導覽",
    "settingsSecondaryNavbar.myOshiSettings": "我推設定",
    "settingsSecondaryNavbar.oshiSettings": "收藏名單",
    "settingsSecondaryNavbar.notificationSettings": "推送通知(直播 / 新片)",
    "settingsSecondaryNavbar.displaySettings": "顯示設定",
    "aboutSecondaryNavbar.title": "關於",
    "aboutSecondaryNavbar.navAriaLabel": "關於導覽",
    "oshiSettings.searchPlaceholder": "搜尋成員",
    "oshiSettings.noResults": "找不到符合的成員",
    "oshiSettings.addFavoriteAria": "將 {{name}} 加入我推",
    "oshiSettings.removeFavoriteAria": "將 {{name}} 從我推移除",
    "oshiSettings.otherGroupLabel": "其他",
    "oshiSettings.gamersGroupLabel": "Gamers",
    "oshiSettings.pageTitle": "我的收藏",
    "notificationSettings.pageTitle": "推送通知",
    "notificationSettings.pageDescription": "設定直播與新影片的通知方式、提醒時間及通知對象。",
    "notificationSettings.deliveryTimes.title": "新片通知時段",
    "notificationSettings.deliveryTimes.description": "新片通知會在你所在時區的這些時間送出，每天最多 4 個，以 30 分鐘為單位。",
    "notificationSettings.deliveryTimes.listAriaLabel": "新片通知時間",
    "notificationSettings.deliveryTimes.timeAriaLabel": "通知時間 {{index}}",
    "notificationSettings.deliveryTimes.removeAriaLabel": "刪除通知時間 {{time}}",
    "notificationSettings.deliveryTimes.addAriaLabel": "新增通知時間",
    "notificationSettings.simultaneousLive.title": "同時開播預告",
    "notificationSettings.simultaneousLive.description": "當你開啟直播通知的兩位以上創作者預定在完全相同的時間開播時，在開播前通知你。預設關閉。",
    "oshiSettings.pageDescription": "管理你收藏的成員，並用於直播狀態、通知設定等功能。",
    "oshiSettings.selectedCountLabel": "已選 {{count}} 人",
    "oshiSettings.viewFilter.favoritesOnly": "收藏",
    "notificationSettings.liveColumnHeader": "直播",
    "notificationSettings.newVideoColumnHeader": "新片",
    "notificationSettings.liveSwitchAriaLabel": "{{name}} 直播通知",
    "notificationSettings.newVideoSwitchAriaLabel": "{{name}} 新片通知",
    "notificationSettings.otherGroupLabel": "其他",
    "notificationSettings.gamersGroupLabel": "Gamers",
    "notificationSettings.searchPlaceholder": "搜尋成員",
    "notificationSettings.noResults": "找不到符合的成員",
    "notificationSettings.defaultReminderLabel": "直播提醒時間",
    "notificationSettings.reminder.atStart": "開播時",
    "notificationSettings.reminder.10min": "10 分鐘前",
    "notificationSettings.reminder.30min": "30 分鐘前",
    "notificationSettings.reminder.1hour": "1 小時前",
    "notificationSettings.reminderColumnHeader": "提醒時間",
    // U+200B after the first word: a soft line-break opportunity, so a narrow phone column wraps 直播 / 提醒時間 instead of clipping.
    "notificationSettings.drawerReminderColumnHeader": "直播​提醒時間",
    "notificationSettings.reminderSelectAriaLabel": "{{name}} 的提醒時間",
    "notificationSettings.topicReminderMode.memberChoice": "各成員為準",
    "notificationSettings.reminderNotInEffectHint": "未生效（已被「全部」設定覆蓋）",
    "notificationSettings.saveFailed": "無法儲存到伺服器，這次變更未套用。請稍後再試。",
    "notificationSettings.reminder.unset": "不提醒",
    "notificationSettings.reminderUnsupportedTopic": "此主題暫未支援獨立通知，會跟「全部」設定",
    "notificationSettings.notifiedMembersLabel": "通知成員",
    "notificationSettings.selectedCountLabel": "已選 {{count}} 人",
    "notificationSettings.namePreviewSeparator": "、",
    "notificationSettings.noSelectedMembers": "尚未選擇任何成員",
    "notificationSettings.manageMembersButton": "管理成員",
    "notificationSettings.managementDrawerTitle": "{{topic}} — 通知成員",
    "notificationSettings.managementDrawerNotificationType": "通知類型：{{type}}",
    "notificationSettings.favoritesGroupLabel": "收藏",
    "notificationSettings.topic.all": "全部",
    "notificationSettings.saveTopicButton": "儲存",
    "notificationSettings.topicSelectPlaceholder": "選擇主題",
    "notificationSettings.topicSelectAriaLabel": "選擇通知主題",
    "notificationSettings.addTopicButtonAriaLabel": "新增主題",
    "notificationSettings.reminder.1min": "1 分鐘前",
    "notificationSettings.notificationTypeLabel": "通知類型",
    "notificationSettings.notificationTypeCombinedLabel": "直播+新片",
    "notificationSettings.notificationTypeSectionHelp": "選擇要收到這個成員的直播、新片通知",
    "notificationSettings.topicListPanelTitle": "通知主題",
    "notificationSettings.topicSortAriaLabel": "主題排序方式",
    "notificationSettings.topicSortSaved": "預設順序",
    "notificationSettings.topicSortAlphabetical": "依名稱排序",
    "notificationSettings.detailDescription": "開播前固定發送通知",
    "notificationSettings.reminderSectionHelp": "開播時一定會通知一次。若選擇提前時間，會在直播開始前額外再通知一次。",
    "notificationSettings.reminderSectionHelpDisabledNewVideo": "目前只接收新片通知，直播提醒時間無法設定。",
    "notificationSettings.overrideSectionTitle": "個別成員設定（選用）",
    "notificationSettings.overrideBadgeCount": "{{count}} 個別設定",
    "notificationSettings.removeTopicButton": "移除",
    "notificationSettings.removeTopicButtonAriaLabel": "移除「{{topic}}」",
    "notificationSettings.memberPreviewMoreLabel": "+{{count}}",
    "notificationSettings.emptySelection": "請從左側選擇一個主題",
    "myOshiSettings.selectAria": "將 {{name}} 設為我推",
    "myOshiSettings.pageTitle": "我推設定",
    "myOshiSettings.pageDescription": "選擇主畫面預設顯示的主推成員。",
    "myOshiSettings.statusMarker": "MAIN OSHI",
    "myOshiSettings.presentationAria": "目前主推: {{name}}",
    "myOshiSettings.rosterAria": "我推成員選擇列表",
    "languageSettings.picker.zhTW": "繁體中文",
    "languageSettings.picker.en": "英文",
    "languageSettings.picker.ja": "日文",
    "classificationFilterBar.title": "篩選分析",
    "classificationFilterBar.noActiveFilters": "所有儀表板資料",
    "classificationFilterBar.activeFilterCount": "已套用篩選: {{count}}",
    "classificationFilterBar.clearFilters": "清除篩選",
    "classificationFilterBar.creatorScopeGroup": "創作者範圍",
    "classificationFilterBar.contentScopeGroup": "內容範圍",
    "contributionBarChart.title": "貢獻度",
    "contributionBarChart.shareOf": "{{period}}的佔比",
    "contributionBarChart.periodLabel.day": "今日成長",
    "contributionBarChart.periodLabel.multiDay": "此期間的成長",
    "contributionBarChart.empty": "沒有正向成長可顯示。",
    "contributionBarChart.ariaLabel": "成員對{{period}}的貢獻",
    "displaySettings.title": "顯示設定",
    "displaySettings.description": "設定應用程式內時間資訊的顯示方式。",
    "displaySettings.timeFormatLabel": "時間顯示格式",
    "displaySettings.timeFormatHelp": "設定直播開始時間、預定時間等時間資訊的顯示方式。",
    "displaySettings.timeFormat24h": "24 小時制（HH:mm）",
    "displaySettings.timeFormat12h": "12 小時制（AM/PM）",
    "displaySettings.upcomingLabel": "即將到來的直播",
    "displaySettings.upcomingHelp": "設定即將到來的直播時間的顯示格式。",
    "displaySettings.languageLabel": "語言設定",
    "displaySettings.languageHelp": "選擇 OshiYobi 的顯示語言。",
    "displaySettings.upcomingCountdownOption": "倒數計時",
    "notificationToggle.enable": "開啟通知",
    "notificationToggle.on": "通知已開啟",
    "notificationToggle.unavailable": "無法使用通知",
    "notificationToggle.unsupportedTooltip": "此瀏覽器不支援推送通知",
    "settingsSecondaryNavbar.openMenuAriaLabel": "開啟設定選單",
    "settingsSecondaryNavbar.closeMenuAriaLabel": "關閉設定選單",
    "push.explainTitle": "允許 OshiYobi 傳送通知",
    "push.explainBody": "直播提醒與新影片通知需要透過裝置的通知送達。按「繼續」後，系統會詢問是否允許通知，請選擇「允許」。",
    "push.explainContinue": "繼續",
    "push.deniedTitle": "尚未開啟通知權限",
    "push.deniedDescription": "請前往裝置設定，允許 OshiYobi 傳送通知。",
    "push.deniedAction": "查看設定方法",
    "push.deniedHelpIos": "iPhone／iPad：開啟「設定」→「通知」→「OshiYobi」，並開啟「允許通知」。",
    "push.deniedHelpInstalled": "開啟裝置的「設定」→「應用程式」→「OshiYobi」→「通知」，並允許通知。",
    "push.deniedHelpBrowser": "點選網址列旁的網站設定圖示（鎖頭或調整圖示）→「通知」→ 選擇「允許」，然後回到此頁面。",
    "push.deniedReturnHint": "設定完成後回到 OshiYobi，畫面會自動更新，不需要重新整理。",
    "push.unsupportedTitle": "此裝置目前無法接收通知",
    "push.unsupportedBody": "這個瀏覽器不支援網頁推播通知。",
    "push.unsupportedIosBody": "在 iPhone／iPad 上，請先用 Safari 將 OshiYobi 加入主畫面，再從主畫面開啟 OshiYobi 並設定通知。",
    "push.failedTitle": "無法開啟通知",
    "push.failedBody": "請稍後再試。這次的變更未套用。",
    "push.failedDiagnosticLabel": "診斷碼",
    "push.close": "關閉",
    "videoLink.titleUnavailable": "無法顯示影片",
    "videoLink.titleUnknown": "無法確認影片狀態",
    "videoLink.membersOnly": "這部影片已改為會員限定，無法顯示。",
    "videoLink.privateOrDeleted": "這部影片已設為私人或已被刪除，無法顯示。",
    "videoLink.unavailable": "這部影片目前無法觀看。",
    "videoLink.unknown": "無法確認影片狀態，請稍後再試。",
    "videoLink.retry": "重試",
    "videoLink.close": "關閉",
    "pwa.installLabel": "安裝 OshiYobi",
    "pwa.installHelp": "將 OshiYobi 加入裝置主畫面，之後可像 App 一樣開啟。安裝是選用的，不安裝也能正常使用。",
    "pwa.installButton": "安裝",
    "pwa.howButton": "查看安裝方法",
    "pwa.iosTitle": "加入主畫面",
    "pwa.iosStep1": "在 Safari 點選「分享」按鈕。",
    "pwa.iosStep2": "選擇「加入主畫面」。",
    "pwa.iosStep3": "點選「新增」，之後從主畫面開啟 OshiYobi。",
    "pwa.menuTitle": "安裝 OshiYobi",
    "pwa.menuStep1": "開啟瀏覽器選單（通常是右上角的「⋮」或「…」）。",
    "pwa.menuStep2": "選擇「安裝應用程式」或「加到主畫面」，之後從主畫面開啟 OshiYobi。",
    "pwa.dataWarningTitle": "本機資料可能不會自動帶入",
    "pwa.dataWarningBody": "加入主畫面後的 OshiYobi 可能不會自動使用你在 Safari 中的本機資料，例如 My Oshi、收藏、顯示設定及其他僅存在此裝置的偏好設定。原本 Safari 裡的資料不會被刪除，但也不保證會自動轉移，你可能需要在主畫面版本重新設定。",
    "liveSchedule.pageTitle": "直播時間表",
    "liveSchedule.pageSubtitle": "你所選創作者的即將到來與直播中節目。",
    "liveSchedule.timeColumnHeader": "時間",
    "liveSchedule.prevWeekAria": "上一週",
    "liveSchedule.nextWeekAria": "下一週",
    "liveSchedule.filterLabel": "篩選",
    "liveSchedule.removeStreamReminderButton": "移除單場設定（改用創作者設定）",
    "liveSchedule.filterAriaLabel": "篩選創作者",
    "liveSchedule.organizationFilterAriaLabel": "組織",
    "liveSchedule.organizationAll": "全部",
    "liveSchedule.organizationVspo": "VSPO",
    "liveSchedule.organizationHololive": "Hololive",
    "liveSchedule.filterFavoritesGroup": "收藏",
    "liveSchedule.filterAllGroup": "全部創作者",
    "liveSchedule.filterAddFavorites": "加入全部收藏",
    "liveSchedule.filterClear": "清除篩選",
    "liveSchedule.filterNoMatch": "找不到創作者",
    "liveSchedule.filterSelectedCount": "已選 {{count}} 位",
    "liveSchedule.liveBadge": "LIVE",
    "liveSchedule.premiereBadge": "首播",
    "liveSchedule.noThumbnail": "沒有縮圖",
    "liveSchedule.moreStreamsAria": "還有 {{count}} 個直播",
    "liveSchedule.dayNavAria": "日期切換",
    "liveSchedule.previousDayAria": "前一天",
    "liveSchedule.nextDayAria": "後一天",
    "liveSchedule.closeAria": "關閉",
    "liveSchedule.setReminderButton": "設定提醒",
    "liveSchedule.openStreamButton": "開啟直播",
    "videoPlayer.rotateHint": "旋轉裝置以獲得更大的畫面",
    "liveSchedule.startsInMinutes": "{{minutes}} 分鐘後開始",
    "liveSchedule.streamReminderExplanationLine1": "此設定只適用於這一次直播。",
    "liveSchedule.streamReminderExplanationLine2": "儲存後，這場直播會使用此處的通知設定，取代該創作者原本的直播通知設定。",
    "liveSchedule.saveReminderButton": "儲存",
    "liveSchedule.saveReminderFailed": "無法儲存提醒設定,請稍後再試。",
    "liveSchedule.streamReminderUnsetHint": "這場直播目前沒有提醒。選擇時間後按儲存，即可只為這一場設定。開播時固定發送通知。",
  },
  en: {
    "common.cancel": "Cancel",
    "oshiSwitch.confirmMessage": 'Switch the screen to "{{creatorName}}"?',
    "oshiSwitch.confirmAction": "Switch",
    "oshiSwitch.dontAskAgain": "Don't ask again",
    "favorite.add": "Add Favorite",
    "favorite.remove": "Remove Favorite",
    "creatorStatusList.emptyFavorites": "No favorites yet.",
    "creatorStatusList.emptySearch": "No matching creator.",
    "creatorStatusList.switchOshiTo": "Switch Oshi to {{creatorName}}",
    "creatorStatusList.otherGroupLabel": "Other",
    "creatorStatusList.gamersGroupLabel": "Gamers",
    "creatorStatusList.mainBadge": "MAIN",
    "recentVideos.tag.latestVideos": "Latest Videos",
    "recentVideos.tag.latestLive": "Latest Live",
    "recentVideos.tag.short": "Short",
    "recentVideos.liveBadge": "LIVE",
    "recentVideos.tag.all": "ALL",
    "recentVideos.tag.sf6": "SF6",
    "recentVideos.tag.valo": "VALO",
    "recentVideos.tag.minecraft": "Minecraft",
    "recentVideos.tag.apex": "Apex",
    "recentVideos.tag.chatting": "Chatting",
    "recentVideos.tag.singing": "Singing",
    "recentVideos.tag.mv": "MV",
    "recentVideos.sort.newest": "Newest",
    "recentVideos.sort.oldest": "Oldest",
    "recentVideos.sort.mostViews": "Most Views",
    "recentVideos.sortAriaLabel": "Sort videos",
    "recentVideos.windowAriaLabel": "Period",
    "recentVideos.window.total": "All",
    "recentVideos.window.1d": "1d",
    "recentVideos.window.7d": "7d",
    "recentVideos.window.30d": "30d",
    "recentVideos.contentType.all": "All",
    "recentVideos.contentType.live": "Live",
    "recentVideos.contentType.video": "Videos",
    "recentVideos.contentTypeAriaLabel": "Content type",
    "recentVideos.empty.latestVideos": "No recent videos",
    "recentVideos.empty.latestLive": "No recent streams",
    "recentVideos.empty.other": "No videos",
    "recentVideos.viewAll": "View All",
    "videoSearch.placeholder": "Search videos",
    "videoSearch.empty": "No matching videos",
    "liveScheduleDock.title": "LIVE STATUS",
    "liveScheduleDock.close": "Close",
    "liveScheduleDock.panelAriaLabel": "Live schedule search",
    "liveScheduleDock.resize.shrink": "Shrink",
    "liveScheduleDock.resize.expand": "Expand",
    "liveScheduleDock.resize.shrinkAria": "Shrink panel",
    "liveScheduleDock.resize.expandAria": "Expand panel to full height",
    "oshiStatus.liveNext": "Live / Next 24 Hours",
    "oshiStatus.noScheduledStream": "No scheduled stream",
    "oshiStatus.liveNow": "LIVE NOW",
    "oshiStatus.unseen": "Not watched yet",
    "oshiStatus.unseenVideos": "Videos",
    "oshiStatus.unseenLive": "Livestreams",
    "oshiStatus.uploads": "Uploads",
    "oshiStatus.streams": "Streams",
    "oshiStatus.thisWeek": "This week",
    "oshiStatus.recent": "Recent",
    "oshiStatus.noRecentActivity": "No recent activity",
    "oshiStatus.viewAll": "View all",
    "oshiStatus.markAllWatched": "Mark all watched",
    "oshiStatus.markAllWatched.confirmMessage": "Mark all new videos as watched?",
    "oshiStatus.markAllWatched.confirmAction": "OK",
    "oshiStatus.closeActivity": "Close",
    "oshiStatus.newBadge": "NEW",
    "oshiStatus.subscribers": "subscribers",
    "oshiStatus.nowPlaying": "Now Playing",
    "oshiStatus.thumbnailLabel": "Thumbnail: {{title}}",
    "oshiStatus.devResetVisit": "Reset visit",
    "oshiStatus.milestones.open": "Open birthday and debut anniversary",
    "oshiStatus.milestones.dialogLabel": "Birthday and debut anniversary",
    "oshiStatus.milestones.birthday": "Birthday",
    "oshiStatus.milestones.anniversary": "{{ordinal}} Anniversary",
    "oshiStatus.milestones.anniversaryUnknown": "Anniversary",
    "oshiStatus.milestones.date": "{{month}} {{day}}",
    "oshiStatus.milestones.unit.month": "mo",
    "oshiStatus.milestones.unit.day": "d",
    "oshiStatus.milestones.unit.hour": "h",
    "oshiStatus.milestones.unit.minute": "m",
    "oshiStatus.milestones.unit.second": "s",
    "oshiStatus.milestones.unavailable": "Data is temporarily unavailable",
    "oshiStatus.milestones.loading": "Loading",
    "oshiStatus.milestones.today": "Today",
    "oshiStatus.milestones.caption": "Based on JST 00:00",
    "liveStatus.milestone.birthday": "Birthday",
    "liveStatus.milestone.debut": "Debut",
    "liveStatus.milestone.both": "Birthday & Debut",
    "liveStatus.milestone.today": "Today",
    "errorState.code": "(Code: {{code}})",
    "errorState.defaultMessage": "Something went wrong loading this data.",
    "errorState.retry": "Retry",
    "apiError.config": "Application configuration error. Please contact an administrator.",
    "apiError.network": "Could not connect to the server. Please check your network connection and try again.",
    "apiError.rateLimited": "Usage is currently high and the server is temporarily rate-limiting requests (429). Automatic retries did not succeed — please refresh and try again shortly.",
    "apiError.serverError": "The server returned an error ({{status}}). This is not a problem with your network — please try again shortly.",
    "apiError.generic": "Request failed ({{status}}): {{message}}",
    "mainNavbar.navAriaLabel": "Main navigation",
    "mainNavbar.dashboard": "Video Data",
    "mainNavbar.home": "Home",
    "mainNavbar.settings": "Settings",
    "mainNavbar.schedule": "Schedule",
    "mainNavbar.about": "About",
    "mainNavbar.openNavAriaLabel": "Open navigation",
    "mainNavbar.closeNavAriaLabel": "Close navigation",
    "settingsSecondaryNavbar.title": "Settings",
    "settingsSecondaryNavbar.navAriaLabel": "Settings navigation",
    "settingsSecondaryNavbar.myOshiSettings": "Oshi Settings",
    "settingsSecondaryNavbar.oshiSettings": "Favorites List",
    "settingsSecondaryNavbar.notificationSettings": "Live/Video Notifications",
    "aboutSecondaryNavbar.title": "About",
    "aboutSecondaryNavbar.navAriaLabel": "About navigation",
    "settingsSecondaryNavbar.displaySettings": "Display",
    "oshiSettings.searchPlaceholder": "Search creators",
    "oshiSettings.noResults": "No creators found",
    "oshiSettings.addFavoriteAria": "Add {{name}} to favorites",
    "oshiSettings.removeFavoriteAria": "Remove {{name}} from favorites",
    "oshiSettings.otherGroupLabel": "Other",
    "oshiSettings.gamersGroupLabel": "Gamers",
    "oshiSettings.pageTitle": "My Favorites",
    "notificationSettings.pageTitle": "Push Notifications",
    "notificationSettings.pageDescription": "Configure notifications for live streams and new videos, including reminder timing and recipients.",
    "notificationSettings.deliveryTimes.title": "New Video notification times",
    "notificationSettings.deliveryTimes.description": "New Video notifications are delivered at these times on your own clock: up to 4 per day, in 30-minute steps.",
    "notificationSettings.deliveryTimes.listAriaLabel": "New Video notification times",
    "notificationSettings.deliveryTimes.timeAriaLabel": "Notification time {{index}}",
    "notificationSettings.deliveryTimes.removeAriaLabel": "Delete notification time {{time}}",
    "notificationSettings.deliveryTimes.addAriaLabel": "Add a notification time",
    "notificationSettings.simultaneousLive.title": "Simultaneous stream heads-up",
    "notificationSettings.simultaneousLive.description": "Get a notice before the start when two or more creators you have live notifications for are scheduled to go live at exactly the same time. Off by default.",
    "oshiSettings.pageDescription": "Manage your favorite members for Live Status, notification settings, and other features.",
    "oshiSettings.selectedCountLabel": "{{count}} selected",
    "oshiSettings.viewFilter.favoritesOnly": "Favorites",
    "notificationSettings.liveColumnHeader": "Live",
    "notificationSettings.newVideoColumnHeader": "New Video",
    "notificationSettings.liveSwitchAriaLabel": "{{name}} live notifications",
    "notificationSettings.newVideoSwitchAriaLabel": "{{name}} new video notifications",
    "notificationSettings.otherGroupLabel": "Other",
    "notificationSettings.gamersGroupLabel": "Gamers",
    "notificationSettings.searchPlaceholder": "Search creators",
    "notificationSettings.noResults": "No creators found",
    "notificationSettings.defaultReminderLabel": "Live reminder time",
    "notificationSettings.reminder.atStart": "At start",
    "notificationSettings.reminder.10min": "10 minutes before",
    "notificationSettings.reminder.30min": "30 minutes before",
    "notificationSettings.reminder.1hour": "1 hour before",
    "notificationSettings.reminderColumnHeader": "Reminder time",
    "notificationSettings.drawerReminderColumnHeader": "Live reminder time",
    "notificationSettings.reminderSelectAriaLabel": "{{name}}'s reminder time",
    "notificationSettings.topicReminderMode.memberChoice": "Member's choice",
    "notificationSettings.reminderNotInEffectHint": "Not in effect (overridden by the \"All\" setting)",
    "notificationSettings.saveFailed": "Couldn't save to the server — this change was not applied. Try again.",
    "notificationSettings.reminder.unset": "No reminder",
    "notificationSettings.reminderUnsupportedTopic": "This topic doesn't support its own notification yet; it follows the \"All\" setting.",
    "notificationSettings.notifiedMembersLabel": "Notified members",
    "notificationSettings.selectedCountLabel": "{{count}} selected",
    "notificationSettings.namePreviewSeparator": ", ",
    "notificationSettings.noSelectedMembers": "No members selected yet",
    "notificationSettings.manageMembersButton": "Manage Members",
    "notificationSettings.managementDrawerTitle": "{{topic}} — Notified Members",
    "notificationSettings.managementDrawerNotificationType": "Notification type: {{type}}",
    "notificationSettings.favoritesGroupLabel": "Favorites",
    "notificationSettings.topic.all": "All",
    "notificationSettings.saveTopicButton": "Save",
    "notificationSettings.topicSelectPlaceholder": "Select a topic",
    "notificationSettings.topicSelectAriaLabel": "Select notification topic",
    "notificationSettings.addTopicButtonAriaLabel": "Add topic",
    "notificationSettings.reminder.1min": "1 minute before",
    "notificationSettings.notificationTypeLabel": "Notification type",
    "notificationSettings.notificationTypeCombinedLabel": "Live + New Video",
    "notificationSettings.notificationTypeSectionHelp": "Choose which live stream and new video notifications you receive for this member",
    "notificationSettings.topicListPanelTitle": "Notification topics",
    "notificationSettings.topicSortAriaLabel": "Sort topics",
    "notificationSettings.topicSortSaved": "Saved order",
    "notificationSettings.topicSortAlphabetical": "By name",
    "notificationSettings.detailDescription": "A notification is always sent before the stream starts",
    "notificationSettings.reminderSectionHelp": "A notification is always sent when the stream starts. If you choose an earlier time, an additional reminder will be sent before the stream.",
    "notificationSettings.reminderSectionHelpDisabledNewVideo": "Live reminder timing is unavailable while only New Video notifications are enabled.",
    "notificationSettings.overrideSectionTitle": "Per-member overrides (optional)",
    "notificationSettings.overrideBadgeCount": "{{count}} custom",
    "notificationSettings.removeTopicButton": "Remove",
    "notificationSettings.removeTopicButtonAriaLabel": "Remove \"{{topic}}\"",
    "notificationSettings.memberPreviewMoreLabel": "+{{count}}",
    "notificationSettings.emptySelection": "Select a topic on the left",
    "myOshiSettings.selectAria": "Set {{name}} as my Oshi",
    "myOshiSettings.pageTitle": "Oshi Settings",
    "myOshiSettings.pageDescription": "Choose the Main Oshi shown by default on the Home screen.",
    "myOshiSettings.statusMarker": "MAIN OSHI",
    "myOshiSettings.presentationAria": "Current Main Oshi: {{name}}",
    "myOshiSettings.rosterAria": "Main Oshi creator selector",
    "languageSettings.picker.zhTW": "Traditional Chinese",
    "languageSettings.picker.en": "English",
    "languageSettings.picker.ja": "Japanese",
    "classificationFilterBar.title": "Filter analytics",
    "classificationFilterBar.noActiveFilters": "All dashboard data",
    "classificationFilterBar.activeFilterCount": "Active filters: {{count}}",
    "classificationFilterBar.clearFilters": "Clear filters",
    "classificationFilterBar.creatorScopeGroup": "Creator scope",
    "classificationFilterBar.contentScopeGroup": "Content scope",
    "contributionBarChart.title": "Contribution",
    "contributionBarChart.shareOf": "Share of {{period}}",
    "contributionBarChart.periodLabel.day": "today's growth",
    "contributionBarChart.periodLabel.multiDay": "this period's growth",
    "contributionBarChart.empty": "No positive growth to show.",
    "contributionBarChart.ariaLabel": "Member contribution to {{period}}",
    "displaySettings.title": "Display",
    "displaySettings.description": "Choose how time information is shown in the app.",
    "displaySettings.timeFormatLabel": "Time format",
    "displaySettings.timeFormatHelp": "Choose how stream start times and scheduled times are shown.",
    "displaySettings.timeFormat24h": "24-hour (HH:mm)",
    "displaySettings.timeFormat12h": "12-hour (AM/PM)",
    "displaySettings.upcomingLabel": "Upcoming streams",
    "displaySettings.upcomingHelp": "Choose how upcoming stream times are shown.",
    "displaySettings.languageLabel": "Language",
    "displaySettings.languageHelp": "Choose the display language for OshiYobi.",
    "displaySettings.upcomingCountdownOption": "Countdown",
    "notificationToggle.enable": "Enable notifications",
    "notificationToggle.on": "Notifications on",
    "notificationToggle.unavailable": "Notifications unavailable",
    "notificationToggle.unsupportedTooltip": "This browser doesn't support push notifications",
    "settingsSecondaryNavbar.openMenuAriaLabel": "Open settings menu",
    "settingsSecondaryNavbar.closeMenuAriaLabel": "Close settings menu",
    "push.explainTitle": "Allow OshiYobi to send notifications",
    "push.explainBody": "Live reminders and new-video alerts are delivered as device notifications. After you tap Continue, your device will ask for permission — please choose Allow.",
    "push.explainContinue": "Continue",
    "push.deniedTitle": "Notification permission is off",
    "push.deniedDescription": "Go to your device settings and allow OshiYobi to send notifications.",
    "push.deniedAction": "See how",
    "push.deniedHelpIos": "iPhone / iPad: open Settings → Notifications → OshiYobi, then turn on Allow Notifications.",
    "push.deniedHelpInstalled": "Open your device's Settings → Apps → OshiYobi → Notifications, then allow notifications.",
    "push.deniedHelpBrowser": "Open the site settings icon next to the address bar (lock or tune icon) → Notifications → Allow, then come back to this page.",
    "push.deniedReturnHint": "When you come back to OshiYobi this updates automatically — no reload needed.",
    "push.unsupportedTitle": "Notifications aren't available here",
    "push.unsupportedBody": "This browser doesn't support web push notifications.",
    "push.unsupportedIosBody": "On iPhone / iPad, add OshiYobi to your Home Screen from Safari first, then open it from the Home Screen to set up notifications.",
    "push.failedTitle": "Couldn't turn on notifications",
    "push.failedBody": "Please try again later. This change wasn't applied.",
    "push.failedDiagnosticLabel": "Diagnostic code",
    "push.close": "Close",
    "videoLink.titleUnavailable": "This video can't be shown",
    "videoLink.titleUnknown": "Couldn't check the video",
    "videoLink.membersOnly": "This video was changed to members-only and can't be shown.",
    "videoLink.privateOrDeleted": "This video is private or has been deleted and can't be shown.",
    "videoLink.unavailable": "This video isn't available to watch right now.",
    "videoLink.unknown": "We couldn't check the video's status. Please try again later.",
    "videoLink.retry": "Retry",
    "videoLink.close": "Close",
    "pwa.installLabel": "Install OshiYobi",
    "pwa.installHelp": "Add OshiYobi to your device's home screen to open it like an app. Installing is optional — everything works without it.",
    "pwa.installButton": "Install",
    "pwa.howButton": "How to install",
    "pwa.iosTitle": "Add to Home Screen",
    "pwa.iosStep1": "In Safari, tap the Share button.",
    "pwa.iosStep2": "Choose Add to Home Screen.",
    "pwa.iosStep3": "Tap Add, then open OshiYobi from your Home Screen.",
    "pwa.menuTitle": "Install OshiYobi",
    "pwa.menuStep1": "Open the browser menu (usually the ⋮ or … button).",
    "pwa.menuStep2": "Choose Install app or Add to Home screen, then open OshiYobi from your Home screen.",
    "pwa.dataWarningTitle": "Local data may not carry over",
    "pwa.dataWarningBody": "The Home Screen version of OshiYobi may not automatically use the local data you had in Safari, such as My Oshi, Favorites, display settings and other preferences stored only on this device. Your Safari data is not deleted, but it is not guaranteed to transfer — you may need to set things up again in the Home Screen version.",
    "liveSchedule.pageTitle": "Live Schedule",
    "liveSchedule.pageSubtitle": "Upcoming and live streams across your selected creators.",
    "liveSchedule.timeColumnHeader": "Time",
    "liveSchedule.prevWeekAria": "Previous week",
    "liveSchedule.nextWeekAria": "Next week",
    "liveSchedule.filterLabel": "Filter",
    "liveSchedule.removeStreamReminderButton": "Remove (use creator settings)",
    "liveSchedule.filterAriaLabel": "Filter by creator",
    "liveSchedule.organizationFilterAriaLabel": "Organization",
    "liveSchedule.organizationAll": "All",
    "liveSchedule.organizationVspo": "VSPO",
    "liveSchedule.organizationHololive": "Hololive",
    "liveSchedule.filterFavoritesGroup": "Favorites",
    "liveSchedule.filterAllGroup": "All creators",
    "liveSchedule.filterAddFavorites": "Add all favorites",
    "liveSchedule.filterClear": "Clear filter",
    "liveSchedule.filterNoMatch": "No creators found",
    "liveSchedule.filterSelectedCount": "{{count}} selected",
    "liveSchedule.liveBadge": "LIVE",
    "liveSchedule.premiereBadge": "Premiere",
    "liveSchedule.noThumbnail": "No thumbnail",
    "liveSchedule.moreStreamsAria": "{{count}} more streams",
    "liveSchedule.dayNavAria": "Day navigation",
    "liveSchedule.previousDayAria": "Previous day",
    "liveSchedule.nextDayAria": "Next day",
    "liveSchedule.closeAria": "Close",
    "liveSchedule.setReminderButton": "Set Reminder",
    "liveSchedule.openStreamButton": "Open Stream",
    "videoPlayer.rotateHint": "Rotate your device for a larger view",
    "liveSchedule.startsInMinutes": "Starts in {{minutes}}m",
    "liveSchedule.streamReminderExplanationLine1": "This setting applies only to this livestream.",
    "liveSchedule.streamReminderExplanationLine2": "Once saved, this livestream will use the notification setting here, replacing the creator's usual live notification setting for this stream only.",
    "liveSchedule.saveReminderButton": "Save",
    "liveSchedule.saveReminderFailed": "Couldn't save this reminder. Please try again.",
    "liveSchedule.streamReminderUnsetHint": "This livestream has no reminder right now. Pick a time and save to set one for this stream only. A notification is always sent when the stream starts.",
  },
  ja: {
    "common.cancel": "キャンセル",
    "oshiSwitch.confirmMessage": "画面を「{{creatorName}}」に切り替えますか？",
    "oshiSwitch.confirmAction": "切り替える",
    "oshiSwitch.dontAskAgain": "今後この確認を表示しない",
    "favorite.add": "お気に入りに追加",
    "favorite.remove": "お気に入りから削除",
    "creatorStatusList.emptyFavorites": "まだお気に入りがありません。",
    "creatorStatusList.emptySearch": "該当する配信者が見つかりません。",
    "creatorStatusList.switchOshiTo": "推しを{{creatorName}}に切り替える",
    "creatorStatusList.otherGroupLabel": "その他",
    "creatorStatusList.gamersGroupLabel": "ゲーマーズ",
    "creatorStatusList.mainBadge": "MAIN",
    "recentVideos.tag.latestVideos": "最新動画",
    "recentVideos.tag.latestLive": "最新配信",
    "recentVideos.tag.short": "ショット",
    "recentVideos.liveBadge": "配信中",
    "recentVideos.tag.all": "ALL",
    "recentVideos.tag.sf6": "SF6",
    "recentVideos.tag.valo": "VALO",
    "recentVideos.tag.minecraft": "Minecraft",
    "recentVideos.tag.apex": "Apex",
    "recentVideos.tag.chatting": "雑談",
    "recentVideos.tag.singing": "歌枠",
    "recentVideos.tag.mv": "MV",
    "recentVideos.sort.newest": "新着順",
    "recentVideos.sort.oldest": "古い順",
    "recentVideos.sort.mostViews": "総再生数順",
    "recentVideos.sortAriaLabel": "動画を並び替え",
    "recentVideos.windowAriaLabel": "期間",
    "recentVideos.window.total": "All",
    "recentVideos.window.1d": "1d",
    "recentVideos.window.7d": "7d",
    "recentVideos.window.30d": "30d",
    "recentVideos.contentType.all": "すべて",
    "recentVideos.contentType.live": "配信",
    "recentVideos.contentType.video": "動画",
    "recentVideos.contentTypeAriaLabel": "コンテンツ種別",
    "recentVideos.empty.latestVideos": "最新動画はありません",
    "recentVideos.empty.latestLive": "最新配信はありません",
    "recentVideos.empty.other": "動画がありません",
    "recentVideos.viewAll": "すべて見る",
    "videoSearch.placeholder": "動画を検索",
    "videoSearch.empty": "該当する動画がありません",
    "liveScheduleDock.title": "配信ステータス",
    "liveScheduleDock.close": "閉じる",
    "liveScheduleDock.panelAriaLabel": "配信スケジュール検索",
    "liveScheduleDock.resize.shrink": "縮小",
    "liveScheduleDock.resize.expand": "拡大",
    "liveScheduleDock.resize.shrinkAria": "パネルを縮小",
    "liveScheduleDock.resize.expandAria": "パネルを全画面に拡大",
    "oshiStatus.liveNext": "ライブ／今後24時間以内",
    "oshiStatus.noScheduledStream": "予定されている配信はありません",
    "oshiStatus.liveNow": "配信中",
    "oshiStatus.unseen": "未視聴",
    "oshiStatus.unseenVideos": "動画",
    "oshiStatus.unseenLive": "ライブ配信",
    "oshiStatus.uploads": "アップロード",
    "oshiStatus.streams": "配信",
    "oshiStatus.thisWeek": "今週",
    "oshiStatus.recent": "最近の動き",
    "oshiStatus.noRecentActivity": "最近の動きはありません",
    "oshiStatus.viewAll": "すべて見る",
    "oshiStatus.markAllWatched": "すべて視聴済み",
    "oshiStatus.markAllWatched.confirmMessage": "新着動画をすべて視聴済みにしますか?",
    "oshiStatus.markAllWatched.confirmAction": "OK",
    "oshiStatus.closeActivity": "閉じる",
    "oshiStatus.newBadge": "NEW",
    "oshiStatus.subscribers": "登録者数",
    "oshiStatus.nowPlaying": "再生中",
    "oshiStatus.thumbnailLabel": "サムネイル：{{title}}",
    "oshiStatus.devResetVisit": "訪問をリセット",
    "oshiStatus.milestones.open": "誕生日とデビュー記念日を開く",
    "oshiStatus.milestones.dialogLabel": "誕生日とデビュー記念日",
    "oshiStatus.milestones.birthday": "誕生日",
    "oshiStatus.milestones.anniversary": "{{ordinal}}周年記念日",
    "oshiStatus.milestones.anniversaryUnknown": "周年記念日",
    "oshiStatus.milestones.date": "{{month}}月{{day}}日",
    "oshiStatus.milestones.unit.month": "ヶ月",
    "oshiStatus.milestones.unit.day": "日",
    "oshiStatus.milestones.unit.hour": "時間",
    "oshiStatus.milestones.unit.minute": "分",
    "oshiStatus.milestones.unit.second": "秒",
    "oshiStatus.milestones.unavailable": "データを一時的に取得できません",
    "oshiStatus.milestones.loading": "読み込み中",
    "oshiStatus.milestones.today": "当日",
    "oshiStatus.milestones.caption": "JST 00:00基準",
    "liveStatus.milestone.birthday": "誕生日",
    "liveStatus.milestone.debut": "デビュー日",
    "liveStatus.milestone.both": "誕生日&デビュー日",
    "liveStatus.milestone.today": "当日",
    "errorState.code": "(コード: {{code}})",
    "errorState.defaultMessage": "データの読み込み中にエラーが発生しました。",
    "errorState.retry": "再試行",
    "apiError.config": "アプリの設定エラーです。管理者にお問い合わせください。",
    "apiError.network": "サーバーに接続できませんでした。ネットワーク接続を確認して再試行してください。",
    "apiError.rateLimited": "現在アクセスが集中しており、サーバーが一時的にリクエストを制限しています (429)。自動リトライも成功しませんでした。しばらくしてから再読み込みしてください。",
    "apiError.serverError": "サーバー側でエラーが発生しました ({{status}})。ネットワークの問題ではありません。しばらくしてから再試行してください。",
    "apiError.generic": "リクエストに失敗しました ({{status}}):{{message}}",
    "mainNavbar.navAriaLabel": "メインナビゲーション",
    "mainNavbar.dashboard": "動画データ",
    "mainNavbar.home": "ホーム",
    "mainNavbar.settings": "設定",
    "mainNavbar.schedule": "スケジュール",
    "mainNavbar.about": "概要",
    "mainNavbar.openNavAriaLabel": "ナビゲーションを開く",
    "mainNavbar.closeNavAriaLabel": "ナビゲーションを閉じる",
    "settingsSecondaryNavbar.title": "設定",
    "settingsSecondaryNavbar.navAriaLabel": "設定ナビゲーション",
    "settingsSecondaryNavbar.myOshiSettings": "推し設定",
    "settingsSecondaryNavbar.oshiSettings": "お気に入りリスト",
    "aboutSecondaryNavbar.title": "概要",
    "aboutSecondaryNavbar.navAriaLabel": "概要ナビゲーション",
    "settingsSecondaryNavbar.notificationSettings": "通知設定(配信 / 新着動画)",
    "settingsSecondaryNavbar.displaySettings": "表示設定",
    "oshiSettings.searchPlaceholder": "メンバーを検索",
    "oshiSettings.noResults": "該当するメンバーが見つかりません",
    "oshiSettings.addFavoriteAria": "{{name}}を推しに追加",
    "oshiSettings.removeFavoriteAria": "{{name}}を推しから削除",
    "oshiSettings.otherGroupLabel": "その他",
    "oshiSettings.gamersGroupLabel": "ゲーマーズ",
    "oshiSettings.pageTitle": "マイお気に入り",
    "notificationSettings.pageTitle": "プッシュ通知",
    "notificationSettings.pageDescription": "配信や新着動画の通知方法、通知タイミング、対象メンバーを設定します。",
    "notificationSettings.deliveryTimes.title": "新着動画の通知時間",
    "notificationSettings.deliveryTimes.description": "新着動画の通知は、お使いの端末の時刻でこの時間に届きます。1日あたり最大4つまで、30分単位で選べます。",
    "notificationSettings.deliveryTimes.listAriaLabel": "新着動画の通知時間",
    "notificationSettings.deliveryTimes.timeAriaLabel": "通知時間 {{index}}",
    "notificationSettings.deliveryTimes.removeAriaLabel": "通知時間 {{time}} を削除",
    "notificationSettings.deliveryTimes.addAriaLabel": "通知時間を追加",
    "notificationSettings.simultaneousLive.title": "同時配信のお知らせ",
    "notificationSettings.simultaneousLive.description": "ライブ通知をオンにしている2人以上の配信者がまったく同じ時刻に配信予定のとき、開始前にお知らせします。初期設定はオフです。",
    "oshiSettings.pageDescription": "お気に入りのメンバーを管理します。ライブ状況や通知設定などで確認できます。",
    "oshiSettings.selectedCountLabel": "{{count}} 人選択中",
    "oshiSettings.viewFilter.favoritesOnly": "お気に入り",
    "notificationSettings.liveColumnHeader": "配信",
    "notificationSettings.newVideoColumnHeader": "新着動画",
    "notificationSettings.liveSwitchAriaLabel": "{{name}} の配信通知",
    "notificationSettings.newVideoSwitchAriaLabel": "{{name}} の新着動画通知",
    "notificationSettings.otherGroupLabel": "その他",
    "notificationSettings.gamersGroupLabel": "ゲーマーズ",
    "notificationSettings.searchPlaceholder": "メンバーを検索",
    "notificationSettings.noResults": "該当するメンバーが見つかりません",
    "notificationSettings.defaultReminderLabel": "配信リマインダー時間",
    "notificationSettings.reminder.atStart": "配信開始時",
    "notificationSettings.reminder.10min": "10分前",
    "notificationSettings.reminder.30min": "30分前",
    "notificationSettings.reminder.1hour": "1時間前",
    "notificationSettings.reminderColumnHeader": "リマインド時間",
    "notificationSettings.drawerReminderColumnHeader": "配信の​リマインド時間",
    "notificationSettings.reminderSelectAriaLabel": "{{name}} のリマインド時間",
    "notificationSettings.topicReminderMode.memberChoice": "各メンバーの設定",
    "notificationSettings.reminderNotInEffectHint": "現在は無効（「全部」の設定が優先）",
    "notificationSettings.saveFailed": "サーバーに保存できませんでした。この変更は適用されていません。もう一度お試しください。",
    "notificationSettings.reminder.unset": "通知なし",
    "notificationSettings.reminderUnsupportedTopic": "このトピックは個別の通知に未対応です。「全部」の設定に従います",
    "notificationSettings.notifiedMembersLabel": "通知メンバー",
    "notificationSettings.selectedCountLabel": "{{count}} 人選択中",
    "notificationSettings.namePreviewSeparator": "、",
    "notificationSettings.noSelectedMembers": "まだメンバーが選択されていません",
    "notificationSettings.manageMembersButton": "メンバーを管理",
    "notificationSettings.managementDrawerTitle": "{{topic}} — 通知メンバー",
    "notificationSettings.managementDrawerNotificationType": "通知タイプ：{{type}}",
    "notificationSettings.favoritesGroupLabel": "お気に入り",
    "notificationSettings.topic.all": "全部",
    "notificationSettings.saveTopicButton": "保存",
    "notificationSettings.topicSelectPlaceholder": "トピックを選択",
    "notificationSettings.topicSelectAriaLabel": "通知トピックを選択",
    "notificationSettings.addTopicButtonAriaLabel": "トピックを追加",
    "notificationSettings.reminder.1min": "1分前",
    "notificationSettings.notificationTypeLabel": "通知タイプ",
    "notificationSettings.notificationTypeCombinedLabel": "配信＋新着動画",
    "notificationSettings.notificationTypeSectionHelp": "このメンバーの配信・新着動画の通知を受け取るかどうかを選択します",
    "notificationSettings.topicListPanelTitle": "通知トピック",
    "notificationSettings.topicSortAriaLabel": "トピックの並び替え",
    "notificationSettings.topicSortSaved": "保存順",
    "notificationSettings.topicSortAlphabetical": "名前順",
    "notificationSettings.detailDescription": "配信開始前に必ず通知が送られます",
    "notificationSettings.reminderSectionHelp": "配信開始時には必ず1回通知されます。事前時間を選択すると、配信開始前にも追加で通知されます。",
    "notificationSettings.reminderSectionHelpDisabledNewVideo": "新着動画通知のみが有効なため、配信リマインド時間は設定できません。",
    "notificationSettings.overrideSectionTitle": "個別メンバー設定（任意）",
    "notificationSettings.overrideBadgeCount": "{{count}}件カスタム",
    "notificationSettings.removeTopicButton": "削除",
    "notificationSettings.removeTopicButtonAriaLabel": "「{{topic}}」を削除",
    "notificationSettings.memberPreviewMoreLabel": "+{{count}}",
    "notificationSettings.emptySelection": "左側からトピックを選択してください",
    "myOshiSettings.selectAria": "{{name}} を推しに設定",
    "myOshiSettings.pageTitle": "推し設定",
    "myOshiSettings.pageDescription": "ホーム画面で初期表示するメイン推しを選択します。",
    "myOshiSettings.statusMarker": "MAIN OSHI",
    "myOshiSettings.presentationAria": "現在の推し: {{name}}",
    "myOshiSettings.rosterAria": "推しメンバー選択リスト",
    "languageSettings.picker.zhTW": "繁体中国語",
    "languageSettings.picker.en": "英語",
    "languageSettings.picker.ja": "日本語",
    "classificationFilterBar.title": "分析をフィルター",
    "classificationFilterBar.noActiveFilters": "すべてのダッシュボードデータ",
    "classificationFilterBar.activeFilterCount": "適用中のフィルター: {{count}}",
    "classificationFilterBar.clearFilters": "フィルターをクリア",
    "classificationFilterBar.creatorScopeGroup": "クリエイター範囲",
    "classificationFilterBar.contentScopeGroup": "コンテンツ範囲",
    "contributionBarChart.title": "貢献度",
    "contributionBarChart.shareOf": "{{period}}の割合",
    "contributionBarChart.periodLabel.day": "本日の成長",
    "contributionBarChart.periodLabel.multiDay": "この期間の成長",
    "contributionBarChart.empty": "表示できるプラス成長がありません。",
    "contributionBarChart.ariaLabel": "{{period}}へのメンバー貢献",
    "displaySettings.title": "表示設定",
    "displaySettings.description": "アプリ内の時間情報の表示方法を設定します。",
    "displaySettings.timeFormatLabel": "時間表示形式",
    "displaySettings.timeFormatHelp": "配信開始時間や予定時間などの表示方法を設定します。",
    "displaySettings.timeFormat24h": "24 時間制（HH:mm）",
    "displaySettings.timeFormat12h": "12 時間制（AM/PM）",
    "displaySettings.upcomingLabel": "今後の配信",
    "displaySettings.upcomingHelp": "今後の配信時間の表示形式を設定します。",
    "displaySettings.languageLabel": "言語設定",
    "displaySettings.languageHelp": "OshiYobi の表示言語を選択します。",
    "displaySettings.upcomingCountdownOption": "カウントダウン",
    "notificationToggle.enable": "通知をオンにする",
    "notificationToggle.on": "通知オン",
    "notificationToggle.unavailable": "通知は利用できません",
    "notificationToggle.unsupportedTooltip": "このブラウザはプッシュ通知に対応していません",
    "settingsSecondaryNavbar.openMenuAriaLabel": "設定メニューを開く",
    "settingsSecondaryNavbar.closeMenuAriaLabel": "設定メニューを閉じる",
    "push.explainTitle": "OshiYobiからの通知を許可しますか",
    "push.explainBody": "配信リマインダーや新着動画のお知らせは、端末の通知として届きます。「続ける」を押すと端末が許可を求めますので、「許可」を選んでください。",
    "push.explainContinue": "続ける",
    "push.deniedTitle": "通知の許可がオフです",
    "push.deniedDescription": "端末の設定で、OshiYobiからの通知を許可してください。",
    "push.deniedAction": "設定方法を見る",
    "push.deniedHelpIos": "iPhone／iPad：「設定」→「通知」→「OshiYobi」を開き、「通知を許可」をオンにします。",
    "push.deniedHelpInstalled": "端末の「設定」→「アプリ」→「OshiYobi」→「通知」を開き、通知を許可します。",
    "push.deniedHelpBrowser": "アドレスバー横のサイト設定アイコン（鍵または調整アイコン）→「通知」→「許可」を選び、このページに戻ってください。",
    "push.deniedReturnHint": "設定後にOshiYobiへ戻ると自動で更新されます。再読み込みは不要です。",
    "push.unsupportedTitle": "この端末では通知を利用できません",
    "push.unsupportedBody": "このブラウザはウェブプッシュ通知に対応していません。",
    "push.unsupportedIosBody": "iPhone／iPadでは、まずSafariでOshiYobiをホーム画面に追加し、ホーム画面から開いて通知を設定してください。",
    "push.failedTitle": "通知をオンにできませんでした",
    "push.failedBody": "しばらくしてからもう一度お試しください。今回の変更は適用されていません。",
    "push.failedDiagnosticLabel": "診断コード",
    "push.close": "閉じる",
    "videoLink.titleUnavailable": "動画を表示できません",
    "videoLink.titleUnknown": "動画の状態を確認できません",
    "videoLink.membersOnly": "この動画はメンバー限定に変更されたため、表示できません。",
    "videoLink.privateOrDeleted": "この動画は非公開または削除されたため、表示できません。",
    "videoLink.unavailable": "この動画は現在視聴できません。",
    "videoLink.unknown": "動画の状態を確認できませんでした。時間をおいて再度お試しください。",
    "videoLink.retry": "再試行",
    "videoLink.close": "閉じる",
    "pwa.installLabel": "OshiYobi をインストール",
    "pwa.installHelp": "OshiYobiを端末のホーム画面に追加して、アプリのように開けます。インストールは任意で、しなくても通常どおり使えます。",
    "pwa.installButton": "インストール",
    "pwa.howButton": "インストール方法を見る",
    "pwa.iosTitle": "ホーム画面に追加",
    "pwa.iosStep1": "Safariで「共有」ボタンをタップします。",
    "pwa.iosStep2": "「ホーム画面に追加」を選びます。",
    "pwa.iosStep3": "「追加」をタップし、ホーム画面からOshiYobiを開きます。",
    "pwa.menuTitle": "OshiYobi をインストール",
    "pwa.menuStep1": "ブラウザのメニュー（通常は「⋮」または「…」ボタン）を開きます。",
    "pwa.menuStep2": "「アプリをインストール」または「ホーム画面に追加」を選び、ホーム画面から OshiYobi を開きます。",
    "pwa.dataWarningTitle": "ローカルデータは引き継がれない場合があります",
    "pwa.dataWarningBody": "ホーム画面版のOshiYobiは、Safariで使っていたローカルデータ（My Oshi、お気に入り、表示設定など、この端末内にのみ保存されている設定）を自動では引き継がない場合があります。Safari側のデータは削除されませんが、自動で移行される保証はなく、ホーム画面版で再設定が必要になることがあります。",
    "liveSchedule.pageTitle": "配信スケジュール",
    "liveSchedule.pageSubtitle": "選択したクリエイターの今後の配信と配信中の番組。",
    "liveSchedule.timeColumnHeader": "時間",
    "liveSchedule.prevWeekAria": "前の週",
    "liveSchedule.nextWeekAria": "次の週",
    "liveSchedule.filterLabel": "フィルター",
    "liveSchedule.removeStreamReminderButton": "削除（クリエイター設定を使う）",
    "liveSchedule.filterAriaLabel": "クリエイターで絞り込み",
    "liveSchedule.organizationFilterAriaLabel": "事務所",
    "liveSchedule.organizationAll": "すべて",
    "liveSchedule.organizationVspo": "VSPO",
    "liveSchedule.organizationHololive": "Hololive",
    "liveSchedule.filterFavoritesGroup": "お気に入り",
    "liveSchedule.filterAllGroup": "すべてのクリエイター",
    "liveSchedule.filterAddFavorites": "お気に入りをすべて追加",
    "liveSchedule.filterClear": "絞り込みをクリア",
    "liveSchedule.filterNoMatch": "クリエイターが見つかりません",
    "liveSchedule.filterSelectedCount": "{{count}}人を選択中",
    "liveSchedule.liveBadge": "LIVE",
    "liveSchedule.premiereBadge": "プレミア公開",
    "liveSchedule.noThumbnail": "サムネイルなし",
    "liveSchedule.moreStreamsAria": "他に{{count}}件の配信",
    "liveSchedule.dayNavAria": "日付の切り替え",
    "liveSchedule.previousDayAria": "前の日",
    "liveSchedule.nextDayAria": "次の日",
    "liveSchedule.closeAria": "閉じる",
    "liveSchedule.setReminderButton": "リマインダーを設定",
    "liveSchedule.openStreamButton": "配信を開く",
    "videoPlayer.rotateHint": "端末を横向きにすると大きく表示されます",
    "liveSchedule.startsInMinutes": "{{minutes}}分後に開始",
    "liveSchedule.streamReminderExplanationLine1": "この設定はこの配信にのみ適用されます。",
    "liveSchedule.streamReminderExplanationLine2": "保存すると、この配信はここでの通知設定が優先され、クリエイター本来の配信通知設定の代わりに使用されます。",
    "liveSchedule.saveReminderButton": "保存",
    "liveSchedule.saveReminderFailed": "リマインダーを保存できませんでした。もう一度お試しください。",
    "liveSchedule.streamReminderUnsetHint": "この配信には現在リマインダーがありません。時間を選んで保存すると、この配信だけに設定できます。配信開始時には必ず通知が送られます。",
  },
}

/** Looks up `key` in `locale` and substitutes any `{{param}}` placeholders. */
export function t(locale: Locale, key: TranslationKey, params?: Record<string, string>): string {
  const text = TRANSLATIONS[locale][key]
  if (!params) return text
  return Object.entries(params).reduce((result, [paramKey, value]) => result.replaceAll(`{{${paramKey}}}`, value), text)
}
