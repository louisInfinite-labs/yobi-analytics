/** The push-notification topic list shows EXACTLY ten options, in order -- 全部, 雜談, 歌回, MV, Apex, Minecraft, SF6, VALO, Short, 其他 -- even though
 * GET /topics returns the whole 52-topic GLOBAL catalog. 最新影片 / 最新直播 are Home-only browsing shortcuts and are not notification topics (Live
 * and New Video are this page's separate notification TYPES, which are unchanged). A card the user saved earlier for another topic keeps its stored
 * preferences untouched; it is just not shown. */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"
import { loadGlobalCatalog } from "../../../test/globalTopicCatalog"

// Each render here mounts the whole ~120-creator roster; under a loaded machine (CI) the default 5s is not enough.
vi.setConfig({ testTimeout: 20_000 })

vi.mock("../push/pushGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../push/pushGate")>()),
  ensurePushEnabled: vi.fn(async () => "ready"),
}))
vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const TEN = {
  "zh-TW": ["全部", "雜談", "歌回", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "其他"],
  en: ["All", "Chatting", "Singing", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "Other"],
  ja: ["全部", "雑談", "歌枠", "MV", "Apex", "Minecraft", "SF6", "VALO", "ショット", "その他"],
} as const

function renderSettings(locale: "zh-TW" | "en" | "ja" = "en") {
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

const cardNames = () => Array.from(document.querySelectorAll(".notification-topic-item__name")).map((node) => node.textContent)

/** Adds one category through "+ Add topic", exactly as a user does. */
async function addTopic(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("button", { name: /Add topic|新增主題|トピックを追加/ }))
  await user.click(screen.getByRole("combobox", { name: /Select notification topic|選擇通知主題|通知トピックを選択/ }))
  await user.click(await screen.findByTitle(label))
  await user.click(document.querySelector<HTMLElement>(".notification-save-button")!)
}

beforeEach(async () => {
  vi.mocked(fetchVideoTopics).mockResolvedValue(await loadGlobalCatalog())
})

describe("the offered categories", () => {
  it("with the full 52-topic catalog, '+ Add topic' offers only Minecraft, SF6, VALO, Short and Other (after the five permanent cards)", async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByRole("button", { name: "Add topic" }))
    await user.click(screen.getByRole("combobox", { name: "Select notification topic" }))

    await screen.findByTitle("Minecraft")
    const offered = Array.from(document.querySelectorAll(".ant-select-item-option")).map((node) => node.getAttribute("title"))
    expect(offered).toEqual(["Minecraft", "SF6", "VALO", "Short", "Other"])
    for (const hidden of ["Phasmophobia", "Among Us", "PEAK", "Latest Videos", "Latest Live"]) expect(offered).not.toContain(hidden)
  })

  it("starts with the five permanent cards: 全部, 雜談, 歌回, MV, Apex", async () => {
    renderSettings("zh-TW")

    expect(cardNames()).toEqual(TEN["zh-TW"].slice(0, 5))
  })
})

describe("the complete list", () => {
  it.each(["zh-TW", "en", "ja"] as const)("%s: once every offered category is added there are exactly ten cards, in the requested order", async (locale) => {
    const user = userEvent.setup()
    renderSettings(locale)
    await screen.findByRole("button", { name: /Add topic|新增主題|トピックを追加/ })
    for (const label of TEN[locale].slice(5)) await addTopic(user, label)

    expect(cardNames()).toEqual(TEN[locale])
    // nothing else, whatever GLOBAL holds, and no Home-only shortcut
    expect(cardNames()).toHaveLength(10)
    expect(screen.queryByRole("button", { name: /Add topic|新增主題|トピックを追加/ })).not.toBeInTheDocument() // nothing left to add
  })
})

describe("a card saved earlier for a topic outside the ten", () => {
  it("is not displayed, but its stored preferences are left exactly as they were (no destructive change)", async () => {
    const saved = {
      topicOrder: ["all", "chatting", "singing", "mv", "apex", "phasmophobia", "among_us"],
      topics: {
        phasmophobia: { live: ["aizawa_ema"], newVideo: ["aizawa_ema"], reminderOverrides: { aizawa_ema: "10min" }, notificationType: "both" },
        among_us: { live: [], newVideo: ["aizawa_ema"], reminderOverrides: {}, notificationType: "newVideo" },
      },
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
    renderSettings()

    expect(cardNames()).toEqual(TEN.en.slice(0, 5))
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
    expect(stored.topicOrder).toEqual(saved.topicOrder)
    expect(stored.topics.phasmophobia).toEqual(saved.topics.phasmophobia) // members, reminder and type all intact
    expect(stored.topics.among_us).toEqual(saved.topics.among_us)
  })
})

describe("the notification TYPES are unchanged", () => {
  it("every card still offers 直播+新片 / 直播 / 新片 (Live / New Video) -- those are not list entries", async () => {
    renderSettings()

    const detail = within(document.querySelector(".notification-detail-panel") as HTMLElement)
    expect(detail.getAllByRole("radio")).toHaveLength(3)
    expect(detail.getByRole("radio", { name: "Live" })).toBeInTheDocument()
    expect(detail.getByRole("radio", { name: "New Video" })).toBeInTheDocument()
  })
})
