import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InstallSetting } from "./InstallSetting"
import { resetInstallStateForTests } from "../installState"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "zh-TW")
  resetAllSharedStateForTests()
  resetInstallStateForTests()
})
afterEach(() => {
  resetInstallStateForTests()
  Reflect.deleteProperty(navigator, "standalone")
  vi.restoreAllMocks()
})

/** The browser's install event (Chrome / Edge / Android). */
function fireBeforeInstallPrompt() {
  const prompt = vi.fn(async () => undefined)
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: "accepted" as const }) })
  act(() => {
    window.dispatchEvent(event)
  })
  return { event, prompt }
}

describe("InstallSetting (optional install row in Display Settings)", () => {
  it("renders nothing on a browser that offers no install path -- installing is optional, never forced", () => {
    const { container } = render(<InstallSetting />)

    expect(container).toBeEmptyDOMElement()
  })

  it("where the browser offers an install prompt, shows an Install button that triggers it only when clicked", async () => {
    const user = userEvent.setup()
    render(<InstallSetting />)
    const { event, prompt } = fireBeforeInstallPrompt()

    expect(event.defaultPrevented).toBe(true) // the browser's own infobar is suppressed: install stays a deliberate choice here
    expect(prompt).not.toHaveBeenCalled() // never auto-prompts
    await user.click(await screen.findByRole("button", { name: "安裝" }))

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "安裝" })).not.toBeInTheDocument() // the saved event is single-use
  })

  it("hides once the app is installed (appinstalled)", async () => {
    render(<InstallSetting />)
    fireBeforeInstallPrompt()
    expect(await screen.findByRole("button", { name: "安裝" })).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event("appinstalled"))
    })

    expect(screen.queryByRole("button", { name: "安裝" })).not.toBeInTheDocument()
  })

  it("hides when the page already runs as an installed standalone app", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(display-mode: standalone)", media: query }) as MediaQueryList)
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true })

    const { container } = render(<InstallSetting />)

    expect(container).toBeEmptyDOMElement()
  })

  it("iOS/iPadOS Safari (navigator.standalone exists, no install event): shows 'how to install', with the Add to Home Screen steps and the local-data warning", async () => {
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true })
    const user = userEvent.setup()
    render(<InstallSetting />)

    await user.click(screen.getByRole("button", { name: "查看安裝方法" }))

    const dialog = screen.getByRole("dialog", { name: "加入主畫面" })
    expect(dialog).toHaveTextContent("分享")
    expect(dialog).toHaveTextContent("加入主畫面")
    expect(dialog).toHaveTextContent("本機資料可能不會自動帶入")
    expect(dialog).toHaveTextContent("My Oshi")
    expect(dialog).toHaveTextContent("收藏")
    expect(dialog).toHaveTextContent("顯示設定")
    expect(dialog).toHaveTextContent("原本 Safari 裡的資料不會被刪除")
    expect(dialog).toHaveTextContent("不保證會自動轉移")

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("shows nothing modal or blocking by itself on load, even on iOS (no auto-opened dialog)", () => {
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true })

    render(<InstallSetting />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("follows the language (en)", async () => {
    window.localStorage.setItem("yobi.locale", "en")
    resetAllSharedStateForTests()
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true })

    render(<InstallSetting />)

    expect(screen.getByText("Install OshiYobi")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "How to install" })).toBeInTheDocument()
  })
})
