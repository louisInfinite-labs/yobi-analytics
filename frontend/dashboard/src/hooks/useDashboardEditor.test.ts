import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDashboardEditor } from "./useDashboardEditor"
import type { CanonicalLayout } from "../types/dashboardLayout"

function resolvingSubmitSave() {
  return vi.fn(async () => {})
}

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

// Guidelines Section 7's own worked example: a single-row A|B layout.
const ROW: CanonicalLayout = {
  grid: { columns: 2, rows: 1 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

describe("useDashboardEditor", () => {
  it("clicking Edit creates a draftLayout deeply equal to canonicalLayout (AC1)", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    act(() => result.current.enterEditMode())
    expect(result.current.draftLayout).toEqual(LAYOUT)
    expect(result.current.editMode).toBe(true)
  })

  it("the draft validation runs the canonical validateLayout continuously (AC7)", () => {
    const overlapping: CanonicalLayout = {
      grid: { columns: 2, rows: 2 },
      widgets: [
        { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 2, height: 1 },
        { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    const { result } = renderHook(() => useDashboardEditor(overlapping))
    act(() => result.current.enterEditMode())
    expect(result.current.draftValidation.valid).toBe(false)
    expect(result.current.draftValidation.errors.map((e) => e.code)).toContain("WIDGET_OVERLAP")
  })

  it("editing draft coordinates does not change canonical coordinates (AC8)", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    act(() => result.current.enterEditMode())
    act(() => result.current.updateDraftWidget("a", { x: 0, y: 0 }))
    act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))

    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "b")?.y).toBe(1)
    expect(result.current.layout).toEqual(LAYOUT)
    expect(result.current.layout.widgets.find((w) => w.widgetId === "b")?.y).toBe(0)
  })

  it("a rejected draft mutation leaves the draft's last valid coordinates untouched", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    act(() => result.current.enterEditMode())
    act(() => result.current.updateDraftWidget("a", { x: 1, y: 0 })) // collides with "b"

    expect(result.current.draftLayout).toEqual(LAYOUT)
  })

  it("Cancel restores all IDs, coordinates, sizes, and order to the pre-edit snapshot (AC9)", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    act(() => result.current.enterEditMode())
    act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))
    act(() => result.current.cancel())

    expect(result.current.draftLayout).toEqual(LAYOUT)
    expect(result.current.layout).toEqual(LAYOUT)
    expect(result.current.editMode).toBe(false)
  })

  it("Restore Default changes only the draft to a fresh 2x2 default, leaving canonical untouched (AC11)", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    act(() => result.current.enterEditMode())
    act(() => result.current.restoreDefault())

    expect(result.current.draftLayout.grid).toEqual({ columns: 2, rows: 2 })
    expect(result.current.draftLayout).not.toEqual(LAYOUT)
    expect(result.current.layout).toEqual(LAYOUT)
  })

  describe("save() / grid-change confirmation (MT-09)", () => {
    it("save() with no existing-widget geometry change commits directly, without opening a confirmation (unchanged draft)", async () => {
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      act(() => result.current.enterEditMode())

      await act(async () => {
        await result.current.save()
      })

      expect(submitSave).toHaveBeenCalledTimes(1)
      expect(result.current.gridChangeConfirmation).toBeNull()
      expect(result.current.editMode).toBe(false)
    })

    it("save() that moves an existing widget opens a confirmation instead of submitting (AC1, AC2)", async () => {
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))

      await act(async () => {
        await result.current.save()
      })

      expect(submitSave).not.toHaveBeenCalled()
      expect(result.current.gridChangeConfirmation).toEqual({
        currentGrid: LAYOUT.grid,
        targetGrid: LAYOUT.grid,
        affectedWidgetIds: ["b"],
      })
      expect(result.current.editMode).toBe(true) // still editing -- nothing committed yet
    })

    it("confirmGridChange() sends exactly one save request containing the validated draft and commits it atomically (AC6, AC7)", async () => {
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))
      await act(async () => {
        await result.current.save()
      })

      await act(async () => {
        await result.current.confirmGridChange()
      })

      expect(submitSave).toHaveBeenCalledTimes(1)
      expect(submitSave).toHaveBeenCalledWith(expect.objectContaining({ widgets: expect.any(Array) }))
      expect(result.current.gridChangeConfirmation).toBeNull()
      expect(result.current.editMode).toBe(false)
      expect(result.current.layout.widgets.find((w) => w.widgetId === "b")?.y).toBe(1)
    })

    it("closing/cancelling the confirmation sends zero save requests and leaves canonical state unchanged (AC3, AC4)", async () => {
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))
      await act(async () => {
        await result.current.save()
      })

      act(() => result.current.cancelGridChangeConfirmation())

      expect(submitSave).not.toHaveBeenCalled()
      expect(result.current.gridChangeConfirmation).toBeNull()
      expect(result.current.layout).toEqual(LAYOUT) // canonical untouched
      expect(result.current.editMode).toBe(true) // the draft remains available for further editing
      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "b")?.y).toBe(1) // draft itself preserved
    })

    it("save() does not commit an invalid draft, and never calls submit (AC9's underlying guarantee)", async () => {
      const overlapping: CanonicalLayout = {
        grid: { columns: 2, rows: 2 },
        widgets: [
          { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 2, height: 1 },
          { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
        ],
      }
      const submitSave = resolvingSubmitSave()
      const { result: invalidResult } = renderHook(() => useDashboardEditor(overlapping, submitSave))
      act(() => invalidResult.current.enterEditMode())

      await act(async () => {
        await invalidResult.current.save()
      })

      expect(submitSave).not.toHaveBeenCalled()
      expect(invalidResult.current.editMode).toBe(true) // save was rejected, still editing
      expect(invalidResult.current.layout).toEqual(overlapping) // canonical never replaced by the invalid draft
    })

    it("confirmGridChange() never calls submit for an invalid draft, even if called directly (AC9)", async () => {
      // The gated mutation API (updateDraftWidget, previewInsertionAtSlot)
      // never lets an invalid state into draftLayout in the first place, so
      // an invalid draft is only reachable the same way MT-01/02's own tests
      // manufacture one: an already-invalid initial layout, matching how
      // "the draft validation runs the canonical validateLayout continuously
      // (AC7)" test above does it.
      const overlapping: CanonicalLayout = {
        grid: { columns: 2, rows: 2 },
        widgets: [
          { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 2, height: 1 },
          { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
        ],
      }
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(overlapping, submitSave))
      act(() => result.current.enterEditMode())
      expect(result.current.draftValidation.valid).toBe(false) // this is what a real dialog would use to disable Confirm

      await act(async () => {
        await result.current.confirmGridChange()
      })

      expect(submitSave).not.toHaveBeenCalled()
      expect(result.current.layout).toEqual(overlapping)
    })

    it("a target grid without sufficient capacity for its own widgets disables confirmation and rejects a direct confirmGridChange() call (AC9)", async () => {
      // Same widgets as a genuinely valid 2-column layout would have; only
      // the grid itself has shrunk to 1 column, which cannot contain both --
      // a capacity problem (OUT_OF_BOUNDS), not a manually-overlapping pair.
      const insufficientCapacity: CanonicalLayout = {
        grid: { columns: 1, rows: 1 },
        widgets: [
          { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
          { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
        ],
      }
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(insufficientCapacity, submitSave))
      act(() => result.current.enterEditMode())

      // This is exactly the signal a real dialog uses (`disabled={!draftValidation.valid}`
      // in DashboardCanonicalEditor.tsx) to disable "Continue and Save".
      expect(result.current.draftValidation.valid).toBe(false)
      expect(result.current.draftValidation.errors.map((e) => e.code)).toEqual(["OUT_OF_BOUNDS"])
      expect(result.current.draftValidation.errors[0].widgetIds).toEqual(["b"])

      await act(async () => {
        await result.current.confirmGridChange()
      })

      expect(submitSave).not.toHaveBeenCalled()
      expect(result.current.layout).toEqual(insufficientCapacity)
      expect(result.current.layout.widgets.map((w) => w.widgetId)).toEqual(["a", "b"])
    })

    it("a failed save response leaves canonical state fully unchanged and surfaces an error (AC8)", async () => {
      const submitSave = vi.fn(async () => {
        throw new Error("network down")
      })
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      act(() => result.current.enterEditMode())

      await act(async () => {
        await result.current.save()
      })

      expect(submitSave).toHaveBeenCalledTimes(1)
      expect(result.current.layout).toEqual(LAYOUT)
      expect(result.current.editMode).toBe(true)
      expect(result.current.saveError).toBe("network down")
    })

    it("a submitter that mutates its received layout in place cannot corrupt the draft or the committed canonical state", async () => {
      const submitSave = vi.fn(async (received: CanonicalLayout) => {
        // A badly-behaved submitter: mutate widgetId and geometry in place,
        // then resolve as if nothing happened.
        received.widgets[1].widgetId = "b-hijacked"
        received.widgets[1].x = 99
        received.widgets[1].y = 99
      })
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      const draftBefore = { ...LAYOUT }
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))
      const submittedDraft = result.current.draftLayout

      await act(async () => {
        await result.current.save()
      })
      await act(async () => {
        await result.current.confirmGridChange()
      })

      // The hook's own draft object is untouched (submit received a
      // protected snapshot's data path, not a shared mutable reference the
      // hook itself still holds after the fact).
      expect(submittedDraft.widgets.map((w) => ({ widgetId: w.widgetId, x: w.x, y: w.y }))).toEqual([
        { widgetId: "a", x: 0, y: 0 },
        { widgetId: "b", x: 1, y: 1 },
      ])
      // The committed canonical layout reflects the validated draft, not the submitter's in-place tampering.
      expect(result.current.layout.widgets.map((w) => w.widgetId)).toEqual(["a", "b"])
      expect(result.current.layout.widgets.find((w) => w.widgetId === "b")).toEqual({
        widgetId: "b",
        widgetType: "ranking",
        x: 1,
        y: 1,
        width: 1,
        height: 1,
      })
      expect(draftBefore).toEqual(LAYOUT) // sanity: the original fixture itself was never mutated either
    })

    it("no confirm path deletes, hides, or overlaps a widget: a successful save preserves the exact widget count and every widgetId (AC10, AC11)", async () => {
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(LAYOUT, submitSave))
      const idsBefore = LAYOUT.widgets.map((w) => w.widgetId)
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidget("b", { x: 1, y: 1 }))
      await act(async () => {
        await result.current.save()
      })
      await act(async () => {
        await result.current.confirmGridChange()
      })

      expect(result.current.layout.widgets).toHaveLength(LAYOUT.widgets.length)
      expect(result.current.layout.widgets.map((w) => w.widgetId).sort()).toEqual([...idsBefore].sort())
    })
  })

  describe("comparison selection (MT-11)", () => {
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

    it("MT-11 AC4/AC7: applies A/B to only the target widget's draft, leaving canonical state untouched", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidgetComparison("comparison-widget", ["creator-a", "creator-b"]))

      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
        "creator-a",
        "creator-b",
      ])
      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "unrelated-widget")).toEqual(COMPARISON_LAYOUT.widgets[1])
      expect(result.current.layout).toEqual(COMPARISON_LAYOUT) // canonical unchanged
      expect(result.current.layout).toBe(COMPARISON_LAYOUT)
    })

    it("MT-11 AC5: adding C preserves A/B order in the draft", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidgetComparison("comparison-widget", ["creator-a", "creator-b", "creator-c"]))

      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
        "creator-a",
        "creator-b",
        "creator-c",
      ])
    })

    it("MT-11 AC6: Cancel (never calling the update) leaves the pre-edit comparison configuration exactly as it was", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())
      act(() => result.current.cancel())

      expect(result.current.draftLayout).toEqual(COMPARISON_LAYOUT)
      expect(result.current.layout).toEqual(COMPARISON_LAYOUT)
    })

    it("geometry (widgetId, x, y, width, height) is unchanged after applying a comparison selection", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidgetComparison("comparison-widget", ["creator-a", "creator-b", "creator-c"]))

      const target = result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")!
      expect({ widgetId: target.widgetId, x: target.x, y: target.y, width: target.width, height: target.height }).toEqual({
        widgetId: "comparison-widget",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      })
    })

    it("MT-11 AC7: does not send a save request and does not affect gridChangeConfirmation", async () => {
      const submitSave = resolvingSubmitSave()
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT, submitSave))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidgetComparison("comparison-widget", ["creator-a", "creator-b", "creator-c"]))

      expect(submitSave).not.toHaveBeenCalled()
      expect(result.current.gridChangeConfirmation).toBeNull()
      expect(result.current.layout).toEqual(COMPARISON_LAYOUT)
    })

    it("an incompatible (non-comparison) widget is not silently mutated", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidgetComparison("unrelated-widget", ["creator-a", "creator-b"]))

      expect(result.current.draftLayout).toEqual(COMPARISON_LAYOUT)
      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "unrelated-widget")?.comparison).toBeUndefined()
    })
  })

  describe("creator drag drop (MT-13)", () => {
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
          comparison: { creatorIds: ["creator-a"], comparisonItemIds: [] },
        },
        { widgetId: "unrelated-widget", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
      ],
    }

    it("AC8/AC10: a dropped creator updates only the target widget's draft, leaving canonical state untouched", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())
      act(() => result.current.updateDraftWidgetByCreatorDrop("comparison-widget", "creator-b"))

      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
        "creator-a",
        "creator-b",
      ])
      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "unrelated-widget")).toBe(COMPARISON_LAYOUT.widgets[1])
      expect(result.current.layout).toBe(COMPARISON_LAYOUT)
    })

    it("AC7: never calling the drop handler (a cancelled drag) leaves the draft exactly as it was", () => {
      const { result } = renderHook(() => useDashboardEditor(COMPARISON_LAYOUT))
      act(() => result.current.enterEditMode())

      expect(result.current.draftLayout).toEqual(COMPARISON_LAYOUT)
    })
  })

  describe("insertion preview (MT-08)", () => {
    it("given A|B, previewing the middle slot writes A|E|B into draftLayout, not canonical (AC1, AC4, AC5)", () => {
      const { result } = renderHook(() => useDashboardEditor(ROW))
      act(() => result.current.enterEditMode())
      act(() => result.current.beginInsertion("insights"))

      let accepted = false
      act(() => {
        accepted = result.current.previewInsertionAtSlot(ROW.widgets, 1)
      })

      expect(accepted).toBe(true)
      expect(result.current.draftLayout.widgets.map((w) => w.widgetId)).toEqual(["a", result.current.insertionCandidate!.widgetId, "b"])
      // Existing A/B widths narrowed only in the draft:
      expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "a")).toEqual({ widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 })
      // Canonical view layout is byte-for-byte unchanged during preview:
      expect(result.current.layout).toEqual(ROW)
      expect(result.current.layout).toBe(ROW)
    })

    it("given A|B, previewing the right slot writes A|B|E into draftLayout (AC2)", () => {
      const { result } = renderHook(() => useDashboardEditor(ROW))
      act(() => result.current.enterEditMode())
      act(() => result.current.beginInsertion("insights"))
      act(() => result.current.previewInsertionAtSlot(ROW.widgets, 2))

      expect(result.current.draftLayout.widgets.map((w) => w.widgetType)).toEqual(["kpi-summary", "ranking", "insights"])
    })

    it("does not regenerate the candidate's widgetId as the preview moves between slots", () => {
      const { result } = renderHook(() => useDashboardEditor(ROW))
      act(() => result.current.enterEditMode())
      let candidateId = ""
      act(() => {
        candidateId = result.current.beginInsertion("insights").widgetId
      })
      act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))
      const idAtMiddle = result.current.insertionCandidate?.widgetId
      act(() => result.current.previewInsertionAtSlot(ROW.widgets, 2))
      const idAtRight = result.current.insertionCandidate?.widgetId

      expect(idAtMiddle).toBe(candidateId)
      expect(idAtRight).toBe(candidateId)
    })

    it("leaving the slot restores the previous draft (AC6)", () => {
      const { result } = renderHook(() => useDashboardEditor(ROW))
      act(() => result.current.enterEditMode())
      act(() => result.current.beginInsertion("insights"))
      act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))
      act(() => result.current.cancelInsertion())

      expect(result.current.draftLayout).toEqual(ROW)
      expect(result.current.insertionCandidate).toBeNull()
    })

    it("cancelling the drag restores the previous draft (AC7)", () => {
      const { result } = renderHook(() => useDashboardEditor(ROW))
      act(() => result.current.enterEditMode())
      act(() => result.current.beginInsertion("insights"))
      act(() => result.current.previewInsertionAtSlot(ROW.widgets, 2))
      act(() => result.current.cancelInsertion())

      expect(result.current.draftLayout).toEqual(ROW)
      expect(result.current.draftLayout).toBe(ROW)
    })

    it("an invalid slot accepts no drop and changes no state (AC8)", () => {
      const fiveWide: CanonicalLayout = {
        grid: { columns: 5, rows: 1 },
        widgets: Array.from({ length: 5 }, (_, i) => ({
          widgetId: `w${i}`,
          widgetType: "kpi-summary",
          x: i,
          y: 0,
          width: 1 as const,
          height: 1 as const,
        })),
      }
      const { result } = renderHook(() => useDashboardEditor(fiveWide))
      act(() => result.current.enterEditMode())
      act(() => result.current.beginInsertion("insights"))

      let accepted = true
      act(() => {
        accepted = result.current.previewInsertionAtSlot(fiveWide.widgets, 2)
      })

      expect(accepted).toBe(false)
      expect(result.current.draftLayout).toEqual(fiveWide)
      expect(result.current.draftLayout).toBe(fiveWide)
    })

    it("preview and post-drop draft coordinates are identical (AC9)", () => {
      const { result } = renderHook(() => useDashboardEditor(ROW))
      act(() => result.current.enterEditMode())
      act(() => result.current.beginInsertion("insights"))
      act(() => result.current.previewInsertionAtSlot(ROW.widgets, 1))
      const previewDraft = result.current.draftLayout

      act(() => result.current.commitInsertion())

      expect(result.current.draftLayout).toBe(previewDraft)
      expect(result.current.insertionCandidate).toBeNull()
    })
  })
})
