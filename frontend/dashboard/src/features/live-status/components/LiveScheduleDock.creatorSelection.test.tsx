/** Choosing a creator in Live Status applies it at once and closes the drawer by itself (no outside click), with focus back on the trigger --
 * for a mouse, a touch tap and the keyboard, with or without the "ask before switching" confirmation. A cancelled or failed selection leaves
 * it open; Escape and an outside click still dismiss it. The router is mocked, so this exercises only the drawer's own behavior. */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LiveScheduleDock } from "./LiveScheduleDock"
import * as useCurrentPageModule from "../../../app/navigation/useCurrentPage"
import * as useCreatorStatusesModule from "../hooks/useCreatorStatuses"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

vi.mock("../../../app/navigation/useCurrentPage")
vi.mock("../hooks/useCreatorStatuses", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useCreatorStatuses")>("../hooks/useCreatorStatuses")
  return { ...actual, useCreatorStatuses: vi.fn() }
})
vi.mock("../../../entities/creator/data/creatorRegistry", async () => {
  const actual = await vi.importActual<typeof import("../../../entities/creator/data/creatorRegistry")>("../../../entities/creator/data/creatorRegistry")
  return { ...actual, resolveCreatorKey: vi.fn(actual.resolveCreatorKey) }
})

const CONFIRM_KEY = "yobi.confirmOshiSwitch"
const now = new Date("2026-09-10T12:00:00+09:00")
const realResolveCreatorKey = vi.mocked(resolveCreatorKey).getMockImplementation()!

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveCreatorKey).mockImplementation(realResolveCreatorKey) // the failed-selection test overrides it
  vi.mocked(useCurrentPageModule.useCurrentPage).mockReturnValue(["home", vi.fn()])
  vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses: {}, now })
})

const trigger = () => document.querySelector<HTMLButtonElement>(".live-status-trigger")!
const isOpen = () => document.querySelector(".live-status-dock")?.getAttribute("data-live-status-open") === "true"
const noaRow = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".live-status-member__creator-button")).find((button) => /Noa|のあ/.test(button.getAttribute("aria-label") ?? ""))!

async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger())
  expect(isOpen()).toBe(true)
}

describe("with the confirmation switched off", () => {
  beforeEach(() => {
    window.localStorage.setItem(CONFIRM_KEY, "false")
    resetAllSharedStateForTests() // the preference store re-reads storage
  })

  it("a mouse click applies the creator and closes the drawer immediately, with no outside click", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.click(noaRow())

    expect(useCurrentPageModule.selectCreator).toHaveBeenCalledExactlyOnceWith("ch_kurumi_noa")
    expect(isOpen()).toBe(false)
  })

  it("a touch tap does the same", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.pointer([{ keys: "[TouchA>]", target: noaRow() }, { keys: "[/TouchA]" }])

    expect(useCurrentPageModule.selectCreator).toHaveBeenCalledWith("ch_kurumi_noa")
    expect(isOpen()).toBe(false)
  })

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("%s on the focused creator row does the same", async (_name, key) => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)
    noaRow().focus()

    await user.keyboard(key)

    expect(useCurrentPageModule.selectCreator).toHaveBeenCalledWith("ch_kurumi_noa")
    expect(isOpen()).toBe(false)
  })

  it("focus returns to the Live Status trigger once the drawer has closed", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.click(noaRow())

    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("an unknown creator key (the selection failed) leaves the drawer open", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)
    vi.mocked(resolveCreatorKey).mockImplementation((key) => (key === "ch_kurumi_noa" ? undefined : realResolveCreatorKey(key)))

    await user.click(noaRow())

    expect(isOpen()).toBe(true)
  })

  it("only the creator button closes it: the favorite swipe, search and filter inside the drawer leave it open", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.type(document.querySelector<HTMLInputElement>(".live-status-search input")!, "no")
    await user.click(screen.getByText("Favorites"))

    expect(isOpen()).toBe(true)
  })
})

describe("with the confirmation switched on", () => {
  it("the drawer stays open while the question is shown, and closes once the switch is confirmed", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.click(noaRow())
    expect(screen.getByRole("button", { name: /^Switch$/ })).toBeInTheDocument()
    expect(useCurrentPageModule.selectCreator).not.toHaveBeenCalled()
    expect(isOpen()).toBe(true)

    await user.click(screen.getByRole("button", { name: /^Switch$/ }))

    expect(useCurrentPageModule.selectCreator).toHaveBeenCalledExactlyOnceWith("ch_kurumi_noa")
    expect(isOpen()).toBe(false)
  })

  it("a cancelled switch applies nothing and leaves the drawer open", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.click(noaRow())
    await user.click(screen.getByRole("button", { name: /Cancel/ }))

    expect(useCurrentPageModule.selectCreator).not.toHaveBeenCalled()
    expect(isOpen()).toBe(true)
  })
})

describe("the other ways to dismiss still work", () => {
  it("Escape closes it", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.keyboard("{Escape}")

    expect(isOpen()).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("an outside click closes it", async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">elsewhere</button>
        <LiveScheduleDock />
      </>,
    )
    await openDrawer(user)

    await user.click(screen.getByRole("button", { name: "elsewhere" }))

    expect(isOpen()).toBe(false)
  })

  it("the close button closes it", async () => {
    const user = userEvent.setup()
    render(<LiveScheduleDock />)
    await openDrawer(user)

    await user.click(document.querySelector<HTMLElement>(".live-status-drawer__close")!)

    expect(isOpen()).toBe(false)
  })
})
