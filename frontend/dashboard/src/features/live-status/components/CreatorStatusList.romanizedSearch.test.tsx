import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList } from "./CreatorStatusList"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import type { CreatorStatus } from "../model/creatorStatus"

const now = new Date("2026-09-09T12:00:00.000Z")
const allOffline: Record<string, CreatorStatus> = Object.fromEntries(mockCreators.map((c) => [c.channelId, { kind: "offline" as const }]))

function renderList(query: string, favoriteOnlyIds?: Set<string>) {
  return render(
    <CreatorStatusList
      statuses={allOffline}
      now={now}
      displayMode="absolute"
      query={query}
      favorites={new Set()}
      favoriteOnlyIds={favoriteOnlyIds}
      onToggleFavorite={vi.fn()}
      onSelectCreator={vi.fn()}
      onSelectVideo={vi.fn()}
      locale="en"
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={vi.fn()}
    />,
  )
}

function renderedNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".live-status-member__name")].map((node) => node.textContent?.trim() ?? "")
}

describe("Live Status search by canonical romanized name", () => {
  it.each(["aizawaema", "AizawaEma", "EMA AIZaWa", "ema aizawa", "aizawa_ema", "ema-aizawa"])("%j finds only 藍沢エマ", (query) => {
    const { container } = renderList(query)
    expect(renderedNames(container)).toEqual(["藍沢エマ"])
  })

  it.each(["aizamaema", "aizazwaema"])("%j (a typo) finds nobody and shows the empty state", (query) => {
    const { container } = renderList(query)
    expect(renderedNames(container)).toEqual([])
    expect(screen.getByText("No matching creator.")).toBeInTheDocument()
  })

  it("keeps matching by Japanese display name exactly as before", () => {
    const { container } = renderList("エマ")
    expect(renderedNames(container)).toEqual(["藍沢エマ"])
  })
})

describe("Favorites view of Live Status search by canonical romanized name", () => {
  const favoriteOnlyIds = new Set(["ch_aizawa_ema", "ch_usada_pekora"])

  it("narrows within the favorites to the romanized match, in either order", () => {
    expect(renderedNames(renderList("aizawa ema", favoriteOnlyIds).container)).toEqual(["藍沢エマ"])
    expect(renderedNames(renderList("pekora usada", favoriteOnlyIds).container)).toEqual(["兎田ぺこら"])
  })

  it("never reveals a creator outside the favorites, even on an exact romanized match", () => {
    const { container } = renderList("shirakami fubuki", favoriteOnlyIds)
    expect(renderedNames(container)).toEqual([])
  })
})
