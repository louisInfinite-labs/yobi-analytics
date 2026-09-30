import { describe, expect, it } from "vitest"
import { describeCreatorDrop, dropCreatorsOntoWidget } from "./dashboardCreatorDrop"
import type { CanonicalLayout } from "../../editor/model/dashboardLayout"

describe("ordinary chart creator scope", () => {
  const scopedLayout: CanonicalLayout = {
    grid: { columns: 2, rows: 1 },
    widgets: [
      { widgetId: "video-ranking", widgetType: "creator-video-ranking", x: 0, y: 0, width: 1, height: 1 },
      { widgetId: "leaderboard", widgetType: "subscriber-leaderboard", x: 1, y: 0, width: 1, height: 1 },
    ],
  }

  it("stores a single creator on a compatible target, deduplicated", () => {
    const result = dropCreatorsOntoWidget(scopedLayout, "video-ranking", ["creator-a", "creator-a"])
    expect(result.widgets[0].creatorScope?.creatorIds).toEqual(["creator-a"])
    expect(result.widgets[1]).toBe(scopedLayout.widgets[1])
  })

  it("replaces an existing chart scope without changing its geometry", () => {
    const initial: CanonicalLayout = {
      ...scopedLayout,
      widgets: [{ ...scopedLayout.widgets[0], creatorScope: { creatorIds: ["creator-a"] } }, scopedLayout.widgets[1]],
    }
    const result = dropCreatorsOntoWidget(initial, "video-ranking", ["creator-c"])
    expect(result.widgets[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1, creatorScope: { creatorIds: ["creator-c"] } })
  })

  it("R9's product invariant: rejects dropping more than one creator onto creator-video-ranking, leaving it unchanged", () => {
    const result = dropCreatorsOntoWidget(scopedLayout, "video-ranking", ["creator-a", "creator-b"])
    expect(result).toBe(scopedLayout)
    expect(describeCreatorDrop(scopedLayout, "video-ranking", 2)).toEqual({ status: "too_many_creators", max: 1 })
  })

  it("rejects unsupported subscriber-leaderboard widgets (org-scoped, not creator-scoped) and reports compatibility", () => {
    expect(dropCreatorsOntoWidget(scopedLayout, "leaderboard", ["creator-a"])).toBe(scopedLayout)
    expect(describeCreatorDrop(scopedLayout, "video-ranking")).toEqual({ status: "accepted" })
    expect(describeCreatorDrop(scopedLayout, "leaderboard")).toEqual({ status: "incompatible" })
  })

  it("classifies an unknown widgetId as missing", () => {
    expect(describeCreatorDrop(scopedLayout, "nope")).toEqual({ status: "missing" })
  })
})
