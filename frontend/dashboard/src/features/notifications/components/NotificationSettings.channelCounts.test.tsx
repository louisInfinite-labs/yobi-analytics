import { render, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

// The Live and 新片 switches are independent per member, so Settings shows TWO counts ("Live N", "New Video N") instead of one merged
// "selected" number. Nothing here contacts any API: the topic catalog is mocked and the state is seeded into localStorage.

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const ORDER = ["all", "sf6", "valorant", "apex", "minecraft"]

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([])
  window.localStorage.clear()
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

function seed(topic: { live?: string[]; newVideo?: string[]; notificationType?: "live" | "newVideo" | "both" }) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ topicOrder: ORDER, topics: { all: { live: [], newVideo: [], reminderOverrides: {}, notificationType: "both", ...topic } } }),
  )
  resetAllSharedStateForTests()
}

function renderSettings() {
  render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
  const detail = document.querySelector<HTMLElement>(".notification-detail-panel")!
  const listItem = document.querySelector<HTMLElement>(".notification-topic-item")! // the first card: 全部
  return { detail, listItem }
}

const countsIn = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(".notification-channel-count")).map((node) => `${node.dataset.channel}:${node.textContent}`)

describe("separate Live / New Video member counts", () => {
  it("直播+新片: shows Live N and New Video N apart, in the detail panel and on the topic card", () => {
    seed({ live: ["aizawa_ema", "kaga_sumire"], newVideo: ["kosuzume_toto"] })
    const { detail, listItem } = renderSettings()

    expect(countsIn(detail)).toEqual(["live:Live 2", "newVideo:New Video 1"])
    expect(countsIn(listItem)).toEqual(["live:Live 2", "newVideo:New Video 1"])
    expect(within(detail).queryByText(/selected/)).toBeNull() // the merged count is gone
    expect(within(listItem).queryByText(/selected/)).toBeNull()
  })

  it("a member with both switches on counts in each channel; one with neither counts in none", () => {
    seed({ live: ["aizawa_ema", "kaga_sumire"], newVideo: ["aizawa_ema"] })
    const { detail } = renderSettings()

    expect(countsIn(detail)).toEqual(["live:Live 2", "newVideo:New Video 1"])
  })

  it("an empty topic reads Live 0 and New Video 0", () => {
    seed({})
    const { detail } = renderSettings()

    expect(countsIn(detail)).toEqual(["live:Live 0", "newVideo:New Video 0"])
  })

  it("a topic that sends Live only shows only the Live count (New Video is not in effect, whatever is stored)", () => {
    seed({ live: ["aizawa_ema"], newVideo: ["kosuzume_toto", "kaga_sumire"], notificationType: "live" })
    const { detail, listItem } = renderSettings()

    expect(countsIn(detail)).toEqual(["live:Live 1"])
    expect(countsIn(listItem)).toEqual(["live:Live 1"])
  })

  it("a topic that sends New Video only shows only that count (a stale stored Live member is not counted)", () => {
    seed({ live: ["aizawa_ema"], newVideo: ["kosuzume_toto"], notificationType: "newVideo" })
    const { detail } = renderSettings()

    expect(countsIn(detail)).toEqual(["newVideo:New Video 1"])
  })

  it("counts only members the Settings roster lists (a stored group channel is not a selectable member)", () => {
    seed({ live: ["aizawa_ema", "unit_b_pre_debut"], newVideo: ["hololive_official", "kosuzume_toto"] })
    const { detail } = renderSettings()

    expect(countsIn(detail)).toEqual(["live:Live 1", "newVideo:New Video 1"])
  })

  it("follows the language (labels are the existing column headers)", () => {
    window.localStorage.setItem("yobi.locale", "zh-TW")
    seed({ live: ["aizawa_ema", "kaga_sumire"], newVideo: ["kosuzume_toto"] })
    const { detail } = renderSettings()

    expect(countsIn(detail)).toEqual(["live:直播 2", "newVideo:新片 1"])
  })

  it("the avatar preview still shows every member who has either channel (the product model is unchanged)", () => {
    seed({ live: ["aizawa_ema"], newVideo: ["kosuzume_toto"] })
    const { detail } = renderSettings()

    // two different members, one per channel: the preview lists both (it is the union), while the counts say which channel each has
    expect(detail.querySelectorAll(".notification-member-preview__item")).toHaveLength(2)
    expect(countsIn(detail)).toEqual(["live:Live 1", "newVideo:New Video 1"])
  })
})
