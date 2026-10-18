import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../../../shared/api/apiClient"
import { clearCreatorMilestonesCache, fetchCreatorMilestones, getCachedCreatorMilestones, loadCreatorMilestones } from "./creatorMilestones"

vi.mock("../../../shared/api/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../../../shared/api/apiClient")>("../../../shared/api/apiClient")
  return { ...actual, apiRequest: vi.fn() }
})
import { apiRequest } from "../../../shared/api/apiClient"

const requestMock = vi.mocked(apiRequest)
const SUISEI = { creatorId: "hoshimachi_suisei", birthday: "03-22", debutDate: "2018-03-22" }

beforeEach(() => {
  requestMock.mockReset()
  clearCreatorMilestonesCache()
})

describe("fetchCreatorMilestones", () => {
  it("requests exactly one creator milestones path and returns the three stored fields", async () => {
    requestMock.mockResolvedValue(SUISEI)
    await expect(fetchCreatorMilestones("hoshimachi_suisei")).resolves.toEqual({ kind: "found", milestones: SUISEI })
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledWith("/creators/hoshimachi_suisei/milestones")
  })

  it("keeps the ORIGINAL debut year of a graduated creator", async () => {
    requestMock.mockResolvedValue({ creatorId: "mano_aloe", birthday: "10-28", debutDate: "2020-08-15" })
    const result = await fetchCreatorMilestones("mano_aloe")
    expect(result).toMatchObject({ kind: "found", milestones: { debutDate: "2020-08-15" } })
  })

  it("a 404 is not_found, not an error", async () => {
    requestMock.mockRejectedValue(new ApiError(404, "No milestones are recorded"))
    await expect(fetchCreatorMilestones("vspo_official")).resolves.toEqual({ kind: "not_found" })
  })

  it("a server failure is rethrown", async () => {
    requestMock.mockRejectedValue(new ApiError(503, "unavailable", "MILESTONES_UNAVAILABLE"))
    await expect(fetchCreatorMilestones("hoshimachi_suisei")).rejects.toBeInstanceOf(ApiError)
  })

  it.each([
    ["another creator's record", { ...SUISEI, creatorId: "someone_else" }],
    ["an impossible birthday", { ...SUISEI, birthday: "02-30" }],
    ["a debut date without a year", { ...SUISEI, debutDate: "03-22" }],
    ["a missing date", { creatorId: "hoshimachi_suisei", birthday: "03-22" }],
  ])("rejects %s instead of showing it", async (_label, body) => {
    requestMock.mockResolvedValue(body)
    await expect(fetchCreatorMilestones("hoshimachi_suisei")).rejects.toThrow()
  })
})

describe("loadCreatorMilestones: one read per creator", () => {
  it("shares one request between concurrent callers and serves later calls from memory", async () => {
    requestMock.mockResolvedValue(SUISEI)
    const [first, second] = await Promise.all([loadCreatorMilestones("hoshimachi_suisei"), loadCreatorMilestones("hoshimachi_suisei")])
    await loadCreatorMilestones("hoshimachi_suisei")
    expect(first).toBe(second)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(getCachedCreatorMilestones("hoshimachi_suisei")).toEqual({ kind: "found", milestones: SUISEI })
  })

  it("keeps creators apart", async () => {
    requestMock.mockImplementation(async (path) => (String(path).includes("suisei") ? SUISEI : { creatorId: "mano_aloe", birthday: "10-28", debutDate: "2020-08-15" }))
    await loadCreatorMilestones("hoshimachi_suisei")
    await loadCreatorMilestones("mano_aloe")
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(getCachedCreatorMilestones("mano_aloe")).toMatchObject({ milestones: { creatorId: "mano_aloe" } })
  })

  it("caches a not_found answer too, but never a failure (the next open retries)", async () => {
    requestMock.mockRejectedValueOnce(new ApiError(404, "none"))
    await loadCreatorMilestones("vspo_official")
    await loadCreatorMilestones("vspo_official")
    expect(requestMock).toHaveBeenCalledTimes(1)

    requestMock.mockRejectedValueOnce(new Error("network"))
    await expect(loadCreatorMilestones("hoshimachi_suisei")).rejects.toThrow("network")
    expect(getCachedCreatorMilestones("hoshimachi_suisei")).toBeUndefined()
    requestMock.mockResolvedValueOnce(SUISEI)
    await expect(loadCreatorMilestones("hoshimachi_suisei")).resolves.toMatchObject({ kind: "found" })
  })
})