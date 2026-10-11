import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useNotificationLocaleSync } from "./useNotificationLocaleSync"
import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getSyncedNotificationLocale } from "../api/notificationPreferenceApi"
import { getPushSubscriptionStatus } from "../push/pushNotifications"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))
vi.mock("../../../shared/api/clientCredential", () => ({ getOrCreateClientSecret: vi.fn() }))
vi.mock("../push/pushNotifications", () => ({ getPushSubscriptionStatus: vi.fn() }))

function setDashboardLocale(locale: string) {
  window.localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
}

function preferenceWrites() {
  return vi.mocked(apiRequest).mock.calls.filter(([path]) => String(path).endsWith("/notification-preference"))
}

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  vi.mocked(apiRequest).mockReset().mockResolvedValue(undefined)
  vi.mocked(getOrCreateClientSecret).mockReset().mockResolvedValue("secret-1")
  vi.mocked(getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

describe("useNotificationLocaleSync", () => {
  it("re-sends the preference with the dashboard language when notifications are on and the backend has not confirmed it", async () => {
    setDashboardLocale("zh-TW")

    renderHook(() => useNotificationLocaleSync())

    await waitFor(() => expect(preferenceWrites()).toHaveLength(1))
    const body = (preferenceWrites()[0][1] as { body: { notificationLocale: string; enabled: boolean } }).body
    expect(body.notificationLocale).toBe("zh-TW")
    expect(body.enabled).toBe(true)
    await waitFor(() => expect(getSyncedNotificationLocale()).toBe("zh-TW"))
  })

  it("does nothing when the backend already has this locale", async () => {
    setDashboardLocale("ja")
    window.localStorage.setItem("yobi.notificationLocaleSynced", "ja")

    renderHook(() => useNotificationLocaleSync())

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(preferenceWrites()).toHaveLength(0)
  })

  it("writes nothing when this browser has no push subscription (the enable flow sends the locale with the master switch)", async () => {
    setDashboardLocale("ja")
    vi.mocked(getPushSubscriptionStatus).mockResolvedValue("unsubscribed")

    renderHook(() => useNotificationLocaleSync())

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(preferenceWrites()).toHaveLength(0)
    expect(getSyncedNotificationLocale()).toBeNull()
  })

  it("a failed write is silent and leaves the locale unconfirmed so the next start retries", async () => {
    setDashboardLocale("en")
    vi.mocked(apiRequest).mockRejectedValue(new Error("backend down"))

    renderHook(() => useNotificationLocaleSync())

    await waitFor(() => expect(preferenceWrites()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getSyncedNotificationLocale()).toBeNull()
  })
})
