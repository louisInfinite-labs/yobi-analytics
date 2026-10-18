import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CreatorStatusList } from "./CreatorStatusList"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { loadAllCreatorMilestones } from "../../oshi-status/data/allCreatorMilestones"
import type { CreatorStatus } from "../model/creatorStatus"

vi.setConfig({ testTimeout: 30_000 })
vi.mock("../../oshi-status/data/allCreatorMilestones", () => ({
  loadAllCreatorMilestones: vi.fn(),
  getCachedAllCreatorMilestones: vi.fn(() => null),
}))
const loadMock = vi.mocked(loadAllCreatorMilestones)

/** An absolute instant from JST wall-clock fields. */
const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600 * 1000

const SEED = JSON.parse(readFileSync(resolve(process.cwd(), "../../scripts/migration/creator_milestones_seed.json"), "utf8")).records as {
  creatorId: string
  birthday: string
  debutDate: string
}[]
const ALL = Object.fromEntries(SEED.map((r) => [r.creatorId, { birthday: r.birthday, debutDate: r.debutDate }]))

const allOffline: Record<string, CreatorStatus> = Object.fromEntries(mockCreators.map((c) => [c.channelId, { kind: "offline" as const }]))

function renderList(props: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  return render(
    <CreatorStatusList
      statuses={allOffline}
      now={new Date()}
      displayMode="absolute"
      query=""
      favorites={new Set()}
      onToggleFavorite={vi.fn()}
      onSelectCreator={vi.fn()}
      onSelectVideo={vi.fn()}
      locale="en"
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={vi.fn()}
      {...props}
    />,
  )
}

/** The text of one creator name row (name + inline indicator + MAIN badge), found by the exact displayed name. */
function nameRowText(name: string): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".live-status-member__name"))
    .filter((node) => node.textContent === name)
    .map((node) => node.parentElement?.textContent ?? "")
}
const indicators = () => Array.from(document.querySelectorAll(".live-status-member__milestone")).map((node) => node.textContent)
/** The Suisei row only: March 21 and 22 have other creators birthdays, so the midnight tests watch this one row. */
const suisei = () => nameRowText("星街すいせい")[0]
const names = () => Array.from(document.querySelectorAll(".live-status-member__name")).map((node) => node.textContent)

/** Let the mocked bulk read resolve and React re-render. */
const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  loadMock.mockReset()
  loadMock.mockResolvedValue(ALL)
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
})

