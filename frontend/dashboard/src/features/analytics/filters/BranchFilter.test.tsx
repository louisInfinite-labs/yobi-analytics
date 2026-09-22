import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { BranchFilter } from "./BranchFilter"

describe("BranchFilter", () => {
  it("keeps All first and sorts branch labels A-Z", () => {
    render(
      <BranchFilter
        value={null}
        options={["vspo_jp", "holo_jp", "holo_en", "holo_id", "vspo_en"]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByRole("radio").map((option) => option.parentElement?.textContent)).toEqual([
      "All",
      "Hololive EN",
      "Hololive ID",
      "Hololive JP",
      "VSPO EN",
      "VSPO JP",
    ])
  })
})
