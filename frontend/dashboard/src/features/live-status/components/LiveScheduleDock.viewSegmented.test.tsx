import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LiveScheduleDock } from "./LiveScheduleDock"
import * as useCurrentPageModule from "../../../app/navigation/useCurrentPage"
import * as useCreatorStatusesModule from "../hooks/useCreatorStatuses"

vi.mock("../../../app/navigation/useCurrentPage")
vi.mock("../hooks/useCreatorStatuses", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useCreatorStatuses")>("../hooks/useCreatorStatuses")
  return { ...actual, useCreatorStatuses: vi.fn() }
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem("yobi.locale", "en")
  vi.mocked(useCurrentPageModule.useCurrentPage).mockReturnValue(["home", vi.fn()])
  vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses: {}, now: new Date("2026-09-10T12:00:00+09:00") })
})

async function openDock() {
  const user = userEvent.setup()
  await user.click(document.querySelector(".live-status-trigger") as HTMLElement)
  return user
}

describe("Live Status ALL / Favorites selector (rendered through the shared HomeFilterSegmented)", () => {
  it("keeps exactly its own markup: the live-status layout classes plus the shared Home filter skin, two segments, ALL selected", async () => {
    render(<LiveScheduleDock />)
    await openDock()

    const root = document.querySelector(".live-status-filter-row .ant-segmented") as HTMLElement
    expect(root).toBeInTheDocument()
    expect(root).toHaveClass("live-status-view-segmented", "home-filter-segmented")
    expect(root.querySelectorAll(".ant-segmented-item")).toHaveLength(2)
    for (const label of root.querySelectorAll(".ant-segmented-item-label")) {
      expect(label).toHaveClass("live-status-view-segment-label", "home-filter-segment-label")
    }
    expect(root.querySelector(".ant-segmented-item-selected")).toHaveTextContent("ALL")
  })

  it("still switches between ALL and Favorites", async () => {
    render(<LiveScheduleDock />)
    const user = await openDock()

    const items = document.querySelectorAll<HTMLElement>(".live-status-filter-row .ant-segmented-item")
    await user.click(items[1])
    expect(document.querySelector(".live-status-filter-row .ant-segmented-item-selected")).toHaveTextContent(/favorites/i)
    await user.click(items[0])
    expect(document.querySelector(".live-status-filter-row .ant-segmented-item-selected")).toHaveTextContent("ALL")
  })
})
