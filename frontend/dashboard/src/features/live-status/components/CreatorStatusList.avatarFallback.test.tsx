import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CreatorStatus } from "../model/creatorStatus"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"

// Proves canonical avatarUrl rendering AND the nullable-avatar fallback
// (schema stays nullable regardless of current 118/118 production coverage,
// C7B) against a small synthetic roster -- mocking getCreators alone, same
// convention as MyOshiSettings.avatarFallback.test.tsx (C8A) and
// OshiSettings.avatarFallback.test.tsx (C8B).
const { FIXTURE_CREATORS } = vi.hoisted(() => {
  function fixture(creatorId: string, displayOrder: number, overrides: Record<string, unknown> = {}) {
    return {
      creatorId,
      displayName: creatorId,
      avatarUrl: null,
      organization: "vspo",
      branch: "vspo_jp",
      groupKey: ["NO"],
      channelType: "member",
      themeColor: null,
      lifecycleStage: "active",
      displayOrder,
      active: true,
      youtubeChannelId: `UC_${creatorId}`,
      ...overrides,
    }
  }
  return {
    FIXTURE_CREATORS: [
      fixture("fixture_with_avatar", 0, { avatarUrl: "https://example.com/avatar.jpg" }),
      fixture("fixture_without_avatar", 1, { avatarUrl: null }),
    ],
  }
})

vi.mock("../../../entities/creator/data/creatorRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../entities/creator/data/creatorRegistry")>()
  return {
    ...actual,
    getCreators: (): readonly CanonicalCreator[] => FIXTURE_CREATORS as unknown as CanonicalCreator[],
  }
})

const { CreatorStatusList } = await import("./CreatorStatusList")

const now = new Date("2026-09-09T12:00:00.000Z")
const allOffline: Record<string, CreatorStatus> = Object.fromEntries(
  FIXTURE_CREATORS.map((c) => [`ch_${c.creatorId}`, { kind: "offline" as const }]),
)

function renderList() {
  return render(
    <CreatorStatusList
      statuses={allOffline}
      now={now}
      displayMode="absolute"
      query=""
      favorites={new Set()}
      onToggleFavorite={vi.fn()}
      onSelectCreator={vi.fn()}
      onSelectVideo={vi.fn()}
      locale="en"
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={vi.fn()}
    />,
  )
}

describe("CreatorStatusList avatar rendering", () => {
  it("renders the canonical avatarUrl as the creator's image", () => {
    renderList()
    const image = screen.getByRole("img", { name: "fixture_with_avatar" })
    expect(image).toHaveAttribute("src", "https://example.com/avatar.jpg")
  })

  it("falls back to the initial-letter placeholder when avatarUrl is null", () => {
    renderList()
    expect(screen.queryByRole("img", { name: "fixture_without_avatar" })).not.toBeInTheDocument()
    expect(screen.getAllByText("f").length).toBeGreaterThan(0)
  })
})
