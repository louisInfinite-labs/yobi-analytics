/** A YouTube Premiere's NEW / unwatched behavior on the REAL HomePage. The backend's newContent eligibility lists a Premiere from the moment it was discovered, but the video only
 * becomes NEW (and counts as unwatched) once its archive is confirmed available; at every earlier stage (announced/upcoming, airing, archive pending or handed off) it is visible
 * but neither counted nor badged, so the count never moves until a watchable archive exists. Opening its waiting page or a pending-archive entry never marks it watched. At every
 * pre-archive stage the API also serves a bare provisional row for the same videoId (built from the announcement event, carrying the Premiere's scheduled start): it must never
 * hide the stream/placeholder row, nor be counted or badged itself. The same videoId is used at every stage, and each stage is a separate render over the same persisted
 * browser state (as a revisit would be).
 * Only `fetch` and the YouTube IFrame API are faked. */
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { creatorPath } from "../../app/navigation/creatorRoutes"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { loadYouTubeIframeApi } from "../../features/media-player/utils/youtubeIframeApi"
import { resetHomeSelectedVideoForTests } from "../../features/home-room/hooks/useHomeSelectedVideo"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { liveStreamsStore } from "../../shared/api/liveStreamsStore"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/media-player/utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

const [CREATOR_A] = getCreators().filter((creator) => creator.active)
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const ROUTE_A = creatorPath(CREATOR_A)
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"
const SEEN_KEY = "yobi.newContent.seenVideoIds"

const PREMIERE = "PREMIERE001"
const OTHER_UPLOAD = "UPLOAD00001"
const LIVE_ARCHIVE = "LIVEARCH001"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

/** The lifecycle stage the faked backend is in for the one Premiere under test. */
type Stage = "upcoming" | "airing" | "pending" | "handedOff" | "archived"
let stage: Stage
/** When set, /live-streams answers only after it resolves (a delayed response); when true it fails with a server error. */
let liveStreamsGate: Promise<void> | null
let liveStreamsFails: boolean
/** Extra fields for the Premiere replay row of the "archived" stage (for example the archive-availability time the backend attaches). */
let replayRowFields: Record<string, unknown>
/** Whether the API also serves the bare provisional row built from the announcement event while the Premiere has no archive yet (what it does for an announced Premiere). */
let provisionalRow: boolean

/** Videos the faked /videos/recent archive page serves, and the ids its newContent eligibility lists (the Premiere is always listed: it has been discovered). */
function archivePage() {
  const rows: Record<string, unknown>[] = [
    { videoId: OTHER_UPLOAD, title: "Ordinary upload", publishedAt: "2026-10-20T10:00:00Z", contentType: "upload", currentViewCount: 1, discoveredAt: "2026-10-20T10:00:00Z" },
    { videoId: LIVE_ARCHIVE, title: "Completed livestream", publishedAt: "2026-10-19T10:00:00Z", contentType: "live", liveStatus: "completed", currentViewCount: 1, discoveredAt: "2026-10-19T10:00:00Z" },
  ]
  if (provisionalRow && stage !== "archived") {
    // The announcement's provisional row: no contentType, the creation date as publishedAt (long before the Premiere airs), discovered now.
    // The API presents the scheduled start as publishedAt and also serves it as scheduledStart (the marker of an announced Premiere); the creation date is never exposed.
    const start = stage === "upcoming" ? inHours(48) : stage === "airing" ? inHours(-1) : inHours(-3)
    rows.push({ videoId: PREMIERE, title: "Premiere announced (provisional)", publishedAt: start, scheduledStart: start, contentType: null, currentViewCount: 0, discoveredAt: inHours(-1), provisional: true })
  }
  if (stage === "archived") {
    rows.unshift({ videoId: PREMIERE, title: "Premiere replay", publishedAt: inHours(-3), contentType: "upload", currentViewCount: 1, discoveredAt: "2026-10-18T10:00:00Z", ...replayRowFields })
  }
  const newContent = {
    since: "2026-01-01T00:00:00Z",
    counts: { videos: 2, livestreams: 1, unclassified: 1 },
    videoIds: [OTHER_UPLOAD, PREMIERE].join(","),
    livestreamIds: LIVE_ARCHIVE,
    unclassifiedIds: "",
  }
  return { videos: rows, hasMore: false, newContent }
}

