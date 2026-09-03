import { Clock } from "lucide-react"

/** Shown for a video/date whose canonical snapshot has not completed yet
 * (Roadmap 3.1 `pending`) — distinct from a permanent not_available result. */
export function PendingState({ lastUpdatedAt }: { lastUpdatedAt?: string }) {
  return (
    <div className="state-panel">
      <Clock size={28} className="state-panel__icon" aria-hidden="true" />
      <p>Today's collection hasn't completed yet.</p>
      {lastUpdatedAt && <p style={{ fontSize: 12 }}>Last updated: {lastUpdatedAt}</p>}
    </div>
  )
}
