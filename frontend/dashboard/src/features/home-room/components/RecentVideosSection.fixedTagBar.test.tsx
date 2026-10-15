/** Home's Topic Tag Bar is FIXED at twelve options even though GET /topics returns the whole GLOBAL catalog (52 topics): ALL, 最新影片, 最新直播,
 * 雜談, 歌回, MV, Apex, Minecraft, SF6, VALO, Short, 其他. The catalog owns topic DATA (ids, labels, aliases -- still used by Search and the future
 * Video Filter Dialog); the Home UI owns WHICH topics the header shows. The topics below are the real production GLOBAL catalog fixture. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import { fetchVideoSearch } from "../../video-search/data/videoSearch"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../../video-search/data/videoSearch", () => ({ fetchVideoSearch: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)
const searchMock = vi.mocked(fetchVideoSearch)
const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)

/** The real production GLOBAL catalog (tests/fixtures/topic_catalog_global.json), shaped as GET /topics returns it. */
async function loadGlobalCatalog(): Promise<BackendVideoTopic[]> {
  const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":"))
  const { process } = globalThis as unknown as { process: { cwd(): string } }
  const raw = JSON.parse(String(fs.readFileSync(`${process.cwd()}/../../tests/fixtures/topic_catalog_global.json`, "utf8")))
  return (raw.items as Array<Record<string, unknown>>)
    .sort((a, b) => Number(a.display_order) - Number(b.display_order))
    .map((item) => ({
      id: String(item.topic_tag),
      labels: { "zh-TW": String(item.topic_zh), en: String(item.topic_en), ja: String(item.topic_ja) },
      searchAliases: item.search_aliases as string[],
    }))
}

const EXPECTED: Record<"zh-TW" | "en" | "ja", string[]> = {
  "zh-TW": ["ALL", "最新影片", "最新直播", "雜談", "歌回", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "其他"],
  en: ["ALL", "Latest Videos", "Latest Live", "Chatting", "Singing", "MV", "Apex", "Minecraft", "SF6", "VALO", "Short", "Other"],
  ja: ["ALL", "最新動画", "最新配信", "雑談", "歌枠", "MV", "Apex", "Minecraft", "SF6", "VALO", "ショット", "その他"],
}
const BAR_IDS = ["all", "latestVideos", "latestLive", "chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant", "short", "other"]

const barLabels = () => Array.from(document.querySelectorAll(".oshi-videos__segment-label")).map((element) => element.textContent ?? "")
const lastQuery = () => fetchMock.mock.calls.at(-1)?.[0]
const emptyPage: OshiVideosPage = { videos: [], nextOffset: 0, hasMore: false }

async function renderHome(locale: "zh-TW" | "en" | "ja" = "zh-TW", catalog?: BackendVideoTopic[]) {
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
  fetchTopicsMock.mockResolvedValue(catalog ?? (await loadGlobalCatalog()))
  render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
  await screen.findByText(EXPECTED[locale][3]) // the first catalog topic has rendered
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(emptyPage)
  fetchTopicsMock.mockReset()
  searchMock.mockReset().mockResolvedValue([])
})

describe("GET /topics returns the whole GLOBAL catalog, yet the bar stays the twelve fixed options", () => {
  it("the catalog really has 52 topics (the premise of every test here)", async () => {
    expect(await loadGlobalCatalog()).toHaveLength(52)
  })

  it.each(["zh-TW", "en", "ja"] as const)("%s: exactly the twelve options, in exactly the requested order", async (locale) => {
    await renderHome(locale)

    expect(barLabels()).toEqual(EXPECTED[locale])
    expect(barLabels()).toHaveLength(12)
  })

  it("no other GLOBAL topic is appended (Phasmophobia, Among Us, PEAK, ...), and the order does not depend on the order /topics returned", async () => {
    const catalog = await loadGlobalCatalog()
    await renderHome("zh-TW", [...catalog].reverse())

    expect(barLabels()).toEqual(EXPECTED["zh-TW"])
    const shown = new Set(barLabels())
    const extras = catalog.filter((topic) => !BAR_IDS.includes(topic.id))
    expect(extras).toHaveLength(52 - 8) // the 7 fixed topics and Other are the only catalog entries the bar shows
    for (const extra of extras) expect(shown.has(extra.labels["zh-TW"] ?? extra.id)).toBe(false)
  })

  it("a topic added to the catalog later does not lengthen the bar", async () => {
    const catalog = await loadGlobalCatalog()
    const added = Array.from({ length: 100 }, (_, index): BackendVideoTopic => ({ id: `added_${index}`, labels: { "zh-TW": `新增${index}`, en: `Added ${index}`, ja: `追加${index}` } }))
    await renderHome("zh-TW", [...catalog, ...added])

    expect(barLabels()).toEqual(EXPECTED["zh-TW"])
  })

  it("while GET /topics is loading or has failed, only the frontend-owned options show (no stale topic list)", async () => {
    localStorage.setItem("yobi.locale", "zh-TW")
    resetAllSharedStateForTests()
    fetchTopicsMock.mockRejectedValue(new Error("network error"))
    render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)

    await screen.findByText("ALL")
    await waitFor(() => expect(barLabels()).toEqual(["ALL", "最新影片", "最新直播", "Short"]))
  })
})

