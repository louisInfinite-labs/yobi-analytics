import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useNotificationLocaleSync } from "./useNotificationLocaleSync"
import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getBrowserTimeZone, getSyncedNotificationLocale, getSyncedNotificationTimeZone } from "../api/notificationPreferenceApi"
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

/** Makes the browser report `zone` as its IANA time zone (what Intl.DateTimeFormat().resolvedOptions().timeZone returns). */
function setBrowserTimeZone(zone: string) {
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => ({ resolvedOptions: () => ({ timeZone: zone }) }) as Intl.DateTimeFormat)
}

type WrittenPreference = { notificationTimeZone: string; deliveryWindows: string[]; enabled: boolean }
const lastWrite = () => (preferenceWrites().at(-1)![1] as { body: WrittenPreference }).body

afterEach(() => {
  vi.restoreAllMocks()
})

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
    window.localStorage.setItem("yobi.notificationTimeZoneSynced", getBrowserTimeZone())

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

describe("useNotificationLocaleSync: the browser's IANA time zone", () => {
  beforeEach(() => {
    window.localStorage.setItem("yobi.notificationLocaleSynced", "en") // the language is already in sync: only the zone is under test
  })

  it("re-sends the preference when the browser now reports a different zone, keeping the user's LOCAL times exactly as chosen", async () => {
    window.localStorage.setItem("yobi.notificationTimeZoneSynced", "Asia/Hong_Kong")
    window.localStorage.setItem("yobi.notificationDeliverySlots", JSON.stringify(["08:00", "18:00"]))
    resetAllSharedStateForTests()
    setBrowserTimeZone("Europe/London")

    renderHook(() => useNotificationLocaleSync())

    await waitFor(() => expect(preferenceWrites()).toHaveLength(1))
    expect(lastWrite().notificationTimeZone).toBe("Europe/London")
    expect(lastWrite().deliveryWindows).toEqual(["08:00", "18:00"]) // 08:00 still means 08:00 -- now London's
    await waitFor(() => expect(getSyncedNotificationTimeZone()).toBe("Europe/London"))
  })

  it("does nothing while the zone is unchanged", async () => {
    window.localStorage.setItem("yobi.notificationTimeZoneSynced", "Asia/Hong_Kong")
    setBrowserTimeZone("Asia/Hong_Kong")

    renderHook(() => useNotificationLocaleSync())

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(preferenceWrites()).toHaveLength(0)
  })

  it("an existing browser that never confirmed a zone sends it once with the next preference sync", async () => {
    setBrowserTimeZone("Asia/Tokyo")

    renderHook(() => useNotificationLocaleSync())

    await waitFor(() => expect(preferenceWrites()).toHaveLength(1))
    expect(lastWrite().notificationTimeZone).toBe("Asia/Tokyo")
    await waitFor(() => expect(getSyncedNotificationTimeZone()).toBe("Asia/Tokyo"))
  })

  it("a device that crosses zones while the app stays open is corrected when the app becomes visible again", async () => {
    window.localStorage.setItem("yobi.notificationTimeZoneSynced", "Asia/Hong_Kong")
    setBrowserTimeZone("Asia/Hong_Kong")
    renderHook(() => useNotificationLocaleSync())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(preferenceWrites()).toHaveLength(0)

    setBrowserTimeZone("America/New_York") // the traveller lands
    document.dispatchEvent(new Event("visibilitychange"))

    await waitFor(() => expect(preferenceWrites()).toHaveLength(1))
    expect(lastWrite().notificationTimeZone).toBe("America/New_York")
  })

  it("writes nothing for a browser with no push subscription (the enable flow sends the zone with the master switch)", async () => {
    window.localStorage.setItem("yobi.notificationTimeZoneSynced", "Asia/Hong_Kong")
    vi.mocked(getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    setBrowserTimeZone("Europe/London")

    renderHook(() => useNotificationLocaleSync())

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(preferenceWrites()).toHaveLength(0)
    expect(getSyncedNotificationTimeZone()).toBe("Asia/Hong_Kong")
  })

  it("never asks for geolocation: the zone comes from Intl only", () => {
    const geolocation = vi.fn()
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: geolocation, watchPosition: geolocation }, configurable: true })
    setBrowserTimeZone("Asia/Tokyo")

    renderHook(() => useNotificationLocaleSync())

    expect(geolocation).not.toHaveBeenCalled()
  })
})
