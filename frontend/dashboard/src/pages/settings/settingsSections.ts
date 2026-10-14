import type { TranslationKey } from "../../shared/i18n/translations"

export type SettingsSection = "myOshi" | "oshi" | "notification" | "display" | "deviceSync"

/** Fixed order -- confirmed with the user: 我推設定 (myOshi, a new blank
 * placeholder section -- see MyOshiSettings.tsx) now leads, followed by the
 * pre-existing Favorites List (oshi, this feature's own original "oshi"
 * section id -- kept as-is since nothing besides its own display label
 * changed) and Notification Settings. Language switching isn't a nav
 * section/page of its own: it is the last item of Display Settings
 * (see DisplaySettings.tsx). 裝置同步 (deviceSync) is always the LAST item
 * (Device Sync spec section 2): a new, independent cross-device-pairing
 * feature, not a sibling concern of the four above it. */
export const NAV_ITEMS: { section: SettingsSection; labelKey: TranslationKey }[] = [
  { section: "myOshi", labelKey: "settingsSecondaryNavbar.myOshiSettings" },
  { section: "oshi", labelKey: "settingsSecondaryNavbar.oshiSettings" },
  { section: "notification", labelKey: "settingsSecondaryNavbar.notificationSettings" },
  { section: "display", labelKey: "settingsSecondaryNavbar.displaySettings" },
  { section: "deviceSync", labelKey: "settingsSecondaryNavbar.deviceSync" },
]

/** Device Sync is dev-only for now (backend/infra rollout isn't approved yet) --
 * the same `import.meta.env.DEV` gate MainNavbar.tsx uses for the Video Data nav
 * item, applied here so a production build never shows 裝置同步. */
export function visibleNavItems(): { section: SettingsSection; labelKey: TranslationKey }[] {
  return NAV_ITEMS.filter((item) => item.section !== "deviceSync" || import.meta.env.DEV)
}