describe("every displayed tag keeps its filtering behavior", () => {
  it.each([
    ["ALL", "all", { topic: "all", excludeShorts: true }],
    ["最新影片", "latestVideos", { topic: "all", contentType: "upload" }],
    ["最新直播", "latestLive", { topic: "all", contentType: "live" }],
    ["雜談", "chatting", { topic: "chatting", excludeShorts: true }],
    ["歌回", "singing", { topic: "singing", excludeShorts: true }],
    ["MV", "mv", { topic: "mv", excludeShorts: true }],
    ["Apex", "apex", { topic: "apex", excludeShorts: true }],
    ["Minecraft", "minecraft", { topic: "minecraft", excludeShorts: true }],
    ["SF6", "sf6", { topic: "sf6", excludeShorts: true }],
    ["VALO", "valorant", { topic: "valorant", excludeShorts: true }],
    ["Short", "short", { topic: "all", contentType: "short" }],
    ["其他", "other", { topic: "other", excludeShorts: true }],
  ])("%s asks the backend for its own query (%s)", async (label, _id, expected) => {
    await renderHome("zh-TW")
    // start from a different tag so every click is a real change (ALL is the initial selection)
    await userEvent.setup().click(screen.getByText(label === "雜談" ? "MV" : "雜談"))
    fetchMock.mockClear()

    await userEvent.setup().click(screen.getByText(label))

    await waitFor(() => expect(lastQuery()).toMatchObject(expected))
  })

  it("ALL, Latest Videos, Latest Live, Short and Other are all present and selectable", async () => {
    await renderHome("en")
    for (const label of ["ALL", "Latest Videos", "Latest Live", "Short", "Other"]) expect(screen.getByText(label)).toBeInTheDocument()
  })
})

describe("clicking a fixed tag during a search still clears the query and selects that tag", () => {
  it.each([["雜談", "chatting"], ["ALL", "all"], ["其他", "other"]])("%s", async (label, topic) => {
    await renderHome("zh-TW")
    const input = screen.getByRole<HTMLInputElement>("textbox")
    fireEvent.change(input, { target: { value: "誕生日" } })
    await waitFor(() => expect(searchMock).toHaveBeenCalled())

    await userEvent.setup().click(screen.getByText(label))

    await waitFor(() => expect(input.value).toBe(""))
    await waitFor(() => expect(lastQuery()).toMatchObject({ topic }))
  })
})

describe("the catalog itself is untouched: the bar's absent topics still resolve in Search and GET /topics stays complete", () => {
  it("Search still expands a topic that is NOT in the bar from the full catalog", async () => {
    const catalog = await loadGlobalCatalog()
    const notInBar = catalog.find((topic) => topic.id === "phasmophobia")
    expect(notInBar).toBeDefined()
    await renderHome("zh-TW", catalog)
    const input = screen.getByRole<HTMLInputElement>("textbox")

    fireEvent.change(input, { target: { value: "phasmo" } })

    await waitFor(() => expect(searchMock).toHaveBeenCalled())
    expect(searchMock.mock.calls.at(-1)![0].terms).toContain("phasmophobia") // its localized label, resolved from the full catalog
    expect(screen.queryByText(notInBar!.labels["zh-TW"] as string)).not.toBeInTheDocument()
  })

  it("the component never asks for a different, reduced topics response: it requests the one catalog and trims only the display", async () => {
    await renderHome("zh-TW")

    expect(fetchTopicsMock).toHaveBeenCalled()
    expect(await fetchTopicsMock.mock.results[0].value).toHaveLength(52)
  })
})
