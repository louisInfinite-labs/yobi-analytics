import { test, expect } from "@playwright/test"

/** GAP-2F "Production Catalog-Driven Canonical Add Widget UI" browser
 * evidence: the real production `/dashboard` route (App.tsx's own routing,
 * not an isolated harness -- this task is specifically about the
 * production Add UI), the real mock chart catalog
 * (dashboardChartCatalogSource.ts's fixed four-item list), and the real
 * `localStorage`-backed canonical layout store
 * (dashboardCanonicalLayoutStore.ts). Every test starts from a clean
 * `localStorage` (Playwright gives each test its own browser context), so
 * the Dashboard always starts from the product-defined 2x2 default layout
 * (kpi-summary, growth-bar-chart, contribution-ring, ranking).
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/dashboard")
  await expect(page.getByText("Daily Gain")).toBeVisible()
  await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
})

test("catalog-driven options: catalog-returned charts are offered; a registered-but-not-returned chart is not (AC1-AC4)", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Layout" }).click()
  const tray = page.locator(".widget-tray")

  await expect(tray.getByRole("button", { name: /KPI Summary/ })).toBeVisible()
  await expect(tray.getByRole("button", { name: /Growth Bar Chart/ })).toBeVisible()
  await expect(tray.getByRole("button", { name: /Channel Contribution/ })).toBeVisible()
  await expect(tray.getByRole("button", { name: /Rankings/ })).toBeVisible()
  await expect(tray.getByRole("button", { name: /^Insights/ })).toHaveCount(0)
  await expect(tray.getByRole("button", { name: /Video Stats Table/ })).toHaveCount(0)
  await expect(tray.getByRole("button")).toHaveCount(4)
})

test("explicit-slot add: selecting a chart alone does not place it; a chosen slot commits exactly one widget (AC8-AC10)", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Layout" }).click()
  const removeKpi = page.getByRole("button", { name: /Remove KPI Summary/ })
  await expect(removeKpi).toHaveCount(1)

  await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
  await expect(removeKpi).toHaveCount(1) // AC8: still not placed
  await expect(page.getByTestId("widget-insertion-slots")).toBeVisible()

  const row0 = page.getByTestId("widget-insertion-row-0")
  await row0.getByRole("button").first().click() // AC9: an explicit slot (GAP-7: previews it)
  await expect(removeKpi).toHaveCount(1) // the preview alone still changes no draft
  await page.getByRole("button", { name: "Insert here" }).click() // commits

  await expect(removeKpi).toHaveCount(2) // AC10: exactly one new widget, in the draft
  await expect(page.getByTestId("widget-insertion-slots")).toHaveCount(0)
})

test("invalid slot: growing a row past the 3-column grid maximum is rejected with no state change (AC11)", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Layout" }).click()
  const tray = page.locator(".widget-tray")
  const row0 = () => page.getByTestId("widget-insertion-row-0")

  // Row 0 starts with 2 widgets (kpi-summary, growth-bar-chart); grow it to
  // the canonical maximum of 3 by inserting at the start.
  await tray.getByRole("button", { name: /KPI Summary/ }).click()
  await row0().getByRole("button").first().click()
  await page.getByRole("button", { name: "Insert here" }).click()
  await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)
  const totalBefore = await page.getByRole("button", { name: /^Remove /i }).count()

  // A 4th widget in the same row would need a 4th column -- outside the
  // canonical 1x1-3x3 range.
  await tray.getByRole("button", { name: /KPI Summary/ }).click()
  await row0().getByRole("button").first().click()

  await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
  await expect(page.getByRole("button", { name: /^Remove /i })).toHaveCount(totalBefore)
  // Rejection keeps the picker open so the user can pick a different target.
  await expect(page.getByTestId("widget-insertion-slots")).toBeVisible()
})

test("cancel: an inserted widget disappears and the exact pre-edit canonical state returns (AC17)", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Layout" }).click()
  await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
  await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
  await page.getByRole("button", { name: "Insert here" }).click()
  await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)

  await page.getByRole("button", { name: "Cancel" }).click()
  // View mode renders no Remove buttons at all -- back to Edit to compare counts.
  await expect(page.getByRole("button", { name: /Remove /i })).toHaveCount(0)
  await page.getByRole("button", { name: "Edit Layout" }).click()
  await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(1)
})

test("save: an inserted widget survives the canonical save/reload boundary (AC18)", async ({ page }) => {
  await page.getByRole("button", { name: "Edit Layout" }).click()
  await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
  // Append at the end of the row (rather than the start) so no existing
  // widget's geometry changes -- this keeps MT-09's grid-change-confirmation
  // dialog (a separate, already-covered flow) out of this save/reload proof.
  await page.getByTestId("widget-insertion-row-0").getByRole("button").last().click()
  await page.getByRole("button", { name: "Insert here" }).click()
  await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)

  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("button", { name: "Edit Layout" })).toBeVisible()

  await page.reload()
  // Two KPI Summary widgets are now present (the point of this test), so
  // "Daily Gain" resolves twice -- wait on something unambiguous instead.
  await expect(page.getByRole("button", { name: "Edit Layout" })).toBeVisible()
  await page.getByRole("button", { name: "Edit Layout" }).click()
  await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)
})
