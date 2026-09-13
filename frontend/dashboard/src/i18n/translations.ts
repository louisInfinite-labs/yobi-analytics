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
  | "settingsSecondaryNavbar.oshiSettings"
  | "settingsSecondaryNavbar.notificationSettings"
  | "settingsSecondaryNavbar.languageSettings"
  | "oshiSettings.comingSoon"
  | "notificationSettings.comingSoon"
  | "languageSettings.comingSoon"

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
    "settingsSecondaryNavbar.oshiSettings": "我推設定",
    "settingsSecondaryNavbar.notificationSettings": "推送設定",
    "settingsSecondaryNavbar.languageSettings": "語言設定",
    "oshiSettings.comingSoon": "我推設定即將推出。",
    "notificationSettings.comingSoon": "推送設定即將推出。",
    "languageSettings.comingSoon": "語言設定即將推出。",
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
    "settingsSecondaryNavbar.oshiSettings": "Oshi Settings",
    "settingsSecondaryNavbar.notificationSettings": "Notification Settings",
    "settingsSecondaryNavbar.languageSettings": "Language Settings",
    "oshiSettings.comingSoon": "Oshi Settings is coming soon.",
    "notificationSettings.comingSoon": "Notification Settings is coming soon.",
    "languageSettings.comingSoon": "Language Settings is coming soon.",
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
    "settingsSecondaryNavbar.oshiSettings": "推し設定",
    "settingsSecondaryNavbar.notificationSettings": "通知設定",
    "settingsSecondaryNavbar.languageSettings": "言語設定",
    "oshiSettings.comingSoon": "推し設定は近日公開予定です。",
    "notificationSettings.comingSoon": "通知設定は近日公開予定です。",
    "languageSettings.comingSoon": "言語設定は近日公開予定です。",
  },
}

/** Looks up `key` in `locale` and substitutes any `{{param}}` placeholders. */
export function t(locale: Locale, key: TranslationKey, params?: Record<string, string>): string {
  const text = TRANSLATIONS[locale][key]
  if (!params) return text
  return Object.entries(params).reduce((result, [paramKey, value]) => result.replaceAll(`{{${paramKey}}}`, value), text)
}
