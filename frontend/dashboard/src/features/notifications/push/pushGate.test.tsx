import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PushPermissionHost } from "../components/PushPermissionHost"
import { PushPermissionNotice } from "../components/PushPermissionNotice"
import { ensurePushEnabled, resetPushGateForTests } from "./pushGate"
import { resetPushStateForTests } from "./pushState"
import { installFakePushDevice } from "../../../test/fakePushDevice"
import * as apiClient from "../../../shared/api/apiClient"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))

let fake: ReturnType<typeof installFakePushDevice> | undefined

beforeEach(() => {
  // Defense in depth: the test env loads .env.local (the REAL API base URL), so a request that ever bypassed the apiClient mock below
  // would hit production. With no base URL, apiRequest throws a ConfigError instead.
  vi.stubEnv("VITE_API_BASE_URL", "")
  resetPushGateForTests()
  resetPushStateForTests()
  window.localStorage.setItem("yobi.locale", "zh-TW")
  resetAllSharedStateForTests()
  vi.mocked(apiClient.apiRequest).mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fake?.restore()
  fake = undefined
})

function device(options: Parameters<typeof installFakePushDevice>[0]) {
  fake = installFakePushDevice(options)
  return fake
}

/** "METHOD /path" for every backend call the flow made, with the client id masked. */
function backendWrites() {
  return vi
    .mocked(apiClient.apiRequest)
    .mock.calls.map(([path, init]) => `${(init as { method?: string } | undefined)?.method ?? "GET"} ${String(path).replace(/\/clients\/[^/]+/, "/clients/:id")}`)
}

