import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AdminPanel } from "./AdminPanel"
import { ApiError } from "../lib/apiClient"
import * as apiClient from "../lib/apiClient"

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient")
  return { ...actual, apiRequest: vi.fn() }
})

describe("AdminPanel", () => {
  // The mocked apiRequest is a single module-level vi.fn() shared by every
  // test in this file (vi.mock's factory runs once) -- without clearing its
  // call history between tests, an assertion like toHaveBeenCalledTimes(1)
  // would count calls left over from earlier tests, not just this test's own.
  beforeEach(() => {
    vi.clearAllMocks()
  })


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

  it("auto-loads stats once, a short debounce after a key has been typed, without a button click", async () => {
    const user = userEvent.setup()
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ totalClients: 5, onlineNow: 2 })
    render(<AdminPanel />)

    await user.type(screen.getByLabelText(/admin api key/i), "my-key")

    expect(await screen.findByText(/5 clients total/i)).toBeInTheDocument()
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
  })

  it("does not double-fetch when the debounced auto-load is preempted by an immediate manual click", async () => {
    // fireEvent.change sets the whole value in one synchronous event,
    // unlike user.type's real per-keystroke delay -- that delay is what let
    // the 400ms debounce race the manual click on a slow CI worker (the
    // auto-load could fire mid-typing, disabling the button before the
    // click, or letting two requests through instead of the one this test
    // asserts). A single synchronous change removes the race outright
    // rather than trying to out-schedule it with a timer mock.
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ totalClients: 5, onlineNow: 2 })
    render(<AdminPanel />)

    fireEvent.change(screen.getByLabelText(/admin api key/i), { target: { value: "my-key" } })
    // Clicking immediately, before the debounce timer elapses, should win
    // the race and make the pending auto-load a no-op.
    fireEvent.click(screen.getByRole("button", { name: /refresh stats/i }))

    await screen.findByText(/5 clients total/i)
    // Give the debounce timer (400ms) a chance to fire if it's going to.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
  })

  it("does not let a slower, older request overwrite a newer key's result", async () => {
    // Two deferred promises so the test controls resolution order directly,
    // independent of real timing -- the bug this guards against is a race,
    // so the test must be able to resolve the *older* request last.
    let resolveOld!: (value: { totalClients: number; onlineNow: number }) => void
    let resolveNew!: (value: { totalClients: number; onlineNow: number }) => void
    const oldRequest = new Promise<{ totalClients: number; onlineNow: number }>((resolve) => {
      resolveOld = resolve
    })
    const newRequest = new Promise<{ totalClients: number; onlineNow: number }>((resolve) => {
      resolveNew = resolve
    })
    vi.mocked(apiClient.apiRequest).mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest)
    render(<AdminPanel />)

    fireEvent.change(screen.getByLabelText(/admin api key/i), { target: { value: "old-key" } })
    fireEvent.click(screen.getByRole("button", { name: /refresh stats/i }))
    // The manual click above already started the old-key request and left
    // the button disabled/"Loading…" -- a second click wouldn't even
    // dispatch. Changing the key instead re-arms the auto-load guard
    // (loadedForKeyRef no longer matches adminKey), so the debounced
    // auto-load starts the second request on its own once it fires.
    fireEvent.change(screen.getByLabelText(/admin api key/i), { target: { value: "new-key" } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(2)

    // Resolve the newer request first, then the older, slower one.
    resolveNew({ totalClients: 2, onlineNow: 1 })
    expect(await screen.findByText(/2 clients total/i)).toBeInTheDocument()
    resolveOld({ totalClients: 99, onlineNow: 99 })
    await Promise.resolve()

    expect(screen.getByText(/2 clients total/i)).toBeInTheDocument()
    expect(screen.queryByText(/99 clients total/i)).not.toBeInTheDocument()
  })

  it("auto-loads again for a corrected key after the first key's auto-load failed", async () => {
    vi.mocked(apiClient.apiRequest)
      .mockRejectedValueOnce(new ApiError(403, "Missing or invalid admin API key"))
      .mockResolvedValueOnce({ totalClients: 5, onlineNow: 2 })
    render(<AdminPanel />)

    fireEvent.change(screen.getByLabelText(/admin api key/i), { target: { value: "wrong-key" } })
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing or invalid admin API key")

    fireEvent.change(screen.getByLabelText(/admin api key/i), { target: { value: "right-key" } })

    expect(await screen.findByText(/5 clients total/i)).toBeInTheDocument()
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(2)
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
