/** MT-07 "Editor Shell and Draft Isolation" -- production-path evidence
 * against the real `DashboardCanonicalEditor` component (not a test-only
 * harness). See `../lib/dashboardSpacing.dom.test.tsx` for why
 * `getBoundingClientRect()` is overridden for DOM-based rect assertions in
 * this jsdom environment (no real layout engine, no browser test runner
 * configured in this repository) -- the same documented, inline-style-based
 * technique is reused here rather than duplicated invention.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import * as apiClient from "../lib/apiClient"
import { CanonicalWidgetGrid, DashboardCanonicalEditor } from "./DashboardCanonicalEditor"
import { useDashboardEditor } from "../hooks/useDashboardEditor"
import { useChartCatalog } from "../hooks/useChartCatalog"
import { useSelectedCreator } from "../hooks/useSelectedCreator"
import { mockCreators } from "../data/mockCreators"
import type { MockCreator } from "../data/mockCreators"
import type { CanonicalLayout } from "../types/dashboardLayout"
import type { ChartCatalogItem } from "../types/dashboardChartCatalog"

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

function pixelStyleValue(el: HTMLElement, prop: "left" | "top"): number {
  const parsed = parseFloat(el.style[prop])
  return Number.isFinite(parsed) ? parsed : 0
}

function computeAbsoluteRect(el: HTMLElement) {
  let left = 0
  let top = 0
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    left += pixelStyleValue(node, "left")
    top += pixelStyleValue(node, "top")
  }
  const width = parseFloat(el.style.width) || 0
  const height = parseFloat(el.style.height) || 0
  return { left, top, width, height, right: left + width, bottom: top + height }
}

let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect

beforeAll(() => {
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return computeAbsoluteRect(this) as DOMRect
  }
})

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DashboardCanonicalEditor — toolbar and guides (AC2-4)", () => {
  it("view mode renders no edit guides or insertion markers (AC4)", () => {
    render(<DashboardCanonicalEditor layout={LAYOUT} />)
    expect(screen.queryByTestId("canonical-edit-guide")).not.toBeInTheDocument()
  })

  it("edit mode renders dashed grid guides for every widget (AC2)", () => {
    render(<DashboardCanonicalEditor layout={LAYOUT} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))

    const guides = screen.getAllByTestId("canonical-edit-guide")
    expect(guides).toHaveLength(LAYOUT.widgets.length)
    for (const guide of guides) {
      expect(getComputedStyle(guide).borderStyle).toBe("dashed")
    }
  })

  it("edit mode renders buttons named Save, Cancel, and Restore Default (AC3)", () => {
    render(<DashboardCanonicalEditor layout={LAYOUT} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Restore Default" })).toBeInTheDocument()
  })
})

describe("DashboardCanonicalEditor — geometry neutrality (AC5, AC6)", () => {
  it("the dashed guide adds no independent margin, padding, width, or height (AC5)", () => {
    render(<DashboardCanonicalEditor layout={LAYOUT} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))

    const boxes = screen.getAllByTestId("canonical-widget-box")
    const guides = screen.getAllByTestId("canonical-edit-guide")
    for (let i = 0; i < boxes.length; i++) {
      expect(guides[i].getBoundingClientRect()).toEqual(boxes[i].getBoundingClientRect())
    }
  })

  it("entering edit mode keeps every widget bounding rectangle and neighbor gap unchanged (AC6)", () => {
    render(<DashboardCanonicalEditor layout={LAYOUT} />)
    const viewRects = screen.getAllByTestId("canonical-widget-box").map((el) => el.getBoundingClientRect())

    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    const editRects = screen.getAllByTestId("canonical-widget-box").map((el) => el.getBoundingClientRect())

    expect(editRects).toEqual(viewRects)
  })
})

describe("DashboardCanonicalEditor — Cancel (AC9, AC10)", () => {
  it("Cancel restores IDs, coordinates, and order to the pre-edit snapshot and sends zero save requests (AC9, AC10)", async () => {
    const apiRequestSpy = vi.spyOn(apiClient, "apiRequest")
    render(<DashboardCanonicalEditor layout={LAYOUT} />)

    const beforeIds = screen.getAllByTestId("canonical-widget-box").map((el) => el.dataset.widgetId)

    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    // Drag guide is present while editing -- prove Cancel removes it and
    // restores the exact pre-edit widget set/order in the DOM.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    const afterIds = screen.getAllByTestId("canonical-widget-box").map((el) => el.dataset.widgetId)
    expect(afterIds).toEqual(beforeIds)
    expect(screen.queryByTestId("canonical-edit-guide")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit Layout" })).toBeInTheDocument()
    expect(apiRequestSpy).not.toHaveBeenCalled()
  })
})

describe("DashboardCanonicalEditor — Restore Default (AC11, AC12)", () => {
  it("Restore Default changes only the draft, leaves canonical view state alone once cancelled, and sends zero save requests (AC12)", () => {
    const apiRequestSpy = vi.spyOn(apiClient, "apiRequest")
    render(<DashboardCanonicalEditor layout={LAYOUT} />)

    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore Default" }))

    // Draft became MT-03's fresh 2x2 default (four default widgets), still in edit mode.
    expect(screen.getAllByTestId("canonical-widget-box")).toHaveLength(4)
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
    expect(apiRequestSpy).not.toHaveBeenCalled()

    // Cancelling afterward proves the canonical/view layout was never touched.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    const idsAfterCancel = screen.getAllByTestId("canonical-widget-box").map((el) => el.dataset.widgetId)
    expect(idsAfterCancel).toEqual(["a", "b"])
    expect(apiRequestSpy).not.toHaveBeenCalled()
  })
})

describe("DashboardCanonicalEditor — production widget-list renderer keys by widgetId (AC13)", () => {
  it("keeps the same DOM node for an unchanged widgetId when the layout's widget order changes", () => {
    // CanonicalWidgetGrid is the actual production rendering function
    // DashboardCanonicalEditor uses internally (not a test-only harness) --
    // exercised directly here with a controlled `layout` prop, since the
    // stateful editor hook intentionally owns its own committed layout once
    // mounted and this proof is about the render function's keying, not the
    // hook's state-ownership behavior.
    const { rerender } = render(<CanonicalWidgetGrid layout={LAYOUT} editMode={false} />)
    const originalNode = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "b")

    // Same widgets, reversed array order -- an index-keyed list would reuse
    // and mutate the DOM node that used to represent "a" into now
    // representing "b" instead of moving "b"'s own node; a widgetId-keyed
    // list must keep b's own node.
    const reordered: CanonicalLayout = { ...LAYOUT, widgets: [...LAYOUT.widgets].reverse() }
    rerender(<CanonicalWidgetGrid layout={reordered} editMode={false} />)

    const nodeAfterReorder = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "b")
    expect(nodeAfterReorder).toBe(originalNode)
  })
})

describe("MT-09 — direct Save through the real production component (no existing widget affected)", () => {
  it("clicking Save after Restore Default (an entirely new widget set, nothing existing changed) sends exactly one save request with no confirmation dialog", async () => {
    const submitSave = vi.fn(async () => {})
    render(<DashboardCanonicalEditor layout={LAYOUT} submitSave={submitSave} />)

    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore Default" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(submitSave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit Layout" })).toBeInTheDocument() // back to view mode
    expect(screen.getAllByTestId("canonical-widget-box")).toHaveLength(4) // MT-03's default widget count
  })

  // NOTE: the confirmation-triggering path (AC1: "a draft that changes
  // existing widget geometry") cannot currently be exercised through
  // DashboardCanonicalEditor's own rendered UI -- there is no production
  // control yet for moving/resizing an existing widget or inserting a new
  // one (that trigger UI is GAP-2's canonical Add-widget UI and GAP-4's
  // real drag/resize gesture, both still unresolved). That path's
  // substance (dialog opens, zero requests until confirm, exactly one
  // request on confirm, atomic commit/rollback) is instead proven against
  // the exact same `useDashboardEditor`/`submitLayoutSave` functions this
  // component calls internally, in `useDashboardEditor.test.ts`'s "save() /
  // grid-change confirmation (MT-09)" suite and the AC12 test below (which
  // reaches an affected-widget draft via MT-08's insertion, the one
  // existing mechanism that can produce one). The dialog's own rendering
  // and button wiring are proven directly in `GridChangeConfirmationDialog.test.tsx`.
})

describe("MT-08 — insertion-slot preview (rendered against the real production hook + renderer)", () => {
  // Guidelines Section 7's own worked example: a single-row A|B layout.
  const ROW: CanonicalLayout = {
    grid: { columns: 2, rows: 1 },
    widgets: [
      { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    ],
  }

  it("the active insertion slot is visibly represented by a placeholder marker (AC3)", () => {
    const { result } = renderHook(() => useDashboardEditor(ROW))
    act(() => result.current.enterEditMode())
    act(() => result.current.beginInsertion("insights"))
    act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))
    const candidateId = result.current.insertionCandidate!.widgetId

    render(<CanonicalWidgetGrid layout={result.current.draftLayout} editMode={result.current.editMode} insertionCandidateId={candidateId} />)

    const placeholder = screen.getByTestId("insertion-placeholder")
    expect(getComputedStyle(placeholder).borderStyle).toBe("dashed")
    expect(placeholder.parentElement?.dataset.widgetId).toBe(candidateId)
  })

  it("widget spacing remains exactly 16px throughout the preview (AC10)", () => {
    const { result } = renderHook(() => useDashboardEditor(ROW))
    act(() => result.current.enterEditMode())
    act(() => result.current.beginInsertion("insights"))
    act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))

    render(
      <CanonicalWidgetGrid
        layout={result.current.draftLayout}
        editMode={result.current.editMode}
        insertionCandidateId={result.current.insertionCandidate?.widgetId}
      />,
    )

    const boxes = screen.getAllByTestId("canonical-widget-box")
    expect(boxes).toHaveLength(3) // A, the candidate, B
    for (let i = 0; i < boxes.length - 1; i++) {
      const left = boxes[i].getBoundingClientRect()
      const right = boxes[i + 1].getBoundingClientRect()
      expect(right.left - left.right).toBe(16)
    }
  })

  it("the insertion placeholder and the resulting committed widget have identical border-box rectangles (AC11)", () => {
    const { result } = renderHook(() => useDashboardEditor(ROW))
    act(() => result.current.enterEditMode())
    act(() => result.current.beginInsertion("insights"))
    act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))
    const candidateId = result.current.insertionCandidate!.widgetId

    const { unmount: unmountPreview } = render(
      <CanonicalWidgetGrid layout={result.current.draftLayout} editMode={result.current.editMode} insertionCandidateId={candidateId} />,
    )
    const placeholderRect = screen.getByTestId("insertion-placeholder").getBoundingClientRect()
    unmountPreview()

    act(() => result.current.commitInsertion())

    render(<CanonicalWidgetGrid layout={result.current.draftLayout} editMode={result.current.editMode} insertionCandidateId={null} />)
    const resultBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === candidateId)!
    expect(resultBox.getBoundingClientRect()).toEqual(placeholderRect)
  })

  it("removing the dashed guide when returning to view mode does not shift the newly inserted widget (AC12)", async () => {
    const submitSave = vi.fn(async () => {})
    const { result } = renderHook(() => useDashboardEditor(ROW, submitSave))
    act(() => result.current.enterEditMode())
    act(() => result.current.beginInsertion("insights"))
    act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))
    const candidateId = result.current.insertionCandidate!.widgetId
    act(() => result.current.commitInsertion())

    const { unmount: unmountEdit } = render(<CanonicalWidgetGrid layout={result.current.draftLayout} editMode />)
    const editRect = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === candidateId)!.getBoundingClientRect()
    unmountEdit()

    // The insertion narrowed/repositioned "b" (an existing widget), so save()
    // opens the MT-09 grid-change confirmation instead of submitting directly.
    await act(async () => {
      await result.current.save()
    })
    expect(result.current.gridChangeConfirmation).not.toBeNull()
    await act(async () => {
      await result.current.confirmGridChange()
    })

    render(<CanonicalWidgetGrid layout={result.current.layout} editMode={false} />)
    const viewRect = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === candidateId)!.getBoundingClientRect()

    expect(viewRect).toEqual(editRect)
  })
})

describe("DashboardCanonicalEditor / CanonicalWidgetGrid — MT-11 Flow 1: In-Widget Creator Picker", () => {
  const COMPARISON_LAYOUT: CanonicalLayout = {
    grid: { columns: 2, rows: 2 },
    widgets: [
      {
        widgetId: "comparison-widget",
        widgetType: "creator-comparison-chart",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        comparison: { creatorIds: ["creator-a", "creator-b"], comparisonItemIds: [] },
      },
      { widgetId: "unrelated-widget", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
    ],
  }

  const COMPARISON_CREATORS: MockCreator[] = [
    { channelId: "creator-a", channelName: "A", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
    { channelId: "creator-b", channelName: "B", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
    { channelId: "creator-c", channelName: "C", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
  ]

  it("AC1: only the compatible (creator-comparison-chart) widget exposes Select Creators", () => {
    render(<DashboardCanonicalEditor layout={COMPARISON_LAYOUT} comparisonCreators={COMPARISON_CREATORS} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))

    // Exactly one -- the comparison widget -- not the unrelated kpi-summary widget.
    expect(screen.getAllByRole("button", { name: "Select Creators" })).toHaveLength(1)
  })

  it("does not expose Select Creators when no comparisonCreators data source is wired (no silent partial feature)", () => {
    render(<DashboardCanonicalEditor layout={COMPARISON_LAYOUT} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))

    expect(screen.queryByRole("button", { name: "Select Creators" })).not.toBeInTheDocument()
  })

  it("AC2 correction: the widget's Select Creators action opens the real production Creator List data (mockCreators), not a fabricated fixture list", () => {
    render(<DashboardCanonicalEditor layout={COMPARISON_LAYOUT} comparisonCreators={mockCreators} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))

    expect(screen.getByRole("dialog", { name: "Select Creators" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: mockCreators[0].channelName })).toBeInTheDocument()
  })

  it("AC2/AC3: activating it opens the existing Creator List with A, B already selected in order 1, 2 (rendered against the real production hook + renderer)", () => {
    const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
    act(() => result.current.enterEditMode())
    render(
      <CanonicalWidgetGrid
        layout={result.current.draftLayout}
        editMode={result.current.editMode}
        comparisonCreators={COMPARISON_CREATORS}
        onApplyComparisonSelection={result.current.updateDraftWidgetComparison}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))

    expect(screen.getByRole("dialog", { name: "Select Creators" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "C" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Comparison order 1")).toBeInTheDocument()
    expect(screen.getByLabelText("Comparison order 2")).toBeInTheDocument()
  })

  it("AC4/AC7: applying A/B updates only the target widget's draft; the unrelated widget and canonical layout stay deep-equal (and reference-equal)", () => {
    const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
    act(() => result.current.enterEditMode())
    render(
      <CanonicalWidgetGrid
        layout={result.current.draftLayout}
        editMode={result.current.editMode}
        comparisonCreators={COMPARISON_CREATORS}
        onApplyComparisonSelection={result.current.updateDraftWidgetComparison}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
      "creator-a",
      "creator-b",
    ])
    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "unrelated-widget")).toBe(COMPARISON_LAYOUT.widgets[1])
    expect(result.current.layout).toBe(COMPARISON_LAYOUT) // canonical unaffected by Apply
    expect(result.current.layout).toEqual(COMPARISON_LAYOUT)
  })

  it("AC5: adding C to an existing A/B draft produces A vs B vs C without reordering A/B", () => {
    const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
    act(() => result.current.enterEditMode())
    render(
      <CanonicalWidgetGrid
        layout={result.current.draftLayout}
        editMode={result.current.editMode}
        comparisonCreators={COMPARISON_CREATORS}
        onApplyComparisonSelection={result.current.updateDraftWidgetComparison}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "C" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
      "creator-a",
      "creator-b",
      "creator-c",
    ])
  })

  it("AC6: cancelling the picker leaves the previous comparison configuration unchanged", () => {
    const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
    act(() => result.current.enterEditMode())
    render(
      <CanonicalWidgetGrid
        layout={result.current.draftLayout}
        editMode={result.current.editMode}
        comparisonCreators={COMPARISON_CREATORS}
        onApplyComparisonSelection={result.current.updateDraftWidgetComparison}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "C" })) // change picker-local selection
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(result.current.draftLayout).toEqual(COMPARISON_LAYOUT)
    expect(result.current.layout).toEqual(COMPARISON_LAYOUT)
  })

  it("target widget geometry (widgetId, x, y, width, height) is identical before and after a successful Apply", () => {
    const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
    act(() => result.current.enterEditMode())
    render(
      <CanonicalWidgetGrid
        layout={result.current.draftLayout}
        editMode={result.current.editMode}
        comparisonCreators={COMPARISON_CREATORS}
        onApplyComparisonSelection={result.current.updateDraftWidgetComparison}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "C" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    const before = COMPARISON_LAYOUT.widgets[0]
    const after = result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")!
    expect({ widgetId: after.widgetId, x: after.x, y: after.y, width: after.width, height: after.height }).toEqual({
      widgetId: before.widgetId,
      x: before.x,
      y: before.y,
      width: before.width,
      height: before.height,
    })
  })

  it("AC7: Apply sends zero Dashboard save/persistence requests and never opens the MT-09 grid-change confirmation", async () => {
    const apiRequestSpy = vi.spyOn(apiClient, "apiRequest")
    const submitSave = vi.fn(async (_layout: CanonicalLayout) => {})
    render(<DashboardCanonicalEditor layout={COMPARISON_LAYOUT} comparisonCreators={COMPARISON_CREATORS} submitSave={submitSave} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "C" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(apiRequestSpy).not.toHaveBeenCalled()
    expect(submitSave).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument() // no grid-change confirmation opened

    // Only an explicit Save (unrelated to this microtask's own scope) ever submits,
    // and a comparison-only change never forces existing widget geometry, so it
    // commits directly without a confirmation dialog.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    expect(submitSave).toHaveBeenCalledTimes(1)
    const savedLayout = submitSave.mock.calls[0][0]
    expect(savedLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
      "creator-a",
      "creator-b",
      "creator-c",
    ])
  })

  it("AC8: the chart catalog request count does not increase across open/select/cancel/reopen/apply", async () => {
    const fetchCatalog = vi.fn(() => Promise.resolve<ChartCatalogItem[]>([{ chartDefinitionId: "revenue-trend", title: "Revenue Trend" }]))

    function CatalogAndEditorHarness() {
      // Mounted once alongside the editor -- simulating GAP-1's eventual
      // production wiring (unresolved, out of MT-11's scope) -- so this
      // proves the picker flow itself never triggers a second request,
      // independent of when/whether GAP-1 is resolved.
      useChartCatalog(fetchCatalog)
      return <DashboardCanonicalEditor layout={COMPARISON_LAYOUT} comparisonCreators={COMPARISON_CREATORS} />
    }

    render(<CatalogAndEditorHarness />)
    await waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "C" }))
    // Scoped to the dialog: the editor's own toolbar also has a "Cancel" button.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Select Creators" })) // reopen
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(fetchCatalog).toHaveBeenCalledTimes(1)
  })

  it("does not change the application's current/active creator", () => {
    const activeCreator = renderHook(() => useSelectedCreator())
    const activeBefore = activeCreator.result.current[0]
    expect(activeBefore).toBe(mockCreators[0].channelId)

    render(<DashboardCanonicalEditor layout={COMPARISON_LAYOUT} comparisonCreators={COMPARISON_CREATORS} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit Layout" }))
    fireEvent.click(screen.getByRole("button", { name: "Select Creators" }))
    fireEvent.click(screen.getByRole("button", { name: "C" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))

    expect(activeCreator.result.current[0]).toBe(activeBefore)
  })
})
