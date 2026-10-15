import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"

/** Home's Oshi Videos tag bar takes each fixed topic's id and localized label from GET /topics (data/videoTopics.ts,
 * hooks/useVideoTopicCatalog.ts), never from a frontend label table -- but the catalog does NOT decide WHICH topics the bar shows: it is
 * fixed at twelve options (see RecentVideosSection.fixedTagBar.test.tsx). A topic the catalog gains later therefore never appears here. See
 * RecentVideosSection.shelf.test.tsx for interaction coverage of today's real topics. */

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))

const fetchMock = vi.mocked(fetchOshiVideos)
const fetchTopicsMock = vi.mocked(fetchVideoTopics)

const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)

function page(ids: string[]): OshiVideosPage {
  return { videos: ids.map((videoId) => ({ videoId, title: `Title ${videoId}`, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video" })), nextOffset: ids.length, hasMore: false }
}

function renderSection() {
  return render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
}

/** The Segmented control's own rendered option labels, in DOM order -- the one
 * place this test can observe "what order did the tag bar actually render in",
 * independent of whatever order a test happened to list topics in its mock. */
function renderedTagLabels(): string[] {
  return Array.from(document.querySelectorAll(".oshi-videos__segment-label")).map((el) => el.textContent ?? "")
}

const lastQuery = () => fetchMock.mock.calls.at(-1)?.[0]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(page([]))
  fetchTopicsMock.mockReset()
})

describe("A. backend topics render from GET /topics", () => {
  it("renders a tag for every topic the mocked /topics response returns", async () => {
    fetchTopicsMock.mockResolvedValue([
      { id: "sf6", labels: { en: "SF6" } },
      { id: "chatting", labels: { en: "Chatting" } },
    ])
    renderSection()

    await screen.findByText("SF6")
    expect(screen.getByText("Chatting")).toBeInTheDocument()
  })
})

describe("B. a topic the catalog gains later is NOT added to the fixed Home bar", () => {
  it("stays out of the tag bar (it belongs to Search and the future Video Filter Dialog), while the fixed topics still render", async () => {
    const FUTURE_TOPIC: BackendVideoTopic = { id: "future-topic", labels: { en: "Future Topic" } }
    fetchTopicsMock.mockResolvedValue([{ id: "sf6", labels: { en: "SF6" } }, FUTURE_TOPIC])
    renderSection()

    await screen.findByText("SF6")
    expect(screen.queryByText("Future Topic")).not.toBeInTheDocument()
  })
})

describe("C. topics follow the product display order (not alphabetical, not the order /topics returned them)", () => {
  it("renders Chatting, MV, VALO in that order whatever order /topics returned them", async () => {
    fetchTopicsMock.mockResolvedValue([
      { id: "valorant", labels: { en: "VALO" } },
      { id: "mv", labels: { en: "MV" } },
      { id: "chatting", labels: { en: "Chatting" } },
    ])
    renderSection()

    await screen.findByText("MV")
    const labels = renderedTagLabels()
    const indexOf = (label: string) => labels.indexOf(label)
    expect(indexOf("Chatting")).toBeGreaterThanOrEqual(0)
    expect(indexOf("Chatting")).toBeLessThan(indexOf("MV"))
    expect(indexOf("MV")).toBeLessThan(indexOf("VALO"))
  })

  it("topics the backend adds later are never appended after the known ones", async () => {
    fetchTopicsMock.mockResolvedValue([
      { id: "new_topic_b", labels: { en: "New B" } },
      { id: "new_topic_a", labels: { en: "New A" } },
      { id: "valorant", labels: { en: "VALO" } },
    ])
    renderSection()

    await screen.findByText("VALO")
    const labels = renderedTagLabels()
    expect(labels).not.toContain("New B")
    expect(labels).not.toContain("New A")
    expect(labels.slice(-2)).toEqual(["VALO", "Short"]) // the bar ends VALO, Short (the Other topic is not in this response)
  })
})

describe("D. the 3 special filters are frontend-owned and always present", () => {
  it("renders ALL / Latest Videos / Latest Live before any backend topic, regardless of what /topics returns", async () => {
    fetchTopicsMock.mockResolvedValue([{ id: "sf6", labels: { en: "SF6" } }])
    renderSection()

    await screen.findByText("SF6")
    const labels = renderedTagLabels()
    expect(labels.slice(0, 3)).toEqual(["ALL", "Latest Videos", "Latest Live"])
    expect(labels.indexOf("SF6")).toBeGreaterThan(2)
  })
})

describe("E. today's real singing/mv topics still behave correctly", () => {
  it("歌回 (singing) and MV (mv) each send their own id, never each other's", async () => {
    fetchTopicsMock.mockResolvedValue([
      { id: "singing", labels: { en: "Singing" } },
      { id: "mv", labels: { en: "MV" } },
    ])
    renderSection()
    const user = userEvent.setup()

    await user.click(await screen.findByText("Singing"))
    await waitFor(() => expect(lastQuery()).toMatchObject({ topic: "singing" }))

    await user.click(await screen.findByText("MV"))
    await waitFor(() => expect(lastQuery()).toMatchObject({ topic: "mv" }))
  })
})

describe("F. a failed /topics fetch shows no stale hardcoded topic list", () => {
  it("still renders the 3 special filters, with no crash and none of today's real topic labels", async () => {
    fetchTopicsMock.mockRejectedValue(new Error("network error"))
    renderSection()

    await screen.findByText("ALL")
    expect(screen.getByText("Latest Videos")).toBeInTheDocument()
    expect(screen.getByText("Latest Live")).toBeInTheDocument()
    for (const staleLabel of ["SF6", "VALO", "Minecraft", "Apex", "Singing", "MV", "Chatting", "Other"]) {
      expect(screen.queryByText(staleLabel)).not.toBeInTheDocument()
    }
  })
})
