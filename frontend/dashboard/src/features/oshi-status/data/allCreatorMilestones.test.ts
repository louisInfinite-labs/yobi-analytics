import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../../../shared/api/apiClient"
import {
  FAILURE_RETRY_MS,
  FRESH_FOR_MS,
  fetchAllCreatorMilestones,
  getCachedAllCreatorMilestones,
  hasUsableMilestoneDate,
  isAllCreatorMilestonesStale,
  loadAllCreatorMilestones,
  resetAllCreatorMilestonesForTests,
} from "./allCreatorMilestones"

vi.mock("../../../shared/api/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../../../shared/api/apiClient")>("../../../shared/api/apiClient")
  return { ...actual, apiRequest: vi.fn() }
})
import { apiRequest } from "../../../shared/api/apiClient"

const requestMock = vi.mocked(apiRequest)
const BODY = {
  milestones: [
    { creatorId: "hoshimachi_suisei", birthday: "03-22", debutDate: "2018-03-22" },
    { creatorId: "mano_aloe", birthday: "10-28", debutDate: "2020-08-15" },
  ],
}

beforeEach(() => {
  requestMock.mockReset()
  resetAllCreatorMilestonesForTests()
})

describe("fetchAllCreatorMilestones", () => {
  it("is ONE bulk request for the whole roster", async () => {
    requestMock.mockResolvedValue(BODY)
    const result = await fetchAllCreatorMilestones()
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledWith("/milestones")
    expect(result).toEqual({ hoshimachi_suisei: { birthday: "03-22", debutDate: "2018-03-22" }, mano_aloe: { birthday: "10-28", debutDate: "2020-08-15" } })
  })

  it("skips records with no usable date at all, and keeps only the usable one of a record with a single usable date", async () => {
    requestMock.mockResolvedValue({
      milestones: [
        BODY.milestones[0],
        { creatorId: "bad_birthday", birthday: "02-30", debutDate: "2020-01-01" },
        { creatorId: "bad_debut", birthday: "01-01", debutDate: "01-01" },
        { creatorId: "no_dates", birthday: "02-30", debutDate: "01-01" },
        { creatorId: "empty_strings", birthday: "", debutDate: "" },
        { creatorId: "missing_fields" },
        { birthday: "01-01", debutDate: "2020-01-01" },
        null,
      ],
    })
    expect(await fetchAllCreatorMilestones()).toEqual({
      hoshimachi_suisei: { birthday: "03-22", debutDate: "2018-03-22" },
      bad_birthday: { debutDate: "2020-01-01" },
      bad_debut: { birthday: "01-01" },
    })
  })

  it("a response without a list is an error", async () => {
    requestMock.mockResolvedValue({})
    await expect(fetchAllCreatorMilestones()).rejects.toThrow()
  })
})

describe("loadAllCreatorMilestones: once per page session, never per creator", () => {
  it("shares one request between concurrent callers and serves later calls from memory", async () => {
    requestMock.mockResolvedValue(BODY)
    const [first, second] = await Promise.all([loadAllCreatorMilestones(), loadAllCreatorMilestones()])
    await loadAllCreatorMilestones()
    expect(first).toBe(second)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(getCachedAllCreatorMilestones()).toBe(first)
  })

  it("an unavailable endpoint (404 for a route not deployed yet, 503, network) yields nothing and is retried only after the cool-down", async () => {
    let clock = 1_000_000
    requestMock.mockRejectedValue(new ApiError(404, "No such route"))
    await expect(loadAllCreatorMilestones(() => clock)).rejects.toBeInstanceOf(ApiError)
    expect(getCachedAllCreatorMilestones()).toBeNull()

    // Remounts inside the cool-down do not hit the network again.
    clock += FAILURE_RETRY_MS - 1
    await expect(loadAllCreatorMilestones(() => clock)).rejects.toThrow()
    expect(requestMock).toHaveBeenCalledTimes(1)

    // After it, one new attempt is made, and success is then kept.
    clock += 2
    requestMock.mockResolvedValue(BODY)
    await expect(loadAllCreatorMilestones(() => clock)).resolves.toMatchObject({ hoshimachi_suisei: { birthday: "03-22" } })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })
})

