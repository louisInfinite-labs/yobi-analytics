import { SimpleDialog } from "../../shared/ui/SimpleDialog"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t, type TranslationKey } from "../../shared/i18n/translations"
import type { VideoDeepLinkDialogKind } from "./useVideoDeepLink"

const MESSAGE_KEYS: Record<VideoDeepLinkDialogKind, TranslationKey> = {
  members_only: "videoLink.membersOnly",
  private_or_deleted: "videoLink.privateOrDeleted",
  unavailable: "videoLink.unavailable",
  unknown: "videoLink.unknown",
}

/** The explanation shown over the creator's Home when the video a notification pointed at cannot be shown: members-only, private/deleted, or (with a
 * Retry) a status check that failed. Uses the shared SimpleDialog, so backdrop click, Esc and the Close button all dismiss it. */
export function VideoDeepLinkDialog({ kind, onRetry, onClose }: { kind: VideoDeepLinkDialogKind; onRetry: () => void; onClose: () => void }) {
  const [locale] = useLocale()
  return (
    <SimpleDialog
      title={t(locale, kind === "unknown" ? "videoLink.titleUnknown" : "videoLink.titleUnavailable")}
      onClose={onClose}
      actions={
        <>
          {kind === "unknown" && (
            <button type="button" className="simple-dialog__button simple-dialog__button--primary" onClick={onRetry}>
              {t(locale, "videoLink.retry")}
            </button>
          )}
          <button type="button" className={kind === "unknown" ? "simple-dialog__button" : "simple-dialog__button simple-dialog__button--primary"} onClick={onClose}>
            {t(locale, "videoLink.close")}
          </button>
        </>
      }
    >
      <p>{t(locale, MESSAGE_KEYS[kind])}</p>
    </SimpleDialog>
  )
}
