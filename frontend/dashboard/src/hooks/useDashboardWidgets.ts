/** MT-02 "Widget Identity and Duplicate Prevention"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 4), extended by
 * MT-05 "Grid Dimensions, Widget Sizes, Fill, and Collision" (AC10-12).
 *
 * Owns the in-memory canonical-layout state for the MT-01 widget model and
 * exposes the production Add/update/move/resize path. Every mutation reads
 * `setLayout`'s functional updater form, so each call always builds its
 * candidate from the latest committed layout rather than a snapshot
 * captured at call time -- this is what keeps rapid repeated `addWidget`
 * calls (e.g. a fast double click) from dropping or duplicating a widget,
 * and equally what makes a rejected `moveWidget`/`resizeWidget` call a no-op
 * against the latest state rather than a stale one. The updater function
 * itself runs synchronously inside `setLayout`, so `outcome` below is
 * available immediately after the call without a second render.
 */
import { useCallback, useState } from "react"
import {
  addWidget as addWidgetToLayout,
  createWidget,
  moveWidget as moveWidgetInLayout,
  resizeWidget as resizeWidgetInLayout,
  updateWidgetGeometry,
  type LayoutMutationOutcome,
  type WidgetPlacement,
  type WidgetPosition,
  type WidgetSize,
} from "../lib/dashboardWidgetActions"
import type { CanonicalLayout, LayoutValidationResult } from "../types/dashboardLayout"

export interface UseDashboardWidgetsResult {
  layout: CanonicalLayout
  /** Non-null only after a rejected mutation; cleared on the next commit. */
  lastError: LayoutValidationResult | null
  addWidget: (widgetType: string, placement: WidgetPlacement) => void
  updateWidget: (widgetId: string, patch: Partial<WidgetPlacement>) => void
  /** MT-05's production drag path (Section 9.1): rejects and leaves `layout`
   * unchanged on overlap/out-of-bounds; never touches `widgetId`. */
  moveWidget: (widgetId: string, position: WidgetPosition) => void
  /** MT-05's production resize path (Section 9.2): rejects and leaves
   * `layout` unchanged on an invalid size; never touches `widgetId`. */
  resizeWidget: (widgetId: string, size: WidgetSize) => void
}

export function useDashboardWidgets(initialLayout: CanonicalLayout): UseDashboardWidgetsResult {
  const [layout, setLayout] = useState(initialLayout)
  const [lastError, setLastError] = useState<LayoutValidationResult | null>(null)

  const addWidget = useCallback((widgetType: string, placement: WidgetPlacement) => {
    let outcome: LayoutMutationOutcome | undefined
    setLayout((current) => {
      outcome = addWidgetToLayout(current, createWidget(widgetType, placement))
      return outcome.layout
    })
    setLastError(outcome && !outcome.committed ? outcome.result : null)
  }, [])

  const updateWidget = useCallback((widgetId: string, patch: Partial<WidgetPlacement>) => {
    let outcome: LayoutMutationOutcome | undefined
    setLayout((current) => {
      outcome = updateWidgetGeometry(current, widgetId, patch)
      return outcome.layout
    })
    setLastError(outcome && !outcome.committed ? outcome.result : null)
  }, [])

  const moveWidget = useCallback((widgetId: string, position: WidgetPosition) => {
    let outcome: LayoutMutationOutcome | undefined
    setLayout((current) => {
      outcome = moveWidgetInLayout(current, widgetId, position)
      return outcome.layout
    })
    setLastError(outcome && !outcome.committed ? outcome.result : null)
  }, [])

  const resizeWidget = useCallback((widgetId: string, size: WidgetSize) => {
    let outcome: LayoutMutationOutcome | undefined
    setLayout((current) => {
      outcome = resizeWidgetInLayout(current, widgetId, size)
      return outcome.layout
    })
    setLastError(outcome && !outcome.committed ? outcome.result : null)
  }, [])

  return { layout, lastError, addWidget, updateWidget, moveWidget, resizeWidget }
}
