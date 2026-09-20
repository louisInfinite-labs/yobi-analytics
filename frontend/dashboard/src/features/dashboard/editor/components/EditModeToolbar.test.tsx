import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { EditModeToolbar } from "./EditModeToolbar"

const noop = () => {}

function renderToolbar(props: { isDirty: boolean; saveDisabled?: boolean }) {
  render(<EditModeToolbar editMode isDirty={props.isDirty} saveDisabled={props.saveDisabled} onEnterEditMode={noop} onSave={noop} onCancel={noop} onResetToDefault={noop} />)
}

describe("EditModeToolbar saveDisabled (GAP-7)", () => {
  it("disables Save independently of isDirty while keeping the unsaved-changes label", () => {
    renderToolbar({ isDirty: true, saveDisabled: true })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument()
  })

  it("Save is enabled for a dirty draft when not blocked, and disabled for a clean one", () => {
    renderToolbar({ isDirty: true })
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("a clean draft keeps Save disabled", () => {
    renderToolbar({ isDirty: false })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })
})
