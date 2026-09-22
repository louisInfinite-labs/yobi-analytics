import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core"
import { Button, ConfigProvider, theme as antdTheme } from "antd"
import { mockCreators } from "../../entities/creator/data/mockCreators"
import { useMemberTheme } from "../../shared/theme/ThemeContext"
import { mockDailySeries } from "../../features/dashboard/editor/data/mockDailySeries"
import { describeApiFailure } from "../../shared/api/apiClient"
import { useCachedDashboardData } from "../../features/analytics/hooks/useCachedDashboardData"
import { useChartCatalog } from "../../features/dashboard/catalog/hooks/useChartCatalog"
import { useComparisonItems } from "../../features/dashboard/comparison/hooks/useComparisonItems"
import { useComparisonMappingDialog } from "../../features/dashboard/comparison/hooks/useComparisonMappingDialog"
import { useDashboardEditor } from "../../features/dashboard/editor/hooks/useDashboardEditor"
import { useFilterState } from "../../features/analytics/hooks/useFilterState"
import { useHeartbeat } from "../../shared/api/hooks/useHeartbeat"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { deriveChannelContribution, deriveKpis } from "../../features/analytics/utils/deriveAnalytics"
import { deriveInsights } from "../../features/analytics/utils/deriveInsights"
import { matchesClassification, matchesContent } from "../../features/analytics/filters/filterState"
import { fetchMockAnalytics, fetchRealAnalytics, MOCK_REPORT_DATE } from "../../features/analytics/utils/dashboardAnalyticsSource"
import { fetchChartCatalog } from "../../features/dashboard/catalog/data/dashboardChartCatalogSource"
import type { ChartCatalogItem } from "../../features/dashboard/catalog/model/dashboardChartCatalog"
import { resolveAddableWidgetTypes } from "../../features/dashboard/catalog/utils/dashboardChartCatalogOptions"
import { defaultComparisonSource } from "../../features/dashboard/comparison/data/defaultComparisonSource"
import type { ComparisonSource } from "../../features/dashboard/comparison/data/dashboardComparisonSource"
import { describeCreatorDrop } from "../../features/dashboard/comparison/utils/dashboardCreatorDrop"
import { isComparisonCapableWidget } from "../../features/dashboard/comparison/utils/dashboardComparisonWidgets"
import { convertLegacyLayout, createLocalCanonicalLayoutSubmit, loadCanonicalLayoutState } from "../../features/dashboard/editor/data/dashboardCanonicalLayoutStore"
import { createWidgetId, updateWidgetGeometry } from "../../features/dashboard/editor/utils/dashboardWidgetActions"
import { computeValidatedRowInsertion } from "../../features/dashboard/editor/utils/dashboardInsertionPreview"
import { projectCanonicalLayoutForGridStack, projectResponsiveLayoutForGridStack } from "../../features/dashboard/editor/utils/dashboardGridProjection"
import { findInsertableRows } from "../../features/dashboard/editor/utils/dashboardInsertionRows"
import { BREAKPOINT_MAX_EDITABLE_GRID, computeReadableColumnCap, reflowLayoutForBreakpoint } from "../../features/dashboard/editor/utils/dashboardResponsive"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { dateInTimeZone, detectDeviceTimeZone, millisecondsUntilNextLocalHour } from "../../shared/i18n/timezone"
import type { Period } from "../../entities/creator/model/domain"
import type { DashboardWidget, WidgetHeight } from "../../features/dashboard/editor/model/dashboardLayout"
import type { DashboardWidgetData } from "../../features/dashboard/editor/utils/widgetRegistry"
import { getGridWidgetMeta, type GridWidgetType } from "../../features/dashboard/editor/utils/gridWidgetMeta"
import { ClassificationFilterBar } from "../../features/analytics/filters/ClassificationFilterBar"
import { useDataSource } from "../../features/analytics/charts/DataSourceToggle"
import { DashboardFooter } from "../../features/dashboard/editor/components/DashboardFooter"
import { DashboardGrid } from "../../features/dashboard/editor/components/DashboardGrid"
import { DashboardHeader } from "../../features/dashboard/editor/components/DashboardHeader"
import { EditModeToolbar } from "../../features/dashboard/editor/components/EditModeToolbar"
import { GridChangeConfirmationDialog } from "../../features/dashboard/editor/components/GridChangeConfirmationDialog"
import { SaveToast } from "../../features/dashboard/editor/components/SaveToast"
import { StaleDataNotice } from "../../features/analytics/charts/StaleDataNotice"
import { WidgetTray } from "../../features/dashboard/editor/components/WidgetTray"
import { WidgetInsertionSlots } from "../../features/dashboard/editor/components/WidgetInsertionSlots"
import { EmptyState } from "../../shared/ui/states/EmptyState"
import { ErrorState } from "../../shared/ui/states/ErrorState"
import { LoadingState } from "../../shared/ui/states/LoadingState"
import { LegacyLayoutRecoveryBanner } from "../../features/dashboard/editor/components/LegacyLayoutRecoveryBanner"
import { ComparisonWidget } from "../../features/dashboard/comparison/components/ComparisonWidget"
import { ComparisonMappingDialog } from "../../features/dashboard/comparison/components/ComparisonMappingDialog"
import { CreatorComparisonPicker } from "../../features/dashboard/comparison/components/CreatorComparisonPicker"
import { DraggableCreatorList } from "../../features/dashboard/comparison/components/DraggableCreatorList"

const SAVE_CONFIRMATION_DURATION_MS = 2500

