import type { Page } from "@playwright/test"

/** Pins the app's locale to English so translated label text stays stable
 * across the FA1-FA4 regression specs -- same init-script pattern
 * schedule-and-settings.spec.ts's own beforeEach already uses. */
export async function pinEnglishLocale(page: Page) {
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("yobi.locale")) window.localStorage.setItem("yobi.locale", "en")
  })
}

/** Collects uncaught page exceptions AND unhandled promise rejections --
 * both surface through Playwright's own "pageerror" event -- so a test can
 * assert neither happened during a real interaction flow. Same helper as
 * schedule-and-settings.spec.ts's own trackPageErrors. */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

/** Collects console.error()-level messages separately from thrown
 * exceptions/rejections (trackPageErrors above) -- a React prop-type or key
 * warning surfaces here, never through "pageerror". */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  return errors
}

/** Picks an option from an antd Select identified by its accessible name --
 * same helper as schedule-and-settings.spec.ts's own chooseOption. */
export async function chooseAntdSelectOption(page: Page, selectName: string, optionText: string) {
  await page.getByRole("combobox", { name: selectName }).click()
  await page.locator(".ant-select-item-option-content", { hasText: optionText }).click()
}
