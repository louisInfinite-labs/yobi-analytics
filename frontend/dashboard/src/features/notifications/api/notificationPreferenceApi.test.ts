import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildNotificationPreference, putNotificationPreference, saveNotificationPreference } from "./notificationPreferenceApi"
import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getAllNotificationCreators } from "../model/notificationCreatorGrouping"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))
vi.mock("../../../shared/api/clientCredential", () => ({ getOrCreateClientSecret: vi.fn() }))

beforeEach(() => {
  vi.mocked(apiRequest).mockReset().mockResolvedValue(undefined)
  vi.mocked(getOrCreateClientSecret).mockReset().mockResolvedValue("secret-1")
})

describe("buildNotificationPreference", () => {
  it("is the full default preference plus an explicit new-video switch for every Settings creator", () => {
    const roster = getAllNotificationCreators()
    const body = buildNotificationPreference(true, new Set([roster[0].creatorId]), new Set())

    expect(Object.keys(body).sort()).toEqual(["deliveryWindows", "enabled", "newVideoCreatorOverride", "newVideoShortCreatorOverride", "notificationLevel", "notificationTimeZone"])
    expect(body.enabled).toBe(true)
    expect(body.deliveryWindows).toEqual(["08:00", "18:00"])
    expect(Object.keys(body.newVideoCreatorOverride).sort()).toEqual(roster.map((creator) => creator.creatorId).sort())
    expect(body.newVideoCreatorOverride[roster[0].creatorId]).toBe(true)
    expect(roster.slice(1).every((creator) => body.newVideoCreatorOverride[creator.creatorId] === false)).toBe(true)
  })

  it("carries the Short card members as their own field: every creator an explicit false by default, true only for the members, never a topic", () => {
    const roster = getAllNotificationCreators()
    const none = buildNotificationPreference(true, new Set(), new Set())
    expect(Object.keys(none.newVideoShortCreatorOverride).sort()).toEqual(roster.map((creator) => creator.creatorId).sort())
    expect(Object.values(none.newVideoShortCreatorOverride).every((value) => value === false)).toBe(true)

    const members = buildNotificationPreference(true, new Set(), new Set([roster[0].creatorId, roster[2].creatorId]))
    expect(Object.entries(members.newVideoShortCreatorOverride).filter(([, on]) => on).map(([id]) => id).sort()).toEqual(
      [roster[0].creatorId, roster[2].creatorId].sort(),
    )
    expect(Object.keys(members)).not.toContain("newVideoTopicOverride")
    expect(Object.keys(members.newVideoCreatorOverride)).not.toContain("short")
  })

  it("uses the browser's own IANA time zone", () => {
    expect(buildNotificationPreference(false, new Set(), new Set()).notificationTimeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it("with no creator enabled every switch is an explicit false (not omitted, which would mean 'allowed')", () => {
    const { newVideoCreatorOverride } = buildNotificationPreference(true, new Set(), new Set())

    expect(Object.values(newVideoCreatorOverride).every((value) => value === false)).toBe(true)
  })
})

describe("putNotificationPreference", () => {
  it("PUTs the body to the client's notification-preference route with the client secret", async () => {
    await putNotificationPreference("client 1", "secret-9", false, new Set(["aizawa_ema"]), new Set())

    const [path, options] = vi.mocked(apiRequest).mock.calls[0] as [string, { method: string; headers?: Record<string, string>; body: { enabled: boolean } }]
    expect(path).toBe("/clients/client%201/notification-preference")
    expect(options.method).toBe("PUT")
    expect(options.headers).toEqual({ "X-Client-Secret": "secret-9" })
    expect(options.body.enabled).toBe(false)
  })

  it("sends no secret header when registration produced none (the backend then rejects it)", async () => {
    await putNotificationPreference("c1", null, true, new Set(), new Set())

    expect((vi.mocked(apiRequest).mock.calls[0][1] as { headers?: unknown }).headers).toBeUndefined()
  })
})

describe("saveNotificationPreference", () => {
  it("obtains this browser's credential and writes the preference", async () => {
    await saveNotificationPreference(true, new Set(["aizawa_ema"]), new Set(["shirakami_fubuki"]))

    expect(getOrCreateClientSecret).toHaveBeenCalledTimes(1)
    const [path, options] = vi.mocked(apiRequest).mock.calls[0] as [string, { headers: Record<string, string>; body: { newVideoCreatorOverride: Record<string, boolean>; newVideoShortCreatorOverride: Record<string, boolean> } }]
    expect(path).toMatch(/^\/clients\/.+\/notification-preference$/)
    expect(options.headers).toEqual({ "X-Client-Secret": "secret-1" })
    expect(options.body.newVideoCreatorOverride.aizawa_ema).toBe(true)
    expect(options.body.newVideoShortCreatorOverride.shirakami_fubuki).toBe(true)
    expect(options.body.newVideoShortCreatorOverride.aizawa_ema).toBe(false)
  })

  it("rejects when the backend rejects, so callers never treat the change as saved", async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("HTTP 500"))

    await expect(saveNotificationPreference(true, new Set(), new Set())).rejects.toThrow("HTTP 500")
  })
})
