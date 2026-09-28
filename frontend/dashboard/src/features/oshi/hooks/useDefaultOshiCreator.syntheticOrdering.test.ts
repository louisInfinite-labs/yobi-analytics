import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"

// Proves the fallback creator is a genuine CONSEQUENCE of displayOrder, not a
// hardcoded product rule -- against a small synthetic roster (mocking
// getCreators alone; isCurrentMemberEligible stays the real implementation
// via importOriginal, same convention as
// notifications/model/notificationCreatorGrouping.test.ts) where the "first
// eligible" identity is deliberately NOT aizawa_ema, so this could not pass
// by coincidentally matching a hardcoded id.
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
      fixture("fixture_third", 2),
      fixture("fixture_first", 0),
      fixture("fixture_second_but_ineligible", 1, { channelType: "group" }),
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

const { useDefaultOshiCreator } = await import("./useDefaultOshiCreator")

describe("useDefaultOshiCreator fallback (synthetic ordering)", () => {
  it("falls back to the first ELIGIBLE creator by displayOrder, not creation order, not the ineligible displayOrder=1 entry", () => {
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_fixture_first")
  })
})
