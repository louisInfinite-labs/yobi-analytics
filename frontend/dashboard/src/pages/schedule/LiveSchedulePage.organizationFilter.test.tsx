import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import * as liveStreams from "../../shared/api/liveStreams"

vi.mock("../../shared/api/liveStreams", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/api/liveStreams")>()),
  fetchLiveStreams: vi.fn(),
}))

function stream(videoId: string, creatorId: string, title: string, hour: number): liveStreams.LiveStreamDto {
  return {
    videoId,
    creatorId,
    channelName: creatorId,
    title,
    status: "upcoming",
    scheduledStart: new Date(2026, 8, 23, hour, 0, 0).toISOString(),
    actualStart: null,
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  }
}

const ALL_TITLES = ["Hololive EN stream", "Hololive ID stream", "Hololive JP stream", "VSPO JP stream", "VSPO second stream"]
const HOLOLIVE_TITLES = ["Hololive EN stream", "Hololive ID stream", "Hololive JP stream"]
const VSPO_TITLES = ["VSPO JP stream", "VSPO second stream"]

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
  // Only Date is faked so user-event, React scheduling and the shared poll keep working on real timers.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 8, 23, 8, 0, 0))
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([
    stream("v-ema", "aizawa_ema", "VSPO JP stream", 10),
    stream("v-sumire", "kaga_sumire", "VSPO second stream", 11),
    stream("v-pekora", "usada_pekora", "Hololive JP stream", 12),
    stream("v-gura", "gawr_gura", "Hololive EN stream", 13),
    stream("v-iofi", "airani_iofifteen", "Hololive ID stream", 14),
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

function visibleTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".stream-avatar-button")].map((node) => node.getAttribute("aria-label") ?? "").sort()
}

async function renderLoadedPage() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const utils = render(<LiveSchedulePage />)
  await waitFor(() => expect(visibleTitles(utils.container)).toHaveLength(5))
  return { user, ...utils }
}

async function openFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Filter by creator" }))
  return screen.findByRole("radiogroup", { name: "Organization" })
}

function org(name: "All" | "VSPO" | "Hololive") {
  return screen.getByRole("radio", { name })
}

/** The clickable segment (antd hides the native radio input itself, so a user clicks its label). */
function segment(name: "All" | "VSPO" | "Hololive"): HTMLElement {
  return org(name).closest("label")!
}

async function toggleCreator(user: ReturnType<typeof userEvent.setup>, channelId: string) {
  await user.click(document.querySelector<HTMLElement>(`.schedule-creator-item[data-channel-id="${channelId}"]`)!)
}

