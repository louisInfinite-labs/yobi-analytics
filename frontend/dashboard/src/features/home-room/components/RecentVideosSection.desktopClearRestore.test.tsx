/** Desktop: emptying the Video List search ends it AT ONCE and brings the Topic that was selected before the search back -- fetched again, with
 * content type / sort / period untouched -- whatever the input's focus, and without Enter, Escape or a click elsewhere. A search request that
 * is still pending when the text is cleared can never put its results back on screen. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import { fetchVideoSearch, type VideoSearchResult } from "../../video-search/data/videoSearch"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../../video-search/data/videoSearch", () => ({ fetchVideoSearch: vi.fn() }))

const shelfMock = vi.mocked(fetchOshiVideos)
const topicsMock = vi.mocked(fetchVideoTopics)
const searchMock = vi.mocked(fetchVideoSearch)
const LEGACY_A = toLegacyRosterId(getCreators()[0])

const TOPICS = [
  { id: "chatting", labels: { en: "Chatting" } },
  { id: "minecraft", labels: { en: "Minecraft" } },
  { id: "apex", labels: { en: "Apex" } },
  { id: "other", labels: { en: "Other" } },
]

const video = (videoId: string, title: string) => ({ videoId, title, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video" as const })
const searchHit = (title: string): VideoSearchResult => ({ ...video(`s_${title}`, title), topic: null, contentType: "upload" }) as unknown as VideoSearchResult

/** Each normal list is named after its own query, so "which list is showing" is readable from the screen. */
function installShelf() {
  shelfMock.mockReset().mockImplementation(async (query) => {
    const label = `${query.topic}/${query.contentType}/${query.sort}`
    return { videos: [video(`v_${label}`, `LIST ${label}`)], nextOffset: 1, hasMore: false }
  })
}

const searchBox = () => document.querySelector<HTMLInputElement>(".oshi-videos__search input")!
const shown = () => Array.from(document.querySelectorAll(".oshi-video-card__title")).map((node) => node.textContent)
const lastShelfQuery = () => shelfMock.mock.calls.at(-1)![0]
const callsFor = (topic: string) => shelfMock.mock.calls.filter(([query]) => query.topic === topic).length

async function renderHome() {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  topicsMock.mockResolvedValue(TOPICS)
  render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
  await screen.findByText("Minecraft")
}

beforeEach(() => {
  installShelf()
  topicsMock.mockReset()
  searchMock.mockReset().mockImplementation(async (query) => [searchHit(`HIT ${query.rawQuery}`)])
})

const typeQuery = (text: string) => fireEvent.change(searchBox(), { target: { value: text } })
const clearQuery = () => fireEvent.change(searchBox(), { target: { value: "" } })