function liveStreamsBody() {
  const streams =
    stage === "upcoming"
      ? [{ videoId: PREMIERE, creatorId: CREATOR_A.creatorId, channelName: "c", title: "Premiere waiting page", status: "premiere", scheduledStart: inHours(48), actualStart: null, thumbnailUrl: "", topic: null }]
      : []
  const archiveStatus = stage === "pending" ? "pending" : stage === "handedOff" ? "handed_off_to_daily_task" : null
  const recentlyEnded = archiveStatus
    ? [
        {
          videoId: PREMIERE,
          creatorId: CREATOR_A.creatorId,
          title: "Premiere ended, archive pending",
          actualStart: inHours(-3),
          scheduledStart: inHours(-3),
          actualEnd: inHours(-1),
          confirmedEndedAt: inHours(-1),
          lastSeenLiveAt: inHours(-1),
          endState: "ended",
          archive: { status: archiveStatus },
        },
      ]
    : []
  return { streams, recentlyEnded }
}

function installApi() {
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === "/live-streams") {
        if (liveStreamsGate) await liveStreamsGate
        return liveStreamsFails ? new Response("unavailable", { status: 503 }) : json(liveStreamsBody())
      }
      if (url.pathname === "/topics") return json({ topics: [] })
      const match = url.pathname.match(/^\/creators\/([^/]+)\/(videos\/recent|oshi-status)$/)
      if (!match) return new Response("{}", { status: 404 })
      if (match[2] === "oshi-status") {
        return json({
          subscriberCount: 1,
          latestVideo: null,
          thisWeek: { newUploads: 0, newStreams: 0 },
          growth: { "1d": { absoluteGrowth: 0, videoCount: 0 }, "7d": { absoluteGrowth: 0, videoCount: 0 }, "30d": { absoluteGrowth: 0, videoCount: 0 } },
          sinceLastVisit: null,
        })
      }
      const page = archivePage()
      return json(url.searchParams.get("newSince") ? page : { videos: page.videos, hasMore: false })
    }),
  )
}

beforeEach(() => {
  stage = "upcoming"
  liveStreamsGate = null
  liveStreamsFails = false
  replayRowFields = {}
  provisionalRow = true
  installApi()
  vi.mocked(loadYouTubeIframeApi).mockReset()
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ PlayerState: { PLAYING: 1 }, Player: class {} } as never)
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.localStorage.setItem(BASELINE_KEY, "2026-01-01T00:00:00.000Z")
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  resetHomeSelectedVideoForTests()
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](LEGACY_A))
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  window.history.replaceState({}, "", ROUTE_A)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  window.history.replaceState({}, "", "/")
})

/** A shared-state reset also forgets the selected creator (what loading /creator/<slug> does): select creator A again. */
function selectCreatorA() {
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](LEGACY_A))
}

const seen = () => JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]") as string[]
const playerSrc = () => document.querySelector<HTMLIFrameElement>(".oshi-player-frame iframe")?.getAttribute("src") ?? ""

/** Renders Home for the current stage and waits until Oshi Status lists the ordinary upload (the archive page has loaded). */
async function renderHome() {
  const view = render(<HomePage />)
  await screen.findAllByRole("button", { name: "Ordinary upload", hidden: true })
  return view
}

/** The Oshi Status "Not watched yet" counts: [Videos, Livestreams]. */
function unwatchedCounts(): string[] {
  const section = screen.getByText("Not watched yet").closest("section") as HTMLElement
  return Array.from(section.querySelectorAll(".oshi-status__metric-value")).map((node) => node.textContent ?? "")
}

