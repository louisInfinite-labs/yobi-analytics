import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import * as liveStreams from "../../shared/api/liveStreams"

// The Schedule creator filter and the Schedule grid work from the SAME effective data: the dialog offers only creators that have an event on
// the displayed days (today .. +6, local time), inside the chosen organization (ALL = VSPO + Hololive, VSPO = JP + EN, Hololive = JP + EN + ID).

Element.prototype.scrollIntoView ??= () => {}

vi.mock("../../shared/api/liveStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/liveStreams")>()),
  fetchLiveStreams: vi.fn(),
}))

// "now" = Wed 2026-09-23 12:00 local; the displayed range is Sep 23 .. Sep 29.
const local = (day: number, hour: number, minute = 0, month = 8) => new Date(2026, month, day, hour, minute, 0).toISOString()
const up = (videoId: string, creatorId: string, start: string): liveStreams.LiveStreamDto => ({
  videoId,
  creatorId,
  channelName: creatorId,
  title: videoId,
  status: "upcoming",
  scheduledStart: start,
  actualStart: null,
  thumbnailUrl: "",
  topic: null,
})

const IN_RANGE = [
  up("EMA", "aizawa_ema", local(24, 20)), // VSPO JP
  up("REMIA", "remia_aotsuki", local(25, 21)), // VSPO EN
  up("PEKORA", "usada_pekora", local(24, 18)), // Hololive JP
  up("GURA", "gawr_gura", local(26, 10)), // Hololive EN
  up("IOFI", "airani_iofifteen", local(27, 14)), // Hololive ID
]
// Creators in the roster whose only events are OUTSIDE the displayed days: they must not be offered.
const OUT_OF_RANGE = [
  up("SUMIRE-DAY8", "kaga_sumire", local(30, 12)), // Sep 30 00:00+ = day 8
  up("NAZUNA-YESTERDAY", "kaga_nazuna", local(22, 23, 59)), // Sep 22 23:59 = the day before
  up("FUBUKI-DAY8-MIDNIGHT", "shirakami_fubuki", local(30, 0)), // exactly the next midnight
]

const NAME = { EMA: "藍沢エマ", REMIA: "青月レミア", PEKORA: "兎田ぺこら", GURA: "Gawr Gura", IOFI: "Airani Iofifteen" }
const VSPO_NAMES = [NAME.EMA, NAME.REMIA].sort()
const HOLO_NAMES = [NAME.PEKORA, NAME.GURA, NAME.IOFI].sort()

const shown = () => Array.from(document.querySelectorAll(".stream-avatar-button")).map((node) => node.getAttribute("aria-label")!).sort()
const tiles = () => Array.from(document.querySelectorAll<HTMLElement>(".schedule-creator-item"))
const tileNames = () => tiles().map((tile) => tile.querySelector(".creator-tile__name")!.textContent ?? "").sort()
const headings = () => Array.from(document.querySelectorAll(".schedule-creator-drawer .live-status-group__heading")).map((node) => node.textContent)
const segment = (name: "All" | "VSPO" | "Hololive") => screen.getByRole("radio", { name }).closest("label")!
const tileFor = (name: string) => tiles().find((tile) => tile.querySelector(".creator-tile__name")?.textContent === name)!