describe("desktop search: typing and clearing", () => {
  it("a query shows its results in place of the topic list", async () => {
    await renderHome()
    await screen.findByText(/^LIST all\//)

    typeQuery("apex")

    await waitFor(() => expect(shown()).toEqual(["HIT apex"]))
  })

  it("deleting every character while the input is still focused restores the selected Topic's list (Minecraft)", async () => {
    await renderHome()
    await userEvent.setup().click(screen.getByText("Minecraft"))
    await screen.findByText(/^LIST minecraft\//)
    searchBox().focus()
    typeQuery("APEX")
    await waitFor(() => expect(shown()).toEqual(["HIT apex"]))
    const before = callsFor("minecraft")

    clearQuery()

    await waitFor(() => expect(shown().join()).toMatch(/^LIST minecraft\//))
    expect(document.activeElement).toBe(searchBox()) // focus decides nothing
    expect(searchBox().value).toBe("")
    expect(shown().some((title) => title?.startsWith("HIT"))).toBe(false)
    // Minecraft stays the selected Topic (ALL is never selected by clearing), and its list was fetched AGAIN, not merely left mounted.
    expect(lastShelfQuery().topic).toBe("minecraft")
    await waitFor(() => expect(callsFor("minecraft")).toBeGreaterThan(before))
  })

  it("with ALL selected, clearing restores ALL (and refreshes it)", async () => {
    await renderHome()
    await screen.findByText(/^LIST all\//)
    const before = callsFor("all")
    searchBox().focus()
    typeQuery("birth")
    await waitFor(() => expect(shown()).toEqual(["HIT birth"]))

    clearQuery()

    await waitFor(() => expect(shown().join()).toMatch(/^LIST all\//))
    expect(lastShelfQuery().topic).toBe("all")
    await waitFor(() => expect(callsFor("all")).toBeGreaterThan(before))
  })

  it("a search request still pending when the text is cleared can never bring its results back", async () => {
    let resolve!: (rows: VideoSearchResult[]) => void
    searchMock.mockImplementation(() => new Promise<VideoSearchResult[]>((done) => (resolve = done)))
    await renderHome()
    await userEvent.setup().click(screen.getByText("Minecraft"))
    await screen.findByText(/^LIST minecraft\//)
    searchBox().focus()
    typeQuery("apex")
    await waitFor(() => expect(searchMock).toHaveBeenCalled())

    clearQuery()
    await waitFor(() => expect(shown().join()).toMatch(/^LIST minecraft\//))
    resolve([searchHit("STALE RESULT")]) // the old request answers late

    await new Promise((done) => setTimeout(done, 60))
    expect(shown().join()).toMatch(/^LIST minecraft\//)
    expect(screen.queryByText("STALE RESULT")).not.toBeInTheDocument()
  })

  it("no Enter, Escape or outside click is needed: the very change that empties the input is enough", async () => {
    await renderHome()
    await screen.findByText(/^LIST all\//)
    typeQuery("apex")
    await waitFor(() => expect(shown()).toEqual(["HIT apex"]))

    clearQuery() // nothing else happens

    await waitFor(() => expect(shown().join()).toMatch(/^LIST all\//))
  })

  it("an emptied query that only holds spaces counts as empty too", async () => {
    await renderHome()
    await screen.findByText(/^LIST all\//)
    typeQuery("apex")
    await waitFor(() => expect(shown()).toEqual(["HIT apex"]))

    typeQuery("   ")

    await waitFor(() => expect(shown().join()).toMatch(/^LIST all\//))
  })
})

describe("content type, sort and period are untouched by a search and by clearing it", () => {
  it("the same selections feed the restored list, and the controls still show them", async () => {
    const user = userEvent.setup()
    await renderHome()
    await user.click(screen.getByText("Minecraft"))
    await user.selectOptions(screen.getByRole("combobox", { name: "Content type" }), "live")
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort videos" }), "mostViews")
    await screen.findByText(/^LIST minecraft\/live\/mostViews/)
    typeQuery("apex")
    await waitFor(() => expect(shown()).toEqual(["HIT apex"]))
    // the search itself carries the same selections
    expect(searchMock.mock.calls.at(-1)![0]).toMatchObject({ contentType: "live", sort: "mostViews" })

    clearQuery()

    await waitFor(() => expect(shown().join()).toMatch(/^LIST minecraft\/live\/mostViews/))
    expect(lastShelfQuery()).toMatchObject({ topic: "minecraft", contentType: "live", sort: "mostViews" })
    expect(screen.getByRole("combobox", { name: "Content type" })).toHaveValue("live")
    expect(screen.getByRole("combobox", { name: "Sort videos" })).toHaveValue("mostViews")
  })
})

describe("clicking a tag during a search still clears it and selects that tag (no double fetch of the abandoned list)", () => {
  it("Apex: the query is cleared and the Apex list loads", async () => {
    await renderHome()
    await screen.findByText(/^LIST all\//)
    typeQuery("apex")
    await waitFor(() => expect(shown()).toEqual(["HIT apex"]))

    await userEvent.setup().click(screen.getByText("Apex"))

    await waitFor(() => expect(searchBox().value).toBe(""))
    await waitFor(() => expect(shown().join()).toMatch(/^LIST apex\//))
  })
})
