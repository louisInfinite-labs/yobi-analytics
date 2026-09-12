import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { OshiSwitchConfirmDialog } from "./OshiSwitchConfirmDialog"

describe("OshiSwitchConfirmDialog", () => {
  it("renders the localized confirm message with the creator name substituted", () => {
    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="en" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText('Switch your Oshi to "藍沢エマ"?')).toBeInTheDocument()
  })

  it("renders in zh-TW and ja too", () => {
    const { rerender } = render(
      <OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="zh-TW" onCancel={vi.fn()} onConfirm={vi.fn()} />,
    )
    expect(screen.getByText("要將推し切換為「藍沢エマ」嗎？")).toBeInTheDocument()

    rerender(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="ja" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText("「藍沢エマ」に推しを切り替えますか？")).toBeInTheDocument()
  })

  it("Cancel closes without confirming, even when the checkbox was checked first", async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="en" onCancel={onCancel} onConfirm={onConfirm} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("Switch confirms with dontAskAgain=false when the checkbox is left unchecked", async () => {
    const onConfirm = vi.fn()
    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="en" onCancel={vi.fn()} onConfirm={onConfirm} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Switch" }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it("Switch confirms with dontAskAgain=true when the checkbox is checked", async () => {
    const onConfirm = vi.fn()
    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="en" onCancel={vi.fn()} onConfirm={onConfirm} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Switch" }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it("Escape cancels", async () => {
    const onCancel = vi.fn()
    render(<OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="en" onCancel={onCancel} onConfirm={vi.fn()} />)
    const user = userEvent.setup()
    await user.keyboard("{Escape}")
    expect(onCancel).toHaveBeenCalled()
  })

  it("backdrop click cancels, but a click inside the panel does not", async () => {
    const onCancel = vi.fn()
    const { container } = render(
      <OshiSwitchConfirmDialog creatorName="藍沢エマ" locale="en" onCancel={onCancel} onConfirm={vi.fn()} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('Switch your Oshi to "藍沢エマ"?'))
    expect(onCancel).not.toHaveBeenCalled()

    const backdrop = container.querySelector(".oshi-switch-confirm__backdrop")!
    await user.click(backdrop)
    expect(onCancel).toHaveBeenCalled()
  })
})
