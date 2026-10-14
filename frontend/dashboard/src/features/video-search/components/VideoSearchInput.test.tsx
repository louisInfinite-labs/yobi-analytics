import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { VideoSearchInput } from "./VideoSearchInput"

describe("VideoSearchInput -- IME composition and Enter", () => {
  it("fires onCompositionStart/onCompositionEnd on native composition events", () => {
    const onCompositionStart = vi.fn()
    const onCompositionEnd = vi.fn()
    render(<VideoSearchInput value="" onChange={vi.fn()} locale="en" onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />)
    const input = screen.getByRole("searchbox")
    fireEvent.compositionStart(input)
    expect(onCompositionStart).toHaveBeenCalledTimes(1)
    fireEvent.compositionEnd(input)
    expect(onCompositionEnd).toHaveBeenCalledTimes(1)
  })

  it("calls onSubmit on a plain Enter keydown", () => {
    const onSubmit = vi.fn()
    render(<VideoSearchInput value="abc" onChange={vi.fn()} locale="en" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("does NOT call onSubmit for the Enter that confirms an IME candidate", () => {
    const onSubmit = vi.fn()
    render(<VideoSearchInput value="もんはん" onChange={vi.fn()} locale="en" onSubmit={onSubmit} />)
    // isComposing on the native event is what jsdom/browsers set while an IME candidate list is open.
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter", isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("ignores a non-Enter key", () => {
    const onSubmit = vi.fn()
    render(<VideoSearchInput value="abc" onChange={vi.fn()} locale="en" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "a" })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe("VideoSearchInput -- clear button", () => {
  it("shows no clear button for an empty value with no onClear handler", () => {
    render(<VideoSearchInput value="" onChange={vi.fn()} locale="en" />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("clicking clear with no onClear handler calls onChange('')", () => {
    const onChange = vi.fn()
    render(<VideoSearchInput value="abc" onChange={onChange} locale="en" />)
    fireEvent.click(screen.getByRole("button"))
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("clicking clear with an onClear handler calls that instead of onChange", () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    render(<VideoSearchInput value="abc" onChange={onChange} locale="en" onClear={onClear} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows the clear button for an empty value when onClear is provided (collapse-when-empty support)", () => {
    render(<VideoSearchInput value="" onChange={vi.fn()} locale="en" onClear={vi.fn()} />)
    expect(screen.getByRole("button")).toBeInTheDocument()
  })
})
