import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, ConfigError, apiRequest, describeApiFailure, isHistoricalDataUnavailable } from "./apiClient"

describe("apiRequest", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("returns the parsed JSON body for a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ hello: "world" }) }),
    )

    const result = await apiRequest<{ hello: string }>("/foo")

    expect(result).toEqual({ hello: "world" })
    expect(fetch).toHaveBeenCalledWith("https://api.example.com/foo", expect.objectContaining({ method: "GET" }))
  })

  it("sends a JSON body and Content-Type header for a POST request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
    vi.stubGlobal("fetch", fetchMock)

    await apiRequest("/foo", { method: "POST", body: { a: 1 } })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/foo",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ a: 1 }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    )
  })

  describe("request headers", () => {
    const okFetch = () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
      vi.stubGlobal("fetch", fetchMock)
      return fetchMock
    }
    const sentHeaders = (fetchMock: ReturnType<typeof okFetch>, call = 0) => (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>

    it("adds no Content-Type to a bodyless GET, so the browser needs no CORS preflight for it", async () => {
      const fetchMock = okFetch()

      await apiRequest("/live-streams")

      expect(sentHeaders(fetchMock)).toEqual({})
      expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBeUndefined()
    })

    it.each(["POST", "PUT", "DELETE"] as const)("sends the JSON Content-Type with a %s that has a body", async (method) => {
      const fetchMock = okFetch()

      await apiRequest("/foo", { method, body: { a: 1 } })

      expect(sentHeaders(fetchMock)).toEqual({ "Content-Type": "application/json" })
      expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ a: 1 }))
    })

    it("also types a falsy but present body (0, false, empty string, null) as JSON", async () => {
      for (const body of [0, false, "", null]) {
        const fetchMock = okFetch()
        await apiRequest("/foo", { method: "PUT", body })
        expect(sentHeaders(fetchMock)).toEqual({ "Content-Type": "application/json" })
      }
    })

    it("adds no Content-Type to a bodyless POST or DELETE either (credential registration, push unsubscribe): there is nothing to describe", async () => {
      for (const method of ["POST", "DELETE"] as const) {
        const fetchMock = okFetch()
        await apiRequest("/clients/c1/credential", { method })
        expect(sentHeaders(fetchMock)).toEqual({})
        expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/clients/c1/credential", expect.objectContaining({ method, body: undefined }))
      }
    })

    it("keeps the headers a caller supplies exactly as given on a bodyless GET (admin key, remote-config client secret)", async () => {
      const admin = okFetch()
      await apiRequest("/foo", { headers: { "X-Admin-Key": "secret" } })
      expect(sentHeaders(admin)).toEqual({ "X-Admin-Key": "secret" })

      const remoteConfig = okFetch()
      await apiRequest("/remote-config?clientId=c%201", { headers: { "X-Client-Secret": "s3cret" } })
      expect(remoteConfig).toHaveBeenCalledWith("https://api.example.com/remote-config?clientId=c%201", expect.objectContaining({ method: "GET" }))
      expect(sentHeaders(remoteConfig)).toEqual({ "X-Client-Secret": "s3cret" })
    })

    it("merges caller-supplied headers alongside the Content-Type of a request that has a body", async () => {
      const fetchMock = okFetch()

      await apiRequest("/remote-config", { method: "POST", body: { key: "k" }, headers: { "X-Admin-Key": "secret" } })

      expect(sentHeaders(fetchMock)).toEqual({ "Content-Type": "application/json", "X-Admin-Key": "secret" })
    })

    it("never duplicates or overrides a Content-Type the caller supplies, in any spelling", async () => {
      for (const name of ["Content-Type", "content-type", "CONTENT-TYPE"]) {
        const withBody = okFetch()
        await apiRequest("/foo", { method: "PUT", body: { a: 1 }, headers: { [name]: "application/merge-patch+json" } })
        expect(sentHeaders(withBody)).toEqual({ [name]: "application/merge-patch+json" })

        const bodyless = okFetch()
        await apiRequest("/foo", { headers: { [name]: "text/plain" } })
        expect(sentHeaders(bodyless)).toEqual({ [name]: "text/plain" })
      }
    })

    it("passes the Home data paths to fetch verbatim: same URLs, same query strings, no extra header", async () => {
      const paths = [
        "/creators/aizawa_ema/oshi-status?recentLimit=1",
        "/creators/aizawa_ema/videos/recent?contentType=live&liveStatus=completed&limit=20&offset=0",
        "/creators/aizawa_ema/videos/recent?topic=all&contentType=all&liveStatus=archived&sort=newest&limit=20&offset=0&excludeShorts=true&newSince=2026-10-24T05%3A59%3A38.011Z",
        "/live-streams",
        "/topics",
        "/milestones",
      ]
      const fetchMock = okFetch()

      for (const path of paths) await apiRequest(path)

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(paths.map((path) => `https://api.example.com${path}`))
      for (let call = 0; call < paths.length; call++) expect(sentHeaders(fetchMock, call)).toEqual({})
    })
  })

  it("throws an ApiError carrying the backend's own error message for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: "bad request" }) }),
    )

    await expect(apiRequest("/foo")).rejects.toThrow("bad request")
  })

  it("throws an ApiError instance, carrying the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({ error: "nope" }) }),
    )

    await expect(apiRequest("/foo")).rejects.toBeInstanceOf(ApiError)
    try {
      await apiRequest("/foo")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(403)
    }
  })

  it("falls back to a generic message when the error body isn't the expected shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error("not json")) }),
    )

    await expect(apiRequest("/foo")).rejects.toThrow("Request failed with status 500")
  })

  it("throws a ConfigError, not ApiError, when VITE_API_BASE_URL is not configured", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("VITE_API_BASE_URL", "")

    await expect(apiRequest("/foo")).rejects.toThrow("VITE_API_BASE_URL is not configured")
    try {
      await apiRequest("/foo")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect(error).not.toBeInstanceOf(ApiError)
    }
  })

  it("retries a 429 and succeeds once the backend stops throttling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: () => Promise.resolve({ error: "throttled" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ hello: "world" }) })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("setTimeout", ((fn: () => void) => fn()) as unknown as typeof setTimeout)

    const result = await apiRequest<{ hello: string }>("/foo")

    expect(result).toEqual({ hello: "world" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("retries a 429 with the very same request (URL, method, headers, body), still adding no Content-Type to a bodyless GET", async () => {
    vi.useFakeTimers()
    const throttled = { ok: false, status: 429, json: () => Promise.resolve({ error: "Too Many Requests" }) }
    const fetchMock = vi.fn().mockResolvedValueOnce(throttled).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) })
    vi.stubGlobal("fetch", fetchMock)

    const pending = apiRequest("/topics", { headers: { "X-Client-Secret": "s" } })
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0])
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({ "X-Client-Secret": "s" })
    vi.useRealTimers()
  })

  it("gives up and throws ApiError after exhausting 429 retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({ error: "throttled" }) })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("setTimeout", ((fn: () => void) => fn()) as unknown as typeof setTimeout)

    await expect(apiRequest("/foo")).rejects.toThrow("throttled")
    // Initial attempt + MAX_429_RETRIES (2) retries = 3 total.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("never retries a non-429 error status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: "boom" }) })
    vi.stubGlobal("fetch", fetchMock)

    await expect(apiRequest("/foo")).rejects.toThrow("boom")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("turns the backend's HISTORICAL_DATA_UNAVAILABLE 404 body into an error isHistoricalDataUnavailable recognizes, once", async () => {
    const body = { error: "Historical data for creatorId='mano_aloe' is unavailable", code: "HISTORICAL_DATA_UNAVAILABLE" }
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve(body) })
    vi.stubGlobal("fetch", fetchMock)

    const error = await apiRequest("/creators/mano_aloe/videos/recent").catch((e: unknown) => e)

    expect(isHistoricalDataUnavailable(error)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("recognizes only a 404 carrying exactly that code as unavailable historical data", () => {
    expect(isHistoricalDataUnavailable(new ApiError(404, "x", "HISTORICAL_DATA_UNAVAILABLE"))).toBe(true)
    expect(isHistoricalDataUnavailable(new ApiError(404, "x"))).toBe(false)
    expect(isHistoricalDataUnavailable(new ApiError(404, "x", "SOMETHING_ELSE"))).toBe(false)
    expect(isHistoricalDataUnavailable(new ApiError(503, "x", "HISTORICAL_DATA_UNAVAILABLE"))).toBe(false)
    expect(isHistoricalDataUnavailable(new Error("HISTORICAL_DATA_UNAVAILABLE"))).toBe(false)
  })
})

