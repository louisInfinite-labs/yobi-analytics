import { describe, expect, it, vi } from "vitest"
import { computeAffectedWidgetIds, submitLayoutSave } from "./dashboardLayoutSave"
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout, DashboardWidget } from "../model/dashboardLayout"

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1, ...overrides }
}

function layout(overrides: Partial<CanonicalLayout> = {}): CanonicalLayout {
  return { grid: { columns: 2, rows: 2 }, widgets: [], ...overrides }
}

describe("computeAffectedWidgetIds", () => {
  it("is empty when the draft is identical to canonical", () => {
    const canonical = layout({ widgets: [widget({ widgetId: "a" }), widget({ widgetId: "b", x: 1 })] })
    const draft = layout({ widgets: [widget({ widgetId: "a" }), widget({ widgetId: "b", x: 1 })] })
    expect(computeAffectedWidgetIds(canonical, draft)).toEqual([])
  })

  it("flags an existing widget whose position or size changed", () => {
    const canonical = layout({ widgets: [widget({ widgetId: "a", x: 0 })] })
    const draft = layout({ widgets: [widget({ widgetId: "a", x: 1 })] })
    expect(computeAffectedWidgetIds(canonical, draft)).toEqual(["a"])
  })

  it("does not flag a brand-new widget present only in the draft (e.g. an MT-08 insertion candidate)", () => {
    const canonical = layout({ widgets: [widget({ widgetId: "a" })] })
    const draft = layout({ grid: { columns: 3, rows: 2 }, widgets: [widget({ widgetId: "a" }), widget({ widgetId: "e", x: 1 })] })
    expect(computeAffectedWidgetIds(canonical, draft)).toEqual([])
  })

  it("flags existing widgets narrowed by an MT-08 insertion alongside the new candidate", () => {
    const canonical = layout({
      grid: { columns: 2, rows: 1 },
      widgets: [widget({ widgetId: "a", x: 0 }), widget({ widgetId: "b", x: 1 })],
    })
    // A and B narrowed/repositioned to make room for "e" in the middle.
    const draft = layout({
      grid: { columns: 3, rows: 1 },
      widgets: [widget({ widgetId: "a", x: 0 }), widget({ widgetId: "e", x: 1 }), widget({ widgetId: "b", x: 2 })],
    })
    expect(computeAffectedWidgetIds(canonical, draft).sort()).toEqual(["b"])
  })
})

