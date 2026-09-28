import { describe, expect, it } from "vitest"
import { mockCreators } from "./mockCreators"
import { getCreators, resolveCreatorKey } from "./creatorRegistry"
import { DOCK_BRANCH_ORDER, pinNonMemberChannelsLast } from "../utils/dockCreatorOrder"
import { subgroupsForBranch } from "../utils/hololiveSubgrouping"
import type { BranchKey } from "../model/domain"

/** C8A0 readiness check: proves the new canonical `displayOrder` field, once
 * sorted ascending and grouped through the SAME shared subgroupsForBranch
 * algorithm My Oshi/Oshi Settings already use, reproduces today's
 * mockCreators.ts-derived subgroup member order exactly -- per branch, per
 * generation/unit -- before any UI consumer is migrated to read it. This is
 * what makes it safe for the deferred C8A page migration to sort by
 * displayOrder instead of relying on mockCreators.ts's own array position. */

/** kiryu_coco is a known, PRE-EXISTING data divergence, not a displayOrder
 * bug: mockCreators.ts's own comment on her record documents that she is
 * deliberately fixtured under groupKey "1期生" (not her real generation) as
 * a test scenario for "a graduated creator still retaining an active
 * generation tag". The real canonical creators.json correctly carries her
 * true generation, "4期生" -- a genuine content difference between the mock
 * fixture and production data, which naturally places her in a different
 * subgroup bucket than mockCreators.ts does. Excluded from the strict
 * per-branch parity check below and asserted separately instead (see the
 * dedicated test at the bottom of this file). */
const KNOWN_MOCK_VS_CANONICAL_GROUP_KEY_DIVERGENCE = new Set(["kiryu_coco"])

function mockOrderForBranch(branch: BranchKey): string[] {
  const branchMocks = mockCreators.filter((creator) => creator.branch === branch)
  const ordered = branch === "vspo_jp" ? pinNonMemberChannelsLast(branchMocks) : branchMocks
  return subgroupsForBranch(branch, ordered, (creator) => creator.channelName)
    .flatMap((subgroup) => subgroup.creators)
    .map((creator) => resolveCreatorKey(creator.channelId)?.creatorId)
    // Drops ch_hololive_staff -- mock-only, no canonical counterpart, must
    // never appear in the canonical-side sequence either (see the
    // corresponding it() case below).
    .filter((creatorId): creatorId is string => creatorId !== undefined)
    .filter((creatorId) => !KNOWN_MOCK_VS_CANONICAL_GROUP_KEY_DIVERGENCE.has(creatorId))
}

function canonicalOrderForBranch(branch: BranchKey): string[] {
  const branchCreators = [...getCreators()]
    .filter((creator) => creator.branch === branch)
    .filter((creator) => !KNOWN_MOCK_VS_CANONICAL_GROUP_KEY_DIVERGENCE.has(creator.creatorId))
    .sort((a, b) => a.displayOrder - b.displayOrder)
  const ordered = branch === "vspo_jp" ? pinNonMemberChannelsLast(branchCreators) : branchCreators
  return subgroupsForBranch(branch, ordered, (creator) => creator.displayName)
    .flatMap((subgroup) => subgroup.creators)
    .map((creator) => creator.creatorId)
}

describe("canonical displayOrder reproduces mockCreators' current subgroup order", () => {
  it.each(DOCK_BRANCH_ORDER)("branch %s", (branch) => {
    expect(canonicalOrderForBranch(branch)).toEqual(mockOrderForBranch(branch))
  })

  it("ch_hololive_staff (mock-only) never appears in the canonical-side order", () => {
    const allCanonicalIds = new Set(getCreators().map((creator) => creator.creatorId))
    expect(resolveCreatorKey("ch_hololive_staff")).toBeUndefined()
    expect(allCanonicalIds.has("hololive_staff")).toBe(false)
  })

  it("kiryu_coco: documents the known mock-fixture vs. canonical groupKey divergence", () => {
    const canonical = getCreators().find((creator) => creator.creatorId === "kiryu_coco")
    const mock = mockCreators.find((creator) => creator.channelId === "ch_kiryu_coco")
    expect(canonical?.groupKey).toEqual(["4期生"]) // her real generation
    expect(mock?.groupKey).toEqual(["1期生"]) // intentional mock-only fixture value
  })
})