describe("bounded cache lifetime: fresh for one hour, then revalidated when next needed", () => {
  const NEWER = { milestones: [{ creatorId: "hoshimachi_suisei", birthday: "03-23", debutDate: "2018-03-22" }] }

  it("is fresh for exactly an hour with no request, then stale", async () => {
    let clock = 5_000_000
    requestMock.mockResolvedValue(BODY)
    await loadAllCreatorMilestones(() => clock)
    expect(FRESH_FOR_MS).toBe(60 * 60 * 1000)
    expect(isAllCreatorMilestonesStale(clock + FRESH_FOR_MS - 1)).toBe(false)
    expect(isAllCreatorMilestonesStale(clock + FRESH_FOR_MS)).toBe(true)

    clock += FRESH_FOR_MS - 1
    await loadAllCreatorMilestones(() => clock)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it("stale data is revalidated on the next need with ONE request, which every concurrent caller shares, and the new dates replace the old", async () => {
    let clock = 5_000_000
    requestMock.mockResolvedValueOnce(BODY)
    await loadAllCreatorMilestones(() => clock)

    clock += FRESH_FOR_MS
    requestMock.mockResolvedValueOnce(NEWER)
    const [a, b, c] = await Promise.all([loadAllCreatorMilestones(() => clock), loadAllCreatorMilestones(() => clock), loadAllCreatorMilestones(() => clock)])
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a.hoshimachi_suisei.birthday).toBe("03-23")
    expect(isAllCreatorMilestonesStale(clock)).toBe(false)
  })

  it("makes no request on its own: nothing is scheduled, so an hour passing alone changes nothing until a caller asks", async () => {
    let clock = 5_000_000
    requestMock.mockResolvedValue(BODY)
    await loadAllCreatorMilestones(() => clock)
    clock += 10 * FRESH_FOR_MS
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(getCachedAllCreatorMilestones()).not.toBeNull()
  })

  it("a failed revalidation keeps the last good data (stale or not) and waits out the cool-down before trying again", async () => {
    let clock = 5_000_000
    requestMock.mockResolvedValueOnce(BODY)
    const good = await loadAllCreatorMilestones(() => clock)

    clock += FRESH_FOR_MS
    requestMock.mockRejectedValueOnce(new Error("network down"))
    await expect(loadAllCreatorMilestones(() => clock)).resolves.toBe(good)
    expect(getCachedAllCreatorMilestones()).toBe(good)
    expect(requestMock).toHaveBeenCalledTimes(2)

    // Still stale, but inside the cool-down: served from memory, no request.
    clock += FAILURE_RETRY_MS - 1
    await expect(loadAllCreatorMilestones(() => clock)).resolves.toBe(good)
    expect(requestMock).toHaveBeenCalledTimes(2)

    // After it, one more attempt; success replaces the data.
    clock += 2
    requestMock.mockResolvedValueOnce(NEWER)
    const fresh = await loadAllCreatorMilestones(() => clock)
    expect(requestMock).toHaveBeenCalledTimes(3)
    expect(fresh.hoshimachi_suisei.birthday).toBe("03-23")
  })

  it("with nothing held, a failure still rejects (and is not mistaken for data)", async () => {
    requestMock.mockRejectedValue(new Error("503"))
    await expect(loadAllCreatorMilestones(() => 1)).rejects.toThrow("503")
    expect(getCachedAllCreatorMilestones()).toBeNull()
  })
})

describe("hasUsableMilestoneDate: the one rule for showing the calendar icon", () => {
  it.each([
    ["both dates", { birthday: "03-22", debutDate: "2018-03-22" }, true],
    ["only a birthday", { birthday: "03-22" }, true],
    ["only a debut date", { debutDate: "2018-03-22" }, true],
    ["neither date", {}, false],
    ["two unusable dates", { birthday: "02-30", debutDate: "03-22" }, false],
    ["no record at all", undefined, false],
  ])("%s -> %s", (_label, dates, expected) => {
    expect(hasUsableMilestoneDate(dates)).toBe(expected)
  })
})