describe("Live Status inline birthday / debut indicators", () => {
  it("Hoshimachi Suisei on March 22 JST: ONE combined indicator with the Today label once (Japanese)", async () => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList({ locale: "ja" })
    await settle()
    expect(nameRowText("星街すいせい")).toEqual(["星街すいせい 誕生日&デビュー日 当日"])
    expect(indicators()).toEqual(["誕生日&デビュー日 当日"])
  })

  it.each([
    ["zh-TW", "生日&出道日 當日"],
    ["ja", "誕生日&デビュー日 当日"],
    ["en", "Birthday & Debut Today"],
  ] as const)("%s: the combined label for Suisei is %s", async (locale, expected) => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList({ locale })
    await settle()
    expect(indicators()).toEqual([expected])
  })

  it.each([
    ["ja", "星街すいせい 誕生日&デビュー日 当日"],
    ["zh-TW", "星街すいせい 生日&出道日 當日"],
    ["en", "星街すいせい Birthday & Debut Today"],
  ] as const)("%s: exactly one space between the name, the event label and the Today label -> %s", async (locale, expected) => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList({ locale })
    await settle()
    expect(suisei()).toBe(expected)
    // The space is a text node between the two flex items: no empty spacer element, and the note itself carries its own single inner space.
    const row = Array.from(document.querySelectorAll(".live-status-member__name")).find((node) => node.textContent === "星街すいせい")?.parentElement
    expect(row?.childNodes[1]?.nodeType).toBe(Node.TEXT_NODE)
    expect(row?.childNodes[1]?.textContent).toBe(" ")
    expect(row?.querySelector(".live-status-member__milestone")?.textContent).toBe(expected.slice("星街すいせい ".length))
  })
  it("the creator button accessible name includes today's note (aria-label replaces the content, so the note is appended to it)", async () => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList({ locale: "en" })
    await settle()
    expect(screen.getByRole("button", { name: "Switch Oshi to 星街すいせい, Birthday & Debut Today" })).toBeInTheDocument()
    // Everyone else keeps the plain name.
    expect(screen.getByRole("button", { name: "Switch Oshi to 藍沢エマ" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Switch Oshi to 藍沢エマ, Birthday & Debut Today" })).toBeNull()
  })

  it("birthday only: Kaga Nazuna on April 2 (zh-TW 生日 當日), placed right after the name", async () => {
    vi.setSystemTime(jst(2027, 4, 2, 9))
    renderList({ locale: "zh-TW" })
    await settle()
    expect(nameRowText("花芽なずな")).toEqual(["花芽なずな 生日 當日"])
    const name = Array.from(document.querySelectorAll(".live-status-member__name")).find((node) => node.textContent === "花芽なずな")
    expect(name?.nextElementSibling).toHaveClass("live-status-member__milestone")
  })

  it("debut anniversary only: Kiryu Coco, a graduated creator, on her ORIGINAL debut date (zh-TW 出道日 當日)", async () => {
    vi.setSystemTime(jst(2026, 12, 28, 9))
    renderList({ locale: "zh-TW" })
    await settle()
    expect(nameRowText("桐生ココ")).toEqual(["桐生ココ 出道日 當日"])
  })

  it("an ordinary day (January 1: no birthday or debut anniversary in the roster) shows the name normally with no extra text", async () => {
    vi.setSystemTime(jst(2027, 1, 1, 9))
    renderList()
    await settle()
    expect(indicators()).toEqual([])
    expect(nameRowText("星街すいせい")).toEqual(["星街すいせい"])
  })

  it.each([
    ["LIVE", { kind: "live", videoId: "v1", title: "Playing" }],
    ["UPCOMING", { kind: "upcoming", videoId: "v2", title: "Soon", scheduledStart: "2027-03-22T20:00:00+09:00" }],
    ["OFFLINE", { kind: "offline" }],
  ] as const)("%s: the indicator does not depend on livestream state", async (_label, status) => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList({ statuses: { ...allOffline, ch_hoshimachi_suisei: status } })
    await settle()
    expect(indicators()).toEqual(["Birthday & Debut Today"])
  })

  it("does not change the group order or the creator order", async () => {
    vi.setSystemTime(jst(2027, 1, 1, 9))
    const quiet = renderList()
    await settle()
    const ordinary = names()
    quiet.unmount()

    loadMock.mockClear()
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList()
    await settle()
    expect(indicators()).toHaveLength(1)
    expect(names()).toEqual(ordinary)

    // And with the dates unavailable the roster is still the same.
    document.body.innerHTML = ""
    loadMock.mockRejectedValue(new Error("503"))
    renderList()
    await settle()
    expect(indicators()).toEqual([])
    expect(names()).toEqual(ordinary)
  })

  it("makes ONE bulk request for the whole roster, not one per creator, and none per second", async () => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    renderList()
    await settle()
    expect(document.querySelectorAll(".live-status-member").length).toBeGreaterThan(100)
    expect(loadMock).toHaveBeenCalledTimes(1)
    await settle(30_000)
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("shows nothing (and invents nothing) while the dates are loading or unavailable", async () => {
    vi.setSystemTime(jst(2027, 3, 22, 9))
    loadMock.mockReturnValue(new Promise(() => {}))
    const loading = renderList()
    await settle()
    expect(indicators()).toEqual([])
    loading.unmount()

    loadMock.mockRejectedValue(new Error("404"))
    renderList()
    await settle()
    expect(indicators()).toEqual([])
  })
})

describe("JST midnight and tab restoration", () => {
  it("appears at JST midnight and disappears at the next JST midnight, with no refresh and no new request", async () => {
    vi.setSystemTime(jst(2027, 3, 21, 23, 59, 59) + 500)
    renderList()
    await settle()
    expect(suisei()).toBe("星街すいせい")

    await settle(1000)
    expect(suisei()).toBe("星街すいせい Birthday & Debut Today")

    // The whole celebration day passes in real (fake) time -- one timer aimed at the next JST midnight, no per-second work -- and the row is still marked
    // at 23:59:59.5, then clears by itself when the next JST day begins.
    await settle(24 * 3600 * 1000 - 2000)
    expect(suisei()).toBe("星街すいせい Birthday & Debut Today")
    await settle(1000)
    expect(suisei()).toBe("星街すいせい Birthday & Debut Today")
    await settle(1000)
    expect(suisei()).toBe("星街すいせい")
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("a tab returning from the background re-reads the day at once (both into and out of the celebration day)", async () => {
    vi.setSystemTime(jst(2027, 3, 21, 12))
    renderList()
    await settle()
    expect(suisei()).toBe("星街すいせい")

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    vi.setSystemTime(jst(2027, 3, 22, 15))
    expect(suisei()).toBe("星街すいせい")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(suisei()).toBe("星街すいせい Birthday & Debut Today")

    vi.setSystemTime(jst(2027, 3, 23, 8))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(suisei()).toBe("星街すいせい")
  })

  it("the browser time zone never changes the day", async () => {
    const original = process.env.TZ
    try {
      for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland"]) {
        process.env.TZ = zone
        document.body.innerHTML = ""
        // 2027-03-21 15:00 UTC = 2027-03-22 00:00 JST.
        vi.setSystemTime(Date.UTC(2027, 2, 21, 15, 0, 0))
        renderList()
        await settle()
        expect(suisei(), zone).toBe("星街すいせい Birthday & Debut Today")
        document.body.innerHTML = ""
        vi.setSystemTime(Date.UTC(2027, 2, 21, 14, 59, 59))
        renderList()
        await settle()
        expect(suisei(), zone).toBe("星街すいせい")
      }
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})