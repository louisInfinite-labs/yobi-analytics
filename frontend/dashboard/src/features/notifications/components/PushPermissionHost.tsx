import { useEffect, useState, type ReactNode } from "react"
import { SimpleDialog } from "../../../shared/ui/SimpleDialog"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale, type TranslationKey } from "../../../shared/i18n/translations"
import { HomeScreenGuide } from "../../pwa/components/HomeScreenGuide"
import { isManualHomeScreenInstallPlatform, isStandaloneDisplay } from "../../pwa/installState"
import { answerPushExplanation, closePushDialog, usePushDialog } from "../push/pushGate"
import { usePushState } from "../push/pushState"

/** Which device-settings instructions fit this device, from capabilities (not user-agent strings): a Home Screen web app on iOS/iPadOS
 * (navigator.standalone exists), another installed standalone app (Android), or a normal browser tab. A web page cannot deep-link into
 * any platform's notification settings, so these are instructions, never a fake "open settings" link. */
function deniedHelpKey(): TranslationKey {
  if (isStandaloneDisplay()) return isManualHomeScreenInstallPlatform() ? "push.deniedHelpIos" : "push.deniedHelpInstalled"
  return "push.deniedHelpBrowser"
}

/** The denied-permission help. Its own component so the "see how" disclosure starts collapsed every time the dialog opens. */
function DeniedPermissionDialog({ locale, closeButton }: { locale: Locale; closeButton: ReactNode }) {
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <SimpleDialog
      title={t(locale, "push.deniedTitle")}
      onClose={closePushDialog}
      actions={
        <>
          <button type="button" className="simple-dialog__button" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>
            {t(locale, "push.deniedAction")}
          </button>
          {closeButton}
        </>
      }
    >
      <p>{t(locale, "push.deniedDescription")}</p>
      {helpOpen && (
        <>
          <p>{t(locale, deniedHelpKey())}</p>
          <p>{t(locale, "push.deniedReturnHint")}</p>
        </>
      )}
    </SimpleDialog>
  )
}

/** Mounted once in App: renders whichever notification dialog the gate (pushGate.ts) has opened -- the "why we need permission"
 * explanation before the browser prompt, the denied-permission help, the "this device can't receive push" help, and the failure
 * message. The browser prompt itself is only ever raised after the explanation's Continue. */
export function PushPermissionHost() {
  const [locale] = useLocale()
  const dialog = usePushDialog()
  const { permission } = usePushState()

  // Coming back from the device/browser settings with notifications now allowed: the help is obsolete -- close it without a reload.
  useEffect(() => {
    if (dialog === "denied" && permission !== "denied") closePushDialog()
  }, [dialog, permission])

  const closeButton = (
    <button type="button" className="simple-dialog__button simple-dialog__button--primary" onClick={closePushDialog}>
      {t(locale, "push.close")}
    </button>
  )

  if (dialog === "explain") {
    return (
      <SimpleDialog
        title={t(locale, "push.explainTitle")}
        onClose={() => answerPushExplanation(false)}
        actions={
          <>
            <button type="button" className="simple-dialog__button" onClick={() => answerPushExplanation(false)}>
              {t(locale, "common.cancel")}
            </button>
            <button type="button" className="simple-dialog__button simple-dialog__button--primary" onClick={() => answerPushExplanation(true)}>
              {t(locale, "push.explainContinue")}
            </button>
          </>
        }
      >
        <p>{t(locale, "push.explainBody")}</p>
      </SimpleDialog>
    )
  }

  if (dialog === "denied") return <DeniedPermissionDialog locale={locale} closeButton={closeButton} />

  if (dialog === "unsupported") {
    const needsHomeScreen = isManualHomeScreenInstallPlatform() && !isStandaloneDisplay()
    return (
      <SimpleDialog title={t(locale, "push.unsupportedTitle")} onClose={closePushDialog} actions={closeButton}>
        <p>{t(locale, needsHomeScreen ? "push.unsupportedIosBody" : "push.unsupportedBody")}</p>
        {needsHomeScreen && <HomeScreenGuide locale={locale} />}
      </SimpleDialog>
    )
  }

  if (dialog === "failed") {
    return (
      <SimpleDialog title={t(locale, "push.failedTitle")} onClose={closePushDialog} actions={closeButton}>
        <p>{t(locale, "push.failedBody")}</p>
      </SimpleDialog>
    )
  }

  return null
}
