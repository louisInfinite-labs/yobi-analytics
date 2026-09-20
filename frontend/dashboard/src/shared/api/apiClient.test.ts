import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, ConfigError, apiRequest, describeApiFailure } from "./apiClient"

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

  it("merges caller-supplied headers alongside the default Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
    vi.stubGlobal("fetch", fetchMock)

    await apiRequest("/foo", { headers: { "X-Admin-Key": "secret" } })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/foo",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json", "X-Admin-Key": "secret" }) }),
    )
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