/** The Oshi Status Recent Activity row of one video (by its title button). */
function activityRow(title: string): HTMLElement {
  const link = Array.from(document.querySelectorAll<HTMLElement>(".oshi-status__recent-video-link")).find((node) => node.textContent === title)
  if (!link) throw new Error(`no Recent Activity row titled ${title}`)
  return link.closest(".oshi-status__recent-row") as HTMLElement
}

const hasBadge = (row: HTMLElement) => row.querySelector(".oshi-status__recent-new-badge") !== null

/** The title button of a Recent Activity row (the row also holds a thumbnail button with its own accessible name). */
const titleButton = (row: HTMLElement) => row.querySelector(".oshi-status__recent-video-link") as HTMLElement

describe("a Premiere before its archive is confirmed", () => {
  it("upcoming: visible in Oshi Status, not NEW, and not counted although the backend eligibility already lists it", async () => {
    await renderHome()

    const row = await waitFor(() => activityRow("Premiere waiting page"))
    expect(hasBadge(row)).toBe(false)
    expect(unwatchedCounts()).toEqual(["1", "1"]) // only the ordinary upload and the completed livestream
    expect(screen.getAllByRole("button", { name: /Premiere waiting page/ }).length).toBeGreaterThan(0) // also visible in the Video List
    expect(() => activityRow("Premiere announced (provisional)")).toThrow() // the provisional row never replaces or duplicates the stream row
  })

  it.each([
    ["pending", "pending"],
    ["handedOff", "handed off for processing"],
  ] as const)("archive %s: visible, not NEW, not counted (%s)", async (next, _description) => {
    stage = next
    await renderHome()

    const row = await waitFor(() => activityRow("Premiere ended, archive pending"))
    expect(hasBadge(row)).toBe(false)
    expect(unwatchedCounts()).toEqual(["1", "1"]) // the pending placeholder wins over the provisional announcement row, so the Premiere stays out of the count
    expect(() => activityRow("Premiere announced (provisional)")).toThrow()
  })

  it("the provisional announcement row never decides the Premiere's position: it sorts by its real start, first in Recent Activity, not by its creation date", async () => {
    for (const next of ["upcoming", "pending"] as const) {
      stage = next
      resetHomeSelectedVideoForTests()
      const view = await renderHome()
      const titles = await waitFor(() => {
        const found = Array.from(document.querySelectorAll(".oshi-status__recent-video-link")).map((node) => node.textContent)
        if (!found.some((title) => title?.startsWith("Premiere"))) throw new Error("not rendered yet")
        return found
      })
      expect(titles[0]?.startsWith("Premiere")).toBe(true) // 2026-10-01 (creation date) would have put it last
      view.unmount()
    }
  })

  it("opening the waiting page selects it in the player but never marks it watched", async () => {
    await renderHome()
    await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere waiting page"))))

    await waitFor(() => expect(playerSrc()).toContain(`/embed/${PREMIERE}?`))
    expect(seen()).not.toContain(PREMIERE)
  })

  it("opening it from the Video List card never marks it watched either", async () => {
    await renderHome()
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".oshi-video-card img[src*='PREMIERE001']")?.closest("button")
      if (!found) throw new Error("card not rendered yet")
      return found
    })
    await userEvent.setup().click(card)

    await waitFor(() => expect(playerSrc()).toContain(`/embed/${PREMIERE}?`))
    expect(seen()).not.toContain(PREMIERE)
  })

  it("opening a pending-archive entry (or one handed off) never marks the eventual archive watched", async () => {
    for (const next of ["pending", "handedOff"] as const) {
      stage = next
      resetHomeSelectedVideoForTests()
      const view = await renderHome()
      await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere ended, archive pending"))))
      await waitFor(() => expect(playerSrc()).toContain(`/embed/${PREMIERE}?`))
      expect(seen()).not.toContain(PREMIERE)
      view.unmount()
    }
  })
})

