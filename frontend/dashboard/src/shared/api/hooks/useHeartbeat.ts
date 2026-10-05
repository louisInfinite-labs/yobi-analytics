import { useEffect } from "react"
import { apiRequest } from "../apiClient"
import { getOrCreateClientId } from "../clientId"
import { startJitteredInterval } from "../jitter"

// Well under Roadmap 4.4's 2-minute online threshold, so a client that's
// still open reads as "online" with margin for one missed/slow tick.
const HEARTBEAT_INTERVAL_MS = 60_000

const APP_VERSION = "dashboard-1.0.0"

/** Send a periodic heartbeat (Roadmap 4.4) identifying this browser by its
 * own Roadmap 4.3 clientId, for as long as the Dashboard tab stays open.
 * Fires once immediately on mount and then on a jittered ~60 s interval; a failed
 * heartbeat is never surfaced to the user — this is best-effort presence
 * data, not a correctness requirement, so the next tick simply retries.
 */
export function useHeartbeat(): void {
  useEffect(() => {
    const clientId = getOrCreateClientId()

    const sendHeartbeat = () => {
      apiRequest("/heartbeat", { method: "POST", body: { clientId, appVersion: APP_VERSION } }).catch(() => {
        // Best-effort — see docstring above.
      })
    }

    // The first heartbeat is immediate (never delayed); only the repeats are jittered so tabs do not stay in lockstep.
    sendHeartbeat()
    return startJitteredInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
  }, [])
}
