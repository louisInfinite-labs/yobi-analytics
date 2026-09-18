import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { CreatorComparisonPicker } from "./CreatorComparisonPicker"
import { groupCreatorsForDock } from "../lib/dockCreatorOrder"
import { mockCreators } from "../data/mockCreators"
import type { MockCreator } from "../data/mockCreators"

const CREATORS: MockCreator[] = [
  { channelId: "creator-a", channelName: "A", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
  { channelId: "creator-b", channelName: "B", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
  { channelId: "creator-c", channelName: "C", organization: "vspo", branch: "vspo_en", groupKey: ["NO"], channelType: "member", lifecycleStage: "active" },
]

describe("CreatorComparisonPicker", () => {
  it("MT-11 AC2: opens as a dialog exposing the injected Creator List's creators", () => {
    render(<CreatorComparisonPicker creators={CREATORS} initialSelectedIds={[]} onCancel={vi.fn()} onApply={vi.fn()} />)

    expect(screen.getByRole("dialog", { name: "Select Creators" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "B" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "C" })).toBeInTheDocument()
  })

  it("AC2 correction: reuses the real production Creator List's own data (mockCreators), order (groupCreatorsForDock), and search (creatorMatchesSearch) rather than a separate fabricated list", () => {
    render(<CreatorComparisonPicker creators={mockCreators} initialSelectedIds={[]} onCancel={vi.fn()} onApply={vi.fn()} />)

    // Same array, same functions CreatorStatusList itself uses -- so the
    // rendered order is provably identical to groupCreatorsForDock's own output.
    const expectedOrder = groupCreatorsForDock(mockCreators).flatMap((g) => g.creators.map((c) => c.channelName))
    const renderedOrder = within(screen.getByRole("list")).getAllByRole("button").map((btn) => btn.getAttribute("aria-label"))
    expect(renderedOrder).toEqual(expectedOrder)

    // Selecting by the real creator's own channelId (no fabricated id).
    fireEvent.click(screen.getByRole("button", { name: mockCreators[0].channelName }))
    expect(screen.getByLabelText("Comparison order 1")).toBeInTheDocument()
  })

  it("MT-11 AC3: existing creatorIds appear selected with order 1 and 2", () => {
    render(
      <CreatorComparisonPicker creators={CREATORS} initialSelectedIds={["creator-a", "creator-b"]} onCancel={vi.fn()} onApply={vi.fn()} />,
    )

    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "C" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByLabelText("Comparison order 1")).toBeInTheDocument()
    expect(screen.getByLabelText("Comparison order 2")).toBeInTheDocument()
  })

  it("MT-11 AC5: clicking C after A/B are preselected orders it third and calls onApply with A, B, C", () => {
    const onApply = vi.fn()
    render(
      <CreatorComparisonPicker
        creators={CREATORS}
        initialSelectedIds={["creator-a", "creator-b"]}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "C" }))
    expect(screen.getByLabelText("Comparison order 3")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    expect(onApply).toHaveBeenCalledWith(["creator-a", "creator-b", "creator-c"])
  })

  it("MT-11 AC6: Cancel calls onCancel without ever calling onApply", () => {
    const onApply = vi.fn()
    const onCancel = vi.fn()
    render(
      <CreatorComparisonPicker creators={CREATORS} initialSelectedIds={["creator-a", "creator-b"]} onCancel={onCancel} onApply={onApply} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "C" })) // change local selection
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it("reuses the existing Creator List's own search semantics (creatorMatchesSearch) -- filtering does not remove an already-selected creator", () => {
    render(
      <CreatorComparisonPicker creators={CREATORS} initialSelectedIds={["creator-a", "creator-b"]} onCancel={vi.fn()} onApply={vi.fn()} />,
    )

    fireEvent.change(screen.getByRole("searchbox", { name: "Search creators" }), { target: { value: "C" } })
    // A and B are filtered out of the visible list, but their selection state is untouched.
    expect(screen.queryByRole("button", { name: "A" })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole("searchbox", { name: "Search creators" }), { target: { value: "" } })
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "B" })).toHaveAttribute("aria-pressed", "true")
  })

  it("MT-10 canCompare guard: Apply is disabled below two selected creators", () => {
    render(<CreatorComparisonPicker creators={CREATORS} initialSelectedIds={["creator-a"]} onCancel={vi.fn()} onApply={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled()
  })
})
