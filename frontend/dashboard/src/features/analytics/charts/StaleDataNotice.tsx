import { AlertCircle } from "lucide-react"

const STALE_THRESHOLD_MS = 1000 * 60 * 60 * 30 // 30 hours — the daily collector runs once per day

/** A small inline notice when the most recent collection is older than
 * expected, so a viewer isn't misled into thinking the data is current. */
export function StaleDataNotice({ lastUpdatedAt, now = new Date() }: { lastUpdatedAt: string; now?: Date }) {
  const ageMs = now.getTime() - new Date(lastUpdatedAt).getTime()
  if (ageMs < STALE_THRESHOLD_MS) return null

  return (
    <span className="stale-notice">
      <AlertCircle size={12} aria-hidden="true" />
      Data may be stale
    </span>
  )
}
