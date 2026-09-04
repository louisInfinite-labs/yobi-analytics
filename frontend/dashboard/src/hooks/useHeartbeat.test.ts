import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useHeartbeat } from "./useHeartbeat"
import * as apiClient from "../lib/apiClient"
import * as clientId from "../lib/clientId"

vi.mock("../lib/apiClient", () => ({ apiRequest: vi.fn() }))

describe("useHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.spyOn(clientId, "getOrCreateClientId").mockReturnValue("client-1")
    vi.mocked(apiClient.apiRequest).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("sends a heartbeat immediately on mount using this browser's own clientId", () => {
    renderHook(() => useHeartbeat())

    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
    expect(apiClient.apiRequest).toHaveBeenCalledWith(
      "/heartbeat",
      expect.objectContaining({ method: "POST", body: expect.objectContaining({ clientId: "client-1" }) }),
    )
  })

  it("sends another heartbeat every interval tick while mounted", () => {
    renderHook(() => useHeartbeat())
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(60_000)
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(3)
  })

  it("stops sending heartbeats after unmount", () => {
    const { unmount } = renderHook(() => useHeartbeat())
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)

    unmount()
    vi.advanceTimersByTime(120_000)

    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
  })

  it("does not throw when a heartbeat request fails", async () => {
    vi.mocked(apiClient.apiRequest).mockRejectedValue(new Error("network error"))

    expect(() => renderHook(() => useHeartbeat())).not.toThrow()
    // Flush the microtask queue so the hook's own .catch() runs before the
    // test exits, rather than leaking an unhandled-rejection warning.
    await Promise.resolve()
    await Promise.resolve()
  })
})
