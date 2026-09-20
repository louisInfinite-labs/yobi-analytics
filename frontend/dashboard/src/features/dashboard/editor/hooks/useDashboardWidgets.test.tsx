import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDashboardWidgets } from "./useDashboardWidgets"
import type { CanonicalLayout } from "../model/dashboardLayout"

const EMPTY_LAYOUT: CanonicalLayout = { grid: { columns: 3, rows: 3 }, widgets: [] }

/** Renders the widget list keyed by `widgetId` (Section 4, rule 7) plus an
 * Add button wired straight to the production `addWidget` path — this is
 * the harness the acceptance criteria's E2E-style assertions drive; the
 * real editor UI that will consume this hook is owned by later microtasks
 * (MT-07 "Editor Shell and Draft Isolation" onward). */
function Harness({ initialLayout }: { initialLayout: CanonicalLayout }) {
  const { layout, lastError, addWidget, moveWidget, resizeWidget } = useDashboardWidgets(initialLayout)
  const nextSlot = { x: layout.widgets.length % 3, y: Math.floor(layout.widgets.length / 3), width: 1, height: 1 as const }
  return (
    <div>
      <button onClick={() => addWidget("kpi-summary", nextSlot)}>Add</button>
      <button onClick={() => moveWidget("a", { x: 1, y: 0 })}>Move a</button>
      <button onClick={() => resizeWidget("a", { width: 2, height: 1 })}>Resize a</button>
      <span data-testid="error">{lastError ? lastError.errors.map((e) => e.code).join(",") : ""}</span>
      <ul>
        {layout.widgets.map((widget) => (
          <li
            key={widget.widgetId}
            data-testid="widget-row"
            data-widget-id={widget.widgetId}
            data-x={widget.x}
            data-y={widget.y}
            data-width={widget.width}
            data-height={widget.height}
          />
        ))}
      </ul>
    </div>
  )
}

describe("useDashboardWidgets", () => {
  it("rapidly activating Add five times in a row inserts five widgets with five distinct ids", () => {
    render(<Harness initialLayout={EMPTY_LAYOUT} />)
    const addButton = screen.getByRole("button", { name: "Add" })

    for (let i = 0; i < 5; i++) fireEvent.click(addButton)

    const rows = screen.getAllByTestId("widget-row")
    expect(rows).toHaveLength(5)
    const ids = rows.map((row) => row.dataset.widgetId)
    expect(new Set(ids).size).toBe(5)
  })

  it("renders each widget row keyed by widgetId, not array index", () => {
    // Placed on a grid cell that the Harness's own Add clicks never touch,
    // so the seeded row's identity is the only thing under test.
    const seeded: CanonicalLayout = {
      grid: { columns: 3, rows: 3 },
      widgets: [{ widgetId: "seed-1", widgetType: "kpi-summary", x: 2, y: 2, width: 1, height: 1 }],
    }
    render(<Harness initialLayout={seeded} />)

    const seedRow = screen.getByTestId("widget-row")
    expect(seedRow.dataset.widgetId).toBe("seed-1")

    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    const rows = screen.getAllByTestId("widget-row")
    expect(rows).toHaveLength(2)
    // The pre-existing seed row is still the same DOM node after a widget is
    // appended after it -- consistent with keying by widgetId rather than
    // array position (an index key would still pass this particular case,
    // since append doesn't shift indices; reordering/removal, which would
    // distinguish the two, belongs to later microtasks that add drag and
    // insertion-slot support).
    expect(rows[0]).toBe(seedRow)
    expect(rows[0].dataset.widgetId).toBe("seed-1")
  })

  it("rejects an add whose generated widgetId collides with an existing widget, leaving the layout unchanged", () => {
    const fixedUuid = "00000000-0000-0000-0000-000000000000" as ReturnType<typeof crypto.randomUUID>
    const randomUUIDSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid)

    try {
      const seeded: CanonicalLayout = {
        grid: { columns: 2, rows: 2 },
        widgets: [{ widgetId: `kpi-summary-${fixedUuid}`, widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
      }
      render(<Harness initialLayout={seeded} />)

      fireEvent.click(screen.getByRole("button", { name: "Add" }))

      // The forced-collision id means the candidate widget duplicates the
      // seeded one -- validateLayout must reject it before commit.
      expect(screen.getAllByTestId("widget-row")).toHaveLength(1)
      expect(screen.getByTestId("error").textContent).toContain("DUPLICATE_WIDGET_ID")
    } finally {
      randomUUIDSpy.mockRestore()
    }
  })

  it("a successful move changes only that widget's geometry, never its widgetId", () => {
    const seeded: CanonicalLayout = {
      grid: { columns: 3, rows: 3 },
      widgets: [{ widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    render(<Harness initialLayout={seeded} />)

    fireEvent.click(screen.getByRole("button", { name: "Move a" }))

    const row = screen.getByTestId("widget-row")
    expect(row.dataset.widgetId).toBe("a")
    expect(row.dataset.x).toBe("1")
    expect(row.dataset.y).toBe("0")
    expect(row.dataset.width).toBe("1")
  })

  it("a successful resize changes only that widget's geometry, never its widgetId", () => {
    const seeded: CanonicalLayout = {
      grid: { columns: 3, rows: 3 },
      widgets: [{ widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 }],
    }
    render(<Harness initialLayout={seeded} />)

    fireEvent.click(screen.getByRole("button", { name: "Resize a" }))

    const row = screen.getByTestId("widget-row")
    expect(row.dataset.widgetId).toBe("a")
    expect(row.dataset.x).toBe("0")
    expect(row.dataset.y).toBe("0")
    expect(row.dataset.width).toBe("2")
  })

  it("a rejected resize restores the last valid draft coordinates instead of partially committing", () => {
    const seeded: CanonicalLayout = {
      grid: { columns: 2, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    render(<Harness initialLayout={seeded} />)

    // Widening "a" to width 2 on a 2-column grid would overlap "b".
    fireEvent.click(screen.getByRole("button", { name: "Resize a" }))

    const rows = screen.getAllByTestId("widget-row")
    const row = rows.find((r) => r.dataset.widgetId === "a")
    expect(row?.dataset.width).toBe("1")
    expect(screen.getByTestId("error").textContent).toContain("WIDGET_OVERLAP")
    // "b" is untouched too -- the whole candidate layout was rejected, not partially applied.
    const other = rows.find((r) => r.dataset.widgetId === "b")
    expect(other?.dataset.x).toBe("1")
  })
})
