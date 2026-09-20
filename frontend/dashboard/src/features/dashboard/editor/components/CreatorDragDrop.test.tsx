/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3).
 * `getBoundingClientRect` is overridden the same way `DashboardCanonicalEditor.test.tsx`
 * already does for jsdom -- position/size are read from each element's own
 * inline `left`/`top`/`width`/`height` style, walking up `position: absolute`
 * ancestors, so `@dnd-kit/core`'s own rect-based collision detection sees
 * real, distinct rectangles for each widget box and the draggable cell.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, renderHook, screen, within } from "@testing-library/react"
import { DndContext, type DragEndEvent } from "@dnd-kit/core"
import { CanonicalWidgetGrid } from "./DashboardCanonicalEditor"
import { DraggableCreatorList } from "../../comparison/components/DraggableCreatorList"
import { useDashboardEditor } from "../hooks/useDashboardEditor"
import { COMPARISON_WIDGET_TYPE } from "../../comparison/utils/dashboardComparisonWidgets"
import { mockCreators } from "../../../../entities/creator/data/mockCreators"
import type { CanonicalLayout } from "../model/dashboardLayout"

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 1 },
  widgets: [
    {
      widgetId: "comparison-widget",
      widgetType: COMPARISON_WIDGET_TYPE,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      comparison: { creatorIds: [], comparisonItemIds: [] },
    },
    { widgetId: "unrelated-widget", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
  ],
}

function pixelStyleValue(el: HTMLElement, prop: "left" | "top"): number {
  const parsed = parseFloat(el.style[prop])
  return Number.isFinite(parsed) ? parsed : 0
}

function computeAbsoluteRect(el: HTMLElement) {
  let left = 0
  let top = 0
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    left += pixelStyleValue(node, "left")
    top += pixelStyleValue(node, "top")
  }
  const width = parseFloat(el.style.width) || 40
  const height = parseFloat(el.style.height) || 40
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
}

let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect

beforeAll(() => {
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return computeAbsoluteRect(this) as DOMRect
  }
})

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

// dnd-kit's PointerSensor attaches its move/end listeners to the original
// `pointerdown` target itself (see AbstractPointerSensor's `attach()` --
// `getEventListenerTarget` resolves to `event.target`), not `window` or
// `document`, so every subsequent event in a drag session must be fired on
// the same `handle` element for the sensor to observe it.
function drag(handle: HTMLElement, target: HTMLElement) {
  const targetRect = target.getBoundingClientRect()
  fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientX: targetRect.left + 5, clientY: targetRect.top + 5 })
  fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true })
}

// Mirrors the same event-shape routing DashboardCanonicalEditor's own
// internal onDragEnd handler performs, so this test exercises the real
// @dnd-kit drag session end-to-end against the real production hook.
function handleDragEnd(event: DragEndEvent, updateDraftWidgetByCreatorDrop: (widgetId: string, creatorId: string) => void) {
  const creatorId = event.active.data.current?.creatorId as string | undefined
  const widgetId = event.over?.id
  if (creatorId && typeof widgetId === "string") updateDraftWidgetByCreatorDrop(widgetId, creatorId)
}

describe("MT-13 Flow 3: real @dnd-kit drag session wired to the production hook", () => {
  it("AC1/AC8/AC10: dropping a creator onto the compatible widget updates only that widget's draft, leaving canonical state unchanged", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    result.current.enterEditMode()
    render(
      <DndContext onDragEnd={(event) => handleDragEnd(event, result.current.updateDraftWidgetByCreatorDrop)}>
        <DraggableCreatorList creators={[mockCreators[0]]} />
        <CanonicalWidgetGrid layout={result.current.draftLayout} editMode />
      </DndContext>,
    )

    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })
    const compatibleBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "comparison-widget")!

    drag(handle, compatibleBox)

    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
      mockCreators[0].channelId,
    ])
    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "unrelated-widget")).toBe(LAYOUT.widgets[1])
    expect(result.current.layout).toBe(LAYOUT) // canonical unaffected (AC10)
  })

  it("cancelling a drag (releasing outside any droppable) changes no widget state (AC7)", () => {
    const onDragEnd = vi.fn()
    render(
      <DndContext onDragEnd={onDragEnd}>
        <DraggableCreatorList creators={[mockCreators[0]]} />
        <CanonicalWidgetGrid layout={LAYOUT} editMode />
      </DndContext>,
    )
    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })

    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientX: 5000, clientY: 5000 }) // far outside any droppable
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true })

    expect(onDragEnd).toHaveBeenCalledTimes(1)
    expect(onDragEnd.mock.calls[0][0].over).toBeNull()
  })
})

