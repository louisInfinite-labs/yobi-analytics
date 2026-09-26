import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { LiveSchedulePage } from "./LiveSchedulePage"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("LiveSchedulePage", () => {
  it("renders the page title, toolbar, and one column per day of the week", () => {
    const { container } = render(<LiveSchedulePage />)

    expect(screen.getByText("Live Schedule")).toBeInTheDocument()
    expect(screen.getByText("Time")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Previous week" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next week" })).toBeInTheDocument()
    expect(container.querySelectorAll(".day-column")).toHaveLength(7)
  })

  it("renders the filter toolbar control as disabled (not wired to real behavior yet), with no manual timezone control", () => {
    render(<LiveSchedulePage />)

    expect(screen.getByText("Filter").closest("button")).toBeDisabled()
    expect(screen.queryByText("JST")).not.toBeInTheDocument()
  })
})
