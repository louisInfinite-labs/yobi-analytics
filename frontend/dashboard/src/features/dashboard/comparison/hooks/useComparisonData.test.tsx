import { renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { buildComparisonDataRequest, useComparisonData } from "./useComparisonData"
import type { ComparisonDataRequest, ComparisonDataResponse } from "../model/dashboardComparisonData"
import type { ComparisonItem } from "../model/dashboardComparisonCatalog"

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

const AVAILABLE_ITEMS: ComparisonItem[] = [
  { comparisonItemId: "revenue", label: "Revenue" },
  { comparisonItemId: "engagement", label: "Engagement" },
  { comparisonItemId: "growth", label: "Growth" },
]

const RESPONSE: ComparisonDataResponse = {
  creators: [
    { status: "ok", creatorId: "creator-a", points: [{ label: "Mon", value: 10 }] },
    { status: "ok", creatorId: "creator-b", points: [{ label: "Mon", value: 5 }] },
  ],
}

describe("buildComparisonDataRequest", () => {
  it("MT-14 AC1: preserves ordered creatorIds and deduplicates", () => {
    const request = buildComparisonDataRequest(["creator-a", "creator-b", "creator-a"], ["revenue"], AVAILABLE_ITEMS)
    expect(request.creatorIds).toEqual(["creator-a", "creator-b"])
  })

  it("MT-14 AC2: preserves ordered, backend-supported comparisonItemIds and deduplicates", () => {
    const request = buildComparisonDataRequest(["creator-a"], ["revenue", "engagement", "revenue"], AVAILABLE_ITEMS)
    expect(request.comparisonItemIds).toEqual(["revenue", "engagement"])
  })

  it("MT-14 AC2: drops a comparisonItemId that is not in the backend-supported catalog", () => {
    const request = buildComparisonDataRequest(["creator-a"], ["revenue", "not-a-real-item", "engagement"], AVAILABLE_ITEMS)
    expect(request.comparisonItemIds).toEqual(["revenue", "engagement"])
    expect(request.comparisonItemIds).not.toContain("not-a-real-item")
  })

  it("MT-14 AC2: an entirely unsupported id list produces an empty comparisonItemIds request, never a fabricated fallback", () => {
    const request = buildComparisonDataRequest(["creator-a"], ["not-a-real-item"], AVAILABLE_ITEMS)
    expect(request.comparisonItemIds).toEqual([])
  })
})

describe("useComparisonData", () => {
  it("starts in the loading state before the fetch resolves, exposing the request that was made", () => {
    const fetchComparisonData = vi.fn(() => pending<ComparisonDataResponse>())
    const { result } = renderHook(() => useComparisonData(["creator-a", "creator-b"], ["revenue"], AVAILABLE_ITEMS, fetchComparisonData))

    expect(result.current.state).toEqual({ phase: "loading" })
    expect(result.current.request).toEqual({ creatorIds: ["creator-a", "creator-b"], comparisonItemIds: ["revenue"] })
  })

  it("calls fetchComparisonData with the ordered, deduplicated, backend-supported request (AC1/AC2 request snapshot)", () => {
    const fetchComparisonData = vi.fn(() => pending<ComparisonDataResponse>())
    renderHook(() => useComparisonData(["creator-a", "creator-b", "creator-a"], ["revenue", "revenue"], AVAILABLE_ITEMS, fetchComparisonData))

    expect(fetchComparisonData).toHaveBeenCalledTimes(1)
    expect(fetchComparisonData).toHaveBeenCalledWith({ creatorIds: ["creator-a", "creator-b"], comparisonItemIds: ["revenue"] })
  })

  it("MT-14 AC2: an unsupported comparisonItemId never reaches the outgoing fetch call", () => {
    const fetchComparisonData = vi.fn((_request: ComparisonDataRequest) => pending<ComparisonDataResponse>())
    renderHook(() => useComparisonData(["creator-a"], ["revenue", "not-a-real-item"], AVAILABLE_ITEMS, fetchComparisonData))

    expect(fetchComparisonData).toHaveBeenCalledWith({ creatorIds: ["creator-a"], comparisonItemIds: ["revenue"] })
    const actualRequest = fetchComparisonData.mock.calls[0]?.[0]
    expect(actualRequest?.comparisonItemIds).not.toContain("not-a-real-item")
  })

  it("resolves to success with exactly the response the fetch returned", async () => {
    const fetchComparisonData = vi.fn(() => Promise.resolve(RESPONSE))
    const { result } = renderHook(() => useComparisonData(["creator-a", "creator-b"], ["revenue"], AVAILABLE_ITEMS, fetchComparisonData))

    await waitFor(() => expect(result.current.state.phase).toBe("success"))
    expect(result.current.state).toEqual({ phase: "success", response: RESPONSE })
  })

  it("MT-14 AC7: a rejected fetch surfaces a distinguishable error state while the request/config is still readable", async () => {
    const fetchComparisonData = vi.fn(() => Promise.reject(new Error("comparison data unavailable")))
    const { result } = renderHook(() => useComparisonData(["creator-a", "creator-b"], ["revenue"], AVAILABLE_ITEMS, fetchComparisonData))

    await waitFor(() => expect(result.current.state.phase).toBe("error"))
    expect(result.current.state).toMatchObject({ phase: "error", error: expect.any(Error) })
    expect(result.current.request).toEqual({ creatorIds: ["creator-a", "creator-b"], comparisonItemIds: ["revenue"] })
  })

  it("re-fetches when the ordered creatorIds/comparisonItemIds actually change", async () => {
    const fetchComparisonData = vi.fn(() => Promise.resolve(RESPONSE))
    const { rerender } = renderHook(({ creatorIds }) => useComparisonData(creatorIds, ["revenue"], AVAILABLE_ITEMS, fetchComparisonData), {
      initialProps: { creatorIds: ["creator-a"] },
    })
    await waitFor(() => expect(fetchComparisonData).toHaveBeenCalledTimes(1))

    rerender({ creatorIds: ["creator-a", "creator-b"] })
    await waitFor(() => expect(fetchComparisonData).toHaveBeenCalledTimes(2))
  })
})
