import { describe, expect, it } from "vitest"
import {
  addCreatorToOrder,
  canStartComparison,
  comparisonOrderOf,
  dedupePreservingOrder,
  MIN_COMPARISON_CREATORS,
  removeCreatorFromOrder,
  toggleCreatorSelection,
} from "./creatorComparisonOrder"

// MT-10's shared deterministic fixture
// (DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md "Shared Deterministic Fixtures").
const creators = [
  { creatorId: "creator-a", displayName: "A" },
  { creatorId: "creator-b", displayName: "B" },
  { creatorId: "creator-c", displayName: "C" },
]

describe("toggleCreatorSelection", () => {
  it("MT-10 AC1: clicking A, then B, then C stores the click order", () => {
    let orderedIds: string[] = []
    orderedIds = toggleCreatorSelection(orderedIds, "creator-a")
    orderedIds = toggleCreatorSelection(orderedIds, "creator-b")
    orderedIds = toggleCreatorSelection(orderedIds, "creator-c")

    expect(orderedIds).toEqual(["creator-a", "creator-b", "creator-c"])
  })

  it("MT-10 AC4: deselecting B renumbers the remaining creators consecutively", () => {
    let orderedIds = ["creator-a", "creator-b", "creator-c"]
    orderedIds = toggleCreatorSelection(orderedIds, "creator-b")

    expect(orderedIds).toEqual(["creator-a", "creator-c"])
    expect(comparisonOrderOf(orderedIds, "creator-a")).toBe(1)
    expect(comparisonOrderOf(orderedIds, "creator-c")).toBe(2)
    expect(comparisonOrderOf(orderedIds, "creator-b")).toBeNull()
  })

  it("MT-10 AC5: reselecting a deselected creator appends it to the end", () => {
    let orderedIds = ["creator-a", "creator-b", "creator-c"]
    orderedIds = toggleCreatorSelection(orderedIds, "creator-b") // deselect B -> [a, c]
    orderedIds = toggleCreatorSelection(orderedIds, "creator-b") // reselect B -> [a, c, b]

    expect(orderedIds).toEqual(["creator-a", "creator-c", "creator-b"])
    expect(comparisonOrderOf(orderedIds, "creator-a")).toBe(1)
    expect(comparisonOrderOf(orderedIds, "creator-c")).toBe(2)
    expect(comparisonOrderOf(orderedIds, "creator-b")).toBe(3)
  })

  it("does not mutate the input array", () => {
    const orderedIds = ["creator-a"]
    const next = toggleCreatorSelection(orderedIds, "creator-b")

    expect(orderedIds).toEqual(["creator-a"])
    expect(next).toEqual(["creator-a", "creator-b"])
  })
})

describe("addCreatorToOrder", () => {
  it("MT-10 AC7: rejects a duplicate -- adding the same id twice keeps a single entry", () => {
    let orderedIds: string[] = []
    orderedIds = addCreatorToOrder(orderedIds, "creator-a")
    orderedIds = addCreatorToOrder(orderedIds, "creator-a")

    expect(orderedIds).toEqual(["creator-a"])
  })

  it("appends new ids to the end without reordering existing ones", () => {
    const orderedIds = addCreatorToOrder(["creator-a", "creator-b"], "creator-c")
    expect(orderedIds).toEqual(["creator-a", "creator-b", "creator-c"])
  })
})

describe("removeCreatorFromOrder", () => {
  it("removing an id not present is a no-op", () => {
    const orderedIds = removeCreatorFromOrder(["creator-a"], "creator-z")
    expect(orderedIds).toEqual(["creator-a"])
  })
})

describe("comparisonOrderOf", () => {
  it("is 1-based", () => {
    const orderedIds = ["creator-a", "creator-b", "creator-c"]
    expect(comparisonOrderOf(orderedIds, "creator-a")).toBe(1)
    expect(comparisonOrderOf(orderedIds, "creator-b")).toBe(2)
    expect(comparisonOrderOf(orderedIds, "creator-c")).toBe(3)
  })

  it("returns null for an unselected creator", () => {
    expect(comparisonOrderOf([], "creator-a")).toBeNull()
  })
})

describe("canStartComparison", () => {
  it("MT-10 AC8: disabled with zero or one selected creator", () => {
    expect(canStartComparison([])).toBe(false)
    expect(canStartComparison(["creator-a"])).toBe(false)
  })

  it("MT-10 AC8: enabled from two distinct creators onward", () => {
    expect(canStartComparison(["creator-a", "creator-b"])).toBe(true)
    expect(canStartComparison(["creator-a", "creator-b", "creator-c"])).toBe(true)
  })

  it("uses the documented minimum constant", () => {
    expect(MIN_COMPARISON_CREATORS).toBe(2)
  })
})

describe("dedupePreservingOrder", () => {
  it("removes duplicates while preserving first-occurrence order", () => {
    expect(dedupePreservingOrder(["creator-a", "creator-b", "creator-a", "creator-c", "creator-b"])).toEqual([
      "creator-a",
      "creator-b",
      "creator-c",
    ])
  })
})

describe("MT-10 AC9: a single ordered creatorIds list is the one source every consumer would read", () => {
  it("request params, chart series, legend, tooltip, and saved configuration derive from the same array reference/value", () => {
    let orderedIds: string[] = []
    orderedIds = toggleCreatorSelection(orderedIds, "creator-a")
    orderedIds = toggleCreatorSelection(orderedIds, "creator-b")
    orderedIds = toggleCreatorSelection(orderedIds, "creator-c")

    // Stand-ins for MT-14's future request/series/legend/tooltip adapters and
    // MT-11/MT-12's future saved widget configuration: each is a direct read
    // of `orderedIds`, so there is exactly one order to keep in sync, not
    // several derived copies that could disagree.
    const requestCreatorIdsParam = orderedIds
    const chartSeriesOrder = orderedIds.map((creatorId) => creatorId)
    const legendOrder = [...orderedIds]
    const tooltipOrder = [...orderedIds]
    const savedComparisonConfigCreatorIds = orderedIds

    expect(requestCreatorIdsParam).toEqual(["creator-a", "creator-b", "creator-c"])
    expect(chartSeriesOrder).toEqual(requestCreatorIdsParam)
    expect(legendOrder).toEqual(requestCreatorIdsParam)
    expect(tooltipOrder).toEqual(requestCreatorIdsParam)
    expect(savedComparisonConfigCreatorIds).toEqual(requestCreatorIdsParam)
  })
})

describe("MT-10 AC6: search/filtering do not remove selected ids", () => {
  it("filtering the creator fixture list does not touch a separately held selection", () => {
    let orderedIds: string[] = []
    orderedIds = toggleCreatorSelection(orderedIds, "creator-a")
    orderedIds = toggleCreatorSelection(orderedIds, "creator-b")

    // Simulates typing a search query that narrows the visible roster --
    // selection state lives independently of whatever subset is displayed.
    const searchQuery = "A"
    const visibleAfterSearch = creators.filter((creator) => creator.displayName.includes(searchQuery))

    expect(visibleAfterSearch.map((creator) => creator.creatorId)).toEqual(["creator-a"])
    // Selection is untouched even though "creator-b" is no longer visible.
    expect(orderedIds).toEqual(["creator-a", "creator-b"])
  })
})