async function renderPage(streams: liveStreams.LiveStreamDto[], expectedShown: number) {
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue(streams)
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, pointerEventsCheck: 0 })
  render(<LiveSchedulePage />)
  if (expectedShown > 0) await waitFor(() => expect(shown()).toHaveLength(expectedShown))
  else await waitFor(() => expect(vi.mocked(liveStreams.fetchLiveStreams)).toHaveBeenCalled())
  return user
}
async function openFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Filter by creator" }))
  await screen.findByRole("radiogroup", { name: "Organization" })
}
const search = (user: ReturnType<typeof userEvent.setup>, text: string) =>
  user.type(within(document.querySelector<HTMLElement>(".schedule-creator-drawer")!).getByPlaceholderText("Search creators"), text)

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 8, 23, 12, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the creator choices come from the displayed schedule", () => {
  it("ALL offers exactly the creators with an event on the schedule, across both organizations -- no one else from the roster", async () => {
    const user = await renderPage([...IN_RANGE, ...OUT_OF_RANGE], 5)
    await openFilter(user)

    expect(tileNames()).toEqual([...VSPO_NAMES, ...HOLO_NAMES].sort())
    expect(headings()).toEqual(["VSPO! // JP", "VSPO! // EN", "HOLOLIVE // JP", "HOLOLIVE // EN", "HOLOLIVE // ID"])
  })

  it("a creator with no event on the schedule is not a choice (nothing in range, a day-8 stream, yesterday's stream, the next midnight)", async () => {
    const user = await renderPage([...IN_RANGE, ...OUT_OF_RANGE], 5)
    await openFilter(user)

    for (const absent of ["花芽すみれ", "花芽なずな", "白上フブキ", "一ノ瀬うるは"]) expect(tileNames()).not.toContain(absent)
    expect(tiles()).toHaveLength(5)
  })

  it("a creator with an event appears, under her own organization's heading", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)

    const ema = tileFor(NAME.EMA)
    expect(ema).toBeDefined()
    const group = ema.closest(".live-status-group") as HTMLElement
    expect(group.querySelector(".live-status-group__heading")?.textContent).toBe("VSPO! // JP")
    expect(tileFor(NAME.PEKORA).closest(".live-status-group")!.querySelector(".live-status-group__heading")?.textContent).toBe("HOLOLIVE // JP")
  })

  it("the date range is the grid's own: the last 23:30 slot of the last day counts, the next midnight and the day before do not", async () => {
    const user = await renderPage(
      [up("LAST-SLOT", "kaga_sumire", local(29, 23, 30)), up("FIRST-SLOT", "kaga_nazuna", local(23, 0)), ...OUT_OF_RANGE],
      2,
    )
    await openFilter(user)

    expect(tileNames()).toEqual(["花芽すみれ", "花芽なずな"].sort())
    expect(shown()).toEqual(["FIRST-SLOT", "LAST-SLOT"])
  })

  it("keeps avatar, name and the shared creator-tile structure", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)

    const ema = tileFor(NAME.EMA)
    expect(ema.querySelector(".schedule-creator-item__avatar, .creator-tile__avatar-wrap img, .creator-tile__avatar-wrap")).not.toBeNull()
    expect(ema.querySelector(".creator-tile__name")?.textContent).toBe(NAME.EMA)
  })
})

describe("ALL / VSPO / Hololive work in the dialog AND on the schedule", () => {
  it("VSPO: only the schedule's VSPO creators in the dialog (JP + EN), and only VSPO events on the grid", async () => {
    const user = await renderPage([...IN_RANGE, ...OUT_OF_RANGE], 5)
    await openFilter(user)

    await user.click(segment("VSPO"))

    expect(tileNames()).toEqual(VSPO_NAMES)
    expect(headings()).toEqual(["VSPO! // JP", "VSPO! // EN"])
    expect(shown()).toEqual(["EMA", "REMIA"])
  })

  it("Hololive: only the schedule's Hololive creators (JP + EN + ID), no VSPO row left over, and only Hololive events on the grid", async () => {
    const user = await renderPage([...IN_RANGE, ...OUT_OF_RANGE], 5)
    await openFilter(user)

    await user.click(segment("Hololive"))

    expect(tileNames()).toEqual(HOLO_NAMES)
    expect(headings()).toEqual(["HOLOLIVE // JP", "HOLOLIVE // EN", "HOLOLIVE // ID"])
    expect(headings().some((heading) => heading?.startsWith("VSPO"))).toBe(false)
    expect(shown()).toEqual(["GURA", "IOFI", "PEKORA"])
  })

  it("switching VSPO -> Hololive -> ALL leaves no unrelated rows behind at any step", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)

    await user.click(segment("VSPO"))
    expect(tileNames()).toEqual(VSPO_NAMES)
    await user.click(segment("Hololive"))
    expect(tileNames()).toEqual(HOLO_NAMES)
    await user.click(segment("All"))
    expect(tileNames()).toEqual([...VSPO_NAMES, ...HOLO_NAMES].sort())
  })

  it("the dialog and the grid agree: every offered creator has a visible event, and every visible event's creator is offered", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)

    for (const [org, expectedShown] of [["All", 5], ["VSPO", 2], ["Hololive", 3]] as const) {
      await user.click(segment(org))
      expect(tiles()).toHaveLength(expectedShown)
      expect(shown()).toHaveLength(expectedShown)
    }
  })

  it("search respects the active organization: エマ is found under ALL and VSPO, and not under Hololive", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)

    await search(user, "エマ")
    expect(tileNames()).toEqual([NAME.EMA])

    await user.click(segment("VSPO"))
    expect(tileNames()).toEqual([NAME.EMA])

    await user.click(segment("Hololive"))
    expect(tileNames()).toEqual([])
    expect(screen.getByText("No creators found")).toBeInTheDocument()

    await user.click(segment("All"))
    expect(tileNames()).toEqual([NAME.EMA]) // the typed text is kept, and the match returns with its scope
  })

  it("search also only searches schedule creators: a rostered creator with no event is not found", async () => {
    const user = await renderPage([...IN_RANGE, ...OUT_OF_RANGE], 5)
    await openFilter(user)

    await search(user, "すみれ")

    expect(tileNames()).toEqual([])
  })
})

