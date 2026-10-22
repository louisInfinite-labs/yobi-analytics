/** Where "Install OshiYobi" lives: its own section of Notification Settings, after the push and simultaneous-livestream settings and nested in neither,
 * shown only on a phone browser outside the installed app -- and no longer in Display Settings. */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { DisplaySettings } from "../../../pages/settings/DisplaySettings"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetInstallStateForTests } from "../../pwa/installState"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

vi.mock("../push/pushGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../push/pushGate")>()),
  ensurePushEnabled: vi.fn(async () => "ready"),
}))
vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
const originalWidth = window.innerWidth

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([{ id: "apex", labels: { en: "Apex", "zh-TW": "Apex", ja: "Apex" } }])
  window.localStorage.setItem("yobi.locale", "en")
  window.localStorage.removeItem("yobi.notificationDeliverySlots")
  resetAllSharedStateForTests()
  resetInstallStateForTests()
})
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth })
  Reflect.deleteProperty(navigator, "standalone")
  resetInstallStateForTests()
  vi.restoreAllMocks()
})

function phoneBrowser() {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_SAFARI)
  Object.defineProperty(navigator, "standalone", { value: false, configurable: true })
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 })
}

function renderPage() {
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

const installSection = () => screen.queryByRole("heading", { name: "Install OshiYobi" })?.closest("section") ?? null

/** The rows (sections) of the open topic's settings box, in document order. */
const rowTitles = () => [...document.querySelectorAll<HTMLElement>(".notification-detail-panel > section.notification-detail-section")].map((row) => row.querySelector("h3")?.textContent ?? "")

async function openApexTopic() {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  await user.click(screen.getByRole("button", { name: /^Apex/ }))
}

describe("Install OshiYobi in Notification Settings", () => {
  it("is the last ROW of the same settings box, right below the simultaneous-livestream row -- same parent, no card of its own", async () => {
    phoneBrowser()
    renderPage()
    await openApexTopic()

    const panel = document.querySelector(".notification-detail-panel")!
    const rows = rowTitles()
    expect(rows[rows.length - 1]).toBe("Install OshiYobi")
    expect(rows[rows.length - 2]).toBe("Simultaneous stream heads-up") // immediately below it
    const install = installSection()!
    expect(install.parentElement).toBe(panel) // the same existing container as every other row
    expect(install.previousElementSibling?.querySelector("h3")?.textContent).toBe("Simultaneous stream heads-up")
    expect(install.matches("section.notification-detail-section")).toBe(true) // the existing row styling (padding and separator), nothing new
    expect(install.querySelector(".notification-detail-panel, .notification-topic-panel")).toBeNull() // no nested box
  })

  it("exists exactly once on the page (one open topic panel at a time, never repeated per topic) and not at the bottom after the topic list", async () => {
    phoneBrowser()
    renderPage()
    await openApexTopic()

    expect(screen.getAllByRole("heading", { name: "Install OshiYobi" })).toHaveLength(1)
    expect(document.querySelectorAll(".pwa-install-section")).toHaveLength(1)
    const page = document.querySelector(".notification-settings-page")!
    expect(installSection()!.closest(".notification-topic-accordion__panel, .notification-detail-panel")).not.toBeNull() // inside the box
    const lastBlock = page.querySelector(".notification-settings-main")!.lastElementChild!
    expect(lastBlock.contains(installSection()!) && lastBlock.classList.contains("pwa-install-section")).toBe(false) // not a trailing block after the topics
  })

  it("is not rendered while no topic is open (the settings box itself is not on the page), and nowhere outside the box", () => {
    phoneBrowser()
    renderPage()

    expect(installSection()).toBeNull()
    expect(document.querySelector(".notification-settings-page > .pwa-install-section, .notification-settings-content > .pwa-install-section")).toBeNull()
  })

  it("the row above it keeps its separator, and when the install row is hidden nothing of it remains (no row, no separator, no gap)", async () => {
    phoneBrowser()
    const shown = renderPage()
    await openApexTopic()
    const withInstall = rowTitles()
    expect(withInstall).toContain("Install OshiYobi")
    shown.unmount()

    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(DESKTOP_CHROME)
    resetInstallStateForTests()
    renderPage()
    await openApexTopic()

    expect(rowTitles()).toEqual(withInstall.filter((title) => title !== "Install OshiYobi"))
    expect(document.querySelector(".pwa-install-section")).toBeNull()
    expect(document.querySelector(".notification-detail-panel")!.textContent).not.toContain("Install OshiYobi")
  })

  it("has exactly one install control and the compact settings style (a row title and a small button, no card or image)", async () => {
    phoneBrowser()
    renderPage()
    await openApexTopic()

    expect(screen.getAllByRole("button", { name: "How to install" })).toHaveLength(1)
    expect(installSection()!.querySelector("img, video, canvas")).toBeNull()
  })

  it("on desktop it is not rendered at all, even with a topic open", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(DESKTOP_CHROME)
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1400 })
    renderPage()

    expect(installSection()).toBeNull()
    expect(screen.queryByRole("button", { name: "How to install" })).toBeNull()
  })

  it("in the installed app it is not rendered at all", async () => {
    phoneBrowser()
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true })
    renderPage()
    await openApexTopic()

    expect(installSection()).toBeNull()
  })

  it("the push notification page keeps its title and the topic list next to it", () => {
    phoneBrowser()
    renderPage()

    expect(screen.getByRole("heading", { level: 1, name: "Push Notifications" })).toBeInTheDocument()
    expect(document.querySelectorAll(".notification-topic-item").length).toBeGreaterThan(0)
  })
})

describe("Display Settings no longer holds the install entry", () => {
  it("renders no install section, on a phone browser either: the function is shown once, in Notification Settings", () => {
    phoneBrowser()
    render(<DisplaySettings />)

    expect(screen.queryByRole("heading", { name: "Install OshiYobi" })).toBeNull()
    expect(screen.queryByRole("button", { name: "How to install" })).toBeNull()
  })
})