describe("Schedule organization filter", () => {
  it("is the first control in the existing Filter panel and defaults to All, with every stream visible", async () => {
    const { user, container } = await renderLoadedPage()
    const group = await openFilter(user)

    expect(org("All")).toBeChecked()
    expect(org("VSPO")).not.toBeChecked()
    expect(org("Hololive")).not.toBeChecked()
    expect(visibleTitles(container)).toEqual(ALL_TITLES)

    // Placed before the search/creator controls, inside the same drawer.
    const drawerBody = group.closest(".ant-drawer-body")!
    expect(drawerBody.firstElementChild).toBe(group.closest(".schedule-creator-drawer__organization"))
    expect(drawerBody.querySelector(".schedule-creator-drawer__controls")).toBeInTheDocument()
  })

  it("offers exactly All, VSPO and Hololive, and only one can be selected at a time", async () => {
    const { user } = await renderLoadedPage()
    const group = await openFilter(user)

    expect(screen.getAllByRole("radio").filter((radio) => group.contains(radio)).map((radio) => radio.getAttribute("aria-label") ?? radio.closest("label")?.textContent)).toEqual([
      "All",
      "VSPO",
      "Hololive",
    ])
    await user.click(segment("VSPO"))
    expect(screen.getAllByRole("radio", { checked: true }).filter((radio) => group.contains(radio))).toHaveLength(1)
    expect(org("VSPO")).toBeChecked()
  })

  it("VSPO shows only VSPO streams, Hololive only Hololive streams (JP, EN and ID), and All restores everything", async () => {
    const { user, container } = await renderLoadedPage()
    await openFilter(user)

    await user.click(segment("VSPO"))
    expect(visibleTitles(container)).toEqual(VSPO_TITLES)

    await user.click(segment("Hololive"))
    expect(visibleTitles(container)).toEqual(HOLOLIVE_TITLES)

    await user.click(segment("All"))
    expect(visibleTitles(container)).toEqual(ALL_TITLES)
  })

  it("composes (AND) with the creator filter: a creator outside the chosen organization leaves nothing", async () => {
    const { user, container } = await renderLoadedPage()
    await openFilter(user)

    await toggleCreator(user, "ch_usada_pekora")
    expect(visibleTitles(container)).toEqual(["Hololive JP stream"])

    await user.click(segment("VSPO"))
    expect(visibleTitles(container)).toEqual([])

    await user.click(segment("Hololive"))
    expect(visibleTitles(container)).toEqual(["Hololive JP stream"])

    await user.click(segment("All"))
    expect(visibleTitles(container)).toEqual(["Hololive JP stream"])
  })

  it("changing the organization does not reset the creator selection (it is kept, and comes back with its tile when its organization is chosen again)", async () => {
    const { user } = await renderLoadedPage()
    await openFilter(user)
    await toggleCreator(user, "ch_usada_pekora")
    const pekora = () => document.querySelector(".schedule-creator-item[data-channel-id='ch_usada_pekora']")

    for (const name of ["VSPO", "Hololive", "All"] as const) {
      await user.click(segment(name))
      expect(document.querySelector(".schedule-creator-filter__count")).toHaveTextContent("1") // still selected, whatever the scope
      if (name === "VSPO") expect(pekora()).toBeNull() // out of scope: not listed, but not forgotten
      else expect(pekora()).toHaveAttribute("aria-pressed", "true")
    }
  })

  it("changing the creator filter does not reset the organization", async () => {
    const { user, container } = await renderLoadedPage()
    await openFilter(user)
    await user.click(segment("VSPO"))

    await toggleCreator(user, "ch_kaga_sumire")
    expect(org("VSPO")).toBeChecked()
    expect(visibleTitles(container)).toEqual(["VSPO second stream"])

    await user.click(screen.getByRole("button", { name: "Clear filter" }))
    expect(org("VSPO")).toBeChecked()
    expect(visibleTitles(container)).toEqual(VSPO_TITLES)
  })

  it("keeps its selection when the Filter panel is closed and reopened", async () => {
    const { user, container } = await renderLoadedPage()
    await openFilter(user)
    await user.click(segment("Hololive"))

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Organization" })).not.toBeInTheDocument())
    expect(visibleTitles(container)).toEqual(HOLOLIVE_TITLES)

    await openFilter(user)
    expect(org("Hololive")).toBeChecked()
  })

  it("does not close the Filter panel when the organization changes", async () => {
    const { user } = await renderLoadedPage()
    await openFilter(user)
    await user.click(segment("VSPO"))
    expect(screen.getByRole("radiogroup", { name: "Organization" })).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Search creators")).toBeInTheDocument()
  })

  it("never refetches /live-streams when the organization changes", async () => {
    const { user } = await renderLoadedPage()
    await openFilter(user)
    const callsAfterLoad = vi.mocked(liveStreams.fetchLiveStreams).mock.calls.length
    expect(callsAfterLoad).toBeGreaterThan(0)

    for (const name of ["VSPO", "Hololive", "All", "VSPO", "All"] as const) await user.click(segment(name))

    expect(vi.mocked(liveStreams.fetchLiveStreams).mock.calls.length).toBe(callsAfterLoad)
  })

  it("classifies by the canonical creator organization, not by the stream title or creator name", async () => {
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([
      stream("v-a", "usada_pekora", "【VSPO】collab practice", 10),
      stream("v-b", "aizawa_ema", "hololive official announcement", 11),
    ])
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { container } = render(<LiveSchedulePage />)
    await waitFor(() => expect(visibleTitles(container)).toHaveLength(2))
    await openFilter(user)

    await user.click(segment("VSPO"))
    expect(visibleTitles(container)).toEqual(["hololive official announcement"])
    await user.click(segment("Hololive"))
    expect(visibleTitles(container)).toEqual(["【VSPO】collab practice"])
  })
})
