import type { TranslationKey } from "../../shared/i18n/translations"

export type SettingsSection = "myOshi" | "oshi" | "notification" | "display"

/** Fixed order -- confirmed with the user: 我推設定 (myOshi, a new blank
 * placeholder section -- see MyOshiSettings.tsx) now leads, followed by the
 * pre-existing Favorites List (oshi, this feature's own original "oshi"
 * section id -- kept as-is since nothing besides its own display label
 * changed) and Notification Settings. Language switching isn't a nav
 * section/page of its own: it is the last item of Display Settings
 * (see DisplaySettings.tsx). */
export const NAV_ITEMS: { section: SettingsSection; labelKey: TranslationKey }[] = [
  { section: "myOshi", labelKey: "settingsSecondaryNavbar.myOshiSettings" },
  { section: "oshi", labelKey: "settingsSecondaryNavbar.oshiSettings" },
  { section: "notification", labelKey: "settingsSecondaryNavbar.notificationSettings" },
  { section: "display", labelKey: "settingsSecondaryNavbar.displaySettings" },
]
