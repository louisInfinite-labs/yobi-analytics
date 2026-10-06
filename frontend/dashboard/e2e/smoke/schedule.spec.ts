import { test, expect } from "./helpers"
import { pinEnglishLocale, trackPageErrors } from "../helpers/common"

/** docs/testing/V1_PRODUCTION_E2E_SMOKE_TEST.md, case I1/I6 -- the current
 * V1 product decision: Schedule is a fixed, non-paginated 7-day window.
 * `ScheduleToolbar.tsx`'s own docstring is explicit that the week-selector
 * arrows are natively `disabled` ("this phase's data is always the
 * backend's own fixed today-through-+6-day window... there is nothing to
 * page back or forward into") -- this spec asserts exactly that intended
 * state and deliberately never attempts a click on either arrow (clicking a
 * disabled button just hangs on Playwright's actionability wait, which is
 * the exact failure mode of the pre-existing, out-of-scope stale test in
 * schedule-and-settings.spec.ts's "pages between weeks..." case -- see the
 * MD's Schedule section for that cross-reference). This file does not
 * replace that existing suite's broader Schedule coverage (hour labels,
 * stream-detail dialog); it only owns the V1 paging-is-off contract, which
 * nothing else currently asserts.
 *
 * Day-order note: `useWeeklySchedule.ts`'s own `weekStart = today` (not a
 * Sunday-aligned calendar week) means the 7 rendered day headers roll from
 * whatever today's weekday actually is, wrapping around -- e.g. on a
 * Tuesday: Tue, Wed, Thu, Fri, Sat, Sun, Mon. The expected order below is
 * therefore computed from the real current date rather than hardcoded as
 * ["Sun",...,"Sat"] -- a hardcoded Sun-first order is exactly what makes
 * schedule-and-settings.spec.ts's own "renders a full-day Sunday-to-Saturday
 * timetable..." test fail on every day of the week except Sunday (confirmed:
 * it is failing right now, on today's actual date, for exactly this reason
 * -- a second pre-existing, out-of-scope stale-test finding alongside the
 * week-paging one, both in that same file, neither fixed here).
 *
 * The expected order is derived from the browser's own "now" (captured via
 * page.evaluate right after navigation), not Node's separate clock -- two
 * independent `new Date()` calls across processes could disagree by a day
 * within a few seconds of local midnight, which a fixed test file must not
 * assume away. */
function expectedDayOrder(todayIso: string): string[] {
  const formatter = new Intl.DateTimeFormat("en", { weekday: "short" })
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(todayIso)
    date.setDate(date.getDate() + offset)
    return formatter.format(date)
  })
}

test.describe("V1 smoke: Schedule (fixed 7-day window, paging disabled)", () => {
  test("loads with the current 7-day range and both week-paging arrows disabled, no paging attempted", async ({ page }) => {
    await pinEnglishLocale(page)
    const pageErrors = trackPageErrors(page)

    await page.goto("/schedule")
    const todayIso = await page.evaluate(() => new Date().toISOString())

    await expect(page.getByRole("heading", { name: "Live Schedule" })).toBeVisible()
    await expect(page.locator(".schedule-day-header")).toHaveCount(7)
    await expect(page.locator(".day-name")).toHaveText(expectedDayOrder(todayIso))
    await expect(page.locator(".schedule-day-header.is-today")).toHaveCount(1)

    const previousWeek = page.getByRole("button", { name: "Previous week" })
    const nextWeek = page.getByRole("button", { name: "Next week" })
    await expect(previousWeek).toBeVisible()
    await expect(previousWeek).toBeDisabled()
    await expect(nextWeek).toBeVisible()
    await expect(nextWeek).toBeDisabled()

    expect(pageErrors).toEqual([])
  })
})