function creatorName(creatorId: string): string {
  return mockCreators.find((creator) => creator.channelId === creatorId)?.channelName ?? creatorId
}

/** Top-level composition: wires cache-backed data, filters, and every
 * KPI/chart/ranking/table view together behind one shared filter state.
 * Remounting (via `key`) after a successful legacy conversion makes
 * the content re-read storage through the normal load path. */
export function DashboardPage({
  comparisonSource = defaultComparisonSource,
  fetchCatalog = fetchChartCatalog,
}: { comparisonSource?: ComparisonSource; fetchCatalog?: () => Promise<ChartCatalogItem[]> } = {}) {
  const [loadEpoch, setLoadEpoch] = useState(0)
  return <DashboardPageContent key={loadEpoch} comparisonSource={comparisonSource} fetchCatalog={fetchCatalog} onLegacyConverted={() => setLoadEpoch((epoch) => epoch + 1)} />
}

function DashboardPageContent({
  comparisonSource,
  fetchCatalog,
  onLegacyConverted,
}: {
  comparisonSource: ComparisonSource
  fetchCatalog: () => Promise<ChartCatalogItem[]>
  onLegacyConverted: () => void
}) {
  useHeartbeat()
  const { theme: memberTheme } = useMemberTheme()
  // Memoized: ConfigProvider recomputes and regenerates its CSS-in-JS theme
  // whenever this object's reference changes, so a fresh literal on every
  // render (this component re-renders on nearly every interaction) redoes
  // that work needlessly -- keep the same reference unless the creator
  // accent actually changes.
  const dashboardAntdTheme = useMemo<Parameters<typeof ConfigProvider>[0]["theme"]>(
    () => ({
      algorithm: antdTheme.darkAlgorithm,
      token: {
        colorPrimary: memberTheme.primary,
        colorBgContainer: "#211d29",
        colorBgElevated: "#292432",
        colorBorder: "#393342",
        colorText: "#f3eff7",
        colorTextSecondary: "#b9b1c5",
        colorTextTertiary: "#948b9f",
        borderRadius: 6,
      },
      components: {
        Segmented: {
          itemColor: "#b9b1c5",
          itemHoverColor: "#f3eff7",
          itemHoverBg: `color-mix(in srgb, ${memberTheme.primary} 12%, transparent)`,
          itemSelectedBg: `color-mix(in srgb, ${memberTheme.primary} 22%, transparent)`,
          itemSelectedColor: "#f3eff7",
          trackBg: "#211d29",
        },
      },
    }),
    [memberTheme.primary],
  )
  const [locale] = useLocale()
  const [period, setPeriod] = useState<Period>("1d")
  const [timeZone] = useState(detectDeviceTimeZone)
  const [refreshToken, setRefreshToken] = useState(0)
  const filters = useFilterState()
  const [dataSource, setDataSource] = useDataSource()

  // The canonical layout/draft
  // (the chosen source of truth) replaces the legacy
  // useEditableLayout/LayoutProfile state this page held before. Lazy
  // initializers run once, on mount -- the same "fresh page/session"
  // semantics DashboardCanonicalEditor.tsx already established for the same
  // load/submit pair, reused here rather than reimplemented.
  const [{ layout: initialCanonicalLayout, legacy: legacyRecovery }] = useState(() => loadCanonicalLayoutState())
  const [legacyConvertError, setLegacyConvertError] = useState<string | null>(null)
  const handleConvertLegacy = () => {
    if (!legacyRecovery) return
    const result = convertLegacyLayout(legacyRecovery)
    if (result.ok) onLegacyConverted()
    else setLegacyConvertError(result.reason)
  }
  const [canonicalSubmit] = useState(() => createLocalCanonicalLayoutSubmit())
  const {
    layout: canonicalLayout,
    draftLayout,
    editMode,
    isDirty,
    draftValidation,
    enterEditMode,
    cancel: cancelEditMode,
    restoreDefault,
    save,
    isSaving,
    saveError,
    gridChangeConfirmation,
    confirmGridChange,
    cancelGridChangeConfirmation,
    updateDraftWidget,
    removeDraftWidget,
    addWidgetAtSlot,
    updateDraftWidgetComparison,
    updateDraftWidgetCreatorScope,
    commitExternalLayout,
  } = useDashboardEditor(initialCanonicalLayout, canonicalSubmit)

  // Reproduces the pre-cutover SaveToast behavior (a ~2.5s confirmation
  // after a successful save) from useDashboardEditor's own signals, since
  // that hook has no direct "just saved" event of its own -- isSaving
  // transitioning true -> false with no saveError is exactly that moment.
  // Flow 1: which comparison widget's in-widget picker is open (UI state only).
  const [pickerWidgetId, setPickerWidgetId] = useState<string | null>(null)
  const [saveConfirmation, setSaveConfirmation] = useState(false)
  const wasSavingRef = useRef(false)
  useEffect(() => {
    const wasSaving = wasSavingRef.current
    wasSavingRef.current = isSaving
    if (wasSaving && !isSaving && !saveError) {
      setSaveConfirmation(true)
      const timeout = setTimeout(() => setSaveConfirmation(false), SAVE_CONFIRMATION_DURATION_MS)
      return () => clearTimeout(timeout)
    }
  }, [isSaving, saveError])

  // The rendered layout: the draft while editing, the committed canonical
  // layout otherwise -- same `displayedLayout` pattern DashboardCanonicalEditor.tsx
  // already uses for the same two-state hook.
  const displayedCanonicalLayout = editMode ? draftLayout : canonicalLayout

  // Responsive reflow and minimum readable width: the
  // real reactive viewport breakpoint (../hooks/useBreakpoint.ts -- the same
  // hook/thresholds the responsive reflow already resolves from; no second
  // breakpoint system). Mobile is view-only and always shows the
  // existing `reflowLayoutForBreakpoint` stack. Desktop and tablet support
  // editing up to their product maximum (3x3), further bounded by
  // `readableColumnCap` below: the number of columns the actually rendered
  // grid width can hold at `MIN_CHART_WIDTH_PX` (measured: 198.7px
  // charts at a 768px tablet viewport). A layout wider than that cap is shown through the same
  // read-only reflow, and Edit is unavailable for it, since editing would
  // require mapping gestures through the reflowed (not real) coordinates --
  // a correctness risk that is not taken on. The saved canonical layout is
  // never rewritten: widening the viewport restores it, and Edit, as-is.
  const breakpoint = useBreakpoint()

  // The width actually available to the grid content, measured from the
  // real rendered DOM (a ResizeObserver on the div wrapping DashboardGrid
  // below) rather than derived from `window.innerWidth` -- page chrome
  // (nav, padding) consumes part of the viewport, and a direct
  // measurement showed that gap is not a fixed/negligible amount safe to
  // assume. `null` only for the brief window before the observer's first
  // callback fires, during which the static `BREAKPOINT_MAX_EDITABLE_GRID`
  // ceiling is used as a fallback.
  //
  // A callback ref (not a plain `useRef` + `useLayoutEffect([])`) is
  // required here: the wrapper div below only exists once
  // `loading`/`error`/`filteredStats.length === 0` have all resolved, so a
  // mount-once effect with `[]` deps would run before that div exists,
  // read `null`, and never run again -- silently leaving
  // `gridContentWidth` stuck at `null` forever. A callback ref instead
  // fires exactly when the node actually attaches (and again on detach),
  // which `gridContentEl` state below turns into a proper effect
  // dependency.
  const [gridContentEl, setGridContentEl] = useState<HTMLDivElement | null>(null)
  const [gridContentWidth, setGridContentWidth] = useState<number | null>(null)
  // A non-positive width means "not measurable" (jsdom has no layout
  // engine, and a hidden/collapsed container reports 0), never "zero columns
  // fit" -- it is treated exactly like the not-yet-measured `null` so the
  // static breakpoint cap applies instead of forcing a cap of 1.
  useLayoutEffect(() => {
    if (!gridContentEl) return
    const measured = (width: number) => (width > 0 ? width : null)
    setGridContentWidth(measured(gridContentEl.getBoundingClientRect().width))
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined) setGridContentWidth(measured(width))
    })
    observer.observe(gridContentEl)
    return () => observer.disconnect()
  }, [gridContentEl])

  // The horizontal readable cap, for every non-mobile breakpoint: how
  // many columns the *measured* grid width can hold at `MIN_CHART_WIDTH_PX`
  // each, bounded by the breakpoint's own product maximum (desktop 5,
  // tablet 3). It is the one seam Add activation/preview/commit already
  // enforce, so desktop inherits the readable-width contract without any
  // Add-specific formula. Mobile is view-only and keeps its static value.
  const staticMaxColumns = BREAKPOINT_MAX_EDITABLE_GRID[breakpoint]
  const readableColumnCap =
    breakpoint === "mobile" || gridContentWidth === null ? staticMaxColumns : computeReadableColumnCap(gridContentWidth, staticMaxColumns)
  const effectiveEditableCap = readableColumnCap

  // Editability must be decided from the layout that is actually being
  // *edited* -- the canonical layout in view mode, the draft while editing --
  // and never from the reflowed display projection: a canonical 3-column
  // layout reflowed to 2 columns would otherwise look like it fits and
  // re-enable Edit on coordinates that are not the real ones.
  // Columns are bounded by the dynamic, width-driven cap; rows are a product
  // maximum unrelated to horizontal width, so they are checked separately
  // against the static breakpoint maximum (3 on desktop and tablet).
  const layoutFitsEditableCap =
    displayedCanonicalLayout.grid.columns <= readableColumnCap && displayedCanonicalLayout.grid.rows <= staticMaxColumns
  // An unresolved legacy (pre-3x3) saved layout disables Edit, and
  // through `gridEditable` also Add; the store's save guard rejects a normal
  // Save regardless of UI state.
  const editingAvailable = breakpoint !== "mobile" && layoutFitsEditableCap && legacyRecovery === null
  const usesReflowedDisplay = breakpoint === "mobile" || !layoutFitsEditableCap

  // Entering edit mode is only ever offered (below, via EditModeToolbar's
  // conditional render) while `editingAvailable`; this additionally
  // guards against a resize *while already editing* making it
  // unavailable mid-session (e.g. rotating/shrinking from desktop to
  // mobile, or narrowing tablet below the readable-width threshold) --
  // Cancel is the existing, non-destructive exit (canonical state was
  // never touched by an unsaved edit), so there is nothing to roll back
  // beyond what Cancel already does.
  useEffect(() => {
    if (editMode && !editingAvailable) cancelEditMode()
  }, [editMode, editingAvailable, cancelEditMode])

  // GridStack must never become interactive at a breakpoint/layout
  // combination where editing isn't offered (AC16) -- evaluated fresh on
  // every render rather than relying only on the cancel effect above,
  // which can lag one render behind a breakpoint change.
  const gridEditable = editMode && editingAvailable

  // Selecting a chart from `WidgetTray`
  // only records it as pending (AC8) -- local UI state, not a second layout
  // store, since it never itself holds any geometry. `insertionRejected` is
  // reset whenever the pending selection changes and set only when the most
  // recently attempted slot was rejected (AC11: the rejection itself changes
  // no layout state, only this UI hint).
  //
  // `previewSlot` is the one extra piece of Add state -- the slot
  // whose insertion is being *previewed* (a row's `y` rather than the row's
  // widgets, so it can never hold a stale row), plus the candidate widget
  // id minted once for this preview session and reused by the commit. The
  // preview layout below is *derived* from it on every render and is never
  // written into `draftLayout`, so rolling a preview back is just clearing
  // this value.
  const [pendingWidgetType, setPendingWidgetType] = useState<GridWidgetType | null>(null)
  const [insertionRejected, setInsertionRejected] = useState(false)
  const [previewSlot, setPreviewSlot] = useState<{ rowY: number; slotIndex: number; candidateId: string } | null>(null)

  const insertionRows = useMemo(() => (pendingWidgetType ? findInsertableRows(draftLayout) : []), [pendingWidgetType, draftLayout])

  // Same `computeRowInsertionPreview` + `validateLayout` computation
  // `addWidgetAtSlot` commits with (computeValidatedRowInsertion), so the
  // previewed layout is exactly what a commit produces. Re-checked against
  // `effectiveEditableCap` on *every* render, not only at activation: tablet's
  // readable cap can shrink while a preview is showing, and a preview
  // wider than the current cap must never render below the minimum readable
  // width.
  const previewRowNumber = previewSlot ? insertionRows.findIndex((row) => row.y === previewSlot.rowY) + 1 : 0
  const activePreviewLayout = useMemo(() => {
    if (!gridEditable || !previewSlot || !pendingWidgetType) return null
    const row = insertionRows.find((candidateRow) => candidateRow.y === previewSlot.rowY)
    if (!row) return null
    const { layout: previewLayout, valid } = computeValidatedRowInsertion(
      draftLayout,
      row.widgets,
      { widgetId: previewSlot.candidateId, widgetType: pendingWidgetType },
      previewSlot.slotIndex,
    )
    return valid && previewLayout.grid.columns <= effectiveEditableCap ? previewLayout : null
  }, [gridEditable, previewSlot, pendingWidgetType, insertionRows, draftLayout, effectiveEditableCap])
  const previewActive = activePreviewLayout !== null

  // A preview that stopped being valid (viewport/cap change, row gone,
  // editing lost) is dropped, never left stale. Nothing was written to the
  // draft, so there is nothing to restore.
  useEffect(() => {
    if (previewSlot && !activePreviewLayout) setPreviewSlot(null)
  }, [previewSlot, activePreviewLayout])

  const layoutForDisplay = activePreviewLayout ?? displayedCanonicalLayout

  const projection = useMemo(() => {
    if (usesReflowedDisplay) {
      const columnCapOverride = breakpoint === "mobile" ? undefined : readableColumnCap
      return projectResponsiveLayoutForGridStack(reflowLayoutForBreakpoint(layoutForDisplay, breakpoint, columnCapOverride))
    }
    return projectCanonicalLayoutForGridStack(layoutForDisplay)
  }, [layoutForDisplay, breakpoint, usesReflowedDisplay, readableColumnCap])

  const handleCommitGeometry = useCallback(
    (widgetId: string, patch: { x: number; y: number; width: number; height: WidgetHeight }) => updateDraftWidget(widgetId, patch),
    [updateDraftWidget],
  )

  // A live drag/resize gesture's non-color valid/invalid feedback
  // (before drop) reuses the exact same canonical mutation primitive
  // `updateDraftWidget` above eventually calls (no second validator) --
  // `updateWidgetGeometry` is pure, so calling it here to inspect
  // `.committed` never mutates `draftLayout` or commits a preview tick.
  const validateGesturePreview = useCallback(
    (widgetId: string, patch: { x: number; y: number; width: number; height: WidgetHeight }) =>
      updateWidgetGeometry(draftLayout, widgetId, patch).committed,
    [draftLayout],
  )

  // One shared assistive-technology live region for both the Add
  // insertion announcement (below) and the drag/resize commit/rollback
  // announcement (DashboardGrid's `onAnnounce`).
  const [announcement, setAnnouncement] = useState("")
  const handleAnnounce = useCallback((message: string) => setAnnouncement(message), [])

  // GAP-1A: mounted here -- the one component that survives Edit/Cancel
  // toggling (`editMode` above is local state, never an unmount) -- rather
  // than inside a conditionally-rendered component like `WidgetTray`, which
  // would issue a fresh request every time Edit is re-entered (see
  // useChartCatalog.ts's own docstring). The Add UI reads this catalog to drive
  // the production Add UI's available choices (`resolveAddableWidgetTypes`
  // below); mounting it here rather than inside `WidgetTray` is what keeps
  // AC5 ("zero additional catalog requests") true across repeated Edit/Add
  // toggles.
  const chartCatalog = useChartCatalog(fetchCatalog)
  const addableWidgetTypes = useMemo(
    () => (chartCatalog.state.status === "success" ? resolveAddableWidgetTypes(chartCatalog.state.items) : []),
    [chartCatalog.state],
  )

  // Leaving edit mode (Cancel, a successful Save, or a confirmed grid
  // change) must not leave a stale pending Add selection armed for the next
  // time Edit Layout is entered.
  useEffect(() => {
    if (!editMode) {
      setPendingWidgetType(null)
      setInsertionRejected(false)
      setPreviewSlot(null)
      setPickerWidgetId(null)
    }
  }, [editMode])

  // Any change of the pending selection ends the preview session
  // (its candidate id is not reused for a different widget type).
  const handleSelectWidgetType = useCallback((type: GridWidgetType) => {
    setInsertionRejected(false)
    setPreviewSlot(null)
    setPendingWidgetType((current) => (current === type ? null : type))
  }, [])

  const handleCancelInsertion = useCallback(() => {
    setPendingWidgetType(null)
    setInsertionRejected(false)
    setPreviewSlot(null)
  }, [])

  // Restore Default replaces the whole draft, so any preview (built
  // from the old draft's rows) is dropped first.
  const handleRestoreDefault = useCallback(() => {
    setPendingWidgetType(null)
    setInsertionRejected(false)
    setPreviewSlot(null)
    restoreDefault()
  }, [restoreDefault])

  // Selecting a slot only *activates its preview* -- nothing is
  // written to `draftLayout` until `handleInsert`.
  const handleSelectInsertionSlot = useCallback(
    (row: DashboardWidget[], slotIndex: number) => {
      if (!pendingWidgetType) return
      // Add is the only mutation that can grow
      // `grid.columns` (a drag/resize never touches `grid` -- see
      // useDashboardEditor.ts's docstring), so it is the one place a
      // breakpoint's editable grid cap must be enforced explicitly.
      // `effectiveEditableCap` is tablet's *current* dynamically-measured
      // readable cap, not merely the static 3x3 maximum -- growing to a
      // column count the current viewport can no longer render at
      // `MIN_CHART_WIDTH_PX` must be rejected even when 3x3 would otherwise
      // still be allowed. `updateWidgetGeometry`'s existing `validateLayout`
      // bounds check already covers drag/resize for free once the grid
      // itself never exceeds this cap.
      const candidateId = previewSlot?.candidateId ?? createWidgetId(pendingWidgetType)
      const { valid } = computeValidatedRowInsertion(draftLayout, row, { widgetId: candidateId, widgetType: pendingWidgetType }, slotIndex)
      if (row.length + 1 > effectiveEditableCap || !valid) {
        setPreviewSlot(null)
        setInsertionRejected(true)
        return
      }
      setInsertionRejected(false)
      setPreviewSlot({ rowY: row[0]?.y ?? 0, slotIndex, candidateId })
    },
    [pendingWidgetType, previewSlot, draftLayout, effectiveEditableCap],
  )

  // Commits exactly the active preview -- same row, slot and
  // candidate id, through the one existing Add mutation.
  const handleInsert = useCallback(() => {
    if (!previewSlot || !pendingWidgetType || !activePreviewLayout) return
    const row = insertionRows.find((candidateRow) => candidateRow.y === previewSlot.rowY)
    if (!row) return
    const outcome = addWidgetAtSlot(pendingWidgetType, row.widgets, previewSlot.slotIndex, previewSlot.candidateId)
    if (outcome.accepted) {
      // Announced only on an accepted commit -- a
      // rejected commit falls through to the `else` branch below and never
      // reaches this call, so no false success announcement is possible.
      setAnnouncement(
        `${getGridWidgetMeta(pendingWidgetType).title} added at position ${previewSlot.slotIndex + 1} in row ${previewRowNumber}.`,
      )
      setPendingWidgetType(null)
      setInsertionRejected(false)
    } else {
      setInsertionRejected(true)
    }
    setPreviewSlot(null)
  }, [previewSlot, pendingWidgetType, activePreviewLayout, insertionRows, addWidgetAtSlot, previewRowNumber])

  const previewStatus =
    activePreviewLayout && previewSlot && pendingWidgetType
      ? `Previewing ${getGridWidgetMeta(pendingWidgetType).title} at position ${previewSlot.slotIndex + 1} in row ${previewRowNumber}${
          activePreviewLayout.grid.columns !== draftLayout.grid.columns ? `; grid becomes ${activePreviewLayout.grid.columns} columns` : ""
        }.`
      : null

  // The live comparison integration. Comparison
  // items come from the injected source seam (`dashboardComparisonSource.ts`),
  // loaded once per mount and independent of the chart catalog above.
  const comparisonItems = useComparisonItems(comparisonSource.loadItems)

  // Flow 1: which comparison widget's in-widget picker is open. Which
  // picker is open is UI state; the selection itself only ever lands in the
  // draft (`updateDraftWidgetComparison`), never canonical state.
  const pickerWidget = pickerWidgetId ? draftLayout.widgets.find((widget) => widget.widgetId === pickerWidgetId) : undefined
  const handleApplyPickerSelection = useCallback(
    (creatorIds: string[]) => {
      if (!pickerWidgetId) return
      updateDraftWidgetComparison(pickerWidgetId, creatorIds)
      setAnnouncement(`Comparison creators updated: ${creatorIds.map((id, index) => `${index + 1}, ${creatorName(id)}`).join("; ")}.`)
      setPickerWidgetId(null)
    },
    [pickerWidgetId, updateDraftWidgetComparison],
  )

  // Flow 2: the dialog owns its own atomic transaction against
  // *canonical* state (never the draft), persisting through the same store
  // submit as a normal Save; on success the editor adopts the persisted layout.
  const handleFlow2Committed = useCallback(
    (committed: typeof canonicalLayout) => {
      commitExternalLayout(committed)
      setAnnouncement("Comparison charts added to the Dashboard.")
    },
    [commitExternalLayout],
  )
  const comparisonDialog = useComparisonMappingDialog(canonicalLayout, canonicalSubmit, handleFlow2Committed)

  // Flow 3: a creator dragged out of the Creator List onto a
  // comparison chart appends to that widget's draft config only.
  const dragSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const [activeCreatorIds, setActiveCreatorIds] = useState<string[]>([])
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<string[]>([])
  const handleCreatorDragStart = useCallback((event: DragStartEvent) => {
    const creatorId = event.active.data.current?.creatorId
    const draggedCreatorIds = event.active.data.current?.creatorIds
    if (typeof creatorId !== "string") return
    const ids = Array.isArray(draggedCreatorIds) ? draggedCreatorIds.filter((id): id is string => typeof id === "string") : [creatorId]
    setSelectedCreatorIds(ids)
    setActiveCreatorIds(ids)
  }, [])
  // Drag-and-drop is the only action that ever writes a widget's creator
  // scope; checkbox toggles here only ever adjust the in-progress selection
  // for the *next* drag, so switching targets between drops can never
  // silently overwrite a widget the user isn't currently dragging onto.
  const handleCreatorSelectionChange = useCallback((creatorIds: string[]) => {
    setSelectedCreatorIds(creatorIds)
  }, [])
  const handleCreatorDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCreatorIds([])
      if (!gridEditable || previewActive) return
      const creatorId = event.active.data.current?.creatorId
      const draggedCreatorIds = event.active.data.current?.creatorIds
      const widgetId = event.over?.id
      if (typeof creatorId !== "string" || typeof widgetId !== "string") return
      const creatorIds = Array.isArray(draggedCreatorIds)
        ? draggedCreatorIds.filter((id): id is string => typeof id === "string")
        : [creatorId]
      const name = creatorName(creatorId)
      const outcome = describeCreatorDrop(draftLayout, widgetId)
      if (outcome.status === "missing") return
      if (outcome.status === "incompatible") {
        setAnnouncement(`${name} can't be applied: this widget does not support member filters.`)
        return
      }
      const target = draftLayout.widgets.find((widget) => widget.widgetId === widgetId)
      if (target && isComparisonCapableWidget(target)) {
        updateDraftWidgetComparison(widgetId, creatorIds)
      } else {
        updateDraftWidgetCreatorScope(widgetId, creatorIds)
      }
      setSelectedCreatorIds(creatorIds)
      setAnnouncement(`${creatorIds.length} member${creatorIds.length === 1 ? "" : "s"} applied to this chart.`)
    },
    [gridEditable, previewActive, draftLayout, updateDraftWidgetCreatorScope, updateDraftWidgetComparison],
  )

  const renderComparisonWidget = useCallback(
    (widgetId: string) => {
      const widget = displayedCanonicalLayout.widgets.find((candidate) => candidate.widgetId === widgetId)
      if (!widget) return null
      return (
        <ComparisonWidget
          widget={widget}
          roster={mockCreators}
          availableComparisonItems={comparisonItems}
          fetchComparisonData={comparisonSource.fetchData}
          sampleData={comparisonSource.origin === "mock"}
          onSelectCreators={gridEditable && !previewActive ? setPickerWidgetId : undefined}
        />
      )
    },
    [displayedCanonicalLayout, comparisonItems, comparisonSource, gridEditable, previewActive],
  )

  const reportDate = dataSource === "live" ? dateInTimeZone(new Date(), "Asia/Tokyo") : MOCK_REPORT_DATE
  const fetchFn = useCallback(() => {
    const fetchPromise =
      dataSource === "live"
        ? fetchRealAnalytics(reportDate, period, timeZone)
        : fetchMockAnalytics(reportDate, period)
    return fetchPromise.then((entry) => ({ ...entry, timeZone }))
  }, [period, timeZone, dataSource, reportDate])
  const { entry, loading, error } = useCachedDashboardData(
    { timeZone, reportDate, period, dataSource },
    fetchFn,
    refreshToken,
  )

  useEffect(() => {
    let timeoutId: number
    const schedule = () => {
      timeoutId = window.setTimeout(() => {
        setRefreshToken((current) => current + 1)
        schedule()
      }, millisecondsUntilNextLocalHour(18))
    }
    schedule()
    return () => window.clearTimeout(timeoutId)
  }, [timeZone])

  const allStats = useMemo(() => entry?.results ?? [], [entry])
  const dataBackedCreatorIds = useMemo(
    () => new Set(allStats.filter((stat) => stat.status === "ok").map((stat) => stat.channelId)),
    [allStats],
  )
  const selectableCreators = useMemo(
    () => mockCreators.filter((creator) => dataBackedCreatorIds.has(creator.channelId)),
    [dataBackedCreatorIds],
  )
  const filteredStats = useMemo(
    () => allStats.filter((s) => matchesClassification(s, filters.state) && matchesContent(s, filters.state)),
    [allStats, filters.state],
  )

  const kpis = useMemo(() => deriveKpis(filteredStats), [filteredStats])
  const contributions = useMemo(() => deriveChannelContribution(filteredStats), [filteredStats])
  const insights = useMemo(() => deriveInsights(filteredStats, period), [filteredStats, period])

  const byChannel = useMemo(
    () => contributions.slice(0, 8).map((c) => ({ label: c.channelName, value: c.dailyIncrease, channelId: c.channelId })),
    [contributions],
  )
  const allTimeTotal = useMemo(
    () => allStats.filter((s) => s.status === "ok").reduce((sum, s) => sum + s.dailyIncrease, 0),
    [allStats],
  )
  const byDay = useMemo(() => {
    const ratio = allTimeTotal > 0 ? kpis.totalDailyIncrease / allTimeTotal : 0
    return mockDailySeries.map((p) => ({ label: p.date.slice(5), value: Math.round(p.dailyIncrease * ratio) }))
  }, [allTimeTotal, kpis.totalDailyIncrease])

  const lastUpdatedAt =
    filteredStats.reduce((latest, s) => (s.collectedAt > latest ? s.collectedAt : latest), filteredStats[0]?.collectedAt ?? "") ||
    entry?.fetchedAt ||
    new Date().toISOString()

  const widgetData: DashboardWidgetData = {
    kpis,
    contributions,
    filteredStats,
    insights,
    byDay,
    byChannel,
    period,
    timeZone,
  }

  // Computed once per relevant dependency change rather than once per widget
  // per render, so re-renders that touch neither the data nor the layout
  // (drag start/end, announcements, ...) don't redo every scoped widget's
  // KPI/contribution/insight derivation.
  const scopedWidgetDataById = useMemo(() => {
    const result: Record<string, DashboardWidgetData> = {}
    for (const widget of displayedCanonicalLayout.widgets) {
      const creatorIds = widget.creatorScope?.creatorIds
      if (!creatorIds?.length) continue
      const allowed = new Set(creatorIds)
      const scopedStats = filteredStats.filter((stat) => allowed.has(stat.channelId))
      const scopedKpis = deriveKpis(scopedStats)
      const scopedContributions = deriveChannelContribution(scopedStats)
      const ratio = allTimeTotal > 0 ? scopedKpis.totalDailyIncrease / allTimeTotal : 0
      result[widget.widgetId] = {
        ...widgetData,
        kpis: scopedKpis,
        contributions: scopedContributions,
        filteredStats: scopedStats,
        insights: deriveInsights(scopedStats, period),
        byChannel: scopedContributions.slice(0, 8).map((item) => ({ label: item.channelName, value: item.dailyIncrease, channelId: item.channelId })),
        byDay: mockDailySeries.map((point) => ({ label: point.date.slice(5), value: Math.round(point.dailyIncrease * ratio) })),
      }
    }
    return result
  }, [allTimeTotal, displayedCanonicalLayout.widgets, filteredStats, period, widgetData])

  const getWidgetData = useCallback(
    (widgetId: string): DashboardWidgetData => scopedWidgetDataById[widgetId] ?? widgetData,
    [scopedWidgetDataById, widgetData],
  )

  const getWidgetScopeLabels = useCallback((widgetId: string): string[] => {
    const ids = displayedCanonicalLayout.widgets.find((widget) => widget.widgetId === widgetId)?.creatorScope?.creatorIds ?? []
    return ids.map(creatorName)
  }, [displayedCanonicalLayout.widgets])

  return (
    <ConfigProvider theme={dashboardAntdTheme}>
    <DndContext
      sensors={dragSensors}
      onDragStart={handleCreatorDragStart}
      onDragCancel={() => setActiveCreatorIds([])}
      onDragEnd={handleCreatorDragEnd}
    >
    <div className="dashboard-page">
      <DashboardHeader
        lastUpdatedAt={lastUpdatedAt}
        timeZone={timeZone}
        period={period}
        onPeriodChange={setPeriod}
        dataSource={dataSource}
        onDataSourceChange={setDataSource}
      />

      <ClassificationFilterBar
        state={filters.state}
        onOrganizationChange={filters.setOrganization}
        onBranchChange={filters.setBranch}
        onGroupKeyToggle={filters.toggleGroupKey}
        onChannelTypeChange={filters.setChannelType}
        onLifecycleStageChange={filters.setLifecycleStage}
        onContentTagToggle={filters.toggleContentTag}
        onContentFormatChange={filters.setContentFormat}
        onReset={filters.reset}
      />

      {legacyRecovery && (
        <LegacyLayoutRecoveryBanner
          savedGrid={legacyRecovery.parsed.grid}
          canConvert={legacyRecovery.proposed !== null}
          error={legacyConvertError}
          onConvert={handleConvertLegacy}
        />
      )}

      {loading ? (
        <div className="card">
          <LoadingState rows={4} />
        </div>
      ) : error && entry === null ? (
        <div className="card">
          {(() => {
            const { code, description } = describeApiFailure(error, locale)
            return <ErrorState message={description} code={code} />
          })()}
        </div>
      ) : filteredStats.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Mobile is view-only -- no Edit control at all
           * (not merely a disabled one), and no oversized-for-tablet
           * layout may be edited either (see `editingAvailable` above). */}
          {editingAvailable && (
            <div className={editMode ? "dashboard-page__toolbar" : "dashboard-page__toolbar dashboard-page__toolbar--view"}>
              <EditModeToolbar
                editMode={editMode}
                isDirty={isDirty}
                onEnterEditMode={enterEditMode}
                onSave={save}
                onCancel={cancelEditMode}
                onResetToDefault={handleRestoreDefault}
                resetToDefaultLabel="Restore Default"
                saveDisabled={previewActive}
              />
              {gridEditable && (
                <DraggableCreatorList
                  creators={mockCreators}
                  availableCreatorIds={dataBackedCreatorIds}
                  initiallyOpen={false}
                  dragging={activeCreatorIds.length > 0}
                  selectedIds={selectedCreatorIds}
                  onSelectedIdsChange={handleCreatorSelectionChange}
                />
              )}
              {/* Flow 2 entry point: view mode only, so the dialog's
               * canonical-only transaction can never race an unsaved draft. */}
              {!editMode && (
                <Button onClick={comparisonDialog.open} disabled={comparisonItems.length === 0}>
                  Compare Creators
                </Button>
              )}
            </div>
          )}

          {/* GAP-1A: test-observable proof that the catalog loader is
           * mounted at this page level and that view/edit mode share the
           * same result (Section 3.3 rule 3). `WidgetTray` below now
           * reads this same cached status/result -- no second fetch. */}
          <span data-testid="chart-catalog-status" className="sr-only">
            {chartCatalog.state.status}
          </span>

          {/* Shared assistive-technology live region for both the
           * Add insertion announcement and the drag/resize commit/rollback
           * announcement -- already mounted before any editing gesture can
           * occur so assistive technology reliably picks up later text
           * changes (Guidelines Section 12). */}
          <span data-testid="dashboard-editor-announcer" className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>

          {gridEditable && (
            <WidgetTray
              availableTypes={addableWidgetTypes}
              catalogStatus={chartCatalog.state.status}
              selectedType={pendingWidgetType}
              onSelectWidget={handleSelectWidgetType}
              onRetryCatalog={chartCatalog.retry}
            />
          )}

          {/* Unstyled measurement wrapper only -- a plain block-level
           * div in normal flow has zero layout effect, so this changes no
           * rendered geometry; it exists solely to give the ResizeObserver
           * above a stable element whose width equals the grid's own
           * available content width, independent of GridStack's column
           * count (which the width measurement itself must not depend on). */}
          <div ref={setGridContentEl}>
            <DashboardGrid
              widgets={projection.widgets}
              columns={projection.columns}
              rows={layoutForDisplay.grid.rows}
              editable={gridEditable}
              data={widgetData}
              getWidgetData={getWidgetData}
              getWidgetScopeLabels={getWidgetScopeLabels}
              renderComparisonWidget={renderComparisonWidget}
              onCommitGeometry={handleCommitGeometry}
              onRemoveWidget={removeDraftWidget}
              validateGesturePreview={validateGesturePreview}
              onAnnounce={handleAnnounce}
              placeholderWidgetId={previewActive ? previewSlot?.candidateId : null}
              locked={previewActive}
            />
          </div>

          {/* Rendered *below* the grid, not above it. The panel exists
           * only for the duration of an Add session, and everything above
           * the grid shifts the grid vertically when it mounts/unmounts (the
           * flow gap and the panel's own height) -- which moved the committed
           * widget away from where its preview placeholder had been drawn.
           * Below the grid it can appear, grow (status line, rejection
           * alert) and disappear without moving the grid or any widget, so
           * the placeholder and the committed widget share one absolute
           * border-box. */}
          {gridEditable && pendingWidgetType && (
            <WidgetInsertionSlots
              pendingTitle={getGridWidgetMeta(pendingWidgetType).title}
              rows={insertionRows}
              onSelectSlot={handleSelectInsertionSlot}
              onCancel={handleCancelInsertion}
              rejected={insertionRejected}
              activeSlot={previewSlot && previewActive ? { rowY: previewSlot.rowY, slotIndex: previewSlot.slotIndex } : null}
              previewStatus={previewStatus}
              canInsert={previewActive}
              onInsert={handleInsert}
            />
          )}

          {gridEditable && pickerWidget && isComparisonCapableWidget(pickerWidget) && (
            <CreatorComparisonPicker
              key={pickerWidget.widgetId}
              creators={selectableCreators}
              initialSelectedIds={pickerWidget.comparison?.creatorIds ?? []}
              onCancel={() => setPickerWidgetId(null)}
              onApply={handleApplyPickerSelection}
            />
          )}

          {comparisonDialog.isOpen && (
            <ComparisonMappingDialog
              creators={selectableCreators}
              availableComparisonItems={comparisonItems}
              orderedCreatorIds={comparisonDialog.orderedCreatorIds}
              onToggleCreator={comparisonDialog.toggleCreator}
              orderedItemIds={comparisonDialog.orderedItemIds}
              onToggleItem={comparisonDialog.toggleItem}
              preview={comparisonDialog.preview}
              canSave={comparisonDialog.canSave}
              isSaving={comparisonDialog.isSaving}
              error={comparisonDialog.error}
              onSave={() => void comparisonDialog.save()}
              onCancel={comparisonDialog.close}
            />
          )}

          {gridChangeConfirmation && (
            <GridChangeConfirmationDialog
              confirmation={gridChangeConfirmation}
              disabled={!draftValidation.valid}
              onCancel={cancelGridChangeConfirmation}
              onConfirm={confirmGridChange}
            />
          )}

          <StaleDataNotice lastUpdatedAt={lastUpdatedAt} />
        </>
      )}

      <SaveToast visible={saveConfirmation} />
      <DashboardFooter />
    </div>
      <DragOverlay dropAnimation={null}>
        {activeCreatorIds.length > 0 && (
          <div className="member-drag-overlay">
            <strong>{activeCreatorIds.length} member{activeCreatorIds.length === 1 ? "" : "s"}</strong>
            <span>{activeCreatorIds.map(creatorName).join(", ")}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
    </ConfigProvider>
  )
}
