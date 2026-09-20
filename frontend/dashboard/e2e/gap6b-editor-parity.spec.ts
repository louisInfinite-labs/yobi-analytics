import { test, expect, type Page } from "@playwright/test"

/** GAP-6B "Live Editor Visual + ARIA Parity" browser evidence, against the
 * real production `/dashboard` route (never a fixture/harness) -- the same
 * `freshDashboard`/localStorage-seeding convention `gap5b-responsive.spec.ts`
 * already established for exercising the real route from a controlled
 * starting layout.
 */

const STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"
const DESKTOP = { width: 1280, height: 900 }
// Tall enough that every widget's own resize handle sits comfortably inside
// the viewport -- GAP-5B1 already documented that a resize handle (or any
// gesture target) sitting at/near the viewport's bottom edge makes
// Playwright's pointer sequence behave inconsistently (this task's own
// investigation reproduced the same class of flake against the real
// `/dashboard` route specifically, never against the isolated GAP-4C
// harness, which renders near the top of a much shorter page).
const GESTURE_VIEWPORT = { width: 1280, height: 1100 }

// A 3-column, single-row layout with one spare cell (x=2), "kpi-a" already
// adjacent to it -- a deterministic, single-column *valid* drag target that
// never has to cross over "chart-b"'s own occupied cell.
const SPARE_CAPACITY_LAYOUT = {
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "chart-b", widgetType: "growth-bar-chart", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "kpi-a", widgetType: "kpi-summary", x: 1, y: 0, width: 1, height: 1 },
  ],
}

// A stacked 0.5X pair plus a filler, with one spare cell -- GridStack's own
// collision engine has no objection to dragging "top" into the empty cell
// (no overlap, in bounds), but the canonical validator rejects it
// (INCOMPLETE_COLUMN: "bottom" would become an unresolvable lone 0.5X
// widget), the same scenario `gap4c-pointer-wiring.spec.ts` already
// establishes as a reliable *invalid drag* (as opposed to a resize below a
// widget-type's capability floor, which GridStack's own `minH` blocks
// before any tentative geometry is ever produced at all, and so never
// reaches this feature's live preview in the first place).
const INCOMPLETE_COLUMN_LAYOUT = {
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "top", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 0.5 },
    { widgetId: "bottom", widgetType: "kpi-summary", x: 0, y: 0.5, width: 1, height: 0.5 },
    { widgetId: "filler", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
  ],
}

async function freshDashboard(page: Page, viewport: { width: number; height: number }, seedLayout?: unknown) {
  await page.setViewportSize(viewport)
  await page.goto("/dashboard")
  await page.evaluate(
    ({ key, seed }) => {
      localStorage.clear()
      if (seed) localStorage.setItem(key, JSON.stringify(seed))
    },
    { key: STORAGE_KEY, seed: seedLayout },
  )
  await page.reload()
  await expect(page.getByText("Daily Gain").first()).toBeVisible()
}

interface WidgetRect {
  id: string | null
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      const parent = el.closest("[gs-id]")
      return { id: parent?.getAttribute("gs-id") ?? null, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    })
    return items as WidgetRect[]
  })
}

function adjacentGaps(items: WidgetRect[]) {
  const gaps: number[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue
      const a = items[i]
      const b = items[j]
      const vOverlap = a.y < b.y + b.height && b.y < a.y + a.height
      const hOverlap = a.x < b.x + b.width && b.x < a.x + a.width
      if (vOverlap && b.x > a.x && b.x - a.right < 100) gaps.push(b.x - a.right)
      if (hOverlap && b.y > a.y && b.y - a.bottom < 100) gaps.push(b.y - a.bottom)
    }
  }
  return gaps
}

