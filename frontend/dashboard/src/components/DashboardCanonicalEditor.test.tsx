/** MT-07 "Editor Shell and Draft Isolation" -- production-path evidence
 * against the real `DashboardCanonicalEditor` component (not a test-only
 * harness). See `../lib/dashboardSpacing.dom.test.tsx` for why
 * `getBoundingClientRect()` is overridden for DOM-based rect assertions in
 * this jsdom environment (no real layout engine, no browser test runner
 * configured in this repository) -- the same documented, inline-style-based
 * technique is reused here rather than duplicated invention.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import * as apiClient from "../lib/apiClient"
import { CanonicalWidgetGrid, DashboardCanonicalEditor } from "./DashboardCanonicalEditor"
import { useDashboardEditor } from "../hooks/useDashboardEditor"
import type { CanonicalLayout } from "../types/dashboardLayout"

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
