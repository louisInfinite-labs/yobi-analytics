import { beforeEach, describe, expect, it, vi } from "vitest"
import * as apiClient from "../../../shared/api/apiClient"
import {
  deleteCreatorReminder,
  fetchReminderSettings,
  reminderValueToSetting,
  saveCreatorReminder,
  saveStreamNotificationOverride,
  settingToReminderValue,
} from "./liveReminderApi"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))
vi.mock("../../../shared/api/clientCredential", () => ({ getOrCreateClientSecret: vi.fn().mockResolvedValue("secret-1") }))
vi.mock("../../../shared/api/clientId", () => ({ getOrCreateClientId: () => "client 1" }))

const item = (key: string, value: unknown) => ({ clientId: "client 1", key, value, updatedAt: "2026-01-01T00:00:00+00:00" })
const setting = (advanceReminder: string | null) => ({ notifyAtStart: true, advanceReminder })

beforeEach(() => {
  vi.mocked(apiClient.apiRequest).mockReset()
  vi.mocked(apiClient.apiRequest).mockResolvedValue(undefined)
})

describe("reminder value <-> setting", () => {
  it("encodes at_start as no advance reminder and every other value as that advance reminder", () => {
    expect(reminderValueToSetting("at_start")).toEqual({ notifyAtStart: true, advanceReminder: null })
    expect(reminderValueToSetting("30min")).toEqual({ notifyAtStart: true, advanceReminder: "30min" })
  })

  it("decodes a missing setting as unset (null), distinct from at_start", () => {
    expect(settingToReminderValue(null)).toBeNull()
    expect(settingToReminderValue(undefined)).toBeNull()
    expect(settingToReminderValue({ notifyAtStart: true, advanceReminder: null })).toBe("at_start")
    expect(settingToReminderValue({ notifyAtStart: true, advanceReminder: "1hour" })).toBe("1hour")
  })
})

describe("saveCreatorReminder / deleteCreatorReminder", () => {
  it("PUTs one reminder to its own creator + scope path, with the client secret", async () => {
    await saveCreatorReminder("aizawa_ema", "sf6", reminderValueToSetting("10min"))

    expect(apiClient.apiRequest).toHaveBeenCalledWith("/clients/client%201/creator-reminder/aizawa_ema/sf6", {
      method: "PUT",
      headers: { "X-Client-Secret": "secret-1" },
      body: { notifyAtStart: true, advanceReminder: "10min" },
    })
  })

  it("uses the scope `all` for the creator-level 全部 reminder", async () => {
    await saveCreatorReminder("aizawa_ema", "all", reminderValueToSetting("30min"))

    expect(vi.mocked(apiClient.apiRequest).mock.calls[0][0]).toBe("/clients/client%201/creator-reminder/aizawa_ema/all")
  })

  it("DELETEs only that one reminder", async () => {
    await deleteCreatorReminder("aizawa_ema", "sf6")

    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
    expect(apiClient.apiRequest).toHaveBeenCalledWith("/clients/client%201/creator-reminder/aizawa_ema/sf6", {
      method: "DELETE",
      headers: { "X-Client-Secret": "secret-1" },
    })
  })
})

describe("saveStreamNotificationOverride", () => {
  it("PUTs one stream's override to its own path, carrying no scheduledStartMs", async () => {
    await saveStreamNotificationOverride("v1", { creatorId: "aizawa_ema", ...reminderValueToSetting("1hour") })

    expect(apiClient.apiRequest).toHaveBeenCalledWith("/clients/client%201/stream-notification-override/v1", {
      method: "PUT",
      headers: { "X-Client-Secret": "secret-1" },
      body: { creatorId: "aizawa_ema", notifyAtStart: true, advanceReminder: "1hour" },
    })
  })
})

describe("fetchReminderSettings", () => {
  it("reads every stored item once and sorts them into 全部, creator + topic and stream override levels", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({
      configs: [
        item("creatorReminder#aizawa_ema#all", setting("30min")),
        item("creatorReminder#aizawa_ema#sf6", setting("10min")),
        item("creatorReminder#aizawa_ema#singing", setting(null)),
        item("creatorReminder#kaga_sumire#sf6", setting("1hour")),
        item("streamOverride#v1", { creatorId: "aizawa_ema", ...setting("1min") }),
        item("notificationPreference", { enabled: true }),
      ],
    })

    const settings = await fetchReminderSettings()

    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
    expect(apiClient.apiRequest).toHaveBeenCalledWith("/remote-config?clientId=client%201", { headers: { "X-Client-Secret": "secret-1" } })
    expect(settings.creatorAll).toEqual({ aizawa_ema: setting("30min") })
    expect(settings.creatorTopics).toEqual({
      aizawa_ema: { sf6: setting("10min"), singing: setting(null) },
      kaga_sumire: { sf6: setting("1hour") },
    })
    expect(settings.streamOverrides).toEqual({ v1: { creatorId: "aizawa_ema", ...setting("1min") } })
  })

  it("returns empty settings when nothing is stored", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ configs: [] })

    expect(await fetchReminderSettings()).toEqual({ creatorAll: {}, creatorTopics: {}, streamOverrides: {} })
  })

  it("skips a stored item that doesn't parse, without affecting the others", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({
      configs: [
        item("creatorReminder#aizawa_ema#all", { notifyAtStart: "yes" }),
        item("creatorReminder#aizawa_ema#sf6", { notifyAtStart: true, advanceReminder: "2hours" }),
        item("creatorReminder#aizawa_ema", setting("10min")),
        item("creatorReminder#a#b#c", setting("10min")),
        item("streamOverride#v1", setting("1min")),
        item("creatorReminder#aizawa_ema#apex", setting("30min")),
      ],
    })

    const settings = await fetchReminderSettings()

    expect(settings.creatorAll).toEqual({})
    expect(settings.creatorTopics).toEqual({ aizawa_ema: { apex: setting("30min") } })
    expect(settings.streamOverrides).toEqual({})
  })
})
