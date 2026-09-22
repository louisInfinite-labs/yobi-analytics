import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { DailyVideoStat } from "../../../entities/creator/model/domain"
import { RankingCard } from "./RankingCard"

const STATS: DailyVideoStat[] = [
  {
    date: "2026-09-02",
    videoId: "video-1",
    channelId: "channel-1",
    channelName: "Gawr Gura",
    organization: "hololive",
    branch: "holo_en",
    groupKey: ["Myth"],
    channelType: "member",
    lifecycleStage: "active",
    videoTitle: "3D Live Concert Details",
    publishedAt: "2026-09-01T00:00:00Z",
    totalViews: 1_000_000,
    dailyIncrease: 20_000,
    growthPercent: 2,
    sevenDayAverage: 10_000,
    collectedAt: "2026-09-02T00:00:00Z",
    status: "ok",
    contentTags: [],
    contentFormat: "normal_video",
  },
]

describe("RankingCard", () => {
  it("shows the creator with each ranked video in every ranking mode", () => {
    render(<RankingCard stats={STATS} />)

    expect(screen.getByText("3D Live Concert Details")).toBeInTheDocument()
    expect(screen.getByText("Gawr Gura")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Most Viewed" }))
    expect(screen.getByText("Gawr Gura")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Fastest Growing" }))
    expect(screen.getByText("Gawr Gura")).toBeInTheDocument()
  })
})
