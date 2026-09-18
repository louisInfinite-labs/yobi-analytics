import { describe, expect, it } from "vitest"
import { buildComparisonChartRows } from "./comparisonChartData"

describe("buildComparisonChartRows", () => {
  it("MT-14 AC3: pivots each ok creator's points into one row per label, one key per creator", () => {
    const rows = buildComparisonChartRows([
      {
        creatorId: "creator-a",
        points: [
          { label: "Mon", value: 10 },
          { label: "Tue", value: 20 },
        ],
      },
      {
        creatorId: "creator-b",
        points: [
          { label: "Mon", value: 5 },
          { label: "Tue", value: 15 },
        ],
      },
    ])

    expect(rows).toEqual([
      { label: "Mon", "creator-a": 10, "creator-b": 5 },
      { label: "Tue", "creator-a": 20, "creator-b": 15 },
    ])
  })

  it("preserves first-seen label order rather than sorting", () => {
    const rows = buildComparisonChartRows([{ creatorId: "creator-a", points: [{ label: "Wed", value: 1 }, { label: "Mon", value: 2 }] }])
    expect(rows.map((row) => row.label)).toEqual(["Wed", "Mon"])
  })

  it("never fabricates a value for a creator missing a label's point (Section 3.4: no fabricated values)", () => {
    const rows = buildComparisonChartRows([
      { creatorId: "creator-a", points: [{ label: "Mon", value: 10 }, { label: "Tue", value: 20 }] },
      { creatorId: "creator-b", points: [{ label: "Mon", value: 5 }] }, // no Tue point
    ])

    const tueRow = rows.find((row) => row.label === "Tue")!
    expect(tueRow["creator-a"]).toBe(20)
    expect("creator-b" in tueRow).toBe(false)
  })

  it("returns an empty array for no ok results", () => {
    expect(buildComparisonChartRows([])).toEqual([])
  })
})