describe("ensurePushEnabled: permission is only requested after an explicit Continue", () => {
  it("default permission: shows OshiYobi's explanation first and does NOT call requestPermission until Continue", async () => {
    const push = device({ permission: "default" })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    let result: string | undefined
    act(() => {
      void ensurePushEnabled().then((value) => (result = value))
    })

    expect(await screen.findByRole("dialog", { name: "允許 OshiYobi 傳送通知" })).toBeInTheDocument()
    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(push.subscribe).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "繼續" }))

    await waitFor(() => expect(result).toBe("ready"))
    expect(push.requestPermission).toHaveBeenCalledTimes(1)
    expect(push.subscribe).toHaveBeenCalledTimes(1)
    // The existing backend contract: the subscription, then the preference (enabled) -- both under this client's own id.
    expect(backendWrites()).toEqual(expect.arrayContaining(["PUT /clients/:id/push-subscription", "PUT /clients/:id/notification-preference"]))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("default permission, user cancels the explanation: resolves cancelled; no prompt, no subscription, nothing written", async () => {
    const push = device({ permission: "default" })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    let result: string | undefined
    act(() => {
      void ensurePushEnabled().then((value) => (result = value))
    })
    await user.click(await screen.findByRole("button", { name: "取消" }))

    await waitFor(() => expect(result).toBe("cancelled"))
    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(push.subscribe).not.toHaveBeenCalled()
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
  })

  it("Escape on the explanation counts as cancel -- the browser prompt never appears", async () => {
    const push = device({ permission: "default" })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    let result: string | undefined
    act(() => {
      void ensurePushEnabled().then((value) => (result = value))
    })
    await screen.findByRole("dialog")
    await user.keyboard("{Escape}")

    await waitFor(() => expect(result).toBe("cancelled"))
    expect(push.requestPermission).not.toHaveBeenCalled()
  })

  it("default permission, the browser prompt is answered 'denied': the approved denied-permission UI appears and nothing is enabled", async () => {
    const push = device({ permission: "default", promptAnswer: "denied" })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    let result: string | undefined
    act(() => {
      void ensurePushEnabled().then((value) => (result = value))
    })
    await user.click(await screen.findByRole("button", { name: "繼續" }))

    await waitFor(() => expect(result).toBe("denied"))
    expect(await screen.findByRole("dialog", { name: "尚未開啟通知權限" })).toBeInTheDocument()
    expect(push.subscribe).not.toHaveBeenCalled()
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
  })

  it("never requests permission just because the app is open (the host alone is inert)", async () => {
    const push = device({ permission: "default" })
    render(<PushPermissionHost />)
    await Promise.resolve()

    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("ensurePushEnabled: permission already decided", () => {
  it("granted + a valid subscription: resolves ready, reuses the subscription, and shows no dialog and no prompt", async () => {
    const push = device({ permission: "granted", subscribed: true })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("ready")

    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(push.subscribe).not.toHaveBeenCalled()
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("granted but the subscription is missing: recreates it (self-healing) without a prompt or an explanation, and re-registers it with the backend", async () => {
    const push = device({ permission: "granted", subscribed: false })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("ready")

    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(push.subscribe).toHaveBeenCalledTimes(1)
    expect(backendWrites()).toEqual(expect.arrayContaining(["PUT /clients/:id/push-subscription", "PUT /clients/:id/notification-preference"]))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("denied: resolves denied WITHOUT calling requestPermission, and shows exactly the approved title and description", async () => {
    const push = device({ permission: "denied" })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("denied")

    expect(push.requestPermission).not.toHaveBeenCalled()
    expect(push.subscribe).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("dialog", { name: "尚未開啟通知權限" })
    expect(dialog).toHaveTextContent("請前往裝置設定，允許 OshiYobi 傳送通知。")
    expect(dialog).not.toHaveTextContent("通知權限已被封鎖")
    expect(screen.getByRole("button", { name: "查看設定方法" })).toBeInTheDocument()
  })

  it("denied: 查看設定方法 reveals platform instructions (no fake 'open settings' deep link), and Close dismisses", async () => {
    device({ permission: "denied" })
    const user = userEvent.setup()
    render(<PushPermissionHost />)
    await ensurePushEnabled()

    const action = await screen.findByRole("button", { name: "查看設定方法" })
    expect(action).toHaveAttribute("aria-expanded", "false")
    await user.click(action)

    expect(action).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText(/網站設定圖示/)).toBeInTheDocument() // a normal browser tab: the site-settings instructions
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "關閉" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("the denied copy follows the language too (en)", async () => {
    window.localStorage.setItem("yobi.locale", "en")
    resetAllSharedStateForTests()
    device({ permission: "denied" })
    render(<PushPermissionHost />)
    await ensurePushEnabled()

    expect(await screen.findByRole("dialog", { name: "Notification permission is off" })).toHaveTextContent(
      "Go to your device settings and allow OshiYobi to send notifications.",
    )
  })

  it("a browser without Web Push support: resolves unavailable and explains it (no permission request)", async () => {
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("unavailable")

    expect(await screen.findByRole("dialog", { name: "此裝置目前無法接收通知" })).toBeInTheDocument()
  })

  it("iOS Safari outside a Home Screen app (no push, but navigator.standalone exists): explains Add to Home Screen and warns that local data may not carry over", async () => {
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true })
    try {
      render(<PushPermissionHost />)
      await ensurePushEnabled()

      const dialog = await screen.findByRole("dialog", { name: "此裝置目前無法接收通知" })
      expect(dialog).toHaveTextContent("加入主畫面")
      expect(dialog).toHaveTextContent("本機資料可能不會自動帶入")
      expect(dialog).toHaveTextContent("My Oshi")
    } finally {
      Reflect.deleteProperty(navigator, "standalone")
    }
  })

  it("a failed backend write is undone and reported: resolves failed, the browser subscription is removed, the failure dialog shows", async () => {
    const push = device({ permission: "granted", subscribed: false })
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path, init) => {
      if (String(path).endsWith("/push-subscription") && (init as { method?: string }).method === "PUT") throw new Error("boom")
      return undefined
    })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(push.device.subscription).toBeNull() // the half-made subscription was undone
    expect(await screen.findByRole("dialog", { name: "無法開啟通知" })).toBeInTheDocument()
  })

  /** A rejected backend call, as apiClient throws it: an Error carrying the HTTP status (and a server message that must never reach the user). */
  const rejection = (status: number) => Object.assign(new Error("server said: subscription.endpoint must be an HTTPS URL from an approved Web Push service"), { name: "ApiError", status })

  it("a backend rejection of the push subscription is reported with its step and HTTP status -- and nothing sensitive (the iPhone failure)", async () => {
    // An iPhone Home Screen app subscribes against Apple's push service; the backend refused it (HTTP 400) before the allowlist knew it.
    const push = device({ permission: "granted", subscribed: false, endpoint: "https://web.push.apple.com/QGZxLjk2-private-token" })
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path, init) => {
      if (String(path).endsWith("/credential")) return { clientId: "c", clientSecret: "issued-secret" } // the credential was issued, as on the real phone
      if (String(path).endsWith("/push-subscription") && (init as { method?: string }).method === "PUT") throw rejection(400)
      return undefined
    })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    const dialog = await screen.findByRole("dialog", { name: "無法開啟通知" })
    expect(dialog).toHaveTextContent("診斷碼: register-subscription / 400")
    expect(dialog.textContent).not.toMatch(/apple|private-token|endpoint|approved Web Push|server said/i) // no endpoint, token or server message
    expect(push.device.subscription).toBeNull()
    // the half-write is cleaned up: preference off, stale subscription record removed
    expect(backendWrites()).toEqual(expect.arrayContaining(["PUT /clients/:id/notification-preference", "DELETE /clients/:id/push-subscription"]))
  })

  it("a rejected preference save is reported as save-preference with its status", async () => {
    device({ permission: "granted", subscribed: false })
    let preferenceWrites = 0
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path, init) => {
      if (String(path).endsWith("/notification-preference") && (init as { method?: string }).method === "PUT" && preferenceWrites++ === 0) throw rejection(500)
      return undefined
    })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    expect(await screen.findByRole("dialog", { name: "無法開啟通知" })).toHaveTextContent("診斷碼: save-preference / 500")
  })

  it("a failure on the browser side (the subscription could not be created) is reported as subscribe, with no HTTP status and no backend write", async () => {
    const push = device({ permission: "granted", subscribed: false })
    push.subscribe.mockRejectedValueOnce(new Error("AbortError: Registration failed - push service error"))
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("failed")

    const dialog = await screen.findByRole("dialog", { name: "無法開啟通知" })
    expect(dialog).toHaveTextContent("診斷碼: subscribe")
    expect(dialog.textContent).not.toMatch(/\/ \d{3}/)
    expect(dialog.textContent).not.toMatch(/AbortError|push service error/)
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
  })

  it("an iOS-style subscription (web.push.apple.com) is sent to the backend exactly as the browser made it", async () => {
    device({ permission: "granted", subscribed: false, endpoint: "https://web.push.apple.com/QGZxLjk2" })
    render(<PushPermissionHost />)

    await expect(ensurePushEnabled()).resolves.toBe("ready")

    const put = vi.mocked(apiClient.apiRequest).mock.calls.find(([path, init]) => String(path).endsWith("/push-subscription") && (init as { method?: string }).method === "PUT")
    expect(put).toBeDefined()
    expect((put![1] as { body: { endpoint: string } }).body.endpoint).toBe("https://web.push.apple.com/QGZxLjk2")
  })

  it("the diagnostic follows the language (en)", async () => {
    window.localStorage.setItem("yobi.locale", "en")
    resetAllSharedStateForTests()
    device({ permission: "granted", subscribed: false })
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path, init) => {
      if (String(path).endsWith("/push-subscription") && (init as { method?: string }).method === "PUT") throw rejection(400)
      return undefined
    })
    render(<PushPermissionHost />)
    await ensurePushEnabled()

    expect(await screen.findByRole("dialog", { name: "Couldn't turn on notifications" })).toHaveTextContent("Diagnostic code: register-subscription / 400")
  })

  it("concurrent calls share one attempt: a single explanation, a single prompt", async () => {
    const push = device({ permission: "default" })
    const user = userEvent.setup()
    render(<PushPermissionHost />)

    let first: string | undefined
    let second: string | undefined
    act(() => {
      void ensurePushEnabled().then((value) => (first = value))
      void ensurePushEnabled().then((value) => (second = value))
    })
    await user.click(await screen.findByRole("button", { name: "繼續" }))

    await waitFor(() => expect([first, second]).toEqual(["ready", "ready"]))
    expect(push.requestPermission).toHaveBeenCalledTimes(1)
  })
})

