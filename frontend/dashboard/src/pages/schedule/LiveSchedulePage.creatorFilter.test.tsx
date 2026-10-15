import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import * as liveStreams from "../../shared/api/liveStreams"
import { filterStreamsByCreators, buildCreatorFilterOptions } from "../../features/live-schedule/model/scheduleCreatorFilter"
import type { ScheduledStream } from "../../features/live-schedule/model/scheduledStream"

// Item 10: the Schedule creator filter. A deterministic fixture with creators whose schedules OVERLAP (same slot), so a hidden extra or
// a missing selected creator would show up as a wrong set of avatars in a slot.

Element.prototype.scrollIntoView ??= () => {}

vi.mock("../../shared/api/liveStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/liveStreams")>()),
  fetchLiveStreams: vi.fn(),
}))

const at = (hour: number, minute = 0) => new Date(2026, 8, 23, hour, minute, 0).toISOString()
const up = (videoId: string, creatorId: string, channelName: string, start: string): liveStreams.LiveStreamDto => ({
  videoId,
  creatorId,
  channelName,
  title: videoId,
  status: "upcoming",
  scheduledStart: start,
  actualStart: null,
  thumbnailUrl: "",
  topic: null,
})

// Wed 2026-09-23, "now" = 12:00. T1 15:00: four creators overlap in ONE slot; T2 15:30: two of them again; plus a later single.
const FIXTURE = [
  up("EMA-1500", "aizawa_ema", "藍沢エマ", at(15)),
  up("SUMIRE-1500", "kaga_sumire", "花芽すみれ", at(15)),
  up("NAZUNA-1500", "kaga_nazuna", "花芽なずな", at(15)),
  up("FUBUKI-1500", "shirakami_fubuki", "白上フブキ", at(15)),
  up("EMA-1530", "aizawa_ema", "藍沢エマ", at(15, 30)),
  up("SUMIRE-1530", "kaga_sumire", "花芽すみれ", at(15, 30)),
  up("PEKORA-1800", "usada_pekora", "兎田ぺこら", at(18)),
]
const ALL = FIXTURE.map((stream) => stream.videoId).sort()

const shown = () => Array.from(document.querySelectorAll(".stream-avatar-button")).map((node) => node.getAttribute("aria-label")!).sort()
const filterButton = () => screen.getByRole("button", { name: "Filter by creator" })
const tiles = () => Array.from(document.querySelectorAll<HTMLElement>(".schedule-creator-item"))
const tileNamed = (name: string) => tiles().find((tile) => tile.querySelector(".creator-tile__name")?.textContent === name)!

