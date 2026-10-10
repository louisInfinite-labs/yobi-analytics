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

describe("NotificationToggle when the service worker never activates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(apiClient.apiRequest).mockResolvedValue(undefined)
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue("unsubscribed")
    vi.mocked(pushNotifications.unsubscribeFromPush).mockResolvedValue(false)
  })

  it("shows the existing error, stays off, and writes nothing to the backend", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.subscribeToPush).mockRejectedValue(new Error("Service worker became redundant"))

    render(<NotificationToggle />)
    await user.click(await screen.findByRole("button", { name: /enable notifications/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't sync with the server/i)
    expect(screen.getByRole("button", { name: /enable notifications/i })).toHaveAttribute("aria-pressed", "false")
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
  })

  it("removes any half-made browser subscription", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.subscribeToPush).mockRejectedValue(new Error("AbortError: no active Service Worker"))

    render(<NotificationToggle />)
    await user.click(await screen.findByRole("button", { name: /enable notifications/i }))

    await waitFor(() => expect(pushNotifications.unsubscribeFromPush).toHaveBeenCalledTimes(1))
  })

  it("still ends in the off state when the cleanup itself throws", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.subscribeToPush).mockRejectedValue(new Error("boom"))
    vi.mocked(pushNotifications.unsubscribeFromPush).mockRejectedValue(new Error("cleanup boom"))

    render(<NotificationToggle />)
    await user.click(await screen.findByRole("button", { name: /enable notifications/i }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /enable notifications/i })).toBeEnabled()
  })

  it("lets the user retry after the failure and succeed", async () => {
    const user = userEvent.setup()
    vi.mocked(pushNotifications.subscribeToPush)
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce({ endpoint: "https://fcm.example.com/x", keys: { p256dh: "p", auth: "a" } })

    render(<NotificationToggle />)
    await user.click(await screen.findByRole("button", { name: /enable notifications/i }))
    await screen.findByRole("alert")

    await user.click(screen.getByRole("button", { name: /enable notifications/i }))

    await waitFor(() => expect(screen.getByRole("button", { name: /notifications on/i })).toBeInTheDocument())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