describe("permission is re-checked when the user comes back to the app (no reload)", () => {
  const comeBack = {
    "window focus": () => window.dispatchEvent(new Event("focus")),
    visibilitychange: () => document.dispatchEvent(new Event("visibilitychange")),
  }

  it.each(Object.keys(comeBack))("the denied notice in Notification Settings disappears after allowing notifications in device settings and returning (%s)", async (name) => {
    const push = device({ permission: "denied" })
    render(<PushPermissionNotice />)

    expect(await screen.findByText("尚未開啟通知權限")).toBeInTheDocument()
    expect(screen.getByText("請前往裝置設定，允許 OshiYobi 傳送通知。")).toBeInTheDocument()

    push.device.permission = "granted" // changed in the device settings while the app was in the background
    act(() => comeBack[name as keyof typeof comeBack]())

    await waitFor(() => expect(screen.queryByText("尚未開啟通知權限")).not.toBeInTheDocument())
  })

  it.each(Object.keys(comeBack))("an open denied-permission dialog closes by itself once permission is allowed and the user returns (%s)", async (name) => {
    const push = device({ permission: "denied" })
    render(<PushPermissionHost />)
    await ensurePushEnabled()
    expect(await screen.findByRole("dialog", { name: "尚未開啟通知權限" })).toBeInTheDocument()

    push.device.permission = "granted"
    act(() => comeBack[name as keyof typeof comeBack]())

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("the notice appears when permission turns denied while the app was in the background (never claims enabled)", async () => {
    const push = device({ permission: "granted", subscribed: true })
    render(<PushPermissionNotice />)
    await Promise.resolve()
    expect(screen.queryByText("尚未開啟通知權限")).not.toBeInTheDocument()

    push.device.permission = "denied"
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })

    expect(await screen.findByText("尚未開啟通知權限")).toBeInTheDocument()
  })

  it("the notice's 查看設定方法 button opens the denied help, and requests no permission", async () => {
    const push = device({ permission: "denied" })
    const user = userEvent.setup()
    render(
      <>
        <PushPermissionNotice />
        <PushPermissionHost />
      </>,
    )

    await user.click(await screen.findByRole("button", { name: "查看設定方法" }))

    expect(await screen.findByRole("dialog", { name: "尚未開啟通知權限" })).toBeInTheDocument()
    expect(push.requestPermission).not.toHaveBeenCalled()
  })
})
