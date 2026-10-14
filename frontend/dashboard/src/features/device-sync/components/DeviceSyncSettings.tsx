import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useDeviceSyncPlatform } from "../platformDetection"
import { PcDeviceSync } from "./PcDeviceSync"
import { MobileDeviceSync } from "./MobileDeviceSync"
import { AndroidBrowserGuidance } from "./AndroidBrowserGuidance"
import { IosSafariGuidance } from "./IosSafariGuidance"

function DeviceSyncBody() {
  const platform = useDeviceSyncPlatform()

  switch (platform) {
    case "pc":
      return <PcDeviceSync />
    case "android-pwa":
    case "ios-pwa":
      return <MobileDeviceSync platform={platform} />
    case "android-browser":
      return <AndroidBrowserGuidance />
    case "ios-safari":
      return <IosSafariGuidance />
  }
}

/** Settings' own 裝置同步 (Device Sync) section -- the single entry point SettingsPage.tsx renders. The page
 * header matches every other Settings section's own convention (settings-page-header/-title/-description, e.g.
 * DisplaySettings.tsx/NotificationSettings.tsx) rather than inventing a header-less layout just for this one.
 * The body branches to one of 5 entirely separate presentation components by platform/install-state
 * (platformDetection.ts). The pairing/device controller (useDeviceSyncController) is created inside
 * PcDeviceSync/MobileDeviceSync only -- NOT here -- so the not-installed guidance states (Android browser, iOS
 * Safari) never register a client secret or call the Device Sync API at all: there is nothing they could do with
 * that state, and creating it anyway would be a needless network call on a page whose only job is "go install
 * the PWA first". */
export function DeviceSyncSettings() {
  const [locale] = useLocale()

  return (
    <>
      <header className="settings-page-header">
        <h1 className="settings-page-title">{t(locale, "deviceSync.title")}</h1>
        <p className="settings-page-description">{t(locale, "deviceSync.pageDescription")}</p>
      </header>
      <DeviceSyncBody />
    </>
  )
}
