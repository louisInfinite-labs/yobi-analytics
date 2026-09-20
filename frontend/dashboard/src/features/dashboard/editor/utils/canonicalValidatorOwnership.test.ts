import { describe, expect, it } from "vitest"

const sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true })
const production = Object.entries(sources).filter(([file]) => !/\.test\.tsx?$/.test(file) && !file.startsWith("/src/test/") && !file.startsWith("/src/e2e/"))

const source = (file: string) => {
  const text = sources[file]
  if (text === undefined) throw new Error(`missing source ${file}`)
  return text
}
const importsValidator = (file: string) => /import\s*\{[^}]*\bvalidateLayout\b[^}]*\}\s*from\s*"[^"]*dashboardLayoutValidation"/.test(source(file))
const callsValidator = (file: string) => /\bvalidateLayout\(/.test(source(file))

describe("canonical validateLayout ownership (production sources)", () => {
  it("defines exactly one validateLayout implementation", () => {
    const definitions = production.filter(([, text]) => /(?:export\s+)?function\s+validateLayout\b|const\s+validateLayout\s*=/.test(text)).map(([file]) => file)
    expect(definitions).toEqual(["/src/features/dashboard/editor/utils/dashboardLayoutValidation.ts"])
  })

  it("only the validator module creates identity, grid, width, bounds, overlap and fill errors", () => {
    const codes = /code:\s*"(?:DUPLICATE_WIDGET_ID|WIDGET_OVERLAP|OUT_OF_BOUNDS|INVALID_GRID_SIZE|INVALID_WIDTH|INCOMPLETE_COLUMN)"/
    const creators = production.filter(([, text]) => codes.test(text)).map(([file]) => file)
    expect(creators).toEqual(["/src/features/dashboard/editor/utils/dashboardLayoutValidation.ts"])
  })

  it("the only other error creator is the per-widget-type height capability, always composed after validateLayout", () => {
    const creators = production.filter(([, text]) => /code:\s*"INVALID_HEIGHT"/.test(text)).map(([file]) => file)
    expect(creators).toEqual(["/src/features/dashboard/editor/utils/dashboardLayoutValidation.ts", "/src/features/dashboard/editor/utils/dashboardWidgetActions.ts"])
    expect(source("/src/features/dashboard/editor/utils/dashboardWidgetActions.ts")).toMatch(/const result = validateLayout\(candidate\)\s*\n\s*const extra = capabilityErrors\(candidate\.widgets\)/)
  })

  it.each([
    ["add / drag / resize / remove", "/src/features/dashboard/editor/utils/dashboardWidgetActions.ts"],
    ["insertion preview and Add insertion", "/src/features/dashboard/editor/utils/dashboardInsertionPreview.ts"],
    ["editor draft validity and insertion preview", "/src/features/dashboard/editor/hooks/useDashboardEditor.ts"],
    ["save", "/src/features/dashboard/editor/utils/dashboardLayoutSave.ts"],
    ["load and legacy conversion", "/src/features/dashboard/editor/data/dashboardCanonicalLayoutStore.ts"],
    ["Flow 2 mapping", "/src/features/dashboard/comparison/utils/dashboardComparisonMapping.ts"],
    ["legacy migration", "/src/features/dashboard/editor/utils/dashboardLayoutMigration.ts"],
  ])("%s calls the canonical validateLayout", (_path, file) => {
    expect(importsValidator(file)).toBe(true)
    expect(callsValidator(file)).toBe(true)
  })

  it("drag and resize reach validateLayout only through the editor: DashboardGrid -> handleCommitGeometry -> updateDraftWidget -> updateWidgetGeometry -> validateCandidate", () => {
    expect(source("/src/features/dashboard/editor/components/DashboardGrid.tsx")).toMatch(/onCommitGeometryRef\.current\(/)
    expect(source("/src/pages/dashboard/DashboardPage.tsx")).toMatch(/onCommitGeometry=\{handleCommitGeometry\}/)
    expect(source("/src/pages/dashboard/DashboardPage.tsx")).toMatch(/handleCommitGeometry[\s\S]{0,200}updateDraftWidget\(widgetId, patch\)/)
    expect(source("/src/features/dashboard/editor/hooks/useDashboardEditor.ts")).toMatch(/updateWidgetGeometry\(draftLayout, widgetId, patch\)/)
    expect(source("/src/features/dashboard/editor/utils/dashboardWidgetActions.ts")).toMatch(/function validateCandidate[\s\S]{0,400}validateLayout\(candidate\)/)
    expect(source("/src/features/dashboard/editor/utils/dashboardWidgetActions.ts")).toMatch(/export function updateWidgetGeometry[\s\S]{0,800}validateCandidate\(/)
  })

  it("the production widget renderer keys every widget by widgetId (GridStack node id = widgetId, portal key = instanceId)", () => {
    const grid = source("/src/features/dashboard/editor/components/DashboardGrid.tsx")
    const portals = grid.match(/createPortal\(/g) ?? []
    const keyed = grid.match(/widget\.instanceId,\s*\)/g) ?? []
    expect(portals.length).toBeGreaterThan(0)
    expect(keyed).toHaveLength(portals.length)
    expect(source("/src/features/dashboard/editor/utils/dashboardGridProjection.ts")).toMatch(/instanceId:\s*node\.id/)
    expect(source("/src/features/dashboard/editor/utils/gridStackGeometryAdapter.ts")).toMatch(/id:\s*widget\.widgetId/)
  })

  it("the GridStack views contain no second validator: they never define or import validateLayout", () => {
    for (const file of ["/src/features/dashboard/editor/components/DashboardGrid.tsx", "/src/features/dashboard/editor/utils/gridStackGeometryAdapter.ts"]) {
      expect(importsValidator(file), file).toBe(false)
      expect(callsValidator(file), file).toBe(false)
    }
  })
})
