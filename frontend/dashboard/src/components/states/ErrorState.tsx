import { AlertTriangle } from "lucide-react"
import { useLocale } from "../../hooks/useLocale"
import { t } from "../../i18n/translations"

/** Shown when the analytics request itself failed (Roadmap 3.4 ClientError/5xx).
 * `code` is the concrete status (e.g. "503", "429") or "NETWORK" when the
 * request never reached the server at all -- shown alongside the message so
 * a visitor (or whoever they report the issue to) can tell "my own
 * connection" apart from "AWS returned an error" instead of every failure
 * looking identical. */
export function ErrorState({
  message = "Something went wrong loading this data.",
  code,
  onRetry,
}: {
  message?: string
  code?: string
  onRetry?: () => void
}) {
  const [locale] = useLocale()
  return (
    <div className="state-panel state-panel--error" role="alert">
      <AlertTriangle size={28} className="state-panel__icon" aria-hidden="true" />
      <p>
        {message}
        {code && <span className="state-panel__error-code"> {t(locale, "errorState.code", { code })}</span>}
      </p>
      {onRetry && (
        <button type="button" className="soft-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}
