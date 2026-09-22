import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ContributionBarChart } from "./ContributionBarChart"

describe("ContributionBarChart", () => {
  it("shows every member with an explicit percentage", () => {
    render(
      <ContributionBarChart
        period="1d"
        contributions={[
          { channelId: "a", channelName: "Ema", dailyIncrease: 70, percent: 70 },
          { channelId: "b", channelName: "Gura", dailyIncrease: 20, percent: 20 },
          { channelId: "c", channelName: "Pekora", dailyIncrease: 10, percent: 10 },
        ]}
      />,
    )

    expect(screen.getByText("Ema")).toBeInTheDocument()
    expect(screen.getByText("Gura")).toBeInTheDocument()
    expect(screen.getByText("Pekora")).toBeInTheDocument()
    expect(screen.getByText("70.0%")).toBeInTheDocument()
    expect(screen.getByText("20.0%")).toBeInTheDocument()
    expect(screen.getByText("10.0%")).toBeInTheDocument()
  })
})
