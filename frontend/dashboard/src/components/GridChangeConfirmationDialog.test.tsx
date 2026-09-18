import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("MT-16 AC7/AC9: focus moves into the dialog on open, landing on Cancel", () => {
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }))
  })

  it("MT-16 AC9: Escape closes the dialog (calls onCancel)", async () => {
    const onCancel = vi.fn()
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={onCancel} onConfirm={vi.fn()} />)
    const user = userEvent.setup()

    await user.keyboard("{Escape}")

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("MT-16 AC9: Tab from the last focusable action wraps back to Cancel", async () => {
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const user = userEvent.setup()
    const cancelButton = screen.getByRole("button", { name: "Cancel" })
    const confirmButton = screen.getByRole("button", { name: "Continue and Save" })

    confirmButton.focus()
    await user.tab()

    expect(document.activeElement).toBe(cancelButton)
  })

  it("MT-16 AC9: Shift+Tab from Cancel wraps to the last focusable action", async () => {
    render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const user = userEvent.setup()
    const confirmButton = screen.getByRole("button", { name: "Continue and Save" })

    screen.getByRole("button", { name: "Cancel" }).focus()
    await user.tab({ shift: true })

    expect(document.activeElement).toBe(confirmButton)
  })

  function TriggerAndDialog() {
    const [open, setOpen] = useState(false)
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        {open && (
          <GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={() => setOpen(false)} onConfirm={vi.fn()} />
        )}
      </div>
    )
  }

  it("MT-16 AC10: closing the dialog returns focus to the control that triggered it", async () => {
    const openButton = document.createElement("button")
    openButton.textContent = "Open"
    document.body.appendChild(openButton)
    openButton.focus()

    const { unmount } = render(<GridChangeConfirmationDialog confirmation={CONFIRMATION} disabled={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(document.activeElement).not.toBe(openButton)

    unmount()

    expect(document.activeElement).toBe(openButton)
    document.body.removeChild(openButton)
  })

  it("MT-16 AC10: Escape-driven close (real trigger/dialog composition) returns focus to the opener", async () => {
    render(<TriggerAndDialog />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Open" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }))
  })
})
