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
  | "oshiStatus.sinceLastVisit"
  | "oshiStatus.uploads"
  | "oshiStatus.streams"
  | "oshiStatus.firstVisit"
  | "oshiStatus.thisWeek"
  | "oshiStatus.recent"
  | "oshiStatus.noRecentActivity"
  | "oshiStatus.newBadge"
  | "oshiStatus.subscribers"
  | "oshiStatus.nowPlaying"
  | "oshiStatus.devResetVisit"
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
  | "notificationSettings.notificationTypeBoth"
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
  | "notificationSettings.resetButton"
  | "notificationSettings.removeTopicButton"
  | "notificationSettings.removeTopicButtonAriaLabel"
  | "notificationSettings.resetButtonAriaLabel"
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
  | "displaySettings.upcomingCountdownOption"
  | "notificationToggle.enable"
  | "notificationToggle.on"
  | "notificationToggle.unavailable"
  | "liveSchedule.pageTitle"
  | "liveSchedule.pageSubtitle"
  | "liveSchedule.timeColumnHeader"
  | "liveSchedule.prevWeekAria"
  | "liveSchedule.nextWeekAria"
  | "liveSchedule.filterLabel"
  | "liveSchedule.streamReminderOff"
  | "liveSchedule.removeStreamReminderButton"
  | "liveSchedule.filterAriaLabel"
  | "liveSchedule.filterFavoritesGroup"
  | "liveSchedule.filterAllGroup"
  | "liveSchedule.filterAddFavorites"
  | "liveSchedule.filterClear"
  | "liveSchedule.filterNoMatch"
  | "liveSchedule.liveBadge"
  | "liveSchedule.noThumbnail"
  | "liveSchedule.moreStreamsAria"
  | "liveSchedule.closeAria"
  | "liveSchedule.setReminderButton"
  | "liveSchedule.openStreamButton"
  | "liveSchedule.startsInMinutes"
  | "liveSchedule.startedMinutesAgo"
  | "liveSchedule.streamReminderExplanationLine1"
  | "liveSchedule.streamReminderExplanationLine2"
  | "liveSchedule.saveReminderButton"
  | "liveSchedule.saveReminderFailed"
  | "liveSchedule.streamReminderUnsetHint"

