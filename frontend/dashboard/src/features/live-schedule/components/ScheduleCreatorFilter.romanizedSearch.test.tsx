import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ScheduleCreatorFilter } from "./ScheduleCreatorFilter"
import type { CreatorFilterOption } from "../model/scheduleCreatorFilter"

const creatorOptions: CreatorFilterOption[] = [
  { channelId: "ch_aizawa_ema", name: "藍沢エマ", isFavorite: false },
  { channelId: "ch_usada_pekora", name: "兎田ぺこら", isFavorite: false },
  { channelId: "ch_shirakami_fubuki", name: "白上フブキ", isFavorite: false },
]

async function openDrawer() {
  const user = userEvent.setup()
  render(<ScheduleCreatorFilter locale="en" creatorOptions={creatorOptions} selectedCreators={[]} onSelectedCreatorsChange={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Filter by creator" }))
  return { user, search: await screen.findByPlaceholderText("Search creators") }
}

function tileNames(): string[] {
  return [...document.querySelectorAll(".schedule-creator-item__name")].map((node) => node.textContent?.trim() ?? "")
}

describe("Schedule creator filter search by canonical romanized name", () => {
  it("lists every schedule creator before anything is typed", async () => {
    await openDrawer()
    // 白上フブキ is listed under both her generation and Gamers (Live Status' grouping), so compare unique creators.
    expect([...new Set(tileNames())].sort()).toEqual(["兎田ぺこら", "白上フブキ", "藍沢エマ"].sort())
  })

  it("finds a creator in either name order, any case and separator", async () => {
    const { user, search } = await openDrawer()
    for (const query of ["aizawaema", "AizawaEma", "EMA AIZaWa", "ema aizawa", "aizawa_ema", "ema-aizawa"]) {
      await user.clear(search)
      await user.type(search, query)
      expect(tileNames()).toEqual(["藍沢エマ"])
    }
  })

  it("finds nobody for a typo and shows the no-match message", async () => {
    const { user, search } = await openDrawer()
    for (const typo of ["aizamaema", "aizazwaema"]) {
      await user.clear(search)
      await user.type(search, typo)
      expect(tileNames()).toEqual([])
      expect(screen.getByText("No creators found")).toBeInTheDocument()
    }
  })
})