test.describe("GAP-6B: live editor visual + ARIA parity", () => {
  test("AC1/AC2/AC3/AC4: dashed edit guide appears only in edit mode and is geometry-neutral", async ({ page }) => {
    await freshDashboard(page, DESKTOP)

    const guidedInView = await page.locator(".widget-shell--editing").count()
    expect(guidedInView).toBe(0) // AC2 baseline: view mode has no guide

    const before = await measure(page)
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const guideCount = await page.locator(".widget-shell--editing").count()
    expect(guideCount).toBe(4) // AC1: every widget shell shows the guide
    const outlineStyle = await page.locator(".widget-shell--editing").first().evaluate((el) => getComputedStyle(el).outlineStyle)
    expect(outlineStyle).toBe("dashed")

    const after = await measure(page)
    // AC3: the toolbar's own content grows in edit mode (Reset/Cancel/Save
    // plus status text, vs. a single "Edit Layout" button in view mode),
    // which shifts the whole grid down by one uniform page-chrome offset --
    // already-confirmed benign per GAP-6A's live audit. Every widget's own
    // size and horizontal position, and the offset itself, must still be
    // byte-identical across all four widgets (i.e. relative geometry is
    // untouched by the guide).
    const beforeById = new Map(before.map((w) => [w.id, w]))
    const dys = new Set<number>()
    for (const widget of after) {
      const prior = beforeById.get(widget.id)!
      expect(widget.x).toBe(prior.x)
      expect(widget.width).toBe(prior.width)
      expect(widget.height).toBe(prior.height)
      dys.add(widget.y - prior.y)
    }
    expect(dys.size).toBe(1) // every widget shifted by the same uniform offset
    for (const gap of adjacentGaps(after)) expect(gap).toBe(16) // AC4

    await page.getByRole("button", { name: "Cancel" }).click()
    expect(await page.locator(".widget-shell--editing").count()).toBe(0) // AC2: removed on return to view mode
  })

  test("AC5/AC8/AC9/AC13: a valid drag shows a non-color valid state before drop and announces the move", async ({ page }) => {
    await freshDashboard(page, GESTURE_VIEWPORT, SPARE_CAPACITY_LAYOUT)
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const kpi = page.locator('[gs-id="kpi-a"]')
    const box = (await kpi.boundingBox())!
    // "kpi-a" starts already adjacent to the one spare column -- a single-
    // column nudge, the same magnitude/step-count `gap5b-responsive.spec.ts`'s
    // own real-drag AC13 test already uses reliably against this same route.
    await page.mouse.move(box.x + box.width / 2, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 40, box.y + 10, { steps: 10 })

    // Mid-gesture, before release: AC5/AC8 -- a non-color (border-style)
    // valid state, no aria-invalid, derived from pure canonical validation
    // (never committed -- draftLayout only advances at drop, see AC9 below).
    const midGesture = await kpi.locator(".widget-shell").evaluate((el) => ({
      outlineStyle: getComputedStyle(el).outlineStyle,
      ariaInvalid: el.getAttribute("aria-invalid"),
      classList: el.className,
    }))
    expect(midGesture.outlineStyle).toBe("solid")
    expect(midGesture.ariaInvalid).toBeNull()
    expect(midGesture.classList).toContain("widget-shell--gesture-valid")

    await page.mouse.up()
    await page.waitForTimeout(300)

    // AC9: committed through the existing GAP-4C path -- final geometry moved.
    await expect(kpi).toHaveAttribute("gs-x", "2")
    await expect(kpi).toHaveAttribute("gs-y", "0")
    // AC13: exactly one move announcement using the accepted canonical result.
    await expect(page.getByTestId("dashboard-editor-announcer")).toHaveText("KPI Summary moved to column 3, row 1.")
  })

  test("AC6/AC7/AC10/AC14/AC15: an invalid drag shows a non-color invalid state before release and announces the rollback", async ({ page }) => {
    await freshDashboard(page, GESTURE_VIEWPORT, INCOMPLETE_COLUMN_LAYOUT)
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const top = page.locator('[gs-id="top"]')
    const box = (await top.boundingBox())!
    // GridStack's own collision engine allows this (the target cell is
    // empty, in bounds) -- only the canonical validator knows dragging "top"
    // away leaves "bottom" as an unresolvable lone 0.5X widget.
    await page.mouse.move(box.x + box.width / 2, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + (box.width + 40) * 2, box.y + 10, { steps: 10 })

    // Mid-gesture, before release: AC6/AC7 -- a non-color (dashed, thicker)
    // invalid state plus a machine-readable aria-invalid flag.
    const midGesture = await top.locator(".widget-shell").evaluate((el) => ({
      outlineStyle: getComputedStyle(el).outlineStyle,
      ariaInvalid: el.getAttribute("aria-invalid"),
      classList: el.className,
    }))
    expect(midGesture.outlineStyle).toBe("dashed")
    expect(midGesture.ariaInvalid).toBe("true")
    expect(midGesture.classList).toContain("widget-shell--gesture-invalid")

    await page.mouse.up()
    await page.waitForTimeout(300)

    // AC10: rejected gesture restores the last valid canonical geometry.
    await expect(top).toHaveAttribute("gs-x", "0")
    await expect(page.locator('[gs-id="bottom"]')).toHaveAttribute("gs-x", "0")
    // AC14/AC15: exactly one rejection announcement, no false success.
    await expect(page.getByTestId("dashboard-editor-announcer")).toHaveText(
      "KPI Summary could not be placed there and returned to its previous position.",
    )
  })

  test("AC11/AC12: a successful Add insertion announces its position; a rejected insertion announces no false success", async ({ page }) => {
    await freshDashboard(page, DESKTOP)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const tray = page.locator(".widget-tray")
    const announcer = page.getByTestId("dashboard-editor-announcer")

    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    await expect(announcer).toHaveText("") // previewing alone announces no success
    await page.getByRole("button", { name: "Insert here" }).click()
    await expect(announcer).toHaveText("KPI Summary added at position 1 in row 1.")

    // Row 0 is now at the canonical 3-column maximum; attempt a rejected 4th.
    const announcementBeforeRejection = await announcer.textContent()
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    // No new (false-success) announcement was produced by the rejected attempt.
    await expect(announcer).toHaveText(announcementBeforeRejection ?? "")
  })

  test("AC17: existing focus-visible behavior is unchanged for Save/Cancel/Restore Default/WidgetTray/insertion-slot/Remove", async ({ page }) => {
    await freshDashboard(page, DESKTOP)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const tray = page.locator(".widget-tray")
    // Commit one insertion first so "Save" is enabled (isDirty) and therefore
    // reachable by Tab at all -- a disabled button is skipped in tab order.
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    await page.getByRole("button", { name: "Insert here" }).click()
    // Reopen the picker (a fresh selection, not a toggle-off) so the
    // insertion-slot buttons are visible again for this sweep.
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await expect(page.getByTestId("widget-insertion-slots")).toBeVisible()

    // The just-clicked tray button is later in DOM/tab order than
    // Reset/Cancel/Save (EditModeToolbar renders before WidgetTray) --
    // walk back to Restore Default first so a plain forward Tab sweep from
    // here passes through every required control in order.
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Shift+Tab")
    await expect(page.locator(":focus")).toHaveText("Restore Default")

    const requiredNames = [
      "Restore Default",
      "Cancel",
      "Save",
      "KPI Summary",
      "Insert KPI Summary at the start of row 1",
      "Remove KPI Summary",
    ]
    const visibleOutline: Record<string, boolean> = {}
    // Focus is already on "Restore Default" -- record it before the
    // forward sweep below moves away from it.
    visibleOutline["Restore Default"] = (await page.evaluate(() => getComputedStyle(document.activeElement as HTMLElement).outlineStyle)) !== "none"
    for (let i = 0; i < 80 && Object.keys(visibleOutline).length < requiredNames.length; i++) {
      await page.keyboard.press("Tab")
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el) return null
        return { text: el.textContent?.trim() ?? "", ariaLabel: el.getAttribute("aria-label"), outline: getComputedStyle(el).outlineStyle }
      })
      if (!info) continue
      // WidgetTray's button text is "KPI Summary" plus its description
      // paragraph concatenated (both inside one <button>), so match by
      // prefix rather than exact equality for that one control.
      const key = info.ariaLabel ?? requiredNames.find((n) => info.text === n || info.text.startsWith(n)) ?? info.text
      if (requiredNames.includes(key) && !(key in visibleOutline)) visibleOutline[key] = info.outline !== "none"
    }
    for (const name of requiredNames) {
      expect(visibleOutline[name], `${name} focus-visible outline`).toBe(true)
    }
  })
})
