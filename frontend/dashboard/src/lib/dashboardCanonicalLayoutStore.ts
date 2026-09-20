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
import {
  isCanonicalLayoutShape,
  isLegacyGridPayload,
  migrateDuplicateWidgetIds,
  proposeLegacyMigration,
  type LegacyGridLayout,
} from "./dashboardLayoutMigration"
import { resolveInitialLayout } from "./dashboardDefaultLayout"
import type { CanonicalLayout, LayoutValidationError } from "../types/dashboardLayout"

const CANONICAL_LAYOUT_STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"

/** The one stable backup key for a legacy (pre-3x3) payload,
 * derived from the canonical key. Written only by `convertLegacyLayout`,
 * never deleted automatically. */
export const LEGACY_LAYOUT_BACKUP_STORAGE_KEY = `${CANONICAL_LAYOUT_STORAGE_KEY}-legacy-backup`

/** A payload saved under the former 1x1-5x5 contract. `raw` is the
 * exact stored string; `parsed` the same data typed with plain-number grid
 * dimensions; `proposed` a fully valid <=3x3 candidate that preserves every
 * widget, or `null` when no lossless one exists. Never a valid layout. */
export interface LegacyLayoutRecovery {
  raw: string
  parsed: LegacyGridLayout
  proposed: CanonicalLayout | null
}

export type CanonicalLayoutLoadResult =
  | { status: "empty" }
  | { status: "valid"; layout: CanonicalLayout }
  | ({ status: "legacy-grid" } & LegacyLayoutRecovery)
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

  if (isLegacyGridPayload(parsed, result.errors)) {
    return { status: "legacy-grid", raw, parsed, proposed: proposeLegacyMigration(parsed) }
  }

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

/** The initial layout plus, when the stored payload is a legacy
 * one, its recovery data. While `legacy` is non-null the returned layout is
 * only the in-memory default; it must never be persisted over the legacy
 * payload. */
export function loadCanonicalLayoutState(storage?: Storage): { layout: CanonicalLayout; legacy: LegacyLayoutRecovery | null } {
  const result = readCanonicalLayout(storage)
  const legacy = result.status === "legacy-grid" ? { raw: result.raw, parsed: result.parsed, proposed: result.proposed } : null
  return { layout: resolveInitialLayout(result.status === "valid" ? result.layout : null), legacy }
}

export type ConvertLegacyLayoutResult = { ok: true } | { ok: false; reason: string }

/** The explicit migration boundary. In order: (1) confirm the
 * primary key still holds exactly the payload the user was shown, (2) write
 * that raw payload to the backup key and read it back, (3) only then write
 * the validated <=3x3 proposal to the primary key. A failure at any step
 * before (3) leaves the primary key byte-identical. An existing backup
 * holding different data is never overwritten. */
export function convertLegacyLayout(recovery: LegacyLayoutRecovery, storage?: Storage): ConvertLegacyLayoutResult {
  const { proposed, raw } = recovery
  if (!proposed) return { ok: false, reason: "This saved layout cannot be converted without removing or changing widgets." }
  if (!validateLayout(proposed).valid) return { ok: false, reason: "The converted layout is not valid, so nothing was changed." }

  let target: Storage
  try {
    target = storage ?? window.localStorage
    if (target.getItem(CANONICAL_LAYOUT_STORAGE_KEY) !== raw) {
      return { ok: false, reason: "The saved layout changed since it was loaded. Reload the page and try again." }
    }
    const existingBackup = target.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY)
    if (existingBackup !== null && existingBackup !== raw) {
      return { ok: false, reason: "A different layout backup already exists, so nothing was changed." }
    }
    target.setItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY, raw)
    if (target.getItem(LEGACY_LAYOUT_BACKUP_STORAGE_KEY) !== raw) {
      return { ok: false, reason: "The layout backup could not be verified, so your saved layout was left untouched." }
    }
  } catch {
    return { ok: false, reason: "Saved layout storage is unavailable, so your saved layout was left untouched." }
  }

  if (!writeCanonicalLayout(proposed, target)) {
    return { ok: false, reason: "The converted layout could not be saved. Your original layout is still preserved." }
  }
  return { ok: true }
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
    // Defensive, storage-level guard independent of any UI state -- a
    // normal save must never replace an unresolved legacy payload.
    if (readCanonicalLayout(storage).status === "legacy-grid") {
      throw new Error("A saved layout from an older grid size is awaiting conversion; saving is unavailable.")
    }
    if (!writeCanonicalLayout(layout, storage)) {
      throw new Error("Failed to persist the dashboard layout.")
    }
  }
}