describe("the airing window: the Premiere has left the live list and no ended record exists yet", () => {
  it("only the provisional announcement row is served for the videoId: it is visible, but neither counted nor badged, and sorts by the Premiere's start", async () => {
    stage = "airing" // /live-streams lists nothing for it, recentlyEnded is empty, the API still serves the provisional row
    await renderHome()

    const row = await waitFor(() => activityRow("Premiere announced (provisional)"))
    expect(hasBadge(row)).toBe(false)
    expect(unwatchedCounts()).toEqual(["1", "1"]) // the count stays exactly where it was while announced
    expect(Array.from(document.querySelectorAll(".oshi-status__recent-video-link")).map((node) => node.textContent)[0]).toBe("Premiere announced (provisional)") // not at its creation date
  })

  it("opening it from there never marks it watched", async () => {
    stage = "airing"
    await renderHome()
    await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere announced (provisional)"))))

    await waitFor(() => expect(playerSrc()).toContain(`/embed/${PREMIERE}?`))
    expect(seen()).not.toContain(PREMIERE)
  })
})

describe("the confirmed archive", () => {
  it("counts exactly once and shows NEW when unwatched, even after the stages above were visited without watching", async () => {
    for (const earlier of ["upcoming", "pending", "handedOff"] as const) {
      stage = earlier
      resetHomeSelectedVideoForTests()
      const view = await renderHome()
      await userEvent.setup().click(await waitFor(() => titleButton(activityRow(earlier === "upcoming" ? "Premiere waiting page" : "Premiere ended, archive pending"))))
      view.unmount()
    }
    expect(seen()).toEqual([]) // visiting never marked it

    stage = "archived"
    await renderHome()

    const row = await waitFor(() => activityRow("Premiere replay"))
    expect(hasBadge(row)).toBe(true)
    expect(unwatchedCounts()).toEqual(["2", "1"]) // the Premiere replay once, plus the ordinary upload
    expect(document.querySelectorAll(".oshi-status__recent-video-link").length).toBe(new Set(Array.from(document.querySelectorAll(".oshi-status__recent-video-link")).map((n) => n.textContent)).size) // no duplicate row
  })

  it("watching it clears the NEW badge and the count, and it stays cleared across a revisit", async () => {
    stage = "archived"
    const view = await renderHome()
    await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere replay"))))

    await waitFor(() => expect(seen()).toContain(PREMIERE))
    expect(hasBadge(activityRow("Premiere replay"))).toBe(false)
    expect(unwatchedCounts()).toEqual(["1", "1"])
    view.unmount()

    resetAllSharedStateForTests() // a reload: in-memory state is gone, localStorage is not
    await renderHome()
    expect(hasBadge(await waitFor(() => activityRow("Premiere replay")))).toBe(false)
    expect(unwatchedCounts()).toEqual(["1", "1"])
  })

  it("normal videos and completed livestreams keep their behavior: both are NEW and counted, and opening them marks them watched", async () => {
    stage = "archived"
    await renderHome()
    expect(unwatchedCounts()).toEqual(["2", "1"])
    const user = userEvent.setup()

    await user.click(titleButton(activityRow("Ordinary upload")))
    await user.click(titleButton(activityRow("Completed livestream")))

    await waitFor(() => expect(seen().sort()).toEqual([LIVE_ARCHIVE, OTHER_UPLOAD]))
    expect(unwatchedCounts()).toEqual(["1", "0"])
  })
})

