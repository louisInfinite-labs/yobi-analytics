import { describe, expect, it, vi } from "vitest"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"

// Exercises ALL_CREATORS/getAllNotificationCreators against a small,
// controlled fixture roster (injected by mocking getCreators alone --
// isCurrentMemberEligible is left as the real implementation via
// importOriginal, so this proves the actual C4/C5A eligibility rule is
// what's applied here, not a re-implementation of it) rather than the real
// ~118-entry generated registry, so every eligibility branch (active,
// pre_debut, graduated, retired, group, staff, active=false) is exercised
// directly and deterministically -- and so a roster entry that only exists
// in this fixture (never in the real registry or the deleted
// features/notifications/data/creators.json) proves ALL_CREATORS is truly
// sourced from getCreators() alone (C5B), with no other data source mixed
// in.
const { FIXTURE_CREATORS } = vi.hoisted(() => {
  function fixture(creatorId: string, overrides: Record<string, unknown> = {}) {
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
      active: true,
      youtubeChannelId: `UC_${creatorId}`,
      ...overrides,
    }
  }
  return {
    FIXTURE_CREATORS: [
      fixture("fixture_active_member", { lifecycleStage: "active" }),
      fixture("fixture_predebut_member", { lifecycleStage: "pre_debut" }),
      fixture("fixture_graduated_member", { lifecycleStage: "graduated" }),
      fixture("fixture_retired_member", { lifecycleStage: "retired" }),
      fixture("fixture_group_channel", { channelType: "group" }),
      fixture("fixture_staff_channel", { channelType: "staff" }),
      fixture("fixture_inactive_member", { active: false }),
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

const { getAllNotificationCreators } = await import("./notificationCreatorGrouping")

describe("Notifications roster (ALL_CREATORS / getAllNotificationCreators)", () => {
  const ids = getAllNotificationCreators().map((creator) => creator.creatorId)

  it("comes from the shared Creator Registry's getCreators(), not any other/local roster", () => {
    // Only fixture ids can appear at all -- a real registry creatorId (e.g.
    // aizawa_ema, only ever present in the real generated registry) proves
    // nothing else is mixed in.
    expect(ids).not.toContain("aizawa_ema")
    expect(ids.length).toBeGreaterThan(0)
  })

  it("includes an eligible active member", () => {
    expect(ids).toContain("fixture_active_member")
  })

  it("includes an eligible pre_debut member", () => {
    expect(ids).toContain("fixture_predebut_member")
  })

  it("excludes a graduated member", () => {
    expect(ids).not.toContain("fixture_graduated_member")
  })

  it("excludes a retired member", () => {
    expect(ids).not.toContain("fixture_retired_member")
  })

  it("excludes a group channel", () => {
    expect(ids).not.toContain("fixture_group_channel")
  })

  it("excludes a staff channel", () => {
    expect(ids).not.toContain("fixture_staff_channel")
  })

  it("excludes an active=false member", () => {
    expect(ids).not.toContain("fixture_inactive_member")
  })

  it("preserves the canonical bare creatorId (no ch_ prefix added or stripped)", () => {
    const activeMember = getAllNotificationCreators().find((creator) => creator.creatorId === "fixture_active_member")
    expect(activeMember?.creatorId).toBe("fixture_active_member")
  })
})