describe("selecting creators", () => {
  it("selecting エマ shows her events (and only hers)", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)
    await search(user, "エマ")

    await user.click(tileFor(NAME.EMA))

    expect(shown()).toEqual(["EMA"])
  })

  it("a selection survives organization changes and comes back (AND with the organization: nothing is deleted, nothing leaks)", async () => {
    const user = await renderPage(IN_RANGE, 5)
    await openFilter(user)
    await user.click(tileFor(NAME.EMA))
    expect(shown()).toEqual(["EMA"])

    await user.click(segment("Hololive"))
    expect(tileNames()).toEqual(HOLO_NAMES) // no VSPO tile
    expect(shown()).toEqual([]) // Ema is outside Hololive, so AND leaves nothing -- and nothing from another creator
    expect(document.querySelector(".schedule-creator-filter__count")).toHaveTextContent("1") // still selected, just out of scope

    await user.click(segment("VSPO"))
    expect(tileFor(NAME.EMA)).toHaveAttribute("aria-pressed", "true")
    expect(shown()).toEqual(["EMA"])
  })

  it("Favorites are not choices by themselves: a favorite with no event is not offered, not counted, and the stored favorites are untouched", async () => {
    const stored = JSON.stringify(["ch_kaga_sumire", "ch_usada_pekora"]) // Sumire has no event on the schedule
    localStorage.setItem("yobi.favoriteCreatorIds", stored)
    resetAllSharedStateForTests()
    const user = await renderPage([...IN_RANGE, ...OUT_OF_RANGE], 5)
    await openFilter(user)

    expect(tileNames()).not.toContain("花芽すみれ")
    expect(await screen.findByRole("button", { name: "Add all favorites (1)" })).toBeInTheDocument() // Pekora only
    await user.click(segment("VSPO"))
    expect(screen.queryByRole("button", { name: /Add all favorites/ })).not.toBeInTheDocument() // none of the VSPO choices is a favorite
    expect(localStorage.getItem("yobi.favoriteCreatorIds")).toBe(stored)
  })
})

describe("empty schedule", () => {
  it("with no streams at all the dialog says so, offers no creator, and the organization control still works", async () => {
    const user = await renderPage([], 0)
    await openFilter(user)

    expect(tiles()).toHaveLength(0)
    expect(screen.getByText("No creators found")).toBeInTheDocument()
    await user.click(segment("VSPO"))
    expect(screen.getByText("No creators found")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "VSPO" })).toBeChecked()
  })

  it("when every stream is outside the displayed days the dialog is empty too (the grid shows nothing either)", async () => {
    const user = await renderPage(OUT_OF_RANGE, 0)
    await openFilter(user)

    expect(shown()).toEqual([])
    expect(tiles()).toHaveLength(0)
  })
})