async function renderPage() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, pointerEventsCheck: 0 })
  render(<LiveSchedulePage />)
  await waitFor(() => expect(shown()).toEqual(ALL))
  return user
}
// The filter is a right-side drawer: open it once, then pick / un-pick creators by clicking their tiles.
async function openFilter(user: ReturnType<typeof userEvent.setup>) {
  if (!document.querySelector(".schedule-creator-drawer.ant-drawer-open")) await user.click(filterButton())
  await waitFor(() => expect(tiles().length).toBeGreaterThan(0))
}
async function pick(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  await openFilter(user)
  for (const name of names) await user.click(tileNamed(name))
}
const selectedTags = () => tiles().filter((tile) => tile.getAttribute("aria-pressed") === "true").map((tile) => tile.querySelector(".creator-tile__name")!.textContent ?? "")

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 8, 23, 12, 0, 0))
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue(FIXTURE)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("Schedule creator filter", () => {
  it("default (nothing selected) shows every creator's streams, including the four that overlap in one slot", async () => {
    await renderPage()

    expect(shown()).toEqual(ALL)
    expect(selectedTags()).toEqual([])
  })

  it("a single creator shows exactly that creator's blocks and nobody else's, even where the slot is shared", async () => {
    const user = await renderPage()

    await pick(user, "花芽すみれ")

    expect(shown()).toEqual(["SUMIRE-1500", "SUMIRE-1530"])
    expect(selectedTags()).toEqual(["花芽すみれ"])
  })

  it("several creators show exactly the union of their blocks: no hidden extra creator, no missing selected one", async () => {
    const user = await renderPage()

    await pick(user, "藍沢エマ", "白上フブキ", "兎田ぺこら")

    expect(shown()).toEqual(["EMA-1500", "EMA-1530", "FUBUKI-1500", "PEKORA-1800"])
    expect(shown()).not.toContain("SUMIRE-1500")
    expect(shown()).not.toContain("NAZUNA-1500")
  })

  it("removing one creator from the selection drops only that creator's blocks", async () => {
    const user = await renderPage()
    await pick(user, "藍沢エマ", "花芽すみれ")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530", "SUMIRE-1500", "SUMIRE-1530"])
    expect(selectedTags().sort()).toEqual(["花芽すみれ", "藍沢エマ"].sort())

    await user.click(tileNamed("藍沢エマ")) // click again = deselect

    expect(selectedTags()).toEqual(["花芽すみれ"])
    expect(shown()).toEqual(["SUMIRE-1500", "SUMIRE-1530"])
  })

  it("Clear filter restores the full schedule", async () => {
    const user = await renderPage()
    await pick(user, "藍沢エマ")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530"])

    await user.click(await screen.findByRole("button", { name: "Clear filter" }))

    await waitFor(() => expect(shown()).toEqual(ALL))
    expect(selectedTags()).toEqual([])
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument()
  })

  it("changing the selection never leaves a stale result: A, then A+B, then only B", async () => {
    const user = await renderPage()

    await pick(user, "藍沢エマ")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530"])
    await pick(user, "兎田ぺこら")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530", "PEKORA-1800"])
    await user.click(tileNamed("藍沢エマ"))
    expect(shown()).toEqual(["PEKORA-1800"])
  })

  it("the tiles stay the full unfiltered list while a selection is active, and are searchable", async () => {
    const user = await renderPage()
    await pick(user, "藍沢エマ")
    expect(tiles().map((tile) => tile.querySelector(".creator-tile__name")!.textContent)).toEqual(expect.arrayContaining(["兎田ぺこら", "白上フブキ", "藍沢エマ"]))

    await user.type(within(document.querySelector<HTMLElement>(".schedule-creator-drawer")!).getByRole("textbox"), "フブキ")

    expect(tiles().filter((tile) => tile.querySelector(".creator-tile__name")!.textContent === "白上フブキ").length).toBeGreaterThan(0)
    expect(tiles().some((tile) => tile.querySelector(".creator-tile__name")!.textContent === "兎田ぺこら")).toBe(false)
  })

  it("favorites carry the shared heart, stay in Live Status' order (no separate Favorites group), and can be added in one click", async () => {
    localStorage.setItem("yobi.favoriteCreatorIds", JSON.stringify(["ch_kaga_sumire", "ch_usada_pekora"]))
    resetAllSharedStateForTests()
    const user = await renderPage()

    await openFilter(user)
    const headings = Array.from(document.querySelectorAll(".schedule-creator-drawer .live-status-group__heading")).map((node) => node.textContent)
    expect(headings).toEqual(["VSPO! // JP", "HOLOLIVE // JP"])
    expect(headings).not.toContain("Favorites")
    const hearted = tiles().filter((tile) => tile.querySelector(".creator-avatar-heart")).map((tile) => tile.querySelector(".creator-tile__name")!.textContent)
    expect(hearted.sort()).toEqual(["兎田ぺこら", "花芽すみれ"].sort())

    await user.click(await screen.findByRole("button", { name: "Add all favorites (2)" }))

    expect(shown()).toEqual(["PEKORA-1800", "SUMIRE-1500", "SUMIRE-1530"])
  })
})

describe("scheduleCreatorFilter model", () => {
  const stream = (id: string, channelId: string): ScheduledStream => ({ id, channelId, videoId: id, title: id, description: "", status: "upcoming", scheduledStartMs: 0, topics: [] })
  const streams = [stream("a1", "ch_a"), stream("a2", "ch_a"), stream("b1", "ch_b"), stream("c1", "ch_c")]

  it("an empty selection is no filter; a selection is exact", () => {
    expect(filterStreamsByCreators(streams, new Set()).map((s) => s.id)).toEqual(["a1", "a2", "b1", "c1"])
    expect(filterStreamsByCreators(streams, new Set(["ch_b", "ch_c"])).map((s) => s.id)).toEqual(["b1", "c1"])
    expect(filterStreamsByCreators(streams, new Set(["ch_zzz"]))).toEqual([])
  })

  it("options: one per creator that has a stream, favorites first, then by name; a selected creator without a stream is NOT offered", () => {
    const options = buildCreatorFilterOptions(streams, new Set(["ch_c"]), (id) => id.replace("ch_", "").toUpperCase())
    expect(options.map((o) => [o.channelId, o.isFavorite])).toEqual([
      ["ch_c", true],
      ["ch_a", false],
      ["ch_b", false],
    ])
  })

  it("a favorite with no stream is not offered either (Favorites decorate choices, they never add them)", () => {
    const options = buildCreatorFilterOptions(streams, new Set(["ch_c", "ch_favorite_without_stream"]), (id) => id)
    expect(options.map((o) => o.channelId)).not.toContain("ch_favorite_without_stream")
  })
})
