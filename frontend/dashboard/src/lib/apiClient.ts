/** A non-2xx response from the Yobi Analytics backend (Roadmap 4.1/4.4/4.5/4.6).
 * `message` is the backend's own `{"error": "..."}` body (api_handler.py's
 * `_json_response`) when present, so a caller can show the same clean text
 * the backend already produced instead of a generic "request failed". */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** Thrown when the app itself is misconfigured (e.g. `VITE_API_BASE_URL` is
 * unset) — distinct from a plain `Error`/network failure so `describeApiFailure`
 * doesn't tell a visitor to check their own connection for a deployment
 * mistake that has nothing to do with them. */
export class ConfigError extends Error {}

interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
  headers?: Record<string, string>
}

// This account's Lambda concurrency quota is a shared, low ceiling (a
// support case to raise it is pending) — a burst of visitors loading the
// dashboard at the same moment (e.g. right after a link is shared to a
// large group) can transiently exceed it and get 429s that would
// otherwise have succeeded a moment later. Retrying a handful of times
// with growing, jittered delays absorbs that without the caller needing
// to know any of this. Only 429 is retried: any other status is a real
// client/server error a retry won't fix.
const MAX_429_RETRIES = 2
const RETRY_BASE_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Call one Yobi Analytics backend endpoint and return its parsed JSON body.
 *
 * Throws `ApiError` for any non-2xx response (the backend always returns a
 * JSON body, even for its own errors) and a plain `Error` — including when
 * `VITE_API_BASE_URL` itself isn't configured — for anything that means the
 * request never got a response to parse at all, so callers can tell "the
 * server refused this" apart from "this never reached the server".
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  // Read at call time, not module load — so it reflects the live
  // environment (and can be stubbed per-test) rather than whatever was
  // configured the moment this module first got imported.
  const baseUrl = import.meta.env.VITE_API_BASE_URL
  if (!baseUrl) {
    throw new ConfigError("VITE_API_BASE_URL is not configured")
  }

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })

    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt
      await sleep(backoff + Math.random() * backoff)
      continue
    }

    const payload: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      const message =
        payload !== null && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed with status ${response.status}`
      throw new ApiError(response.status, message)
    }

    return payload as T
  }
}

/** Turn a failed `apiRequest` call into a status code + user-facing message
 * that distinguishes "this never reached AWS" (the visitor's own network,
 * or the API being unreachable) from "AWS received this and rejected/failed
 * it" (a real status code, shown so it's reportable) — so a caller like
 * ErrorState doesn't have to collapse every failure into one generic
 * message that leaves the visitor unable to tell which side the problem is
 * on. */
export function describeApiFailure(error: Error): { code: string; description: string } {
  if (error instanceof ConfigError) {
    // Never reached AWS, but not the visitor's fault either -- a deployment
    // mistake (missing env var), not something a retry or a different
    // network fixes.
    return { code: "CONFIG", description: "應用程式設定錯誤,請聯絡管理員。" }
  }
  if (!(error instanceof ApiError)) {
    // apiRequest only throws a plain Error when fetch itself never got a
    // response back (offline, DNS/CORS failure, VITE_API_BASE_URL
    // misconfigured) -- that's the visitor's own connection, not AWS.
    return { code: "NETWORK", description: "無法連線到伺服器,請檢查你的網絡連線後重試。" }
  }

  if (error.status === 429) {
    return {
      code: "429",
      description: "現在使用人數較多,伺服器暫時限制請求 (429)。系統已自動重試但仍未成功,請稍後再重新整理。",
    }
  }
  if (error.status >= 500) {
    return { code: String(error.status), description: `AWS 伺服器發生錯誤 (${error.status}),並非你的網絡問題,請稍後再試。` }
  }
  return { code: String(error.status), description: `請求失敗 (${error.status}):${error.message}` }
}
