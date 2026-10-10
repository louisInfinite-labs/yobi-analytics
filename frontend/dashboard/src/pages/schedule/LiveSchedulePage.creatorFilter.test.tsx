import { render, screen, waitFor } from "@testing-library/react"
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
const combobox = () => screen.getByRole("combobox", { name: "Filter by creator" })

async function renderPage() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, pointerEventsCheck: 0 })
  render(<LiveSchedulePage />)
  await waitFor(() => expect(shown()).toEqual(ALL))
  return user
}
async function pick(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  await user.click(combobox())
  for (const name of names) await user.click(await screen.findByTitle(name))
}
// maxTagCount=2: at most two tags are drawn and the rest collapse into one "+ N ..." chip.
const selectedTags = () =>
  Array.from(document.querySelectorAll(".schedule-creator-filter .ant-select-selection-item-content"))
    .map((node) => node.textContent ?? "")
    .filter((text) => !text.startsWith("+"))

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
    expect(selectedTags()).toEqual(["藍沢エマ", "花芽すみれ"])

    await user.click(document.querySelector<HTMLElement>(".schedule-creator-filter .ant-select-selection-item-remove")!) // the first tag (藍沢エマ)

    expect(selectedTags()).toEqual(["花芽すみれ"])
    expect(shown()).toEqual(["SUMIRE-1500", "SUMIRE-1530"])
  })

  it("Clear filter and the clear icon both restore the full schedule", async () => {
    const user = await renderPage()
    await pick(user, "藍沢エマ")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530"])

    await user.click(await screen.findByRole("button", { name: "Clear filter" }))
    await waitFor(() => expect(shown()).toEqual(ALL))
    expect(selectedTags()).toEqual([])

    await pick(user, "兎田ぺこら")
    expect(shown()).toEqual(["PEKORA-1800"])
    await user.hover(document.querySelector(".schedule-creator-filter .ant-select")!)
    await user.click(document.querySelector<HTMLElement>(".schedule-creator-filter .ant-select-clear")!)
    await waitFor(() => expect(shown()).toEqual(ALL))
  })

  it("changing the selection never leaves a stale result: A, then A+B, then only B", async () => {
    const user = await renderPage()

    await pick(user, "藍沢エマ")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530"])
    await pick(user, "兎田ぺこら")
    expect(shown()).toEqual(["EMA-1500", "EMA-1530", "PEKORA-1800"])
    await user.click(document.querySelectorAll<HTMLElement>(".schedule-creator-filter .ant-select-selection-item-remove")[0])
    expect(shown()).toEqual(["PEKORA-1800"])
  })

  it("the options stay the full unfiltered list while a selection is active, and are searchable", async () => {
    const user = await renderPage()
    await pick(user, "藍沢エマ")

    await user.click(combobox())
    await user.type(combobox(), "フブキ")

    expect(await screen.findByTitle("白上フブキ")).toBeInTheDocument()
    expect(screen.queryByTitle("兎田ぺこら")).not.toBeInTheDocument()
  })

  it("favorites are listed first in their own group and can be added in one click", async () => {
    localStorage.setItem("yobi.favoriteCreatorIds", JSON.stringify(["ch_kaga_sumire", "ch_usada_pekora"]))
    resetAllSharedStateForTests()
    const user = await renderPage()

    await user.click(combobox())
    const groups = Array.from(document.querySelectorAll(".schedule-creator-filter__dropdown .ant-select-item-group")).map((node) => node.textContent)
    expect(groups).toEqual(["Favorites", "All creators"])
    const optionTitles = Array.from(document.querySelectorAll(".schedule-creator-filter__dropdown .ant-select-item-option")).map((node) => node.getAttribute("title"))
    expect(optionTitles.slice(0, 2).sort()).toEqual(["兎田ぺこら", "花芽すみれ"].sort())

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

  it("options: one per creator, favorites first, then by name, plus any selected creator without a stream", () => {
    const options = buildCreatorFilterOptions(streams, new Set(["ch_x"]), new Set(["ch_c"]), (id) => id.replace("ch_", "").toUpperCase())
    expect(options.map((o) => [o.channelId, o.isFavorite])).toEqual([
      ["ch_c", true],
      ["ch_a", false],
      ["ch_b", false],
      ["ch_x", false],
    ])
  })
})