describe("mark all watched", () => {
  it("never marks a Premiere that is not a confirmed archive yet, and marks it once the archive is confirmed", async () => {
    window.localStorage.setItem("yobi.confirmMarkAllWatched", "false") // no confirmation dialog: mark at once
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useSelectedCreator()) // the reset also forgot the selected creator
    act(() => result.current[1](LEGACY_A))
    const upcoming = await renderHome()
    await waitFor(() => activityRow("Premiere waiting page")) // the live feed has loaded, so the Premiere is known to be upcoming
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mark all watched" }))
    await waitFor(() => expect(seen()).toContain(OTHER_UPLOAD))
    expect(seen()).not.toContain(PREMIERE)
    expect(unwatchedCounts()).toEqual(["0", "1"]) // the upload was marked; the Premiere was never in the count
    expect(screen.getByRole("button", { name: "Mark all watched" })).toBeDisabled() // nothing outstanding any more
    upcoming.unmount()

    stage = "archived"
    resetHomeSelectedVideoForTests()
    await renderHome()
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mark all watched" }))
    await waitFor(() => expect(seen()).toContain(PREMIERE))
  })
})


describe("the first visit falls before the archive is available", () => {
  /** The user's first-ever visit (the tracking baseline) is 18:50 on the day the Premiere is still waiting; the Premiere had been announced earlier (discoveredAt
   * 2026-10-18, before the baseline) and its replay became available later. */
  const FIRST_VISIT = "2026-10-19T09:50:00.000Z"

  it("the replay is NEW once the backend reports its archive-availability time, even though the announcement predates the baseline", async () => {
    window.localStorage.setItem(BASELINE_KEY, FIRST_VISIT)
    stage = "upcoming"
    resetAllSharedStateForTests()
    selectCreatorA()
    const earlier = await renderHome()
    await waitFor(() => activityRow("Premiere waiting page"))
    expect(hasBadge(activityRow("Premiere waiting page"))).toBe(false) // the announcement is never NEW
    earlier.unmount()

    stage = "archived"
    replayRowFields = { archiveAvailableAt: "2026-10-19T11:00:00Z" } // 20:00: after the baseline
    resetAllSharedStateForTests()
    selectCreatorA()
    resetHomeSelectedVideoForTests()
    const revisit = await renderHome()

    expect(hasBadge(await waitFor(() => activityRow("Premiere replay")))).toBe(true)
    revisit.unmount()
    resetAllSharedStateForTests() // another revisit
    selectCreatorA()
    resetHomeSelectedVideoForTests()
    await renderHome()
    expect(hasBadge(await waitFor(() => activityRow("Premiere replay")))).toBe(true)
  })

  it("without an availability time the existing first-use baseline rule decides, exactly as for any ordinary video", async () => {
    window.localStorage.setItem(BASELINE_KEY, FIRST_VISIT)
    stage = "archived"
    resetAllSharedStateForTests()
    selectCreatorA()
    await renderHome()

    expect(hasBadge(await waitFor(() => activityRow("Premiere replay")))).toBe(false) // discovered 2026-10-18, before the 2026-10-19 baseline
  })

  it("watching the replay clears its NEW state and it stays cleared", async () => {
    window.localStorage.setItem(BASELINE_KEY, FIRST_VISIT)
    stage = "archived"
    replayRowFields = { archiveAvailableAt: "2026-10-19T11:00:00Z" }
    resetAllSharedStateForTests()
    selectCreatorA()
    const view = await renderHome()
    await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere replay"))))
    await waitFor(() => expect(seen()).toContain(PREMIERE))
    expect(hasBadge(activityRow("Premiere replay"))).toBe(false)
    view.unmount()

    resetAllSharedStateForTests()
    selectCreatorA()
    resetHomeSelectedVideoForTests()
    await renderHome()
    expect(hasBadge(await waitFor(() => activityRow("Premiere replay")))).toBe(false)
    expect(seen().filter((id) => id === PREMIERE)).toHaveLength(1) // no duplicate watched record
  })
})

