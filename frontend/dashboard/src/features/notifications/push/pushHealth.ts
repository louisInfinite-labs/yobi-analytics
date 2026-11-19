import { useEffect, useState } from "react"
import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import { getPushSubscriptionEndpoint } from "./pushNotifications"
import { usePushState } from "./pushState"

/** What the backend has stored as this client's push subscription. `inactive`: the push service reported it gone (HTTP 404/410) and the dispatcher stopped using it. */
export interface BackendSubscription {
  endpoint: string | null
  inactive: boolean
}

interface PushSubscriptionReadResponse {
  configs?: Array<{ value?: { endpoint?: unknown }; inactiveAt?: unknown }>
}

/** This client's stored push subscription: null when the backend has none. Rejects when it cannot be read (offline, rejected credential) -- "cannot read" is
 * never the same as "not registered", and a caller must not claim notifications work on the strength of a read that failed. */
export async function readBackendSubscription(clientId: string, clientSecret: string | null): Promise<BackendSubscription | null> {
  const response = await apiRequest<PushSubscriptionReadResponse | undefined>(
    `/remote-config?clientId=${encodeURIComponent(clientId)}&key=pushSubscription`,
    { headers: clientSecret ? { "X-Client-Secret": clientSecret } : undefined },
  )
  const record = response?.configs?.[0]
  if (!record) return null
  const endpoint = typeof record.value?.endpoint === "string" ? record.value.endpoint : null
  return { endpoint, inactive: Boolean(record.inactiveAt) }
}

/** Whether this device can really be reached, from the browser's subscription AND the backend's record -- never from the browser alone:
 * - "healthy": the browser has a subscription and the backend stores that very endpoint, active;
 * - "inactive": the backend marked the stored subscription gone (the push service rejected it) -- nothing is delivered until the browser subscribes anew;
 * - "not-registered": the backend has no subscription for this client;
 * - "endpoint-mismatch": the backend stores another endpoint than this browser's current one (a reinstall, a renewed subscription that never reached it);
 * - "no-browser-subscription": the browser has none;
 * - "unknown": the backend could not be read (offline ...). Treated as NOT healthy by callers that turn something on, and as "say nothing" by the notice. */
export type PushHealth = "healthy" | "inactive" | "not-registered" | "endpoint-mismatch" | "no-browser-subscription" | "unknown"

export async function checkPushHealth(): Promise<PushHealth> {
  let endpoint: string | null
  try {
    endpoint = await getPushSubscriptionEndpoint()
  } catch {
    return "unknown"
  }
  if (!endpoint) return "no-browser-subscription"
  try {
    const clientId = getOrCreateClientId()
    const stored = await readBackendSubscription(clientId, await getOrCreateClientSecret(clientId))
    if (!stored || !stored.endpoint) return "not-registered"
    if (stored.inactive) return "inactive"
    return stored.endpoint === endpoint ? "healthy" : "endpoint-mismatch"
  } catch {
    return "unknown"
  }
}

/** The health the Notification Settings notice reacts to: checked only while the browser says granted + subscribed (otherwise the permission notice, or nothing,
 * already says it), and re-checked whenever the user comes back to the app and after `recheck()` (the Reconnect button). null = not applicable / not read yet. */
export function usePushHealth(): { health: PushHealth | null; recheck: () => void } {
  const { supported, permission, subscribed } = usePushState()
  const [health, setHealth] = useState<PushHealth | null>(null)
  const [version, setVersion] = useState(0)
  const applicable = supported && permission === "granted" && subscribed

  useEffect(() => {
    const bump = () => {
      if (document.visibilityState !== "hidden") setVersion((value) => value + 1)
    }
    window.addEventListener("focus", bump)
    document.addEventListener("visibilitychange", bump)
    return () => {
      window.removeEventListener("focus", bump)
      document.removeEventListener("visibilitychange", bump)
    }
  }, [])

  useEffect(() => {
    if (!applicable) return
    let cancelled = false
    void checkPushHealth().then((result) => {
      if (!cancelled) setHealth(result)
    })
    return () => {
      cancelled = true
    }
  }, [applicable, version])

  return { health: applicable ? health : null, recheck: () => setVersion((value) => value + 1) }
}
