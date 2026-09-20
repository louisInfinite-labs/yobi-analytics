import { useRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useModalFocus } from "./useModalFocus"

function Dialog({ onEscape }: { onEscape: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(panelRef, onEscape)
  return (
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button type="button">First</button>
      <button type="button">Middle</button>
      <button type="button" disabled>
        Disabled
      </button>
      <button type="button">Last</button>
    </div>
  )
}

function Harness({ onEscape = () => {} }: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Opener
      </button>
      <button type="button">Outside</button>
      {open && (
        <Dialog
          onEscape={() => {
            onEscape()
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

describe("useModalFocus", () => {
  it("moves focus into the dialog on open", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Opener" }))
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus()
  })

  it("wraps Tab from the last enabled control to the first and Shift+Tab back, skipping disabled controls", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Opener" }))

    await user.tab()
    expect(screen.getByRole("button", { name: "Middle" })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus()
  })

  it("pulls focus back into the dialog when it lands outside", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Opener" }))

    screen.getByRole("button", { name: "Outside" }).focus()
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus()
  })

  it("Escape calls the handler and focus returns to the opener once the dialog unmounts", async () => {
    const user = userEvent.setup()
    const onEscape = vi.fn()
    render(<Harness onEscape={onEscape} />)
    await user.click(screen.getByRole("button", { name: "Opener" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus()
  })
})
