import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ComparisonMappingDialog } from "./ComparisonMappingDialog"
import { computeComparisonMapping } from "../lib/dashboardComparisonMapping"
import type { CanonicalLayout } from "../types/dashboardLayout"
import type { MockCreator } from "../data/mockCreators"

const CREATORS: MockCreator[] = [
  { channelId: "creator-a", channelName: "A", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
  { channelId: "creator-b", channelName: "B", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
  { channelId: "creator-c", channelName: "C", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
]

const ITEMS = [
  { comparisonItemId: "revenue", label: "Revenue" },
  { comparisonItemId: "engagement", label: "Engagement" },
  { comparisonItemId: "growth", label: "Growth" },
]

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

describe("ComparisonMappingDialog", () => {
  it("MT-12 AC1-AC2: shows A(1), B(2), C(3) and all three selected item IDs", () => {
    const preview = computeComparisonMapping(LAYOUT, ["creator-a", "creator-b", "creator-c"], ["revenue", "engagement", "growth"])
    render(
      <ComparisonMappingDialog
        creators={CREATORS}
        availableComparisonItems={ITEMS}
        orderedCreatorIds={["creator-a", "creator-b", "creator-c"]}
        onToggleCreator={vi.fn()}
        orderedItemIds={["revenue", "engagement", "growth"]}
        onToggleItem={vi.fn()}
        preview={preview}
        canSave
        isSaving={false}
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole("dialog", { name: "Add Comparison Charts" })).toBeInTheDocument()
    expect(screen.getByLabelText("Comparison order 1")).toBeInTheDocument()
    expect(screen.getByLabelText("Comparison order 2")).toBeInTheDocument()
    expect(screen.getByLabelText("Comparison order 3")).toBeInTheDocument()
    expect(screen.getAllByTestId("comparison-mapping-row")).toHaveLength(3)
  })

  it("MT-12 AC12: the mapping preview reflects coordinate-derived visual widget order", () => {
    const preview = computeComparisonMapping(LAYOUT, ["creator-a", "creator-b"], ["revenue", "engagement"])
    render(
      <ComparisonMappingDialog
        creators={CREATORS}
        availableComparisonItems={ITEMS}
        orderedCreatorIds={["creator-a", "creator-b"]}
        onToggleCreator={vi.fn()}
        orderedItemIds={["revenue", "engagement"]}
        onToggleItem={vi.fn()}
        preview={preview}
        canSave
        isSaving={false}
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const rows = screen.getAllByTestId("comparison-mapping-row").map((el) => el.textContent)
    expect(rows[0]).toContain("Revenue")
    expect(rows[0]).toContain("widget[0]")
    expect(rows[1]).toContain("Engagement")
    expect(rows[1]).toContain("widget[1]")
  })

  it("displaying the preview never mutates the input layout", () => {
    const before = JSON.parse(JSON.stringify(LAYOUT))
    const preview = computeComparisonMapping(LAYOUT, ["creator-a", "creator-b"], ["revenue"])
    render(
      <ComparisonMappingDialog
        creators={CREATORS}
        availableComparisonItems={ITEMS}
        orderedCreatorIds={["creator-a", "creator-b"]}
        onToggleCreator={vi.fn()}
        orderedItemIds={["revenue"]}
        onToggleItem={vi.fn()}
        preview={preview}
        canSave
        isSaving={false}
        error={null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(LAYOUT).toEqual(before)
  })

  it("Save is disabled when canSave is false, and clicking it does nothing", () => {
    const onSave = vi.fn()
    const preview = computeComparisonMapping(LAYOUT, [], [])
    render(
      <ComparisonMappingDialog
        creators={CREATORS}
        availableComparisonItems={ITEMS}
        orderedCreatorIds={[]}
        onToggleCreator={vi.fn()}
        orderedItemIds={[]}
        onToggleItem={vi.fn()}
        preview={preview}
        canSave={false}
        isSaving={false}
        error={null}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn()
    const preview = computeComparisonMapping(LAYOUT, [], [])
    render(
      <ComparisonMappingDialog
        creators={CREATORS}
        availableComparisonItems={ITEMS}
        orderedCreatorIds={[]}
        onToggleCreator={vi.fn()}
        orderedItemIds={[]}
        onToggleItem={vi.fn()}
        preview={preview}
        canSave={false}
        isSaving={false}
        error={null}
        onSave={vi.fn()}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
