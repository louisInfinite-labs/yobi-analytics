import { test, expect, type Locator, type Page } from "@playwright/test"

/** MT-16 AC7 correction: real visible-focus browser evidence against the
 * actual rendered Dashboard (`canonical-dashboard-harness.html`). Every
 * assertion below reads real computed CSS (`getComputedStyle` inside the
 * page) captured before and after a real keyboard-driven focus move, and
 * asserts they differ -- never `document.activeElement` alone, never
 * "is a <button>," never "has tabIndex," never "a :focus-visible rule
 * exists in the source."
 *
 * Controls covered (every keyboard-focusable editor action this component
 * actually renders across its workflow -- verified against
 * `EditModeToolbar.tsx` and `DashboardCanonicalEditor.tsx`'s own JSX, not
 * assumed): "Edit Layout" (view mode), "Restore Default", "Cancel", "Save"
 * (all three from the edit-mode toolbar, MT-07 AC3), a widget's own
 * keyboard move/resize box (MT-16 AC6), and "Select Creators" (MT-11 Flow
 * 1) -- the last one only renders for a comparison-capable widget with a
 * `comparisonCreators` prop supplied, which `canonical-dashboard-harness.html`
 * deliberately doesn't have (its fixture is AC3's breakpoint-geometry
 * fixture and isn't touched here); its own test uses a second, separate
 * harness page instead (`canonical-dashboard-comparison-harness.html` /
 * `e2e/harness/mount-comparison.tsx`) built only to render that one
 * condition. `GridChangeConfirmationDialog`'s own Cancel/Continue-and-Save
 * are a different, dialog-scoped control set already covered under AC9
 * (jsdom); out of scope for this AC7-only correction. The canonical
 * Add-widget UI (GAP-2, unresolved per the tasks document) does not exist
 * in this codebase and is not tested here.
 */

interface FocusStyleSnapshot {
  outlineWidth: string
  outlineStyle: string
  outlineColor: string
  boxShadow: string
}

async function readFocusStyle(locator: Locator): Promise<FocusStyleSnapshot> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el)
    return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineColor: s.outlineColor, boxShadow: s.boxShadow }
  })
}

/** True only when the snapshot represents a *rendered, visible* focus
 * indicator -- a non-"none" outline style with a positive width, or a real
 * (non-"none") box-shadow. Two snapshots merely being unequal isn't
 * enough on its own (a color-only outline change could in principle still
 * be invisible at 0 width); this checks the "after" snapshot actually
 * paints something. */
function isVisibleFocusIndicator(snapshot: FocusStyleSnapshot): boolean {
  const hasOutline = snapshot.outlineStyle !== "none" && parseFloat(snapshot.outlineWidth) > 0
  const hasBoxShadow = snapshot.boxShadow !== "none" && snapshot.boxShadow.trim().length > 0
  return hasOutline || hasBoxShadow
}

async function gotoHarness(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/canonical-dashboard-harness.html")
}

/** Real keyboard navigation (repeated `Tab`), never `locator.focus()` --
 * "reach it through keyboard navigation where practical" (AC7 correction
 * requirement 1). Stops as soon as the target locator is the focused
 * element; fails loudly if it's never reached. */
async function tabUntilFocused(page: Page, target: Locator, maxSteps = 10) {
  for (let i = 0; i < maxSteps; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return
    await page.keyboard.press("Tab")
  }
  await expect(target).toBeFocused() // fails with a clear Playwright error if still not reached
}

/** Requirements 2-4: reaches `target` by keyboard, confirms it is focused,
 * and proves the focused computed style is both different from the
 * unfocused snapshot and actually visible (never `document.activeElement`
 * alone). */
async function assertControlHasVisibleFocus(page: Page, target: Locator) {
  const before = await readFocusStyle(target)
  await tabUntilFocused(page, target)
  await expect(target).toBeFocused()
  const after = await readFocusStyle(target)

  expect(after).not.toEqual(before)
  expect(isVisibleFocusIndicator(after)).toBe(true)
}

test("MT-16 AC7: Edit Layout (view mode) shows a real, rendered visible-focus change", async ({ page }) => {
  await gotoHarness(page)
  await assertControlHasVisibleFocus(page, page.getByRole("button", { name: "Edit Layout" }))
})

test("MT-16 AC7: Restore Default (edit-mode toolbar, MT-07) shows a real, rendered visible-focus change", async ({ page }) => {
  await gotoHarness(page)
  await tabUntilFocused(page, page.getByRole("button", { name: "Edit Layout" }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("toolbar", { name: "Layout editing" })).toBeVisible()

  await assertControlHasVisibleFocus(page, page.getByRole("button", { name: "Restore Default" }))
})

test("MT-16 AC7: Cancel (edit-mode toolbar, MT-07) shows a real, rendered visible-focus change", async ({ page }) => {
  await gotoHarness(page)
  await tabUntilFocused(page, page.getByRole("button", { name: "Edit Layout" }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("toolbar", { name: "Layout editing" })).toBeVisible()

  await assertControlHasVisibleFocus(page, page.getByRole("button", { name: "Cancel" }))
})

test("MT-16 AC7: Save (edit-mode toolbar, MT-07), once enabled by a real draft change, shows a real, rendered visible-focus change", async ({ page }) => {
  await gotoHarness(page)
  await tabUntilFocused(page, page.getByRole("button", { name: "Edit Layout" }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("toolbar", { name: "Layout editing" })).toBeVisible()

  // Save starts `disabled` (no draft change yet) -- browsers skip disabled
  // controls entirely during Tab, so there is nothing to reach until one is
  // made. Activating Restore Default via the keyboard is itself real
  // keyboard interaction, not a focus-visibility shortcut: it's the
  // documented way this draft becomes dirty (Section 6.2).
  const restoreDefault = page.getByRole("button", { name: "Restore Default" })
  await tabUntilFocused(page, restoreDefault)
  await page.keyboard.press("Enter")

  const saveButton = page.getByRole("button", { name: "Save" })
  await expect(saveButton).toBeEnabled()
  await assertControlHasVisibleFocus(page, saveButton)
})

test("MT-16 AC7: a keyboard-focused widget box (MT-16 AC6's own control) shows a real, rendered visible-focus change", async ({ page }) => {
  await gotoHarness(page)
  await tabUntilFocused(page, page.getByRole("button", { name: "Edit Layout" }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("toolbar", { name: "Layout editing" })).toBeVisible()

  const widgetA = page.locator('[data-testid="canonical-widget-box"][data-widget-id="a"]')
  await assertControlHasVisibleFocus(page, widgetA)
})

test("MT-16 AC7: Select Creators (MT-11 Flow 1, conditional on a comparison-capable widget) shows a real, rendered visible-focus change", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/canonical-dashboard-comparison-harness.html")

  await tabUntilFocused(page, page.getByRole("button", { name: "Edit Layout" }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("toolbar", { name: "Layout editing" })).toBeVisible()

  const selectCreators = page.getByRole("button", { name: "Select Creators" })
  await expect(selectCreators).toBeVisible()
  await assertControlHasVisibleFocus(page, selectCreators)
})
