import { AlertTriangle } from "lucide-react"

/** Shown when the analytics request itself failed (Roadmap 3.4 ClientError/5xx). */
export function ErrorState({ message = "Something went wrong loading this data.", onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <AlertTriangle size={28} className="state-panel__icon" aria-hidden="true" />
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="soft-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}
