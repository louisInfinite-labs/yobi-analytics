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

interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
  headers?: Record<string, string>
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
    throw new Error("VITE_API_BASE_URL is not configured")
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })

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
