import { describe, expect, it } from "vitest"
import { describeCreatorDrop, dropCreatorsOntoWidget } from "./dashboardCreatorDrop"
import type { CanonicalLayout } from "../../editor/model/dashboardLayout"

describe("ordinary chart creator scope", () => {
  const scopedLayout: CanonicalLayout = {
    grid: { columns: 2, rows: 1 },
    widgets: [
      { widgetId: "growth", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "kpi", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
    ],
  }

  it("stores the complete ordered selection only on a compatible target", () => {
    const result = dropCreatorsOntoWidget(scopedLayout, "growth", ["creator-b", "creator-a", "creator-b"])
    expect(result.widgets[0].creatorScope?.creatorIds).toEqual(["creator-b", "creator-a"])
    expect(result.widgets[1]).toBe(scopedLayout.widgets[1])
  })

  it("replaces an existing chart scope without changing its geometry", () => {
    const initial: CanonicalLayout = {
      ...scopedLayout,
      widgets: [{ ...scopedLayout.widgets[0], creatorScope: { creatorIds: ["creator-a"] } }, scopedLayout.widgets[1]],
    }
    const result = dropCreatorsOntoWidget(initial, "growth", ["creator-c"])
    expect(result.widgets[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1, creatorScope: { creatorIds: ["creator-c"] } })
  })

  it("rejects unsupported KPI widgets and reports compatibility", () => {
    expect(dropCreatorsOntoWidget(scopedLayout, "kpi", ["creator-a"])).toBe(scopedLayout)
    expect(describeCreatorDrop(scopedLayout, "growth")).toEqual({ status: "accepted" })
    expect(describeCreatorDrop(scopedLayout, "kpi")).toEqual({ status: "incompatible" })
  })

  it("classifies an unknown widgetId as missing", () => {
    expect(describeCreatorDrop(scopedLayout, "nope")).toEqual({ status: "missing" })
  })
})
