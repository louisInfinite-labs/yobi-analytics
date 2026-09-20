import { getWidgetDefinition } from "../lib/widgetRegistry"
import type { WidgetTypeId } from "../types/widget"

export type ChartCatalogTrayStatus = "loading" | "error" | "success"

interface WidgetTrayProps {
  /** The catalog-filtered set of addable widget types (already
   * intersected with the frontend registry -- see
   * `dashboardChartCatalogOptions.ts`'s `resolveAddableWidgetTypes`), never
   * `ALL_WIDGET_TYPES`. Only meaningful when `catalogStatus === "success"`;
   * the caller passes an empty array for `"loading"`/`"error"` so this
   * component never has to know about `ChartCatalogState` itself. */
  availableTypes: WidgetTypeId[]
  /** Lets the tray show a distinguishable message for the
   * catalog's pending/error state instead of silently rendering zero
   * options (which would be indistinguishable from a real empty-success
   * catalog). */
  catalogStatus: ChartCatalogTrayStatus
  /** Selecting a chart only marks it as the pending
   * insertion candidate -- it does not place it. `null` while nothing is
   * selected. */
  selectedType: WidgetTypeId | null
  /** Clicking the already-selected type again is how a caller may choose to
   * implement deselection; this component only reports the click. */
  onSelectWidget: (type: WidgetTypeId) => void
  /** Explicit retry after a catalog error (Section 3.3). */
  onRetryCatalog?: () => void
}

/** The widget library: catalog-driven while editing. Selecting an
 * item marks it as the pending Add candidate; it never places the widget by
 * itself -- an explicit insertion slot (see `WidgetInsertionSlots`) is
 * required to actually add it to `draftLayout`. */
export function WidgetTray({ availableTypes, catalogStatus, selectedType, onSelectWidget, onRetryCatalog }: WidgetTrayProps) {
  return (
    <div className="widget-tray card">
      <h2 className="section-header" style={{ marginBottom: 0 }}>
        Widget Library
      </h2>
      {catalogStatus === "loading" && (
        <p className="widget-tray__status" data-testid="widget-tray-status">
          Loading available charts…
        </p>
      )}
      {catalogStatus === "error" && (
        <>
          <p className="widget-tray__status" data-testid="widget-tray-status">
            Couldn't load the chart catalog. Existing widgets are unaffected.
          </p>
          {onRetryCatalog && (
            <button type="button" className="soft-button" onClick={onRetryCatalog}>
              Retry
            </button>
          )}
        </>
      )}
      {catalogStatus === "success" && availableTypes.length === 0 && (
        <p className="widget-tray__status" data-testid="widget-tray-status">
          No charts are currently available to add.
        </p>
      )}
      <div className="widget-tray__list">
        {catalogStatus === "success" &&
          availableTypes.map((type) => {
            const definition = getWidgetDefinition(type)
            return (
              <button
                type="button"
                key={type}
                className="soft-button widget-tray__item"
                aria-pressed={selectedType === type}
                onClick={() => onSelectWidget(type)}
              >
                <span className="widget-tray__item-title">{definition.title}</span>
                <span className="widget-tray__item-description">{definition.description}</span>
              </button>
            )
          })}
      </div>
    </div>
  )
}
