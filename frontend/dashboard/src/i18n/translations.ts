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
  | "recentVideos.tag.latestVideos"
  | "recentVideos.tag.latestLive"
  | "recentVideos.tag.all"
  | "recentVideos.tag.sf6"
  | "recentVideos.tag.valo"
  | "recentVideos.tag.minecraft"
  | "recentVideos.tag.apex"
  | "recentVideos.tag.singing"
  | "recentVideos.tag.chatting"
  | "recentVideos.tag.other"
  | "recentVideos.sort.newest"
  | "recentVideos.sort.oldest"
  | "recentVideos.sort.mostViews"
  | "recentVideos.sortAriaLabel"
  | "recentVideos.empty.latestVideos"
  | "recentVideos.empty.latestLive"
  | "recentVideos.empty.other"
  | "liveScheduleDock.viewToggle.allThenFavorites"
  | "liveScheduleDock.viewToggle.favoritesThenAll"
  | "liveScheduleDock.viewToggle.showFavoritesAria"
  | "liveScheduleDock.viewToggle.showAllAria"
  | "liveScheduleDock.panelAriaLabel"
  | "liveScheduleDock.resize.shrink"
  | "liveScheduleDock.resize.expand"
  | "liveScheduleDock.resize.shrinkAria"
  | "liveScheduleDock.resize.expandAria"
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
  | "settingsSecondaryNavbar.title"
  | "settingsSecondaryNavbar.navAriaLabel"
  | "settingsSecondaryNavbar.myOshiSettings"
  | "settingsSecondaryNavbar.oshiSettings"
  | "settingsSecondaryNavbar.notificationSettings"
  | "myOshiSettings.placeholder"
  | "oshiSettings.searchPlaceholder"
  | "oshiSettings.noResults"
  | "oshiSettings.addFavoriteAria"
  | "oshiSettings.removeFavoriteAria"
  | "oshiSettings.otherGroupLabel"
  | "oshiSettings.gamersGroupLabel"
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
  | "notificationSettings.notifiedMembersLabel"
  | "notificationSettings.selectedCountLabel"
  | "notificationSettings.namePreviewSeparator"
  | "notificationSettings.noSelectedMembers"
  | "notificationSettings.manageMembersButton"
  | "notificationSettings.managementDrawerTitle"
  | "notificationSettings.favoritesGroupLabel"
  | "notificationSettings.topic.all"
  | "languageSettings.picker.zhTW"
  | "languageSettings.picker.en"
  | "languageSettings.picker.ja"

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
    "recentVideos.tag.latestVideos": "最新影片",
    "recentVideos.tag.latestLive": "最新直播",
    "recentVideos.tag.all": "ALL",
    "recentVideos.tag.sf6": "SF6",
    "recentVideos.tag.valo": "VALO",
    "recentVideos.tag.minecraft": "Minecraft",
    "recentVideos.tag.apex": "Apex",
    "recentVideos.tag.singing": "歌回",
    "recentVideos.tag.chatting": "雜談",
    "recentVideos.tag.other": "其他",
    "recentVideos.sort.newest": "最新上架",
    "recentVideos.sort.oldest": "最舊上架",
    "recentVideos.sort.mostViews": "總觀看次數最多",
    "recentVideos.sortAriaLabel": "排序影片",
    "recentVideos.empty.latestVideos": "尚無最新影片",
    "recentVideos.empty.latestLive": "尚無最新直播",
    "recentVideos.empty.other": "沒有影片",
    "liveScheduleDock.viewToggle.allThenFavorites": "全部 / 我的收藏",
    "liveScheduleDock.viewToggle.favoritesThenAll": "我的收藏 / 全部",
    "liveScheduleDock.viewToggle.showFavoritesAria": "只顯示我的收藏",
    "liveScheduleDock.viewToggle.showAllAria": "顯示所有創作者",
    "liveScheduleDock.panelAriaLabel": "直播排程搜尋",
    "liveScheduleDock.resize.shrink": "縮小",
    "liveScheduleDock.resize.expand": "放大",
    "liveScheduleDock.resize.shrinkAria": "縮小面板",
    "liveScheduleDock.resize.expandAria": "展開面板至全高",
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
    "settingsSecondaryNavbar.title": "設定",
    "settingsSecondaryNavbar.navAriaLabel": "設定導覽",
    "settingsSecondaryNavbar.myOshiSettings": "我推設定",
    "settingsSecondaryNavbar.oshiSettings": "收藏名單",
    "settingsSecondaryNavbar.notificationSettings": "推送通知(直播 / 新片)",
    "oshiSettings.searchPlaceholder": "搜尋成員...",
    "oshiSettings.noResults": "找不到符合的成員",
    "oshiSettings.addFavoriteAria": "將 {{name}} 加入我推",
    "oshiSettings.removeFavoriteAria": "將 {{name}} 從我推移除",
    "oshiSettings.otherGroupLabel": "其他",
    "oshiSettings.gamersGroupLabel": "Gamers",
    "notificationSettings.liveColumnHeader": "直播",
    "notificationSettings.newVideoColumnHeader": "新片",
    "notificationSettings.liveSwitchAriaLabel": "{{name}} 直播通知",
    "notificationSettings.newVideoSwitchAriaLabel": "{{name}} 新片通知",
    "notificationSettings.otherGroupLabel": "其他",
    "notificationSettings.gamersGroupLabel": "Gamers",
    "notificationSettings.searchPlaceholder": "搜尋成員...",
    "notificationSettings.noResults": "找不到符合的成員",
    "notificationSettings.defaultReminderLabel": "提醒時間",
    "notificationSettings.reminder.atStart": "開播時",
    "notificationSettings.reminder.10min": "10 分鐘前",
    "notificationSettings.reminder.30min": "30 分鐘前",
    "notificationSettings.reminder.1hour": "1 小時前",
    "notificationSettings.reminderColumnHeader": "提醒時間",
    "notificationSettings.reminderSelectAriaLabel": "{{name}} 的提醒時間",
    "notificationSettings.topicReminderMode.memberChoice": "各成員為準",
    "notificationSettings.reminderNotInEffectHint": "未生效（套用主題時間）",
    "notificationSettings.notifiedMembersLabel": "通知成員",
    "notificationSettings.selectedCountLabel": "已選 {{count}} 人",
    "notificationSettings.namePreviewSeparator": "、",
    "notificationSettings.noSelectedMembers": "尚未選擇任何成員",
    "notificationSettings.manageMembersButton": "管理成員",
    "notificationSettings.managementDrawerTitle": "{{topic}} — 通知成員",
    "notificationSettings.favoritesGroupLabel": "收藏",
    "notificationSettings.topic.all": "全部",
    "myOshiSettings.placeholder": "即將推出",
    "languageSettings.picker.zhTW": "繁體中文",
    "languageSettings.picker.en": "英文",
    "languageSettings.picker.ja": "日文",
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
    "recentVideos.tag.latestVideos": "Latest Videos",
    "recentVideos.tag.latestLive": "Latest Live",
    "recentVideos.tag.all": "ALL",
    "recentVideos.tag.sf6": "SF6",
    "recentVideos.tag.valo": "VALO",
    "recentVideos.tag.minecraft": "Minecraft",
    "recentVideos.tag.apex": "Apex",
    "recentVideos.tag.singing": "Singing",
    "recentVideos.tag.chatting": "Chatting",
    "recentVideos.tag.other": "Other",
    "recentVideos.sort.newest": "Newest",
    "recentVideos.sort.oldest": "Oldest",
    "recentVideos.sort.mostViews": "Most Views",
    "recentVideos.sortAriaLabel": "Sort videos",
    "recentVideos.empty.latestVideos": "No recent videos",
    "recentVideos.empty.latestLive": "No recent streams",
    "recentVideos.empty.other": "No videos",
    "liveScheduleDock.viewToggle.allThenFavorites": "All / Favorites",
    "liveScheduleDock.viewToggle.favoritesThenAll": "Favorites / All",
    "liveScheduleDock.viewToggle.showFavoritesAria": "Show only my favorites",
    "liveScheduleDock.viewToggle.showAllAria": "Show all creators",
    "liveScheduleDock.panelAriaLabel": "Live schedule search",
    "liveScheduleDock.resize.shrink": "Shrink",
    "liveScheduleDock.resize.expand": "Expand",
    "liveScheduleDock.resize.shrinkAria": "Shrink panel",
    "liveScheduleDock.resize.expandAria": "Expand panel to full height",
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
    "settingsSecondaryNavbar.title": "Settings",
    "settingsSecondaryNavbar.navAriaLabel": "Settings navigation",
    "settingsSecondaryNavbar.myOshiSettings": "Oshi Settings",
    "settingsSecondaryNavbar.oshiSettings": "Favorites List",
    "settingsSecondaryNavbar.notificationSettings": "Notifications (Live / New Video)",
    "oshiSettings.searchPlaceholder": "Search creators...",
    "oshiSettings.noResults": "No creators found",
    "oshiSettings.addFavoriteAria": "Add {{name}} to favorites",
    "oshiSettings.removeFavoriteAria": "Remove {{name}} from favorites",
    "oshiSettings.otherGroupLabel": "Other",
    "oshiSettings.gamersGroupLabel": "Gamers",
    "notificationSettings.liveColumnHeader": "Live",
    "notificationSettings.newVideoColumnHeader": "New Video",
    "notificationSettings.liveSwitchAriaLabel": "{{name}} live notifications",
    "notificationSettings.newVideoSwitchAriaLabel": "{{name}} new video notifications",
    "notificationSettings.otherGroupLabel": "Other",
    "notificationSettings.gamersGroupLabel": "Gamers",
    "notificationSettings.searchPlaceholder": "Search creators...",
    "notificationSettings.noResults": "No creators found",
    "notificationSettings.defaultReminderLabel": "Reminder time",
    "notificationSettings.reminder.atStart": "At start",
    "notificationSettings.reminder.10min": "10 minutes before",
    "notificationSettings.reminder.30min": "30 minutes before",
    "notificationSettings.reminder.1hour": "1 hour before",
    "notificationSettings.reminderColumnHeader": "Reminder time",
    "notificationSettings.reminderSelectAriaLabel": "{{name}}'s reminder time",
    "notificationSettings.topicReminderMode.memberChoice": "Member's own choice",
    "notificationSettings.reminderNotInEffectHint": "Not in effect (using topic time)",
    "notificationSettings.notifiedMembersLabel": "Notified members",
    "notificationSettings.selectedCountLabel": "{{count}} selected",
    "notificationSettings.namePreviewSeparator": ", ",
    "notificationSettings.noSelectedMembers": "No members selected yet",
    "notificationSettings.manageMembersButton": "Manage members",
    "notificationSettings.managementDrawerTitle": "{{topic}} — Notified Members",
    "notificationSettings.favoritesGroupLabel": "Favorites",
    "notificationSettings.topic.all": "All",
    "myOshiSettings.placeholder": "Coming soon",
    "languageSettings.picker.zhTW": "Traditional Chinese",
    "languageSettings.picker.en": "English",
    "languageSettings.picker.ja": "Japanese",
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
    "recentVideos.tag.latestVideos": "最新動画",
    "recentVideos.tag.latestLive": "最新配信",
    "recentVideos.tag.all": "ALL",
    "recentVideos.tag.sf6": "SF6",
    "recentVideos.tag.valo": "VALO",
    "recentVideos.tag.minecraft": "Minecraft",
    "recentVideos.tag.apex": "Apex",
    "recentVideos.tag.singing": "歌枠",
    "recentVideos.tag.chatting": "雑談",
    "recentVideos.tag.other": "その他",
    "recentVideos.sort.newest": "新着順",
    "recentVideos.sort.oldest": "古い順",
    "recentVideos.sort.mostViews": "総再生数順",
    "recentVideos.sortAriaLabel": "動画を並び替え",
    "recentVideos.empty.latestVideos": "最新動画はありません",
    "recentVideos.empty.latestLive": "最新配信はありません",
    "recentVideos.empty.other": "動画がありません",
    "liveScheduleDock.viewToggle.allThenFavorites": "全部 / お気に入り",
    "liveScheduleDock.viewToggle.favoritesThenAll": "お気に入り / 全部",
    "liveScheduleDock.viewToggle.showFavoritesAria": "お気に入りのみ表示",
    "liveScheduleDock.viewToggle.showAllAria": "すべての配信者を表示",
    "liveScheduleDock.panelAriaLabel": "配信スケジュール検索",
    "liveScheduleDock.resize.shrink": "縮小",
    "liveScheduleDock.resize.expand": "拡大",
    "liveScheduleDock.resize.shrinkAria": "パネルを縮小",
    "liveScheduleDock.resize.expandAria": "パネルを全画面に拡大",
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
    "settingsSecondaryNavbar.title": "設定",
    "settingsSecondaryNavbar.navAriaLabel": "設定ナビゲーション",
    "settingsSecondaryNavbar.myOshiSettings": "推し設定",
    "settingsSecondaryNavbar.oshiSettings": "お気に入りリスト",
    "settingsSecondaryNavbar.notificationSettings": "通知設定(配信 / 新着動画)",
    "oshiSettings.searchPlaceholder": "メンバーを検索...",
    "oshiSettings.noResults": "該当するメンバーが見つかりません",
    "oshiSettings.addFavoriteAria": "{{name}}を推しに追加",
    "oshiSettings.removeFavoriteAria": "{{name}}を推しから削除",
    "oshiSettings.otherGroupLabel": "その他",
    "oshiSettings.gamersGroupLabel": "ゲーマーズ",
    "notificationSettings.liveColumnHeader": "配信",
    "notificationSettings.newVideoColumnHeader": "新着動画",
    "notificationSettings.liveSwitchAriaLabel": "{{name}} の配信通知",
    "notificationSettings.newVideoSwitchAriaLabel": "{{name}} の新着動画通知",
    "notificationSettings.otherGroupLabel": "その他",
    "notificationSettings.gamersGroupLabel": "ゲーマーズ",
    "notificationSettings.searchPlaceholder": "メンバーを検索...",
    "notificationSettings.noResults": "該当するメンバーが見つかりません",
    "notificationSettings.defaultReminderLabel": "リマインド時間",
    "notificationSettings.reminder.atStart": "配信開始時",
    "notificationSettings.reminder.10min": "10分前",
    "notificationSettings.reminder.30min": "30分前",
    "notificationSettings.reminder.1hour": "1時間前",
    "notificationSettings.reminderColumnHeader": "リマインド時間",
    "notificationSettings.reminderSelectAriaLabel": "{{name}} のリマインド時間",
    "notificationSettings.topicReminderMode.memberChoice": "各メンバーの設定",
    "notificationSettings.reminderNotInEffectHint": "現在は無効（トピックの時間を使用中）",
    "notificationSettings.notifiedMembersLabel": "通知メンバー",
    "notificationSettings.selectedCountLabel": "{{count}} 人選択中",
    "notificationSettings.namePreviewSeparator": "、",
    "notificationSettings.noSelectedMembers": "まだメンバーが選択されていません",
    "notificationSettings.manageMembersButton": "メンバーを管理",
    "notificationSettings.managementDrawerTitle": "{{topic}} — 通知メンバー",
    "notificationSettings.favoritesGroupLabel": "お気に入り",
    "notificationSettings.topic.all": "全部",
    "myOshiSettings.placeholder": "近日公開",
    "languageSettings.picker.zhTW": "繁体中国語",
    "languageSettings.picker.en": "英語",
    "languageSettings.picker.ja": "日本語",
  },
}

/** Looks up `key` in `locale` and substitutes any `{{param}}` placeholders. */
export function t(locale: Locale, key: TranslationKey, params?: Record<string, string>): string {
  const text = TRANSLATIONS[locale][key]
  if (!params) return text
  return Object.entries(params).reduce((result, [paramKey, value]) => result.replaceAll(`{{${paramKey}}}`, value), text)
}
