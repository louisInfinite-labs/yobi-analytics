/** MT-09 "Grid-Change Confirmation and Atomic Save"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 8).
 *
 * `computeAffectedWidgetIds` decides whether saving `draft` would force any
 * *existing* (already-saved) widget to change size or position -- Section
 * 8's trigger condition for the confirmation dialog. A widget present only
 * in `draft` (e.g. a not-yet-saved MT-08 insertion candidate) is not
 * "affected": it isn't being forced to move, it's new.
 *
 * `submitLayoutSave` is the single production save/submission boundary for
 * the canonical model: it re-validates the complete draft through the
 * canonical `validateLayout` (Section 10) before ever calling the injected
 * `submit` function, so an invalid draft -- including one containing
 * duplicate `widgetId` values -- never reaches `submit` at all (Section
 * 8.6, MT-09 AC11). `submit` is an injected async function rather than a
 * hardcoded network call for the same reason `useCachedDashboardData`'s
 * `fetchFn` and `useChartCatalog`'s `fetchCatalog` are injected: no backend
 * endpoint (or even a decided localStorage-vs-backend persistence
 * strategy) exists yet for the canonical model in this repository, and
 * inventing one is not this microtask's job. Whoever eventually wires this
 * into production (MT-15's persistence ownership, or GAP-5's live
 * integration) supplies the real `submit` implementation; this module only
 * owns the validation-gated, atomic *orchestration* around it.
 *
 * `submit` is a command, not a data source: its contract is
 * acknowledgment-only (`Promise<void>`), and the value committed on
 * success is always the already-validated draft -- never anything `submit`
 * might resolve with. Nothing in `DASHBOARD_LAYOUT_GUIDELINES.md` describes
 * a backend that normalizes or rewrites the layout it's given, and no such
 * backend exists in this repository to define such a contract; treating an
 * arbitrary resolved value as the new canonical state would let a
 * misbehaving `submit` silently reintroduce a changed `widgetId`, a
 * duplicate, an overlap, or a missing widget -- exactly what AC10/AC11
 * require never happens.
 *
 * `CanonicalLayout`/`DashboardWidget` (../types/dashboardLayout.ts) are
 * plain, non-`readonly` structures, so TypeScript's `submit` signature
 * cannot by itself stop an implementation from mutating the object it's
 * given in place. `submitLayoutSave` closes that gap the same way every
 * other canonical mutation in this codebase already avoids in-place
 * mutation (`dashboardWidgetActions.ts`'s `addWidget`/`updateWidgetGeometry`
 * always spread into a new object rather than writing through an existing
 * one): it takes two independent snapshots via `cloneCanonicalLayout`
 * before `submit` is ever called -- `validatedCandidate` (never shown to
 * `submit`, becomes the committed value on success) and a second, throwaway
 * clone that is the *only* object `submit` ever receives. `draftLayout`
 * itself is therefore never passed to `submit` either: a caller (e.g. the
 * editor hook) that still holds its own `draftLayout` reference after
 * calling this function is exactly as protected as the eventual committed
 * value. Whatever `submit` does to the object it receives -- mutate it,
 * hold a reference to it indefinitely, or resolve with something else
 * entirely -- can therefore never reach the caller's draft, the committed
 * canonical state, or one via the other. */
import { validateLayout } from "./dashboardLayoutValidation"
import type { CanonicalLayout, LayoutValidationResult } from "../model/dashboardLayout"

/** A plain per-field/per-widget copy -- not a deep clone of anything beyond
 * `CanonicalLayout`'s own two-level shape (a flat `grid` object and an
 * array of flat widget objects), which is all this type ever contains. */
function cloneCanonicalLayout(layout: CanonicalLayout): CanonicalLayout {
  return { grid: { ...layout.grid }, widgets: layout.widgets.map((widget) => ({ ...widget })) }
}

export function computeAffectedWidgetIds(canonical: CanonicalLayout, draft: CanonicalLayout): string[] {
  const canonicalById = new Map(canonical.widgets.map((widget) => [widget.widgetId, widget]))
  const affected: string[] = []
  for (const widget of draft.widgets) {
    const before = canonicalById.get(widget.widgetId)
    if (!before) continue // newly added widget (e.g. an MT-08 insertion candidate) -- not an existing widget being forced to move
    if (before.x !== widget.x || before.y !== widget.y || before.width !== widget.width || before.height !== widget.height) {
      affected.push(widget.widgetId)
    }
  }
  return affected
}

export interface SaveSubmissionOutcome {
  /** True only when `submit` was called and resolved. */
  committed: boolean
  result: LayoutValidationResult
  /** Present only when `committed` is true. */
  layout?: CanonicalLayout
  /** Present only when `submit` was called and rejected. */
  error?: Error
}

/** The production save path (MT-09 AC5, AC11): validates `draftLayout`
 * through the single canonical `validateLayout`, snapshots it twice
 * (`validatedCandidate` for the eventual commit, a separate throwaway clone
 * for `submit`) *before* calling `submit` as an acknowledgment-only
 * command. Never calls `submit` for an invalid draft (no partial submission
 * is possible because nothing is sent at all), and a rejected `submit`
 * leaves the caller's own canonical state untouched -- it never had a
 * chance to be replaced (AC7's atomicity, AC8's rollback). On success,
 * `outcome.layout` is always `validatedCandidate` -- immune to a malformed
 * resolved value (deliberately never used), in-place mutation of the object
 * passed to `submit` (a disposable, independent clone), and immune in the
 * other direction too: `submit` never receives `draftLayout` itself, so it
 * cannot mutate the caller's own draft either. */
export async function submitLayoutSave(
  draftLayout: CanonicalLayout,
  submit: (layout: CanonicalLayout) => Promise<void>,
): Promise<SaveSubmissionOutcome> {
  const result = validateLayout(draftLayout)
  if (!result.valid) return { committed: false, result }

  const validatedCandidate = cloneCanonicalLayout(draftLayout)
  try {
    await submit(cloneCanonicalLayout(draftLayout))
    return { committed: true, result, layout: validatedCandidate }
  } catch (err) {
    return { committed: false, result, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
