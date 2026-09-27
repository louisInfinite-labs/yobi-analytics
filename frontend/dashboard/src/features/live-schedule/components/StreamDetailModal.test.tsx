import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { StreamDetailModal } from "./StreamDetailModal"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { ORGANIZATION_LABELS } from "../../../entities/creator/model/domain"
import type { ScheduledStream } from "../model/scheduledStream"

const creator = mockCreators.find((candidate) => candidate.kana)!
const stream: ScheduledStream = {
  id: "s1",
  channelId: creator.channelId,
  videoId: "v1",
  title: "Apex ranked grind",
  description: "unique-description-text Come hang out!",
  status: "upcoming",
  scheduledStartMs: 0,
  topics: ["unique-topic-chip"],
}

beforeEach(() => {
  localStorage.setItem("yobi.locale", "en")
})

describe("StreamDetailModal", () => {
  it("shows the creator name and stream title", () => {
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} />)
    expect(screen.getByText(creator.channelName)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Apex ranked grind" })).toBeInTheDocument()
  })

  it("does not render the kana reading, organization tag, description, or topic chip", () => {
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} />)
    expect(screen.queryByText(creator.kana!)).not.toBeInTheDocument()
    expect(screen.queryByText(ORGANIZATION_LABELS[creator.organization])).not.toBeInTheDocument()
    expect(screen.queryByText(/unique-description-text/)).not.toBeInTheDocument()
    expect(screen.queryByText("unique-topic-chip")).not.toBeInTheDocument()
  })

  it("keeps the reminder and open-stream actions", () => {
    render(<StreamDetailModal stream={stream} locale="en" now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} />)
    expect(screen.getAllByRole("button").filter((button) => button.classList.contains("reminder-button") || button.classList.contains("open-stream-button"))).toHaveLength(2)
  })

  it.each([
    ["en", "No thumbnail"],
    ["zh-TW", "沒有縮圖"],
    ["ja", "サムネイルなし"],
  ] as const)("localizes the thumbnail fallback for %s", (locale, expected) => {
    render(<StreamDetailModal stream={stream} locale={locale} now={new Date(0)} onClose={() => {}} onOpenStream={() => {}} />)

    fireEvent.error(document.querySelector(".stream-detail-thumbnail")!)

    expect(document.querySelector(".schedule-thumbnail-placeholder")).toHaveTextContent(expected)
    if (locale !== "en") expect(screen.queryByText("No thumbnail")).not.toBeInTheDocument()
  })
})