describe("before the live status has answered", () => {
  it("shows no NEW badge and no count (unavailable), then the settled counts once /live-streams answers", async () => {
    let openGate: () => void = () => undefined
    liveStreamsGate = new Promise<void>((resolve) => (openGate = resolve))
    render(<HomePage />)
    await screen.findAllByRole("button", { name: "Ordinary upload", hidden: true }) // the archive page and its eligibility have loaded; /live-streams has not

    expect(unwatchedCounts()).toEqual(["—", "—"]) // no count that could include the still-unknown Premiere
    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Mark all watched" })).toBeDisabled()

    openGate()
    await waitFor(() => expect(unwatchedCounts()).toEqual(["1", "1"]))
    expect(hasBadge(activityRow("Ordinary upload"))).toBe(true)
    expect(hasBadge(activityRow("Premiere waiting page"))).toBe(false)
  })

  it("a failed /live-streams with no earlier answer never counts a Premiere: the counts and badges are unavailable, but nothing is left loading", async () => {
    liveStreamsFails = true
    await renderHome()

    await waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false)) // the read settled (as a failure), it is not waiting for ever
    expect(liveStreamsStore.get().error).not.toBeNull()
    expect(activityRow("Ordinary upload")).toBeTruthy() // the list itself is shown, not a skeleton
    expect(unwatchedCounts()).toEqual(["—", "—"]) // unavailable: the upcoming Premiere is never mistaken for a new upload
    expect(document.querySelectorAll(".oshi-status__recent-new-badge")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Mark all watched" })).toBeDisabled()
  })

  it("a failed /live-streams with the last known answer keeps using it: the Premiere stays out of the counts and the ordinary video is counted", async () => {
    // What an earlier session (or an earlier poll) left behind: the Premiere was still upcoming.
    window.localStorage.setItem(
      "yobi.liveStreams.cache",
      JSON.stringify({ ...{ streams: liveStreamsBody().streams }, recentlyEnded: [], isLoading: false, error: null }),
    )
    resetAllSharedStateForTests()
    selectCreatorA()
    liveStreamsFails = true
    await renderHome()

    await waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))
    expect(liveStreamsStore.get().error).not.toBeNull()
    await waitFor(() => expect(unwatchedCounts()).toEqual(["1", "1"])) // the upload and the completed livestream; the Premiere is not counted
    expect(hasBadge(activityRow("Ordinary upload"))).toBe(true)
    expect(hasBadge(activityRow("Premiere waiting page"))).toBe(false)
  })

  it("a pending-archive Premiere is not counted at any moment of the load either", async () => {
    stage = "pending"
    let openGate: () => void = () => undefined
    liveStreamsGate = new Promise<void>((resolve) => (openGate = resolve))
    render(<HomePage />)
    await screen.findAllByRole("button", { name: "Ordinary upload", hidden: true })
    const seenCounts: string[][] = [unwatchedCounts()]

    openGate()
    await waitFor(() => expect(unwatchedCounts()).toEqual(["1", "1"]))
    seenCounts.push(unwatchedCounts())

    expect(seenCounts[0]).toEqual(["—", "—"]) // unavailable until the live status is known
    expect(seenCounts.flat().filter((value) => value === "2")).toHaveLength(0) // the Premiere was never added on top of the upload
  })
})


