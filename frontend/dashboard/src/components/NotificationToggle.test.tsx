import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationToggle } from "./NotificationToggle"
import * as apiClient from "../lib/apiClient"
import * as pushNotifications from "../lib/pushNotifications"

vi.mock("../lib/pushNotifications", () => ({
  getPushSubscriptionStatus: vi.fn(),
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}))

vi.mock("../lib/apiClient", () => ({ apiRequest: vi.fn() }))

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
})
