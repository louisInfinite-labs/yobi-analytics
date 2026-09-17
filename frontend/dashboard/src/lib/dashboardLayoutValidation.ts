import {
  isGridDimension,
  isWidgetHeight,
  type CanonicalLayout,
  type DashboardWidget,
  type DraftLayout,
  type LayoutValidationError,
  type LayoutValidationResult,
} from "../types/dashboardLayout"

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** The single canonical validator entry point (Section 10 of
 * DASHBOARD_LAYOUT_GUIDELINES.md) that later microtasks wire into the
 * production add/drag/resize/load/save paths. Runs every check and collects
 * all applicable errors instead of stopping at the first failure, so a
 * caller can surface every problem from one pass. */
export function validateLayout(layout: CanonicalLayout | DraftLayout): LayoutValidationResult {
  const { grid, widgets } = layout
  const errors: LayoutValidationError[] = [
    ...validateGridSize(grid.columns, grid.rows),
    ...validateDuplicateIds(widgets),
    ...validateHeights(widgets),
    ...validateWidths(widgets, grid.columns),
    ...validateBounds(widgets, grid),
    ...validateCollisions(widgets),
    ...validateColumnFill(widgets),
  ]

  return { valid: errors.length === 0, errors }
}

function validateGridSize(columns: number, rows: number): LayoutValidationError[] {
  if (isGridDimension(columns) && isGridDimension(rows)) return []
  return [
    {
      code: "INVALID_GRID_SIZE",
      message: `Grid size ${columns}x${rows} is outside the supported 1x1-5x5 range.`,
    },
  ]
}

function validateDuplicateIds(widgets: DashboardWidget[]): LayoutValidationError[] {
  const counts = new Map<string, number>()
  for (const widget of widgets) counts.set(widget.widgetId, (counts.get(widget.widgetId) ?? 0) + 1)
  const duplicateIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
  if (duplicateIds.length === 0) return []
  return [
    {
      code: "DUPLICATE_WIDGET_ID",
      widgetIds: duplicateIds,
      message: `Duplicate widgetId value(s): ${duplicateIds.join(", ")}.`,
    },
  ]
}

function validateHeights(widgets: DashboardWidget[]): LayoutValidationError[] {
  const invalid = widgets.filter((widget) => !isWidgetHeight(widget.height))
  if (invalid.length === 0) return []
  return [
    {
      code: "INVALID_HEIGHT",
      widgetIds: invalid.map((widget) => widget.widgetId),
      message: `Widget height must be 0.5 or 1; found ${invalid.map((widget) => widget.height).join(", ")}.`,
    },
  ]
}

function validateWidths(widgets: DashboardWidget[], columns: number): LayoutValidationError[] {
  const invalid = widgets.filter(
    (widget) => !Number.isInteger(widget.width) || widget.width < 1 || widget.width > columns,
  )
  if (invalid.length === 0) return []
  return [
    {
      code: "INVALID_WIDTH",
      widgetIds: invalid.map((widget) => widget.widgetId),
      message: `Widget width must be an integer between 1 and the grid's ${columns} column(s).`,
    },
  ]
}

/** `y` must land on a supported half-row boundary: `Number.isInteger(y * 2)`
 * is true for every integer and every `n.5`, and false for anything else
 * (quarter-rows, thirds, etc.), without the drift a modulo check on floats
 * would introduce. */
function isHalfRowAligned(value: number): boolean {
  return Number.isInteger(value * 2)
}

/** A widget's coordinates and grid-unit alignment are part of "fits inside
 * the grid" — a widget that isn't finite, isn't on a supported grid unit, or
 * starts a `1X` widget mid-row can never be a valid placement, so misaligned
 * coordinates are reported as `OUT_OF_BOUNDS` rather than a separate code. */
function hasInvalidCoordinates(widget: DashboardWidget): boolean {
  if (!Number.isFinite(widget.x) || !Number.isFinite(widget.y)) return true
  if (!Number.isInteger(widget.x)) return true
  if (!isHalfRowAligned(widget.y)) return true
  if (widget.height === 1 && !Number.isInteger(widget.y)) return true
  return false
}

function validateBounds(
  widgets: DashboardWidget[],
  grid: { columns: number; rows: number },
): LayoutValidationError[] {
  const outOfBounds = widgets.filter(
    (widget) =>
      hasInvalidCoordinates(widget) ||
      widget.x < 0 ||
      widget.y < 0 ||
      widget.x + widget.width > grid.columns ||
      widget.y + widget.height > grid.rows,
  )
  if (outOfBounds.length === 0) return []
  return [
    {
      code: "OUT_OF_BOUNDS",
      widgetIds: outOfBounds.map((widget) => widget.widgetId),
      message: `Widget(s) fall outside the ${grid.columns}x${grid.rows} grid, or use an unsupported/misaligned coordinate: ${outOfBounds
        .map((widget) => widget.widgetId)
        .join(", ")}.`,
    },
  ]
}

function validateCollisions(widgets: DashboardWidget[]): LayoutValidationError[] {
  const overlapping = new Set<string>()
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      if (overlaps(widgets[i], widgets[j])) {
        overlapping.add(widgets[i].widgetId)
        overlapping.add(widgets[j].widgetId)
      }
    }
  }
  if (overlapping.size === 0) return []
  return [
    {
      code: "WIDGET_OVERLAP",
      widgetIds: [...overlapping],
      message: `Widget(s) overlap: ${[...overlapping].join(", ")}.`,
    },
  ]
}

/** A column segment is one grid column at one integer row band. Section 5.2
 * requires it be filled by exactly one `1X` widget or two stacked `0.5X`
 * widgets — any other total (a lone `0.5X`, for example) leaves an unusable
 * gap or an unresolved overlap. */
function validateColumnFill(widgets: DashboardWidget[]): LayoutValidationError[] {
  const segments = new Map<string, { total: number; widgetIds: Set<string> }>()

  for (const widget of widgets) {
    // Non-finite/misaligned coordinates are already reported as
    // OUT_OF_BOUNDS by validateBounds; skip them here so a NaN/Infinity
    // coordinate can't turn Math.floor/ceil into an unbounded loop below.
    if (hasInvalidCoordinates(widget) || !Number.isFinite(widget.width)) continue
    const rowBand = Math.floor(widget.y)
    const firstColumn = Math.floor(widget.x)
    const lastColumn = Math.ceil(widget.x + widget.width) - 1
    for (let column = firstColumn; column <= lastColumn; column++) {
      const key = `${column}:${rowBand}`
      const segment = segments.get(key) ?? { total: 0, widgetIds: new Set<string>() }
      segment.total += widget.height
      segment.widgetIds.add(widget.widgetId)
      segments.set(key, segment)
    }
  }

  const flagged = new Set<string>()
  for (const segment of segments.values()) {
    if (segment.total !== 1) {
      segment.widgetIds.forEach((id) => flagged.add(id))
    }
  }
  if (flagged.size === 0) return []
  return [
    {
      code: "INCOMPLETE_COLUMN",
      widgetIds: [...flagged],
      message: `Widget(s) leave a row segment that is not exactly one 1X widget or two stacked 0.5X widgets: ${[...flagged].join(", ")}.`,
    },
  ]
}
