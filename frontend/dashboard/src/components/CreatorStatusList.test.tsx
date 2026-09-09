import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList, countLiveAndOffline } from "./CreatorStatusList"
import { mockCreators } from "../data/mockCreators"
import type { CreatorStatus } from "../types/creatorStatus"

const now = new Date("2026-09-09T12:00:00.000Z")
const allOffline: Record<string, CreatorStatus> = Object.fromEntries(mockCreators.map((c) => [c.channelId, { kind: "offline" as const }]))

function renderList(overrides: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  const onSelectVideo = vi.fn()
  const onToggleFavorite = vi.fn()
  render(
    <CreatorStatusList
      statuses={allOffline}
      now={now}
      displayMode="absolute"
      language="en"
      query=""
      favorites={new Set()}
      onToggleFavorite={onToggleFavorite}
      onSelectVideo={onSelectVideo}
      {...overrides}
    />,
  )
  return { onSelectVideo, onToggleFavorite }
}

describe("CreatorStatusList", () => {
  it("lists every creator when favoriteOnlyIds is not set", () => {
    renderList()
    expect(screen.getByText("藍沢エマ")).toBeInTheDocument()
    expect(screen.getByText("白上フブキ")).toBeInTheDocument()
  })

  it("lists only the favorited creators when favoriteOnlyIds is set", () => {
    renderList({ favoriteOnlyIds: new Set(["ch_aizawa_ema"]) })
    expect(screen.getByText("藍沢エマ")).toBeInTheDocument()
    expect(screen.queryByText("白上フブキ")).not.toBeInTheDocument()
  })

  it("shows a favorites-specific empty message when the favorites set is empty", () => {
    renderList({ favoriteOnlyIds: new Set() })
    expect(screen.getByText(/No favorites yet/)).toBeInTheDocument()
  })

  it("calls onToggleFavorite with the creator's channelId when its star is clicked", async () => {
    const { onToggleFavorite } = renderList()
    const user = userEvent.setup()
    await user.click(screen.getByLabelText("Add 藍沢エマ to favorites"))
    expect(onToggleFavorite).toHaveBeenCalledWith("ch_aizawa_ema")
  })

  it("shows a filled heart and a differently-labeled button for an already-favorited creator", () => {
    renderList({ favorites: new Set(["ch_aizawa_ema"]) })
    expect(screen.getByLabelText("Remove 藍沢エマ from favorites")).toHaveTextContent("♥")
  })
})

describe("countLiveAndOffline", () => {
  const statuses: Record<string, CreatorStatus> = {
    ch_a: { kind: "live", videoId: "v1", title: "t" },
    ch_b: { kind: "offline" },
    ch_c: { kind: "offline" },
  }

  it("counts across every creator when favoriteOnlyIds is not set", () => {
    expect(countLiveAndOffline(statuses)).toEqual({ live: 1, offline: 2 })
  })

  it("counts only within favoriteOnlyIds when set", () => {
    expect(countLiveAndOffline(statuses, new Set(["ch_b"]))).toEqual({ live: 0, offline: 1 })
  })
})
