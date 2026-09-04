import { useState } from "react"
import type { FormEvent } from "react"
import { ApiError, apiRequest } from "../lib/apiClient"

interface HeartbeatStats {
  totalClients: number
  onlineNow: number
}

/**
 * Admin-only screen (Roadmap 4.5): view aggregate client activity
 * (Roadmap 4.4's heartbeat data) and author a remote-config entry for any
 * clientId. Reachable only via `?admin` on the Dashboard's own URL — not
 * linked from the normal UI — and gated behind a shared admin API key
 * entered by hand and kept only in this component's own React state. The
 * key is never hardcoded here (this file ships in the same public JS
 * bundle every visitor downloads, so baking in a real secret would hand it
 * to anyone who opens dev tools) and is deliberately never persisted to
 * `localStorage`/`sessionStorage` either — it authorizes remote-config
 * writes for any clientId, so it must not sit readable in browser storage
 * (e.g. to a same-origin XSS) any longer than this page is open. It must
 * be re-entered after a refresh or reopening the page.
 */
export function AdminPanel() {
  const [adminKey, setAdminKey] = useState("")
  const [stats, setStats] = useState<HeartbeatStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [writeClientId, setWriteClientId] = useState("")
  const [writeKey, setWriteKey] = useState("")
  const [writeValue, setWriteValue] = useState("")
  const [writeStatus, setWriteStatus] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  const loadStats = () => {
    setStatsLoading(true)
    setStatsError(null)
    apiRequest<HeartbeatStats>("/admin/heartbeat-stats", { headers: { "X-Admin-Key": adminKey } })
      .then((result) => setStats(result))
      .catch((error: unknown) => setStatsError(error instanceof ApiError ? error.message : "Failed to load stats"))
      .finally(() => setStatsLoading(false))
  }

  const handleWrite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setWriting(true)
    setWriteStatus(null)

    // The backend stores `value` as opaque JSON (Roadmap 4.5) — accept
    // either real JSON (an object/array/number/bool) or fall back to the
    // raw text as a plain string, so an admin typing `true` gets a real
    // boolean but typing a plain label doesn't need to be quoted twice.
    let parsedValue: unknown = writeValue
    try {
      parsedValue = JSON.parse(writeValue)
    } catch {
      // Keep the raw string.
    }

    apiRequest("/remote-config", {
      method: "POST",
      headers: { "X-Admin-Key": adminKey },
      body: { clientId: writeClientId, key: writeKey, value: parsedValue },
    })
      .then(() => setWriteStatus("Saved."))
      .catch((error: unknown) => setWriteStatus(error instanceof ApiError ? `Failed: ${error.message}` : "Failed to save."))
      .finally(() => setWriting(false))
  }

  return (
    <section className="admin-panel">
      <h1>Yobi Analytics — Admin</h1>

      <label className="admin-panel__field">
        Admin API key
        <input
          type="password"
          value={adminKey}
          onChange={(event) => setAdminKey(event.target.value)}
          autoComplete="off"
        />
      </label>
      <p className="admin-panel__hint">Admin key is kept only for this page session and is not saved in the browser.</p>

      <div className="admin-panel__section">
        <h2>Client activity</h2>
        <button type="button" className="soft-button" onClick={loadStats} disabled={!adminKey || statsLoading}>
          {statsLoading ? "Loading…" : "Refresh stats"}
        </button>
        {statsError && (
          <p role="alert" className="admin-panel__error">
            {statsError}
          </p>
        )}
        {stats && (
          <p>
            {stats.totalClients} client{stats.totalClients === 1 ? "" : "s"} total · {stats.onlineNow} online now
          </p>
        )}
      </div>

      <form className="admin-panel__section" onSubmit={handleWrite}>
        <h2>Write remote config</h2>
        <label className="admin-panel__field">
          Client ID
          <input value={writeClientId} onChange={(event) => setWriteClientId(event.target.value)} required />
        </label>
        <label className="admin-panel__field">
          Key
          <input value={writeKey} onChange={(event) => setWriteKey(event.target.value)} required />
        </label>
        <label className="admin-panel__field">
          Value (JSON, or plain text)
          <textarea value={writeValue} onChange={(event) => setWriteValue(event.target.value)} required />
        </label>
        <button type="submit" className="soft-button" disabled={!adminKey || writing}>
          {writing ? "Saving…" : "Save"}
        </button>
        {writeStatus && <p>{writeStatus}</p>}
      </form>
    </section>
  )
}
