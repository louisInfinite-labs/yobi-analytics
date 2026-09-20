import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { WidgetInsertionSlots } from "./WidgetInsertionSlots"
import type { InsertableRow } from "../utils/dashboardInsertionRows"

const ROWS: InsertableRow[] = [
  {
    y: 0,
    widgets: [
      { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    ],
  },
]

function renderSlots(overrides: Partial<React.ComponentProps<typeof WidgetInsertionSlots>> = {}) {
  const props = {
    pendingTitle: "KPI Summary",
    rows: ROWS,
    onSelectSlot: vi.fn(),
    onCancel: vi.fn(),
    rejected: false,
    activeSlot: null,
    previewStatus: null,
    canInsert: false,
    onInsert: vi.fn(),
    ...overrides,
  }
  render(<WidgetInsertionSlots {...props} />)
  return props
}

describe("WidgetInsertionSlots (GAP-7)", () => {
  it("activating a slot reports the row, slot index and row number without committing", async () => {
    const props = renderSlots()
    await userEvent.click(screen.getByRole("button", { name: "Insert KPI Summary after KPI Summary in row 1" }))

    expect(props.onSelectSlot).toHaveBeenCalledWith(ROWS[0].widgets, 1, 1)
    expect(props.onInsert).not.toHaveBeenCalled()
  })

  it("only the active slot is aria-pressed and it shows a non-color marker", () => {
    renderSlots({ activeSlot: { rowY: 0, slotIndex: 2 }, canInsert: true })
    const slots = screen.getAllByRole("button", { name: /^Insert KPI Summary/ })

    expect(slots.map((slot) => slot.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"])
    expect(slots[2]).toHaveTextContent("✓")
    expect(slots[0]).toHaveTextContent("+")
  })

  it("Insert here is disabled without a valid preview and calls onInsert when enabled", async () => {
    const props = renderSlots({ canInsert: true, previewStatus: "Previewing KPI Summary at position 1 in row 1." })

    expect(screen.getByTestId("widget-insertion-preview-status")).toHaveTextContent("Previewing KPI Summary at position 1 in row 1.")
    await userEvent.click(screen.getByRole("button", { name: "Insert here" }))
    expect(props.onInsert).toHaveBeenCalledTimes(1)
  })

  it("Insert here is disabled when canInsert is false", () => {
    renderSlots({ canInsert: false })
    expect(screen.getByRole("button", { name: "Insert here" })).toBeDisabled()
  })
})