describe("describeApiFailure", () => {
  it("reports a plain (non-ApiError) failure as a network problem, not an AWS status code", () => {
    const { code, description } = describeApiFailure(new TypeError("Failed to fetch"))
    expect(code).toBe("NETWORK")
    expect(description).toContain("網絡")
  })

  it("reports a ConfigError as a configuration problem, not a network problem", () => {
    const { code, description } = describeApiFailure(new ConfigError("VITE_API_BASE_URL is not configured"))
    expect(code).toBe("CONFIG")
    expect(description).not.toContain("網絡")
  })

  it("reports an exhausted 429 as AWS-side throttling with the code visible", () => {
    const { code, description } = describeApiFailure(new ApiError(429, "throttled"))
    expect(code).toBe("429")
    expect(description).toContain("429")
  })

  it("reports a 5xx as an AWS server error, explicitly telling the visitor it's not their network", () => {
    const { code, description } = describeApiFailure(new ApiError(503, "unavailable"))
    expect(code).toBe("503")
    expect(description).toContain("503")
    expect(description).toContain("並非你的網絡問題")
  })

  it("reports a 4xx with its own status code and the backend's message", () => {
    const { code, description } = describeApiFailure(new ApiError(403, "Missing or invalid admin API key"))
    expect(code).toBe("403")
    expect(description).toContain("403")
    expect(description).toContain("Missing or invalid admin API key")
  })
})
