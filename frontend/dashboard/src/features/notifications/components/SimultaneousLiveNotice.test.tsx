import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SimultaneousLiveNotice } from "./SimultaneousLiveNotice"
import { fetchSimultaneousLiveNotice, saveSimultaneousLiveNotice } from "../api/simultaneousLiveNoticeApi"

vi.mock("../api/simultaneousLiveNoticeApi", () => ({
  fetchSimultaneousLiveNotice: vi.fn(),
  saveSimultaneousLiveNotice: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(fetchSimultaneousLiveNotice).mockReset().mockResolvedValue(false)
  vi.mocked(saveSimultaneousLiveNotice).mockReset().mockResolvedValue(undefined)
  window.localStorage.setItem("yobi.locale", "en")
})

const toggle = () => screen.getByRole("switch", { name: "Simultaneous stream heads-up" })

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

describe("SimultaneousLiveNotice", () => {
  it("is off by default and has a switch named by its heading and a description", async () => {
    render(<SimultaneousLiveNotice />)

    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(toggle()).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText(/two or more creators you have live notifications for/)).toBeInTheDocument()
  })

  it("shows the backend's stored opt-in", async () => {
    vi.mocked(fetchSimultaneousLiveNotice).mockResolvedValue(true)

    render(<SimultaneousLiveNotice />)

    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"))
  })

  it("stays disabled until the stored state has been read, so it never shows a guess", async () => {
    let answer: (enabled: boolean) => void = () => {}
    vi.mocked(fetchSimultaneousLiveNotice).mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)))

    render(<SimultaneousLiveNotice />)
    expect(toggle()).toBeDisabled()

    answer(false) // settle the read so no later test inherits an unfinished one
    await waitFor(() => expect(toggle()).toBeEnabled())
  })

  it("opts in with one backend write and only then shows it on; turning it off opts out", async () => {
    const user = userEvent.setup()
    render(<SimultaneousLiveNotice />)
    await waitFor(() => expect(toggle()).toBeEnabled())

    await user.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"))
    expect(saveSimultaneousLiveNotice).toHaveBeenLastCalledWith(true)

    await user.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"))
    expect(saveSimultaneousLiveNotice).toHaveBeenLastCalledWith(false)
  })

  it("keeps the switch where the backend left it and shows the save-failed alert when a write is rejected", async () => {
    vi.mocked(saveSimultaneousLiveNotice).mockRejectedValue(new Error("403"))
    const user = userEvent.setup()
    render(<SimultaneousLiveNotice />)
    await waitFor(() => expect(toggle()).toBeEnabled())

    await user.click(toggle())

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(toggle()).toHaveAttribute("aria-checked", "false")
  })

  it("reads the stored state once for any number of mounted panels", async () => {
    render(
      <>
        <SimultaneousLiveNotice />
        <SimultaneousLiveNotice />
      </>,
    )

    await waitFor(() => expect(screen.getAllByRole("switch")[0]).toBeEnabled())
    expect(fetchSimultaneousLiveNotice).toHaveBeenCalledTimes(1)
  })

  it("is a square checkbox, not a switch, on a phone -- like every other on/off control in Settings -- and writes the same value", async () => {
    setViewport(390)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<SimultaneousLiveNotice />)

    const box = await screen.findByRole("checkbox", { name: "Simultaneous stream heads-up" })
    expect(screen.queryAllByRole("switch")).toHaveLength(0)
    await user.click(box)

    await waitFor(() => expect(box).toBeChecked())
    expect(saveSimultaneousLiveNotice).toHaveBeenLastCalledWith(true)
    setViewport(1024)
  })

  it("shows the save-failed alert only in the section whose own change failed, not for another section's failure", async () => {
    const { reportNotificationSaveFailed } = await import("../hooks/notificationSaveStatus")
    render(<SimultaneousLiveNotice />)
    await waitFor(() => expect(toggle()).toBeEnabled())

    reportNotificationSaveFailed() // another control on the page failed

    expect(screen.queryByRole("alert")).toBeNull()
  })
})
