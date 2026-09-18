import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useComparisonMappingDialog } from "./useComparisonMappingDialog"
import type { CanonicalLayout } from "../types/dashboardLayout"

const CANONICAL_LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

function resolvingSubmit() {
  return vi.fn(async (_layout: CanonicalLayout) => {})
}

describe("useComparisonMappingDialog", () => {
  it("MT-12 AC1-AC2: selecting A, B, C stores click order, and selecting three items keeps their order", () => {
    const { result } = renderHook(() => useComparisonMappingDialog(CANONICAL_LAYOUT, resolvingSubmit(), vi.fn()))
    act(() => result.current.open())
    act(() => result.current.toggleCreator("creator-a"))
    act(() => result.current.toggleCreator("creator-b"))
    act(() => result.current.toggleCreator("creator-c"))
    act(() => result.current.toggleItem("revenue"))
    act(() => result.current.toggleItem("engagement"))
    act(() => result.current.toggleItem("growth"))

    expect(result.current.orderedCreatorIds).toEqual(["creator-a", "creator-b", "creator-c"])
    expect(result.current.orderedItemIds).toEqual(["revenue", "engagement", "growth"])
  })

  it("Save remains disabled below two creators or below one item", () => {
    const { result } = renderHook(() => useComparisonMappingDialog(CANONICAL_LAYOUT, resolvingSubmit(), vi.fn()))
    act(() => result.current.open())
    expect(result.current.canSave).toBe(false)

    act(() => result.current.toggleCreator("creator-a"))
    expect(result.current.canSave).toBe(false) // only one creator

    act(() => result.current.toggleCreator("creator-b"))
    expect(result.current.canSave).toBe(false) // no item yet

    act(() => result.current.toggleItem("revenue"))
    expect(result.current.canSave).toBe(true)
  })

  it("MT-12 AC11: Save is disabled and no transaction is sent when the mapping needs a widget with no valid slot", async () => {
    const fullLayout: CanonicalLayout = {
      grid: { columns: 1, rows: 1 },
      widgets: [{ widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    const submit = resolvingSubmit()
    const onCommitted = vi.fn()
    const { result } = renderHook(() => useComparisonMappingDialog(fullLayout, submit, onCommitted))
    act(() => result.current.open())
    act(() => result.current.toggleCreator("creator-a"))
    act(() => result.current.toggleCreator("creator-b"))
    act(() => result.current.toggleItem("revenue"))
    act(() => result.current.toggleItem("engagement")) // needs a 2nd widget; none available

    expect(result.current.canSave).toBe(false)

    await act(async () => {
      await result.current.save()
    })

    expect(submit).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(result.current.isOpen).toBe(true) // dialog stays open
    expect(fullLayout.widgets).toHaveLength(1) // existing config unchanged
  })

  it("MT-12 AC13/AC15: Save sends exactly one transaction and closes the dialog on success", async () => {
    const submit = resolvingSubmit()
    const onCommitted = vi.fn()
    const { result } = renderHook(() => useComparisonMappingDialog(CANONICAL_LAYOUT, submit, onCommitted))
    act(() => result.current.open())
    act(() => result.current.toggleCreator("creator-a"))
    act(() => result.current.toggleCreator("creator-b"))
    act(() => result.current.toggleItem("revenue"))
    act(() => result.current.toggleItem("engagement"))

    await act(async () => {
      await result.current.save()
    })

    expect(submit).toHaveBeenCalledTimes(1)
    expect(onCommitted).toHaveBeenCalledTimes(1)
    const committedLayout = onCommitted.mock.calls[0][0] as CanonicalLayout
    expect(committedLayout.widgets.find((w) => w.widgetId === "widget-a")?.comparison?.comparisonItemIds).toEqual(["revenue"])
    expect(result.current.isOpen).toBe(false)
  })

  it("MT-12 AC14: the transaction is built only from canonicalLayout -- an unrelated draft-only change is never included", async () => {
    // Simulates an unrelated in-progress Dashboard edit that lives only in a
    // draftLayout the caller never passes to this hook -- proving isolation
    // by construction rather than by convention.
    const unrelatedDraftLayout: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        { widgetId: "widget-a", widgetType: "kpi-summary", x: 1, y: 1, width: 1, height: 1 }, // moved, unsaved
        { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const submit = resolvingSubmit()
    const onCommitted = vi.fn()
    const { result } = renderHook(() => useComparisonMappingDialog(CANONICAL_LAYOUT, submit, onCommitted))
    act(() => result.current.open())
    act(() => result.current.toggleCreator("creator-a"))
    act(() => result.current.toggleCreator("creator-b"))
    act(() => result.current.toggleItem("revenue"))

    await act(async () => {
      await result.current.save()
    })

    const submittedLayout = submit.mock.calls[0][0]
    const widgetA = submittedLayout.widgets.find((w) => w.widgetId === "widget-a")!
    expect(widgetA.x).toBe(0) // canonical's own position, not the unrelated draft's moved (1,1)
    expect(widgetA.y).toBe(0)
    expect(unrelatedDraftLayout.widgets[0].x).toBe(1) // sanity: the unrelated draft itself is untouched
  })

  it("MT-12 AC19: a failed transaction leaves the dialog open and commits nothing", async () => {
    const submit = vi.fn(async () => {
      throw new Error("network down")
    })
    const onCommitted = vi.fn()
    const { result } = renderHook(() => useComparisonMappingDialog(CANONICAL_LAYOUT, submit, onCommitted))
    act(() => result.current.open())
    act(() => result.current.toggleCreator("creator-a"))
    act(() => result.current.toggleCreator("creator-b"))
    act(() => result.current.toggleItem("revenue"))

    await act(async () => {
      await result.current.save()
    })

    expect(onCommitted).not.toHaveBeenCalled()
    expect(result.current.isOpen).toBe(true)
    expect(result.current.error).toBe("network down")
  })
})
