import type { Mock } from "vitest"

/** The backend's push-subscription behaviour as the frontend sees it, for tests that mock `apiRequest`: credential registration, the subscription PUT/DELETE
 * (a PUT replaces the whole record, so it clears any inactive marker -- exactly what the real item replacement does), and the explicit read the
 * enrollment/gate use to confirm a subscription (`GET /remote-config?clientId=..&key=pushSubscription`). Every other path answers undefined. */
export interface FakePushBackend {
  /** The stored subscription (null = the backend has none). */
  stored: { endpoint: string; keys?: unknown } | null
  /** The backend marked the stored subscription inactive (the push service said 404/410). */
  inactive: boolean
  /** Make the next calls whose "METHOD /path" matches reject with `{ status }` (undefined status = a network error). */
  failures: Array<{ match: RegExp; status?: number; times: number }>
  /** Every call as "METHOD /path" with the client id masked. */
  calls: string[]
}

export function installFakePushBackend(apiRequest: Mock, initial: Partial<Pick<FakePushBackend, "stored" | "inactive">> = {}): FakePushBackend {
  const backend: FakePushBackend = { stored: initial.stored ?? null, inactive: initial.inactive ?? false, failures: [], calls: [] }
  apiRequest.mockReset().mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET"
    const label = `${method} ${String(path).replace(/\/clients\/[^/?]+/, "/clients/:id").replace(/clientId=[^&]+/, "clientId=:id")}`
    backend.calls.push(label)
    const failure = backend.failures.find((entry) => entry.times > 0 && entry.match.test(label))
    if (failure) {
      failure.times -= 1
      throw failure.status === undefined ? new TypeError("Failed to fetch") : Object.assign(new Error(`HTTP ${failure.status}`), { status: failure.status })
    }
    if (method === "POST" && /\/credential$/.test(path)) return { clientId: "c", clientSecret: "secret" }
    if (/\/push-subscription$/.test(path)) {
      if (method === "PUT") {
        backend.stored = init?.body as FakePushBackend["stored"]
        backend.inactive = false
      } else if (method === "DELETE") {
        backend.stored = null
        backend.inactive = false
      }
      return undefined
    }
    if (method === "GET" && path.startsWith("/remote-config") && path.includes("key=pushSubscription")) {
      return { configs: backend.stored ? [{ clientId: "c", key: "pushSubscription", value: backend.stored, updatedAt: "t", ...(backend.inactive ? { inactiveAt: "2026-11-16T00:00:00+00:00" } : {}) }] : [] }
    }
    return undefined
  })
  return backend
}
