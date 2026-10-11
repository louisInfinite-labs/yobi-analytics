import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useNotificationLocaleSync } from "./useNotificationLocaleSync"
import { NotificationToggle } from "../components/NotificationToggle"
import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { getSyncedNotificationLocale, isNotificationDisabledByUser, putNotificationPreference } from "../api/notificationPreferenceApi"
import { getPushSubscriptionStatus, subscribeToPush } from "../push/pushNotifications"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))
vi.mock("../../../shared/api/clientCredential", () => ({ getOrCreateClientSecret: vi.fn() }))
vi.mock("../push/pushNotifications", () => ({
  getPushSubscriptionStatus: vi.fn(),
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}))

type PreferenceBody = { enabled: boolean; notificationLocale: string }

function preferenceWrites(): PreferenceBody[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([path]) => String(path).endsWith("/notification-preference"))
    .map(([, options]) => (options as { body: PreferenceBody }).body)
}

/** The app root's language sync plus a handle to change the dashboard language the way the user does. */
function mountLocaleSync() {
  return renderHook(() => {
    useNotificationLocaleSync()
    return useLocale()
  })
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  vi.mocked(apiRequest).mockReset().mockResolvedValue(undefined)
  vi.mocked(getOrCreateClientSecret).mockReset().mockResolvedValue("secret-1")
  vi.mocked(getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
  vi.mocked(subscribeToPush).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("global OFF is the master switch for the notification-language sync", () => {
  it("still holds for the rest of the page session when storage rejects the marker write after a confirmed disable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })
    await putNotificationPreference("c1", "secret-1", false, new Set(), new Set())
    expect(isNotificationDisabledByUser()).toBe(true)
    const { result } = mountLocaleSync()

    act(() => result.current[1]("zh-TW"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(preferenceWrites().filter((body) => body.enabled)).toHaveLength(0)
    vi.restoreAllMocks()
    await putNotificationPreference("c1", "secret-1", true, new Set(), new Set()) // a confirmed enable clears the in-session state
    expect(isNotificationDisabledByUser()).toBe(false)
  })

  it("never writes notifications back ON when the disable succeeded but the browser subscription survived", async () => {
    // The toggle's disable path: the backend write (enabled:false) succeeds first, then unsubscribeFromPush() throws, so the
    // PushSubscription remains and getPushSubscriptionStatus() keeps saying "subscribed".
    await putNotificationPreference("c1", "secret-1", false, new Set(), new Set())
    expect(isNotificationDisabledByUser()).toBe(true)
    const { result } = mountLocaleSync()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    act(() => result.current[1]("zh-TW"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(preferenceWrites()).toHaveLength(1) // only the disable itself
    expect(preferenceWrites().some((body) => body.enabled)).toBe(false)
    expect(getSyncedNotificationLocale()).toBe("en") // the new language is not confirmed by a write that never happened
  })

  it("also keeps a still-subscribed browser OFF across an app restart", async () => {
    await putNotificationPreference("c1", "secret-1", false, new Set(), new Set())
    window.localStorage.setItem("yobi.locale", "ja")
    resetAllSharedStateForTests()

    mountLocaleSync()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(preferenceWrites().filter((body) => body.enabled)).toHaveLength(0)
  })

  it("a failed disable write does not mark notifications disabled, so the language sync keeps working", async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("backend down"))
    await expect(putNotificationPreference("c1", "secret-1", false, new Set(), new Set())).rejects.toThrow("backend down")
    expect(isNotificationDisabledByUser()).toBe(false)
    const { result } = mountLocaleSync()
    await waitFor(() => expect(getSyncedNotificationLocale()).toBe("en"))

    act(() => result.current[1]("zh-TW"))

    await waitFor(() => expect(getSyncedNotificationLocale()).toBe("zh-TW"))
    expect(preferenceWrites().at(-1)).toMatchObject({ enabled: true, notificationLocale: "zh-TW" })
  })

  it("a normal enabled subscriber still gets the new language sent (and nothing is marked disabled)", async () => {
    await putNotificationPreference("c1", "secret-1", true, new Set(), new Set())
    const { result } = mountLocaleSync()

    act(() => result.current[1]("ja"))

    await waitFor(() => expect(getSyncedNotificationLocale()).toBe("ja"))
    expect(isNotificationDisabledByUser()).toBe(false)
    expect(preferenceWrites().at(-1)).toMatchObject({ enabled: true, notificationLocale: "ja" })
  })

  it("an explicit successful Enable Notifications clears the disabled state and restores the language sync", async () => {
    await putNotificationPreference("c1", "secret-1", false, new Set(), new Set())
    vi.mocked(getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    vi.mocked(subscribeToPush).mockResolvedValue({ endpoint: "https://push.example/1", keys: { p256dh: "k", auth: "a" } })
    render(<NotificationToggle />)

    await userEvent.click(await screen.findByRole("button", { name: /enable notifications/i }))

    await waitFor(() => expect(screen.getByRole("button", { name: /notifications on/i })).toBeInTheDocument())
    expect(isNotificationDisabledByUser()).toBe(false)
    vi.mocked(getPushSubscriptionStatus).mockResolvedValue("subscribed")
    const { result } = mountLocaleSync()
    act(() => result.current[1]("zh-TW"))
    await waitFor(() => expect(getSyncedNotificationLocale()).toBe("zh-TW"))
  })

  it("a failed language write stays retry-safe: the locale stays unconfirmed and the next start retries", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error("backend down"))
    window.localStorage.setItem("yobi.locale", "ja")
    resetAllSharedStateForTests()
    mountLocaleSync()
    await waitFor(() => expect(preferenceWrites()).toHaveLength(1))
    expect(getSyncedNotificationLocale()).toBeNull()
    expect(isNotificationDisabledByUser()).toBe(false)

    vi.mocked(apiRequest).mockResolvedValue(undefined)
    mountLocaleSync() // next app start

    await waitFor(() => expect(getSyncedNotificationLocale()).toBe("ja"))
  })
})
