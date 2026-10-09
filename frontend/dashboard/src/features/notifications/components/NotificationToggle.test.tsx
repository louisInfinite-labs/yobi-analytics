import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationToggle } from "./NotificationToggle"
import * as apiClient from "../../../shared/api/apiClient"
import * as pushNotifications from "../push/pushNotifications"

vi.mock("../push/pushNotifications", () => ({
  getPushSubscriptionStatus: vi.fn(),
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}))

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))

describe("NotificationToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(apiClient.apiRequest).mockResolvedValue(undefined)
  })

  it("renders an unsupported message and never calls subscribe when push isn't supported", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsupported")

    render(<NotificationToggle />)

    expect(await screen.findByText("Notifications unavailable")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("shows the 'enable' state when no subscription exists yet", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")

    render(<NotificationToggle />)

    const button = await screen.findByRole("button", { name: /enable notifications/i })
    expect(button).toHaveAttribute("aria-pressed", "false")
  })

  it("shows the 'on' state when a subscription already exists", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")

    render(<NotificationToggle />)

    const button = await screen.findByRole("button", { name: /notifications on/i })
    expect(button).toHaveAttribute("aria-pressed", "true")
  })

  it("subscribes and flips to the 'on' state when clicked while unsubscribed", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue({
      endpoint: "https://fcm.example.com/x",
      keys: { p256dh: "p", auth: "a" },
    })

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("button", { name: /notifications on/i })).toBeInTheDocument())
    expect(pushNotifications.subscribeToPush).toHaveBeenCalledWith(expect.any(String))
  })

  it("stays in the 'enable' state when the user denies the permission prompt", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue(null)

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(pushNotifications.subscribeToPush).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument()
  })

  it("unsubscribes and flips to the 'enable' state when clicked while subscribed", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
    vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /notifications on/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument())
    expect(pushNotifications.unsubscribeFromPush).toHaveBeenCalled()
  })

  it("persists the subscription and an enabled preference to the backend when subscribing", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    const subscription = { endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } }
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue(subscription)

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("button", { name: /notifications on/i })).toBeInTheDocument())
    await waitFor(() =>
      expect(apiClient.apiRequest).toHaveBeenCalledWith(
        expect.stringMatching(/\/push-subscription$/),
        expect.objectContaining({ method: "PUT", body: subscription }),
      ),
    )
    expect(apiClient.apiRequest).toHaveBeenCalledWith(
      expect.stringMatching(/\/notification-preference$/),
      expect.objectContaining({ method: "PUT", body: expect.objectContaining({ enabled: true }) }),
    )
  })

  it("retracts the subscription and disables the preference on the backend when unsubscribing", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
    vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /notifications on/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument())
    await waitFor(() =>
      expect(apiClient.apiRequest).toHaveBeenCalledWith(
        expect.stringMatching(/\/push-subscription$/),
        expect.objectContaining({ method: "DELETE" }),
      ),
    )
    expect(apiClient.apiRequest).toHaveBeenCalledWith(
      expect.stringMatching(/\/notification-preference$/),
      expect.objectContaining({ method: "PUT", body: expect.objectContaining({ enabled: false }) }),
    )
  })

  it("writes the master switch as enabled: false in the full default preference payload", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
    vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)

    render(<NotificationToggle />)
    await user.click(await screen.findByRole("button", { name: /notifications on/i }))
    await waitFor(() => expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument())

    const preferenceCall = vi.mocked(apiClient.apiRequest).mock.calls.find(([path]) => String(path).endsWith("/notification-preference"))
    const body = ((preferenceCall?.[1] as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["deliveryWindows", "enabled", "notificationLevel", "notificationTimeZone"])
    expect(body.enabled).toBe(false)
  })

  it("does not persist anything to the backend when the user denies the permission prompt", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue(null)

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(pushNotifications.subscribeToPush).toHaveBeenCalled())
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
  })

  it("rolls back the local subscription and shows an error when a backend sync fails while enabling", async () => {
    // If the toggle flipped to "on" regardless of whether the backend
    // writes actually succeeded, the dispatcher could end up with a
    // preference but no subscription (or vice versa) while the UI claims
    // everything is fine — this is the coordination CodeRabbit flagged.
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    const subscription = { endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } }
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue(subscription)
    vi.mocked(apiClient.apiRequest).mockRejectedValue(new Error("network error"))

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))
    expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument()
    expect(pushNotifications.unsubscribeFromPush).toHaveBeenCalled()
  })

  it("shows an error and rolls back when the subscription write succeeds but the preference write fails", async () => {
    // A partial write, not a total failure — the subscription PUT
    // succeeds and only the notification-preference PUT rejects. Confirms
    // the rollback path triggers from *either* awaited write failing, not
    // just from every request failing together.
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    const subscription = { endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } }
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue(subscription)
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown) => {
      const p = String(path)
      if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
      if (p.endsWith("/push-subscription")) return undefined
      if (p.endsWith("/notification-preference")) throw new Error("network error")
      return undefined
    })

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))
    expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument()
    expect(pushNotifications.unsubscribeFromPush).toHaveBeenCalled()
  })

  it("best-effort reconciles the backend after an enable failure, in case a write actually committed", async () => {
    // The subscription PUT and preference PUT can each commit server-side
    // even though this call's own promise rejects (e.g. its response was
    // lost after the server already processed it) — the enable failure
    // path must try to clean up any such orphaned state with the same
    // secret, not just roll back the local browser subscription.
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    const subscription = { endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } }
    vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue(subscription)
    const calls: Array<{ path: string; method: string | undefined }> = []
    vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown, options?: { method?: string }) => {
      const p = String(path)
      calls.push({ path: p, method: options?.method })
      if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
      if (p.endsWith("/push-subscription") && options?.method === "PUT") return undefined
      if (p.endsWith("/notification-preference") && calls.filter((c) => c.path === p).length === 1) {
        throw new Error("network error")
      }
      return undefined
    })

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))

    const subscriptionCalls = calls.filter((c) => c.path.endsWith("/push-subscription"))
    const preferenceCalls = calls.filter((c) => c.path.endsWith("/notification-preference"))
    expect(subscriptionCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "PUT" }),
        expect.objectContaining({ method: "DELETE" }),
      ]),
    )
    expect(preferenceCalls.length).toBeGreaterThanOrEqual(2)
  })

  it("disables the button while a sync is in flight so a second click can't start an overlapping operation", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    let resolveSubscribe: (value: PushSubscriptionJSON | null) => void = () => {}
    vi.mocked(pushNotifications.subscribeToPush).mockImplementation(
      () =>
        new Promise<PushSubscriptionJSON | null>((resolve) => {
          resolveSubscribe = resolve
        }),
    )

    render(<NotificationToggle />)
    const button = await screen.findByRole("button", { name: /enable notifications/i })
    await user.click(button)

    expect(button).toBeDisabled()

    resolveSubscribe(null)
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  describe("turning notifications OFF is gated on the backend write", () => {
    // The preference write (`enabled: false`) is what stops the dispatcher. If it fails, the toggle
    // must keep showing ON (and the browser must stay subscribed) -- showing OFF while the backend
    // still has notifications enabled is the divergence these tests guard against.
    it("stays ON, stays subscribed and shows an error when the disable write fails", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      const calls: Array<{ path: string; method: string | undefined }> = []
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown, options?: { method?: string }) => {
        const p = String(path)
        calls.push({ path: p, method: options?.method })
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/notification-preference")) throw new Error("network error")
        return undefined
      })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /notifications on/i }))

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))
      expect(screen.getByRole("button", { name: /notifications on/i })).toHaveAttribute("aria-pressed", "true")
      expect(screen.queryByRole("button", { name: /enable notifications/i })).not.toBeInTheDocument()
      expect(pushNotifications.unsubscribeFromPush).not.toHaveBeenCalled()
      expect(calls.some((c) => c.path.endsWith("/push-subscription"))).toBe(false)
    })

    it("stays ON and shows an error when every backend request fails, including the credential", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      vi.mocked(apiClient.apiRequest).mockRejectedValue(new Error("network error"))

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /notifications on/i }))

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))
      expect(screen.getByRole("button", { name: /notifications on/i })).toHaveAttribute("aria-pressed", "true")
      expect(pushNotifications.unsubscribeFromPush).not.toHaveBeenCalled()
    })

    it("can be retried after a failed disable and then turns OFF once the write succeeds", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      let preferenceCalls = 0
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown) => {
        const p = String(path)
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/notification-preference") && ++preferenceCalls === 1) throw new Error("network error")
        return undefined
      })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /notifications on/i }))
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())

      await user.click(screen.getByRole("button", { name: /notifications on/i }))

      await waitFor(() => expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument())
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("disables the button while the disable write is in flight", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      let finishPreferenceWrite: () => void = () => {}
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown) => {
        const p = String(path)
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/notification-preference")) await new Promise<void>((resolve) => (finishPreferenceWrite = resolve))
        return undefined
      })

      render(<NotificationToggle />)
      const button = await screen.findByRole("button", { name: /notifications on/i })
      await user.click(button)

      await waitFor(() => expect(button).toBeDisabled())
      expect(pushNotifications.unsubscribeFromPush).not.toHaveBeenCalled()

      finishPreferenceWrite()
      await waitFor(() => expect(screen.getByRole("button", { name: /enable notifications/i })).not.toBeDisabled())
    })

    it("turns OFF and still reports an error when only the follow-up subscription cleanup fails", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("subscribed")
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      const calls: Array<{ path: string; method: string | undefined; body?: unknown }> = []
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown, options?: { method?: string; body?: unknown }) => {
        const p = String(path)
        calls.push({ path: p, method: options?.method, body: options?.body })
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/push-subscription")) throw new Error("network error")
        return undefined
      })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /notifications on/i }))

      // The preference is already disabled on the backend, so OFF is truthful; the stale subscription record is reported.
      await waitFor(() => expect(screen.getByRole("button", { name: /enable notifications/i })).toBeInTheDocument())
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))
      const order = calls.map((c) => `${c.method ?? "GET"} ${c.path.split("/").pop()}`)
      expect(order.indexOf("PUT notification-preference")).toBeLessThan(order.indexOf("DELETE push-subscription"))
      expect(calls.find((c) => c.path.endsWith("/notification-preference"))?.body).toMatchObject({ enabled: false })
    })
  })

  describe("turning notifications ON", () => {
    it("stays OFF (not pressed) with a visible error when the enable write fails", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
      vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue({ endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } })
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown, options?: { body?: unknown }) => {
        const p = String(path)
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/notification-preference") && (options?.body as { enabled?: boolean } | undefined)?.enabled === true) throw new Error("network error")
        return undefined
      })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /enable notifications/i }))

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't sync/i))
      expect(screen.getByRole("button", { name: /enable notifications/i })).toHaveAttribute("aria-pressed", "false")
      expect(screen.queryByRole("button", { name: /notifications on/i })).not.toBeInTheDocument()
      expect(pushNotifications.unsubscribeFromPush).toHaveBeenCalled()
    })

    it("says notifications may still be on when both cleanup calls after a failed enable fail", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
      vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue({ endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } })
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown, options?: unknown) => {
        const p = String(path)
        const method = (options as { method?: string } | undefined)?.method
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/notification-preference")) throw new Error("network error")
        if (p.endsWith("/push-subscription") && method === "DELETE") throw new Error("network error")
        return undefined
      })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /enable notifications/i }))

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/may still be on/i))
      expect(screen.getByRole("button", { name: /enable notifications/i })).toHaveAttribute("aria-pressed", "false")
    })

    it("still deletes the subscription, and does not claim notifications may be on, when only the preference cleanup fails", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
      vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue({ endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } })
      vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(true)
      vi.mocked(apiClient.apiRequest).mockImplementation(async (path: unknown) => {
        const p = String(path)
        if (p.endsWith("/credential")) return { clientId: "c1", clientSecret: "secret" }
        if (p.endsWith("/notification-preference")) throw new Error("network error")
        return undefined
      })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /enable notifications/i }))

      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
      expect(screen.getByRole("alert")).not.toHaveTextContent(/may still be on/i)
      const deleted = vi
        .mocked(apiClient.apiRequest)
        .mock.calls.some(([path, options]) => String(path).endsWith("/push-subscription") && (options as { method?: string } | undefined)?.method === "DELETE")
      expect(deleted).toBe(true)
    })

    it("writes the master switch as enabled: true in the full default preference payload", async () => {
      const user = userEvent.setup()
      vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
      vi.mocked(pushNotifications.subscribeToPush).mockResolvedValue({ endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } })

      render(<NotificationToggle />)
      await user.click(await screen.findByRole("button", { name: /enable notifications/i }))
      await waitFor(() => expect(screen.getByRole("button", { name: /notifications on/i })).toBeInTheDocument())

      const preferenceCall = vi.mocked(apiClient.apiRequest).mock.calls.find(([path]) => String(path).endsWith("/notification-preference"))
      const body = ((preferenceCall?.[1] as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["deliveryWindows", "enabled", "notificationLevel", "notificationTimeZone"])
      expect(body.enabled).toBe(true)
    })
  })
})