const TRANSLATIONS: Record<Locale, Record<TranslationKey, string>> = {
  "zh-TW": {
    "common.cancel": "取消",
    "oshiSwitch.confirmMessage": "要將推し切換為「{{creatorName}}」嗎？",
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
    "liveScheduleDock.title": "直播狀態",
    "liveScheduleDock.close": "關閉",
    "liveScheduleDock.panelAriaLabel": "直播排程搜尋",
    "liveScheduleDock.resize.shrink": "縮小",
    "liveScheduleDock.resize.expand": "放大",
    "liveScheduleDock.resize.shrinkAria": "縮小面板",
    "liveScheduleDock.resize.expandAria": "展開面板至全高",
    "oshiStatus.liveNext": "直播／接下來",
    "oshiStatus.noScheduledStream": "尚無排定的直播",
    "oshiStatus.liveNow": "直播中",
    "oshiStatus.sinceLastVisit": "自上次造訪後",
    "oshiStatus.uploads": "上傳影片",
    "oshiStatus.streams": "直播場次",
    "oshiStatus.firstVisit": "首次造訪 — 尚無可回顧的內容",
    "oshiStatus.thisWeek": "本週",
    "oshiStatus.recent": "最近動態",
    "oshiStatus.noRecentActivity": "尚無最近動態",
    "oshiStatus.newBadge": "NEW",
    "oshiStatus.subscribers": "訂閱者",
    "oshiStatus.nowPlaying": "正在播放",
    "oshiStatus.devResetVisit": "重置造訪",
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
    "notificationSettings.notificationTypeBoth": "兩者",
    "notificationSettings.notificationTypeCombinedLabel": "直播+新片",
    "notificationSettings.notificationTypeSectionHelp": "選擇這個主題要通知直播、新片，或兩者。",
    "notificationSettings.topicListPanelTitle": "通知主題",
    "notificationSettings.topicSortAriaLabel": "主題排序方式",
    "notificationSettings.topicSortSaved": "預設順序",
    "notificationSettings.topicSortAlphabetical": "依名稱排序",
    "notificationSettings.detailDescription": "設定「{{topic}}」的提醒時間、通知類型與成員。",
    "notificationSettings.reminderSectionHelp": "開播時一定會通知一次。若選擇提前時間，會在直播開始前額外再通知一次。",
    "notificationSettings.reminderSectionHelpDisabledNewVideo": "目前只接收新片通知，直播提醒時間無法設定。",
    "notificationSettings.overrideSectionTitle": "個別成員設定（選用）",
    "notificationSettings.overrideBadgeCount": "{{count}} 個別設定",
    "notificationSettings.resetButton": "重設",
    "notificationSettings.removeTopicButton": "移除",
    "notificationSettings.removeTopicButtonAriaLabel": "移除「{{topic}}」",
    "notificationSettings.resetButtonAriaLabel": "重設「{{topic}}」的預設設定",
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
    "displaySettings.upcomingCountdownOption": "倒數計時",
    "notificationToggle.enable": "開啟通知",
    "notificationToggle.on": "通知已開啟",
    "notificationToggle.unavailable": "無法使用通知",
    "liveSchedule.pageTitle": "直播時間表",
    "liveSchedule.pageSubtitle": "你所選創作者的即將到來與直播中節目。",
    "liveSchedule.timeColumnHeader": "時間",
    "liveSchedule.prevWeekAria": "上一週",
    "liveSchedule.nextWeekAria": "下一週",
    "liveSchedule.filterLabel": "篩選",
    "liveSchedule.streamReminderOff": "這場不提醒",
    "liveSchedule.removeStreamReminderButton": "移除單場設定（改用創作者設定）",
    "liveSchedule.filterAriaLabel": "篩選創作者",
    "liveSchedule.filterFavoritesGroup": "收藏",
    "liveSchedule.filterAllGroup": "全部創作者",
    "liveSchedule.filterAddFavorites": "加入全部收藏",
    "liveSchedule.filterClear": "清除篩選",
    "liveSchedule.filterNoMatch": "找不到創作者",
    "liveSchedule.liveBadge": "LIVE",
    "liveSchedule.noThumbnail": "沒有縮圖",
    "liveSchedule.moreStreamsAria": "還有 {{count}} 個直播",
    "liveSchedule.closeAria": "關閉",
    "liveSchedule.setReminderButton": "設定提醒",
    "liveSchedule.openStreamButton": "開啟直播",
    "liveSchedule.startsInMinutes": "{{minutes}} 分鐘後開始",
    "liveSchedule.startedMinutesAgo": "{{minutes}} 分鐘前開始",
    "liveSchedule.streamReminderExplanationLine1": "此設定只適用於這一次直播。",
    "liveSchedule.streamReminderExplanationLine2": "儲存後，這場直播會使用此處的通知設定，取代該創作者原本的直播通知設定。",
    "liveSchedule.saveReminderButton": "儲存",
    "liveSchedule.saveReminderFailed": "無法儲存提醒設定,請稍後再試。",
    "liveSchedule.streamReminderUnsetHint": "這場直播目前沒有提醒。選擇時間後按儲存，即可只為這一場設定。",
  },
  en: {
    "common.cancel": "Cancel",
    "oshiSwitch.confirmMessage": 'Switch your Oshi to "{{creatorName}}"?',
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
    "liveScheduleDock.title": "LIVE STATUS",
    "liveScheduleDock.close": "Close",
    "liveScheduleDock.panelAriaLabel": "Live schedule search",
    "liveScheduleDock.resize.shrink": "Shrink",
    "liveScheduleDock.resize.expand": "Expand",
    "liveScheduleDock.resize.shrinkAria": "Shrink panel",
    "liveScheduleDock.resize.expandAria": "Expand panel to full height",
    "oshiStatus.liveNext": "Live / Next",
    "oshiStatus.noScheduledStream": "No scheduled stream",
    "oshiStatus.liveNow": "LIVE NOW",
    "oshiStatus.sinceLastVisit": "Since your last visit",
    "oshiStatus.uploads": "Uploads",
    "oshiStatus.streams": "Streams",
    "oshiStatus.firstVisit": "First visit — nothing to catch up on yet",
    "oshiStatus.thisWeek": "This week",
    "oshiStatus.recent": "Recent",
    "oshiStatus.noRecentActivity": "No recent activity",
    "oshiStatus.newBadge": "NEW",
    "oshiStatus.subscribers": "subscribers",
    "oshiStatus.nowPlaying": "Now Playing",
    "oshiStatus.devResetVisit": "Reset visit",
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
    "notificationSettings.notificationTypeBoth": "Both",
    "notificationSettings.notificationTypeCombinedLabel": "Live + New Video",
    "notificationSettings.notificationTypeSectionHelp": "Choose whether this topic notifies for live streams, new videos, or both.",
    "notificationSettings.topicListPanelTitle": "Notification topics",
    "notificationSettings.topicSortAriaLabel": "Sort topics",
    "notificationSettings.topicSortSaved": "Saved order",
    "notificationSettings.topicSortAlphabetical": "By name",
    "notificationSettings.detailDescription": "Configure the reminder time, notification type, and members for \"{{topic}}\".",
    "notificationSettings.reminderSectionHelp": "A notification is always sent when the stream starts. If you choose an earlier time, an additional reminder will be sent before the stream.",
    "notificationSettings.reminderSectionHelpDisabledNewVideo": "Live reminder timing is unavailable while only New Video notifications are enabled.",
    "notificationSettings.overrideSectionTitle": "Per-member overrides (optional)",
    "notificationSettings.overrideBadgeCount": "{{count}} custom",
    "notificationSettings.resetButton": "Reset",
    "notificationSettings.removeTopicButton": "Remove",
    "notificationSettings.removeTopicButtonAriaLabel": "Remove \"{{topic}}\"",
    "notificationSettings.resetButtonAriaLabel": "Reset \"{{topic}}\" to its defaults",
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
    "displaySettings.upcomingCountdownOption": "Countdown",
    "notificationToggle.enable": "Enable notifications",
    "notificationToggle.on": "Notifications on",
    "notificationToggle.unavailable": "Notifications unavailable",
    "liveSchedule.pageTitle": "Live Schedule",
    "liveSchedule.pageSubtitle": "Upcoming and live streams across your selected creators.",
    "liveSchedule.timeColumnHeader": "Time",
    "liveSchedule.prevWeekAria": "Previous week",
    "liveSchedule.nextWeekAria": "Next week",
    "liveSchedule.filterLabel": "Filter",
    "liveSchedule.streamReminderOff": "No reminder for this stream",
    "liveSchedule.removeStreamReminderButton": "Remove (use creator settings)",
    "liveSchedule.filterAriaLabel": "Filter by creator",
    "liveSchedule.filterFavoritesGroup": "Favorites",
    "liveSchedule.filterAllGroup": "All creators",
    "liveSchedule.filterAddFavorites": "Add all favorites",
    "liveSchedule.filterClear": "Clear filter",
    "liveSchedule.filterNoMatch": "No creators found",
    "liveSchedule.liveBadge": "LIVE",
    "liveSchedule.noThumbnail": "No thumbnail",
    "liveSchedule.moreStreamsAria": "{{count}} more streams",
    "liveSchedule.closeAria": "Close",
    "liveSchedule.setReminderButton": "Set Reminder",
    "liveSchedule.openStreamButton": "Open Stream",
    "liveSchedule.startsInMinutes": "Starts in {{minutes}}m",
    "liveSchedule.startedMinutesAgo": "Started {{minutes}}m ago",
    "liveSchedule.streamReminderExplanationLine1": "This setting applies only to this livestream.",
    "liveSchedule.streamReminderExplanationLine2": "Once saved, this livestream will use the notification setting here, replacing the creator's usual live notification setting for this stream only.",
    "liveSchedule.saveReminderButton": "Save",
    "liveSchedule.saveReminderFailed": "Couldn't save this reminder. Please try again.",
    "liveSchedule.streamReminderUnsetHint": "This livestream has no reminder right now. Pick a time and save to set one for this stream only.",
  },
  ja: {
    "common.cancel": "キャンセル",
    "oshiSwitch.confirmMessage": "「{{creatorName}}」に推しを切り替えますか？",
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
    "liveScheduleDock.title": "配信ステータス",
    "liveScheduleDock.close": "閉じる",
    "liveScheduleDock.panelAriaLabel": "配信スケジュール検索",
    "liveScheduleDock.resize.shrink": "縮小",
    "liveScheduleDock.resize.expand": "拡大",
    "liveScheduleDock.resize.shrinkAria": "パネルを縮小",
    "liveScheduleDock.resize.expandAria": "パネルを全画面に拡大",
    "oshiStatus.liveNext": "配信中／次回",
    "oshiStatus.noScheduledStream": "予定されている配信はありません",
    "oshiStatus.liveNow": "配信中",
    "oshiStatus.sinceLastVisit": "前回の訪問から",
    "oshiStatus.uploads": "アップロード",
    "oshiStatus.streams": "配信",
    "oshiStatus.firstVisit": "初回訪問 — まだ追いつく内容はありません",
    "oshiStatus.thisWeek": "今週",
    "oshiStatus.recent": "最近の動き",
    "oshiStatus.noRecentActivity": "最近の動きはありません",
    "oshiStatus.newBadge": "NEW",
    "oshiStatus.subscribers": "登録者数",
    "oshiStatus.nowPlaying": "再生中",
    "oshiStatus.devResetVisit": "訪問をリセット",
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
    "notificationSettings.notificationTypeBoth": "両方",
    "notificationSettings.notificationTypeCombinedLabel": "配信＋新着動画",
    "notificationSettings.notificationTypeSectionHelp": "このトピックで通知する対象（配信・新着動画・両方）を選択します。",
    "notificationSettings.topicListPanelTitle": "通知トピック",
    "notificationSettings.topicSortAriaLabel": "トピックの並び替え",
    "notificationSettings.topicSortSaved": "保存順",
    "notificationSettings.topicSortAlphabetical": "名前順",
    "notificationSettings.detailDescription": "「{{topic}}」のリマインダー時間、通知タイプ、メンバーを設定します。",
    "notificationSettings.reminderSectionHelp": "配信開始時には必ず1回通知されます。事前時間を選択すると、配信開始前にも追加で通知されます。",
    "notificationSettings.reminderSectionHelpDisabledNewVideo": "新着動画通知のみが有効なため、配信リマインド時間は設定できません。",
    "notificationSettings.overrideSectionTitle": "個別メンバー設定（任意）",
    "notificationSettings.overrideBadgeCount": "{{count}}件カスタム",
    "notificationSettings.resetButton": "リセット",
    "notificationSettings.removeTopicButton": "削除",
    "notificationSettings.removeTopicButtonAriaLabel": "「{{topic}}」を削除",
    "notificationSettings.resetButtonAriaLabel": "「{{topic}}」を既定値にリセット",
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
    "displaySettings.upcomingCountdownOption": "カウントダウン",
    "notificationToggle.enable": "通知をオンにする",
    "notificationToggle.on": "通知オン",
    "notificationToggle.unavailable": "通知は利用できません",
    "liveSchedule.pageTitle": "配信スケジュール",
    "liveSchedule.pageSubtitle": "選択したクリエイターの今後の配信と配信中の番組。",
    "liveSchedule.timeColumnHeader": "時間",
    "liveSchedule.prevWeekAria": "前の週",
    "liveSchedule.nextWeekAria": "次の週",
    "liveSchedule.filterLabel": "フィルター",
    "liveSchedule.streamReminderOff": "この配信は通知しない",
    "liveSchedule.removeStreamReminderButton": "削除（クリエイター設定を使う）",
    "liveSchedule.filterAriaLabel": "クリエイターで絞り込み",
    "liveSchedule.filterFavoritesGroup": "お気に入り",
    "liveSchedule.filterAllGroup": "すべてのクリエイター",
    "liveSchedule.filterAddFavorites": "お気に入りをすべて追加",
    "liveSchedule.filterClear": "絞り込みをクリア",
    "liveSchedule.filterNoMatch": "クリエイターが見つかりません",
    "liveSchedule.liveBadge": "LIVE",
    "liveSchedule.noThumbnail": "サムネイルなし",
    "liveSchedule.moreStreamsAria": "他に{{count}}件の配信",
    "liveSchedule.closeAria": "閉じる",
    "liveSchedule.setReminderButton": "リマインダーを設定",
    "liveSchedule.openStreamButton": "配信を開く",
    "liveSchedule.startsInMinutes": "{{minutes}}分後に開始",
    "liveSchedule.startedMinutesAgo": "{{minutes}}分前に開始",
    "liveSchedule.streamReminderExplanationLine1": "この設定はこの配信にのみ適用されます。",
    "liveSchedule.streamReminderExplanationLine2": "保存すると、この配信はここでの通知設定が優先され、クリエイター本来の配信通知設定の代わりに使用されます。",
    "liveSchedule.saveReminderButton": "保存",
    "liveSchedule.saveReminderFailed": "リマインダーを保存できませんでした。もう一度お試しください。",
    "liveSchedule.streamReminderUnsetHint": "この配信には現在リマインダーがありません。時間を選んで保存すると、この配信だけに設定できます。",
  },
}

/** Looks up `key` in `locale` and substitutes any `{{param}}` placeholders. */
export function t(locale: Locale, key: TranslationKey, params?: Record<string, string>): string {
  const text = TRANSLATIONS[locale][key]
  if (!params) return text
  return Object.entries(params).reduce((result, [paramKey, value]) => result.replaceAll(`{{${paramKey}}}`, value), text)
}