describe("one fixed videoId through the whole lifecycle", () => {
  it("is not counted and has no NEW badge at any pre-archive stage, becomes counted once and NEW only on the confirmed archive, is never marked by a waiting-page click, and stops counting once watched", async () => {
    const trail: Array<{ stage: Stage; count: string; badge: boolean; title: string }> = []
    for (const next of ["upcoming", "airing", "pending", "handedOff", "archived"] as const) {
      stage = next
      replayRowFields = next === "archived" ? { archiveAvailableAt: inHours(-2) } : {}
      resetAllSharedStateForTests()
      selectCreatorA()
      resetHomeSelectedVideoForTests()
      const view = await renderHome()
      const title = next === "upcoming" ? "Premiere waiting page" : next === "archived" ? "Premiere replay" : next === "airing" ? "Premiere announced (provisional)" : "Premiere ended, archive pending"
      const row = await waitFor(() => activityRow(title))
      await waitFor(() => expect(unwatchedCounts()[0]).toMatch(/^\d+$/))
      trail.push({ stage: next, count: unwatchedCounts()[0], badge: hasBadge(row), title })
      if (next !== "archived") {
        await userEvent.setup().click(titleButton(row)) // a click on the waiting page / pending entry is not watching the finished video
        await waitFor(() => expect(playerSrc()).toContain(`/embed/${PREMIERE}?`))
        expect(seen()).not.toContain(PREMIERE)
      }
      view.unmount()
    }
    expect(trail.map((entry) => [entry.stage, entry.count, entry.badge])).toEqual([
      ["upcoming", "1", false],
      ["airing", "1", false],
      ["pending", "1", false],
      ["handedOff", "1", false],
      ["archived", "2", true],
    ])

    stage = "archived"
    resetAllSharedStateForTests()
    selectCreatorA()
    resetHomeSelectedVideoForTests()
    await renderHome()
    await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere replay"))))
    await waitFor(() => expect(seen()).toEqual([PREMIERE]))
    expect(unwatchedCounts()).toEqual(["1", "1"]) // watched once: no longer counted, and nothing else changed
  })
})

describe("returning long after the archive became available", () => {
  const FIRST_VISIT = "2026-10-19T09:50:00.000Z"

  it("the lifecycle record is gone (a replay available days ago), yet the unwatched replay is still NEW and counted exactly once until it is watched", async () => {
    window.localStorage.setItem(BASELINE_KEY, FIRST_VISIT)
    stage = "archived" // nothing is in /live-streams any more: no lifecycle record is retained
    replayRowFields = { archiveAvailableAt: "2026-10-19T11:00:00Z" } // the durable time the API now serves from its own record, days after the 36-hour retention
    resetAllSharedStateForTests()
    selectCreatorA()
    const view = await renderHome()

    const row = await waitFor(() => activityRow("Premiere replay"))
    expect(hasBadge(row)).toBe(true)
    expect(unwatchedCounts()).toEqual(["2", "1"]) // the replay (once) and the ordinary upload
    expect(Array.from(document.querySelectorAll(".oshi-status__recent-video-link")).filter((node) => node.textContent === "Premiere replay")).toHaveLength(1)
    view.unmount()

    expect(seen()).toEqual([]) // merely viewing the list never marks anything watched

    resetAllSharedStateForTests()
    selectCreatorA()
    resetHomeSelectedVideoForTests()
    await renderHome()
    await userEvent.setup().click(await waitFor(() => titleButton(activityRow("Premiere replay"))))
    await waitFor(() => expect(seen()).toEqual([PREMIERE]))
    expect(unwatchedCounts()).toEqual(["1", "1"])
  })

  it("the same videoId is counted once through every stage of a revisit sequence ", async () => {
    window.localStorage.setItem(BASELINE_KEY, FIRST_VISIT)
    const countsAtEachStage: string[] = []
    for (const next of ["upcoming", "airing", "pending", "handedOff", "archived"] as const) {
      stage = next
      replayRowFields = next === "archived" ? { archiveAvailableAt: "2026-10-19T11:00:00Z" } : {}
      resetAllSharedStateForTests()
      selectCreatorA()
      resetHomeSelectedVideoForTests()
      const view = await renderHome()
      await waitFor(() => expect(unwatchedCounts()[0]).toMatch(/^\d+$/))
      countsAtEachStage.push(unwatchedCounts()[0])
      view.unmount()
    }

    expect(countsAtEachStage).toEqual(["1", "1", "1", "1", "2"]) // only the ordinary upload until the archive is available (no dip, no rise), then the replay joins once
  })
})
