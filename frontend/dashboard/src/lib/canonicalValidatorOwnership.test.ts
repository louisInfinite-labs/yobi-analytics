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
    expect(definitions).toEqual(["/src/lib/dashboardLayoutValidation.ts"])
  })

  it("only the validator module creates identity, grid, width, bounds, overlap and fill errors", () => {
    const codes = /code:\s*"(?:DUPLICATE_WIDGET_ID|WIDGET_OVERLAP|OUT_OF_BOUNDS|INVALID_GRID_SIZE|INVALID_WIDTH|INCOMPLETE_COLUMN)"/
    const creators = production.filter(([, text]) => codes.test(text)).map(([file]) => file)
    expect(creators).toEqual(["/src/lib/dashboardLayoutValidation.ts"])
  })

  it("the only other error creator is the per-widget-type height capability, always composed after validateLayout", () => {
    const creators = production.filter(([, text]) => /code:\s*"INVALID_HEIGHT"/.test(text)).map(([file]) => file)
    expect(creators).toEqual(["/src/lib/dashboardLayoutValidation.ts", "/src/lib/dashboardWidgetActions.ts"])
    expect(source("/src/lib/dashboardWidgetActions.ts")).toMatch(/const result = validateLayout\(candidate\)\s*\n\s*const extra = capabilityErrors\(candidate\.widgets\)/)
  })

  it.each([
    ["add / drag / resize / remove", "/src/lib/dashboardWidgetActions.ts"],
    ["insertion preview and Add insertion", "/src/lib/dashboardInsertionPreview.ts"],
    ["editor draft validity and insertion preview", "/src/hooks/useDashboardEditor.ts"],
    ["save", "/src/lib/dashboardLayoutSave.ts"],
    ["load and legacy conversion", "/src/lib/dashboardCanonicalLayoutStore.ts"],
    ["Flow 2 mapping", "/src/lib/dashboardComparisonMapping.ts"],
    ["legacy migration", "/src/lib/dashboardLayoutMigration.ts"],
  ])("%s calls the canonical validateLayout", (_path, file) => {
    expect(importsValidator(file)).toBe(true)
    expect(callsValidator(file)).toBe(true)
  })

  it("drag and resize reach validateLayout only through the editor: DashboardGrid -> handleCommitGeometry -> updateDraftWidget -> updateWidgetGeometry -> validateCandidate", () => {
    expect(source("/src/components/DashboardGrid.tsx")).toMatch(/onCommitGeometryRef\.current\(/)
    expect(source("/src/components/DashboardPage.tsx")).toMatch(/onCommitGeometry=\{handleCommitGeometry\}/)
    expect(source("/src/components/DashboardPage.tsx")).toMatch(/handleCommitGeometry[\s\S]{0,200}updateDraftWidget\(widgetId, patch\)/)
    expect(source("/src/hooks/useDashboardEditor.ts")).toMatch(/updateWidgetGeometry\(draftLayout, widgetId, patch\)/)
    expect(source("/src/lib/dashboardWidgetActions.ts")).toMatch(/function validateCandidate[\s\S]{0,400}validateLayout\(candidate\)/)
    expect(source("/src/lib/dashboardWidgetActions.ts")).toMatch(/export function updateWidgetGeometry[\s\S]{0,800}validateCandidate\(/)
  })

  it("the production widget renderer keys every widget by widgetId (GridStack node id = widgetId, portal key = instanceId)", () => {
    const grid = source("/src/components/DashboardGrid.tsx")
    const portals = grid.match(/createPortal\(/g) ?? []
    const keyed = grid.match(/widget\.instanceId,\s*\)/g) ?? []
    expect(portals.length).toBeGreaterThan(0)
    expect(keyed).toHaveLength(portals.length)
    expect(source("/src/lib/dashboardGridProjection.ts")).toMatch(/instanceId:\s*node\.id/)
    expect(source("/src/lib/gridStackGeometryAdapter.ts")).toMatch(/id:\s*widget\.widgetId/)
  })

  it("the GridStack views contain no second validator: they never define or import validateLayout", () => {
    for (const file of ["/src/components/DashboardGrid.tsx", "/src/lib/gridStackGeometryAdapter.ts"]) {
      expect(importsValidator(file), file).toBe(false)
      expect(callsValidator(file), file).toBe(false)
    }
  })
})
