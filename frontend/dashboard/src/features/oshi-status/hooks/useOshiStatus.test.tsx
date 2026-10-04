import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useOshiStatus } from "./useOshiStatus"
import { fetchOshiStatus, type OshiStatusData } from "../data/oshiStatus"

vi.mock("../data/oshiStatus", () => ({ fetchOshiStatus: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiStatus)
const VISIT = new Date("2026-09-25T00:00:00Z")

function status(subscriberCount: number): OshiStatusData {
  return {
    subscriberCount,
    latestVideo: null,
    thisWeek: { newUploads: 0, newStreams: 0 },
    growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
    recent: [],
    sinceLastVisit: null,
  }
}

function deferred() {
  let resolve!: (value: OshiStatusData) => void
  let reject!: (error: Error) => void
  const promise = new Promise<OshiStatusData>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe("useOshiStatus", () => {
  it("fetches the current creator's status with the stored last visit and returns it", async () => {
    fetchMock.mockResolvedValue(status(100))

    const { result } = renderHook(() => useOshiStatus("aizawa_ema", VISIT))

    expect(result.current).toMatchObject({ data: null, loading: true })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledWith("aizawa_ema", VISIT)
    expect(result.current.data?.subscriberCount).toBe(100)
  })

  it("fetches nothing for a creator with no canonical id", () => {
    const { result } = renderHook(() => useOshiStatus(undefined, VISIT))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current).toEqual({ data: null, loading: false, error: null })
  })

  it("does not refetch for a re-render with an equal last-visit Date", async () => {
    fetchMock.mockResolvedValue(status(1))
    const { result, rerender } = renderHook(({ since }) => useOshiStatus("aizawa_ema", since), { initialProps: { since: new Date(VISIT) } })
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ since: new Date(VISIT) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("switching creator drops the previous creator's data at once, even while the new request loads", async () => {
    const a = deferred()
    const b = deferred()
    fetchMock.mockImplementation((creatorId) => (creatorId === "aizawa_ema" ? a.promise : b.promise))
    const { result, rerender } = renderHook(({ id }) => useOshiStatus(id, VISIT), { initialProps: { id: "aizawa_ema" } })
    await act(async () => a.resolve(status(111)))
    expect(result.current.data?.subscriberCount).toBe(111)

    rerender({ id: "gawr_gura" })

    expect(result.current).toMatchObject({ data: null, loading: true })
    await act(async () => b.resolve(status(222)))
    expect(result.current.data?.subscriberCount).toBe(222)
  })

  it("a slow response for the previous creator can never overwrite the new creator's status", async () => {
    const a = deferred()
    const b = deferred()
    fetchMock.mockImplementation((creatorId) => (creatorId === "aizawa_ema" ? a.promise : b.promise))
    const { result, rerender } = renderHook(({ id }) => useOshiStatus(id, VISIT), { initialProps: { id: "aizawa_ema" } })

    rerender({ id: "gawr_gura" })
    await act(async () => b.resolve(status(222)))
    await act(async () => a.resolve(status(111))) // the old creator's request finishes LAST

    expect(result.current.data?.subscriberCount).toBe(222)
  })

  it("a late failure of the previous creator's request does not replace the new creator's data", async () => {
    const a = deferred()
    const b = deferred()
    fetchMock.mockImplementation((creatorId) => (creatorId === "aizawa_ema" ? a.promise : b.promise))
    const { result, rerender } = renderHook(({ id }) => useOshiStatus(id, VISIT), { initialProps: { id: "aizawa_ema" } })

    rerender({ id: "gawr_gura" })
    await act(async () => b.resolve(status(222)))
    await act(async () => a.reject(new Error("late failure")))

    expect(result.current.error).toBeNull()
    expect(result.current.data?.subscriberCount).toBe(222)
  })

  it("a failed request gives no data and the error, never another creator's numbers", async () => {
    fetchMock.mockResolvedValueOnce(status(111)).mockRejectedValueOnce(new Error("503"))
    const { result, rerender } = renderHook(({ id }) => useOshiStatus(id, VISIT), { initialProps: { id: "aizawa_ema" } })
    await waitFor(() => expect(result.current.data?.subscriberCount).toBe(111))

    rerender({ id: "gawr_gura" })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.data).toBeNull()
    expect(result.current.error?.message).toBe("503")
  })
})
