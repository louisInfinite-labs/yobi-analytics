import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MemberThemeProvider } from "../../../../shared/theme/MemberThemeProvider"
import { ALL_WIDGET_TYPES, getWidgetDefinition, maxCreatorScopeCount, renderWidget, supportsCreatorScope } from "./widgetRegistry"

describe("widgetRegistry", () => {
  it("registers exactly the two R9 ranking-product widget types", () => {
    expect(ALL_WIDGET_TYPES.sort()).toEqual(["creator-video-ranking", "subscriber-leaderboard"].sort())
  })

  it.each(ALL_WIDGET_TYPES)("%s has a complete, non-empty definition", (type) => {
    const definition = getWidgetDefinition(type)
    expect(definition.type).toBe(type)
    expect(definition.title.length).toBeGreaterThan(0)
    expect(definition.description.length).toBeGreaterThan(0)
    expect(definition.sizeLimits.minW).toBeGreaterThan(0)
    expect(definition.sizeLimits.minH).toBeGreaterThan(0)
  })

  it("subscriber-leaderboard does not support creator scope: it is org-scoped, not creator-scoped", () => {
    expect(supportsCreatorScope("subscriber-leaderboard")).toBe(false)
    expect(maxCreatorScopeCount("subscriber-leaderboard")).toBe(0)
  })

  it("creator-video-ranking supports creator scope, capped at exactly one creator", () => {
    expect(supportsCreatorScope("creator-video-ranking")).toBe(true)
    expect(maxCreatorScopeCount("creator-video-ranking")).toBe(1)
  })

  it("creator-video-ranking renders an unconfigured empty state when given no creatorId, without crashing", () => {
    expect(() =>
      render(<MemberThemeProvider>{renderWidget("creator-video-ranking", { creatorId: null })}</MemberThemeProvider>),
    ).not.toThrow()
  })

  describe("GAP-2D: allowedHeights (canonical 0.5X/1X capability)", () => {
    it.each([
      ["subscriber-leaderboard", [1]],
      ["creator-video-ranking", [0.5, 1]],
    ] as const)("%s advertises exactly %j", (type, expected) => {
      expect(getWidgetDefinition(type).allowedHeights).toEqual(expected)
    })
  })
})