describe("MT-13 Flow 3: compatible/incompatible drop-target indicator (AC4/AC5)", () => {
  it("AC4: shows an active drop-target indicator while dragging over a compatible widget", () => {
    render(
      <DndContext onDragEnd={vi.fn()}>
        <DraggableCreatorList creators={[mockCreators[0]]} />
        <CanonicalWidgetGrid layout={LAYOUT} editMode />
      </DndContext>,
    )
    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })
    const compatibleBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "comparison-widget")!
    const compatibleRect = compatibleBox.getBoundingClientRect()

    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientX: compatibleRect.left + 5, clientY: compatibleRect.top + 5 })

    expect(compatibleBox.dataset.dropState).toBe("active")
    // MT-16 AC8 correction: the data attribute alone isn't a visible
    // distinction -- a rendered text label is (Guidelines Section 0.2:
    // "Do not communicate ... drag state by color alone").
    const indicator = within(compatibleBox).getByTestId("drop-indicator")
    expect(indicator).toHaveTextContent("Drop to compare")
    expect(indicator.className).toContain("drop-indicator--active")
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true })
  })

  it("AC5: shows a disabled drop-target indicator over an incompatible widget", () => {
    render(
      <DndContext onDragEnd={vi.fn()}>
        <DraggableCreatorList creators={[mockCreators[0]]} />
        <CanonicalWidgetGrid layout={LAYOUT} editMode />
      </DndContext>,
    )
    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })
    const incompatibleBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "unrelated-widget")!
    const incompatibleRect = incompatibleBox.getBoundingClientRect()

    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, isPrimary: true, clientX: incompatibleRect.left + 5, clientY: incompatibleRect.top + 5 })

    expect(incompatibleBox.dataset.dropState).toBe("disabled")
    // MT-16 AC8 correction: distinct rendered text from the "active" case,
    // not merely a different data attribute or color.
    const indicator = within(incompatibleBox).getByTestId("drop-indicator")
    expect(indicator).toHaveTextContent("Not a comparison chart")
    expect(indicator.className).toContain("drop-indicator--disabled")
    fireEvent.pointerUp(handle, { pointerId: 1, isPrimary: true })
  })

  it("AC5: rejects the drop onto an incompatible widget -- no comparison config created", () => {
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    result.current.enterEditMode()
    render(
      <DndContext onDragEnd={(event) => handleDragEnd(event, result.current.updateDraftWidgetByCreatorDrop)}>
        <DraggableCreatorList creators={[mockCreators[0]]} />
        <CanonicalWidgetGrid layout={result.current.draftLayout} editMode />
      </DndContext>,
    )
    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })
    const incompatibleBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "unrelated-widget")!

    drag(handle, incompatibleBox)

    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "unrelated-widget")?.comparison).toBeUndefined()
    expect(result.current.draftLayout).toEqual(LAYOUT)
  })
})

describe("MT-13 Flow 3: duplicate drop (AC6) and Creator List integrity (AC9)", () => {
  it("AC6: dropping a creator already present in the widget adds no duplicate", () => {
    const layoutWithA: CanonicalLayout = {
      grid: LAYOUT.grid,
      widgets: [
        { ...LAYOUT.widgets[0], comparison: { creatorIds: [mockCreators[0].channelId], comparisonItemIds: [] } },
        LAYOUT.widgets[1],
      ],
    }
    const { result } = renderHook(() => useDashboardEditor(layoutWithA))
    result.current.enterEditMode()
    render(
      <DndContext onDragEnd={(event) => handleDragEnd(event, result.current.updateDraftWidgetByCreatorDrop)}>
        <DraggableCreatorList creators={[mockCreators[0]]} />
        <CanonicalWidgetGrid layout={result.current.draftLayout} editMode />
      </DndContext>,
    )
    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })
    const compatibleBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "comparison-widget")!

    drag(handle, compatibleBox)

    expect(result.current.draftLayout.widgets.find((w) => w.widgetId === "comparison-widget")?.comparison?.creatorIds).toEqual([
      mockCreators[0].channelId,
    ])
  })

  it("AC9: dragging a creator cell does not reorder or mutate the source Creator List", () => {
    const before = JSON.parse(JSON.stringify(mockCreators))
    const { result } = renderHook(() => useDashboardEditor(LAYOUT))
    result.current.enterEditMode()
    render(
      <DndContext onDragEnd={(event) => handleDragEnd(event, result.current.updateDraftWidgetByCreatorDrop)}>
        <DraggableCreatorList creators={mockCreators} />
        <CanonicalWidgetGrid layout={result.current.draftLayout} editMode />
      </DndContext>,
    )
    const handle = screen.getByRole("button", { name: mockCreators[0].channelName })
    const compatibleBox = screen.getAllByTestId("canonical-widget-box").find((el) => el.dataset.widgetId === "comparison-widget")!

    drag(handle, compatibleBox)

    expect(mockCreators).toEqual(before)
  })
})
