import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TimeZoneSelector } from "./TimeZoneSelector"

describe("TimeZoneSelector", () => {
  it("commits a full valid IANA zone name as the user finishes typing it", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimeZoneSelector value="UTC" onChange={onChange} />)

    const input = screen.getByLabelText("Reporting time zone")
    await user.clear(input)
    await user.type(input, "Europe/London")

    expect(onChange).toHaveBeenLastCalledWith("Europe/London")
  })

  it("never commits a raw numeric UTC offset, even though Intl.DateTimeFormat accepts it as a timeZone value", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimeZoneSelector value="UTC" onChange={onChange} />)

    const input = screen.getByLabelText("Reporting time zone")
    await user.clear(input)
    await user.type(input, "+09:00")

    expect(onChange).not.toHaveBeenCalled()
  })

  it("reverts the input to the last committed zone on blur after an unrecognized value", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TimeZoneSelector value="Asia/Tokyo" onChange={onChange} />)

    const input = screen.getByLabelText("Reporting time zone") as HTMLInputElement
    await user.clear(input)
    await user.type(input, "Not/A_Real_Zone")
    await user.tab()

    expect(input.value).toBe("Asia/Tokyo")
    expect(onChange).not.toHaveBeenCalled()
  })
})
