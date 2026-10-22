import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InstallSetting } from "./InstallSetting"
import { isMobilePhoneBrowser, resetInstallStateForTests } from "../installState"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
  androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  desktopChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  desktopEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  desktopFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  desktopSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
}

beforeEach(() => {
  window.localStorage.setItem("yobi.locale", "zh-TW")
  resetAllSharedStateForTests()
  resetInstallStateForTests()
})
afterEach(() => {
  resetInstallStateForTests()
  Reflect.deleteProperty(navigator, "standalone")
  Reflect.deleteProperty(navigator, "userAgentData")
  vi.restoreAllMocks()
})

/** Makes the page look like it runs in a browser with this User-Agent. */
function browser(userAgent: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
}

/** iOS WebKit (Safari, Chrome and every other iOS browser) exposes `navigator.standalone`: false in a browser tab, true in the installed Home Screen app. */
function iosStandaloneFlag(value: boolean) {
  Object.defineProperty(navigator, "standalone", { value, configurable: true })
}

/** The browser's install event (Chrome / Edge / Android). */
function fireBeforeInstallPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn(async () => undefined)
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome }) })
  act(() => {
    window.dispatchEvent(event)
  })
  return { event, prompt }
}

function standaloneDisplay() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query === "(display-mode: standalone)", media: query }) as MediaQueryList)
}

const sectionTitle = () => screen.queryByRole("heading", { name: "安裝 OshiYobi" })

describe("InstallSetting: who sees the section", () => {
  it.each([
    ["iPhone Safari", UA.iphoneSafari, true],
    ["iPhone Chrome", UA.iphoneChrome, true],
    ["Android Chrome", UA.androidChrome, true],
    ["Android Firefox", UA.androidFirefox, false],
  ])("%s in a normal browser tab shows the section", (_name, agent, ios) => {
    browser(agent)
    if (ios) iosStandaloneFlag(false)

    render(<InstallSetting />)

    expect(sectionTitle()).toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(1) // exactly one install control, never a duplicate
  })

  it.each([
    ["desktop Chrome", UA.desktopChrome],
    ["desktop Edge", UA.desktopEdge],
    ["desktop Firefox", UA.desktopFirefox],
    ["desktop Safari", UA.desktopSafari],
    ["an Android tablet", UA.androidTablet],
  ])("%s renders nothing at all, even when the browser holds an install prompt", (_name, agent) => {
    browser(agent)
    const { container } = render(<InstallSetting />)
    fireBeforeInstallPrompt()

    expect(container).toBeEmptyDOMElement()
  })

  it("a desktop browser resized to a phone-sized window is still not a phone: nothing is shown", () => {
    browser(UA.desktopChrome)
    Object.defineProperty(window, "innerWidth", { value: 360, configurable: true, writable: true })

    const { container } = render(<InstallSetting />)

    expect(container).toBeEmptyDOMElement()
  })

  it("iPadOS (a desktop-class User-Agent with navigator.standalone) is not a phone either", () => {
    browser(UA.desktopSafari)
    iosStandaloneFlag(false)

    const { container } = render(<InstallSetting />)

    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ["an iPhone Home Screen app (navigator.standalone)", UA.iphoneSafari],
    ["an Android installed app (display-mode: standalone)", UA.androidChrome],
  ])("%s renders the whole section nowhere -- not even a disabled button", (name, agent) => {
    browser(agent)
    if (name.startsWith("an iPhone")) iosStandaloneFlag(true)
    else standaloneDisplay()

    const { container } = render(<InstallSetting />)

    expect(container).toBeEmptyDOMElement()
  })

  it("a phone browser tab still shows the section when the app is installed elsewhere (the page cannot tell, and must not hide it)", () => {
    browser(UA.androidChrome) // no beforeinstallprompt was ever delivered: Chrome withholds it when the app is already installed
    render(<InstallSetting />)

    expect(sectionTitle()).toBeInTheDocument()
  })

  it("uses the User-Agent Client Hints mobile flag where the browser provides it", () => {
    browser(UA.desktopChrome)
    Object.defineProperty(navigator, "userAgentData", { value: { mobile: true }, configurable: true })
    expect(isMobilePhoneBrowser()).toBe(true)

    Object.defineProperty(navigator, "userAgentData", { value: { mobile: false }, configurable: true })
    browser(UA.androidChrome)
    expect(isMobilePhoneBrowser()).toBe(false)
  })

  it("hides once the app is installed during this visit (appinstalled)", async () => {
    browser(UA.androidChrome)
    const { container } = render(<InstallSetting />)
    fireBeforeInstallPrompt()
    expect(await screen.findByRole("button", { name: "安裝" })).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event("appinstalled"))
    })

    expect(container).toBeEmptyDOMElement()
  })
})

describe("InstallSetting: installing", () => {
  it("Android with an install prompt: the button triggers it only when tapped, never on load, and the saved event is single-use", async () => {
    browser(UA.androidChrome)
    const user = userEvent.setup()
    render(<InstallSetting />)
    const { event, prompt } = fireBeforeInstallPrompt()

    expect(event.defaultPrevented).toBe(true) // the browser's own infobar is suppressed: install stays a deliberate choice here
    expect(prompt).not.toHaveBeenCalled() // never auto-prompts
    await user.click(await screen.findByRole("button", { name: "安裝" }))

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "安裝" })).not.toBeInTheDocument()
  })

  it("a dismissed prompt is handled gracefully: no error, and the section falls back to the how-to-install steps", async () => {
    browser(UA.androidChrome)
    const user = userEvent.setup()
    render(<InstallSetting />)
    fireBeforeInstallPrompt("dismissed")

    await user.click(await screen.findByRole("button", { name: "安裝" }))

    expect(await screen.findByRole("button", { name: "查看安裝方法" })).toBeInTheDocument()
    expect(sectionTitle()).toBeInTheDocument()
  })

  it("an Android browser with no install prompt explains the browser menu instead, without pretending to install", async () => {
    browser(UA.androidChrome)
    const user = userEvent.setup()
    render(<InstallSetting />)

    await user.click(screen.getByRole("button", { name: "查看安裝方法" }))

    const dialog = screen.getByRole("dialog", { name: "安裝 OshiYobi" })
    expect(dialog).toHaveTextContent("瀏覽器選單")
    expect(dialog).toHaveTextContent("加到主畫面")
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("iPhone (navigator.standalone exists, no install event): 'how to install' opens the Add to Home Screen steps with the local-data warning", async () => {
    browser(UA.iphoneSafari)
    iosStandaloneFlag(false)
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

  it("shows nothing modal or blocking by itself on load, even on iPhone (no auto-opened dialog)", () => {
    browser(UA.iphoneSafari)
    iosStandaloneFlag(false)

    render(<InstallSetting />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("InstallSetting: labels follow the language", () => {
  it.each([
    ["zh-TW", "安裝 OshiYobi"],
    ["en", "Install OshiYobi"],
    ["ja", "OshiYobi をインストール"],
  ])("%s", (locale, label) => {
    window.localStorage.setItem("yobi.locale", locale)
    resetAllSharedStateForTests()
    browser(UA.iphoneSafari)
    iosStandaloneFlag(false)

    render(<InstallSetting />)

    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument()
  })
})
