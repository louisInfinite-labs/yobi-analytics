import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { AdminPanel } from "./AdminPanel"
import { ApiError } from "../lib/apiClient"
import * as apiClient from "../lib/apiClient"

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient")
  return { ...actual, apiRequest: vi.fn() }
})

describe("AdminPanel", () => {
  it("keeps the admin key input empty and stats unloaded on a fresh page load", () => {
    render(<AdminPanel />)

    expect(screen.getByLabelText(/admin api key/i)).toHaveValue("")
    expect(screen.getByRole("button", { name: /refresh stats/i })).toBeDisabled()
  })

  it("never persists the admin key to localStorage or sessionStorage", async () => {
    const user = userEvent.setup()
    render(<AdminPanel />)

    await user.type(screen.getByLabelText(/admin api key/i), "typed-key")

    expect(screen.getByLabelText(/admin api key/i)).toHaveValue("typed-key")
    expect(window.localStorage.getItem("yobi-analytics-admin-key")).toBeNull()
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it("shows a hint that the admin key is not saved in the browser", () => {
    render(<AdminPanel />)

    expect(screen.getByText(/not saved in the browser/i)).toBeInTheDocument()
  })

  it("loads and displays heartbeat stats using the admin key header", async () => {
    const user = userEvent.setup()
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ totalClients: 5, onlineNow: 2 })
    render(<AdminPanel />)
    await user.type(screen.getByLabelText(/admin api key/i), "my-key")

    await user.click(screen.getByRole("button", { name: /refresh stats/i }))

    expect(await screen.findByText(/5 clients total/i)).toBeInTheDocument()
    expect(screen.getByText(/2 online now/i)).toBeInTheDocument()
    expect(apiClient.apiRequest).toHaveBeenCalledWith("/admin/heartbeat-stats", { headers: { "X-Admin-Key": "my-key" } })
  })

  it("shows an error message when loading stats fails", async () => {
    const user = userEvent.setup()
    vi.mocked(apiClient.apiRequest).mockRejectedValue(new ApiError(403, "Missing or invalid admin API key"))
    render(<AdminPanel />)
    await user.type(screen.getByLabelText(/admin api key/i), "wrong-key")

    await user.click(screen.getByRole("button", { name: /refresh stats/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Missing or invalid admin API key")
  })

  it("writes a remote config entry with the admin key header and a parsed JSON value", async () => {
    const user = userEvent.setup()
    vi.mocked(apiClient.apiRequest).mockResolvedValue({})
    render(<AdminPanel />)
    await user.type(screen.getByLabelText(/admin api key/i), "my-key")
    await user.type(screen.getByLabelText(/client id/i), "c1")
    await user.type(screen.getByLabelText(/^key$/i), "enabled")
    await user.type(screen.getByLabelText(/value/i), "true")

    await user.click(screen.getByRole("button", { name: /^save$/i }))

    await waitFor(() =>
      expect(apiClient.apiRequest).toHaveBeenCalledWith("/remote-config", {
        method: "POST",
        headers: { "X-Admin-Key": "my-key" },
        body: { clientId: "c1", key: "enabled", value: true },
      }),
    )
    expect(await screen.findByText("Saved.")).toBeInTheDocument()
  })

  it("falls back to a plain-text value when it isn't valid JSON", async () => {
    const user = userEvent.setup()
    vi.mocked(apiClient.apiRequest).mockResolvedValue({})
    render(<AdminPanel />)
    await user.type(screen.getByLabelText(/admin api key/i), "my-key")
    await user.type(screen.getByLabelText(/client id/i), "c1")
    await user.type(screen.getByLabelText(/^key$/i), "label")
    await user.type(screen.getByLabelText(/value/i), "not json")

    await user.click(screen.getByRole("button", { name: /^save$/i }))

    await waitFor(() =>
      expect(apiClient.apiRequest).toHaveBeenCalledWith(
        "/remote-config",
        expect.objectContaining({ body: { clientId: "c1", key: "label", value: "not json" } }),
      ),
    )
  })
})
