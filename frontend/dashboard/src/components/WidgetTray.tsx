import { ALL_WIDGET_TYPES, getWidgetDefinition } from "../lib/widgetRegistry"

interface WidgetTrayProps {
  onAddWidget: (type: (typeof ALL_WIDGET_TYPES)[number]) => void
}

/** The widget library: every registered type, addable while editing.
 * New modules appear here automatically and never overwrite a saved
 * layout — adding is purely additive (Roadmap Phase 7). */
export function WidgetTray({ onAddWidget }: WidgetTrayProps) {
  return (
    <div className="widget-tray card">
      <h2 className="section-header" style={{ marginBottom: 0 }}>
        Widget Library
      </h2>
      <div className="widget-tray__list">
        {ALL_WIDGET_TYPES.map((type) => {
          const definition = getWidgetDefinition(type)
          return (
            <button type="button" key={type} className="soft-button widget-tray__item" onClick={() => onAddWidget(type)}>
              <span className="widget-tray__item-title">{definition.title}</span>
              <span className="widget-tray__item-description">{definition.description}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
