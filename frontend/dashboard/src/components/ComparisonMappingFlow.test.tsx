/** MT-12 "Flow 2" integration evidence: the real `useComparisonMappingDialog`
 * hook + `ComparisonMappingDialog` + the real production `CanonicalWidgetGrid`
 * renderer wired together, proving AC15-AC18 end-to-end (dialog closes,
 * assigned chart containers with their loading state appear immediately,
 * with no page reload, no second Dashboard save, and no manual widget
 * movement) without touching `useDashboardEditor`'s own MT-09 save flow at
 * all -- this harness never mounts it.
 */
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import * as apiClient from "../lib/apiClient"
import { CanonicalWidgetGrid } from "./DashboardCanonicalEditor"
import { ComparisonMappingDialog } from "./ComparisonMappingDialog"
import { useComparisonMappingDialog } from "../hooks/useComparisonMappingDialog"
import { mockCreators } from "../data/mockCreators"
import type { CanonicalLayout } from "../types/dashboardLayout"

const ITEMS = [
  { comparisonItemId: "revenue", label: "Revenue" },
  { comparisonItemId: "engagement", label: "Engagement" },
  { comparisonItemId: "growth", label: "Growth" },
]

const LAYOUT: CanonicalLayout = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "widget-a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "widget-b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

function Harness({ submit }: { submit: (layout: CanonicalLayout) => Promise<void> }) {
  const [canonicalLayout, setCanonicalLayout] = useState(LAYOUT)
  const dialog = useComparisonMappingDialog(canonicalLayout, submit, setCanonicalLayout)

  return (
    <div>
      <CanonicalWidgetGrid layout={canonicalLayout} editMode={false} />
      <button type="button" onClick={dialog.open}>
        Add Comparison Charts
      </button>
      {dialog.isOpen && (
        <ComparisonMappingDialog
          creators={mockCreators}
          availableComparisonItems={ITEMS}
          orderedCreatorIds={dialog.orderedCreatorIds}
          onToggleCreator={dialog.toggleCreator}
          orderedItemIds={dialog.orderedItemIds}
          onToggleItem={dialog.toggleItem}
          preview={dialog.preview}
          canSave={dialog.canSave}
          isSaving={dialog.isSaving}
          error={dialog.error}
          onSave={dialog.save}
          onCancel={dialog.close}
        />
      )}
    </div>
  )
}

describe("MT-12 Flow 2 integration: immediate chart containers", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("AC15-AC18: Save closes the dialog and an assigned chart container with its loading state appears immediately -- no second save, no reload, no manual movement", async () => {
    const apiRequestSpy = vi.spyOn(apiClient, "apiRequest")
    const submit = vi.fn(async () => {})
    render(<Harness submit={submit} />)

    expect(screen.queryByTestId("comparison-chart-container")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Add Comparison Charts" }))
    fireEvent.click(screen.getByRole("button", { name: mockCreators[0].channelName }))
    fireEvent.click(screen.getByRole("button", { name: mockCreators[1].channelName }))
    fireEvent.click(screen.getByRole("button", { name: "Revenue" }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument() // AC15
    expect(submit).toHaveBeenCalledTimes(1) // AC13/AC17: exactly one transaction, no second save
    expect(apiRequestSpy).not.toHaveBeenCalled() // never triggers the normal MT-09 Dashboard save flow
    const container = screen.getByTestId("comparison-chart-container") // AC16
    expect(container.dataset.comparisonItemId).toBe("revenue")
    expect(screen.getByTestId("comparison-chart-loading")).toBeInTheDocument() // AC18
  })

  it("AC7-AC8/AC16: when items exceed containers, the appended widget's chart container also appears immediately after Save", async () => {
    const submit = vi.fn(async () => {})
    render(<Harness submit={submit} />)

    fireEvent.click(screen.getByRole("button", { name: "Add Comparison Charts" }))
    fireEvent.click(screen.getByRole("button", { name: mockCreators[0].channelName }))
    fireEvent.click(screen.getByRole("button", { name: mockCreators[1].channelName }))
    fireEvent.click(screen.getByRole("button", { name: "Revenue" }))
    fireEvent.click(screen.getByRole("button", { name: "Engagement" }))
    fireEvent.click(screen.getByRole("button", { name: "Growth" }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })

    expect(screen.getAllByTestId("canonical-widget-box")).toHaveLength(3) // widget-a, widget-b, appended
    expect(screen.getAllByTestId("comparison-chart-container")).toHaveLength(3)
  })
})
