/** A Premiere's waiting page (GET /live-streams status "premiere") must appear in ALL (and ALL narrowed to content
 * type "Videos") like any other upcoming item, but never in 最新直播 (Latest Live) or ALL narrowed to content type
 * "Live" -- a Premiere is not a livestream. */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import { fetchVideoTopics } from "../data/videoTopics"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import { getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.mock("../data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

const shelfMock = vi.mocked(fetchOshiVideos)
const topicsMock = vi.mocked(fetchVideoTopics)
const CREATOR = getCreators()[0]
const LEGACY_A = toLegacyRosterId(CREATOR)

const PREMIERE: LiveStreamDto = {
  videoId: "premiere-1",
  creatorId: CREATOR.creatorId,
  channelName: CREATOR.displayName,
  title: "A Premiere waiting page",
  status: "premiere",
  scheduledStart: "2026-10-25T10:00:00Z",
  actualStart: null,
  thumbnailUrl: "",
}

function mockStreams(streams: LiveStreamDto[]) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, isLoading: false, error: null })
}

const shown = () => Array.from(document.querySelectorAll(".oshi-video-card__title")).map((node) => node.textContent)

beforeEach(() => {
  shelfMock.mockReset().mockResolvedValue({ videos: [], nextOffset: 0, hasMore: false })
  topicsMock.mockReset().mockResolvedValue([])
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

async function renderHome() {
  render(<RecentVideosSection creatorId={LEGACY_A} onSelectVideo={vi.fn()} />)
  await waitFor(() => expect(shelfMock).toHaveBeenCalled())
}

describe("RecentVideosSection: Premiere visibility per tag", () => {
  it("ALL (default tag, default content type) includes the Premiere", async () => {
    mockStreams([PREMIERE])
    await renderHome()

    await waitFor(() => expect(shown()).toContain("A Premiere waiting page"))
  })

  it("Latest Live excludes the Premiere -- it is not a livestream", async () => {
    mockStreams([PREMIERE])
    await renderHome()

    await userEvent.setup().click(screen.getByText("Latest Live"))

    await waitFor(() => expect(shelfMock.mock.calls.some(([q]) => q.contentType === "live")).toBe(true))
    expect(shown()).not.toContain("A Premiere waiting page")
  })

  it("ALL narrowed to content type Live also excludes the Premiere", async () => {
    mockStreams([PREMIERE])
    await renderHome()
    await waitFor(() => expect(shown()).toContain("A Premiere waiting page"))

    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Content type" }), "live")

    await waitFor(() => expect(shown()).not.toContain("A Premiere waiting page"))
  })

  it("a real upcoming stream is unaffected by the Premiere exclusion rule and still shows under Latest Live", async () => {
    mockStreams([{ ...PREMIERE, videoId: "real-upcoming", status: "upcoming", title: "A real upcoming stream" }])
    await renderHome()

    await userEvent.setup().click(screen.getByText("Latest Live"))

    await waitFor(() => expect(shown()).toContain("A real upcoming stream"))
  })
})