describe("submitLayoutSave", () => {
  it("calls submit exactly once with the validated draft and commits that same draft (AC6, AC7)", async () => {
    const draft = layout({ widgets: [widget({ widgetId: "a" })] })
    const submit = vi.fn(async () => {})

    const outcome = await submitLayoutSave(draft, submit)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(draft)
    expect(outcome.committed).toBe(true)
    // A snapshot taken before submit was called, not the same object
    // reference -- see "in-place mutation" tests below for why.
    expect(outcome.layout).toEqual(draft)
    expect(outcome.layout).not.toBe(draft)
  })

  it("rejects a draft containing duplicate widgetId values before submit is ever called (AC11)", async () => {
    const duplicateDraft = layout({
      widgets: [widget({ widgetId: "dup", x: 0 }), widget({ widgetId: "dup", x: 1 })],
    })
    const submit = vi.fn(async () => {})

    const outcome = await submitLayoutSave(duplicateDraft, submit)

    expect(submit).not.toHaveBeenCalled()
    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("DUPLICATE_WIDGET_ID")
  })

  it("rejects any other invalid draft (e.g. overlap) before submit is called", async () => {
    const overlapping = layout({
      widgets: [widget({ widgetId: "a", x: 0, width: 2 }), widget({ widgetId: "b", x: 1 })],
    })
    const submit = vi.fn(async () => {})

    const outcome = await submitLayoutSave(overlapping, submit)

    expect(submit).not.toHaveBeenCalled()
    expect(outcome.committed).toBe(false)
    expect(outcome.result.errors.map((e) => e.code)).toContain("WIDGET_OVERLAP")
  })

  it("a target grid without sufficient capacity for the existing widgets is rejected as OUT_OF_BOUNDS, not merely an overlap, and submit is never called (AC9)", async () => {
    // Requirement #1: canonical is genuinely valid before anything happens.
    const canonicalValid: CanonicalLayout = {
      grid: { columns: 2, rows: 1 },
      widgets: [widget({ widgetId: "a", x: 0 }), widget({ widgetId: "b", widgetType: "ranking", x: 1 })],
    }
    expect(validateLayout(canonicalValid).valid).toBe(true)

    // Requirement #2/#8: the exact same widgets, completely unmoved/unresized/
    // unrenamed -- only the target grid itself shrinks from 2 columns to 1,
    // which can no longer contain "b" (x:1, width:1 -> x+width:2 > columns:1).
    const insufficientCapacityDraft: CanonicalLayout = {
      grid: { columns: 1, rows: 1 },
      widgets: canonicalValid.widgets,
    }

    // Requirement #3: the canonical validator rejects it for the correct,
    // capacity-specific reason -- OUT_OF_BOUNDS, not WIDGET_OVERLAP.
    const validation = validateLayout(insufficientCapacityDraft)
    expect(validation.valid).toBe(false)
    expect(validation.errors.map((e) => e.code)).toEqual(["OUT_OF_BOUNDS"])
    expect(validation.errors[0].widgetIds).toEqual(["b"])

    // Requirement #5/#6: the submission boundary rejects it even if a
    // confirm action were invoked programmatically -- submit is never called.
    const submitSave = vi.fn(async () => {})
    const outcome = await submitLayoutSave(insufficientCapacityDraft, submitSave)
    expect(submitSave).not.toHaveBeenCalled()
    expect(outcome.committed).toBe(false)

    // Requirement #7: canonical remains deep-equal to what it was before the attempt.
    expect(canonicalValid).toEqual({
      grid: { columns: 2, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    })
    expect(validateLayout(canonicalValid).valid).toBe(true)
  })

  it("a rejected submit leaves the outcome uncommitted and surfaces the error, without throwing (AC8)", async () => {
    const draft = layout({ widgets: [widget({ widgetId: "a" })] })
    const submit = vi.fn(async () => {
      throw new Error("network down")
    })

    const outcome = await submitLayoutSave(draft, submit)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(outcome.committed).toBe(false)
    expect(outcome.error?.message).toBe("network down")
  })

  // A prior draft of this module captured `submit`'s resolved value as the
  // committed layout, so tests here forced a malformed resolved value
  // through the type system (`as unknown as void`) to prove it was ignored.
  // `submitLayoutSave` no longer has any code path that reads what `submit`
  // resolves with at all (see the `await submit(draftLayout)` call below,
  // whose result is never assigned to anything) -- those tests are removed
  // as no longer meaningful under the acknowledgment-only contract. The
  // "in-place mutation" suite below is the real remaining threat model
  // (mutating the *argument*, not the *return value*) and is retained.
  describe("in-place mutation of the submission argument does not reach the committed layout", () => {
    it("a submitter that renames an existing widgetId in place does not affect the committed layout", async () => {
      const draft = layout({ widgets: [widget({ widgetId: "a", x: 0 }), widget({ widgetId: "b", x: 1 })] })
      const submit = vi.fn(async (received: CanonicalLayout) => {
        received.widgets[0].widgetId = "a-hijacked"
      })

      const outcome = await submitLayoutSave(draft, submit)

      expect(outcome.committed).toBe(true)
      expect(outcome.layout?.widgets.map((w) => w.widgetId)).toEqual(["a", "b"])
    })

    it("a submitter that mutates geometry in place does not affect the committed layout", async () => {
      const draft = layout({ widgets: [widget({ widgetId: "a", x: 0, width: 1 }), widget({ widgetId: "b", x: 1 })] })
      const submit = vi.fn(async (received: CanonicalLayout) => {
        received.widgets[0].width = 2 // would overlap "b" if it reached committed state
        received.widgets[0].x = 5
      })

      const outcome = await submitLayoutSave(draft, submit)

      expect(outcome.committed).toBe(true)
      const committedA = outcome.layout?.widgets.find((w) => w.widgetId === "a")
      expect(committedA).toEqual({ widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 })
    })

    it("a submitter that pushes a duplicate-ID widget onto the array in place does not affect the committed layout", async () => {
      const draft = layout({ widgets: [widget({ widgetId: "a", x: 0 })] })
      const submit = vi.fn(async (received: CanonicalLayout) => {
        received.widgets.push({ widgetId: "a", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 })
      })

      const outcome = await submitLayoutSave(draft, submit)

      expect(outcome.committed).toBe(true)
      expect(outcome.layout?.widgets).toHaveLength(1)
      expect(outcome.layout?.widgets.map((w) => w.widgetId)).toEqual(["a"])
    })

    it("a submitter that clears the widgets array in place does not affect the committed layout", async () => {
      const draft = layout({ widgets: [widget({ widgetId: "a" }), widget({ widgetId: "b", x: 1 })] })
      const submit = vi.fn(async (received: CanonicalLayout) => {
        received.widgets.length = 0
      })

      const outcome = await submitLayoutSave(draft, submit)

      expect(outcome.committed).toBe(true)
      expect(outcome.layout?.widgets.map((w) => w.widgetId)).toEqual(["a", "b"])
    })
  })
})
