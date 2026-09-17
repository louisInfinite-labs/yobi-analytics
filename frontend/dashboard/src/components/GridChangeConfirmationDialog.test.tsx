import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { GridChangeConfirmationDialog } from "./GridChangeConfirmationDialog"
import type { GridChangeConfirmation } from "../hooks/useDashboardEditor"

const CONFIRMATION: GridChangeConfirmation = {
  currentGrid: { columns: 2, rows: 2 },
  targetGrid: { columns: 3, rows: 2 },
  affectedWidgetIds: ["a", "b"],
}

describe("GridChangeConfirmationDialog", () => {
  it("displays the current grid size, target grid size, and affected widget count (AC2)", () => {
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByTestId("current-grid")).toHaveTextContent("2x2")
    expect(screen.getByTestId("target-grid")).toHaveTextContent("3x2")
    expect(screen.getByTestId("affected-widget-count")).toHaveTextContent("2")
  })

  it("calls onCancel when Cancel is clicked, and never calls onConfirm", () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={onCancel} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("calls onConfirm when Continue and Save is clicked and not disabled", () => {
    const onConfirm = vi.fn()
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={vi.fn()} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole("button", { name: "Continue and Save" }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("disables the Continue and Save action when the draft is currently invalid (AC9)", () => {
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled onCancel={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.getByRole("button", { name: "Continue and Save" })).toBeDisabled()
  })
})
