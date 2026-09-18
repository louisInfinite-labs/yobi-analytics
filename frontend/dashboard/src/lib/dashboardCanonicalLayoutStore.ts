/** MT-15 "Persistence, Legacy Layout, and Reload"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Sections 3.1 and 10).
 *
 * The persistence boundary `dashboardDefaultLayout.ts`'s own module
 * docstring explicitly deferred to MT-15: "reading raw storage, validating
 * untrusted/legacy data, and recovering from an invalid save." Mirrors the
 * pre-existing legacy `layoutStore.ts`'s own storage-key/never-throw/
 * degrade convention for the *different*, canonical (MT-01) layout model,
 * rather than inventing a second convention -- but never reuses
 * `layoutStore.ts` itself, since `LayoutProfile`/`WidgetInstance` are a
 * different, incompatible shape (dashboardLayout.ts's own docstring).
 *
 * `readCanonicalLayout` always runs untrusted stored data through the
 * single canonical `validateLayout` before treating it as valid, attempts
 * MT-15's one migration (`migrateDuplicateWidgetIds`,
 * dashboardLayoutMigration.ts) when `validateLayout`'s only complaint is
 * `DUPLICATE_WIDGET_ID` (AC3/AC5), and otherwise returns a typed,
 * non-throwing `{status:"error"}` result (AC6) -- it never calls
 * `removeItem`/clears the stored value itself, so encountering invalid data
 * never deletes it (AC7: "Recovery does not delete server data without
 * explicit user action"). `loadInitialCanonicalLayout` is AC2's actual
 * production load path -- the function `DashboardCanonicalEditor.tsx` calls
 * to obtain its initial layout when the caller doesn't supply one directly
 * -- composing `readCanonicalLayout` with MT-03's own
 * `resolveInitialLayout`. `writeCanonicalLayout`
 * mirrors `layoutStore.ts`'s own `writeLayout`: a single `setItem` call,
 * which is what keeps a failed write from ever partially overwriting the
 * previously persisted value (AC8) -- there is no multi-step write for a
 * failure to interrupt midway.
 *
 * `createLocalCanonicalLayoutSubmit` is this microtask's actual `submit`
 * implementation for MT-09's `submitLayoutSave` -- the production save
 * orchestrator `dashboardLayoutSave.ts` already built and explicitly left
 * for "whoever eventually wires this into production (MT-15's persistence
 * ownership...)" to supply. Reused as-is, not reimplemented: this module
 * only supplies the missing `submit`, so `submitLayoutSave`'s existing
 * validation-gated atomicity and rollback-on-rejection (AC7/AC8 there)
 * cover AC1/AC8 here for free.
 */
import { validateLayout } from "./dashboardLayoutValidation"
import { isCanonicalLayoutShape, migrateDuplicateWidgetIds } from "./dashboardLayoutMigration"
import { resolveInitialLayout } from "./dashboardDefaultLayout"
import type { CanonicalLayout, LayoutValidationError } from "../types/dashboardLayout"

const CANONICAL_LAYOUT_STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"

export type CanonicalLayoutLoadResult =
  | { status: "empty" }
  | { status: "valid"; layout: CanonicalLayout }
  | { status: "error"; reason: string }

function attemptMigration(layout: CanonicalLayout, errors: LayoutValidationError[]): CanonicalLayout | null {
  const onlyDuplicateIds = errors.length > 0 && errors.every((error) => error.code === "DUPLICATE_WIDGET_ID")
  if (!onlyDuplicateIds) return null // e.g. WIDGET_OVERLAP -- non-migratable by design, see module docstring
  const migrated = migrateDuplicateWidgetIds(layout)
  return validateLayout(migrated).valid ? migrated : null
}

/** AC2/AC3/AC4/AC6/AC7. Never throws, and never deletes/overwrites the
 * stored value merely because it turned out invalid -- an `"error"` result
 * leaves the raw storage exactly as the caller found it. */
export function readCanonicalLayout(storage?: Storage): CanonicalLayoutLoadResult {
  let raw: string | null
  try {
    raw = (storage ?? window.localStorage).getItem(CANONICAL_LAYOUT_STORAGE_KEY)
  } catch {
    return { status: "error", reason: "Saved layout storage is unavailable." }
  }
  if (!raw) return { status: "empty" }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: "error", reason: "Saved layout data is corrupted." }
  }

  if (!isCanonicalLayoutShape(parsed)) {
    return { status: "error", reason: "Saved layout data has an unrecognized shape." }
  }

  const result = validateLayout(parsed)
  if (result.valid) return { status: "valid", layout: parsed }

  const migrated = attemptMigration(parsed, result.errors)
  if (migrated) return { status: "valid", layout: migrated }

  return { status: "error", reason: result.errors.map((error) => error.message).join(" ") }
}

/** AC2's actual production load path: the one function a production
 * consumer calls to get its initial layout, composing this module's own
 * `readCanonicalLayout` (validated/migrated/recovered storage read) with
 * MT-03's `resolveInitialLayout` (Section 3.1's default-vs-saved
 * priority) -- reused as-is, not reimplemented. An `"error"` read (AC6)
 * falls back to the default exactly like an `"empty"` one: Section 3.1
 * requires *"loading the page must not overwrite [a valid saved layout]
 * with 2x2,"* not that a recoverable-error read block rendering entirely. */
export function loadInitialCanonicalLayout(storage?: Storage): CanonicalLayout {
  const result = readCanonicalLayout(storage)
  return resolveInitialLayout(result.status === "valid" ? result.layout : null)
}

/** Mirrors `layoutStore.ts`'s own `writeLayout`: a single `setItem` call,
 * never throws, returns whether it actually persisted. */
export function writeCanonicalLayout(layout: CanonicalLayout, storage?: Storage): boolean {
  try {
    ;(storage ?? window.localStorage).setItem(CANONICAL_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
    return true
  } catch {
    return false
  }
}

/** The `submit` implementation `dashboardLayoutSave.ts`'s `submitLayoutSave`
 * expects: acknowledgment-only, rejecting on a failed write so
 * `submitLayoutSave`'s own try/catch rollback (its AC7/AC8) applies here
 * without any additional rollback logic in this module. */
export function createLocalCanonicalLayoutSubmit(storage?: Storage): (layout: CanonicalLayout) => Promise<void> {
  return async (layout) => {
    if (!writeCanonicalLayout(layout, storage)) {
      throw new Error("Failed to persist the dashboard layout.")
    }
  }
}
