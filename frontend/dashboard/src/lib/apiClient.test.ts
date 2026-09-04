import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, apiRequest } from "./apiClient"

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

  it("throws a plain Error when VITE_API_BASE_URL is not configured", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("VITE_API_BASE_URL", "")

    await expect(apiRequest("/foo")).rejects.toThrow("VITE_API_BASE_URL is not configured")
  })
})
