import { test as base, expect } from "@playwright/test"
import { guardAutomation } from "./automationGuard.mjs"

/** Drop-in replacement for Playwright's `test` for specs that may be pointed at a REAL deployment: every test's context gets the
 * automation guard (GA4 collection + AWS API writes blocked) before its first page exists. Local-fixture runs are unaffected --
 * 127.0.0.1/localhost API traffic is never matched. */
export const test = base.extend<{ automationGuard: Awaited<ReturnType<typeof guardAutomation>> }>({
  automationGuard: [
    async ({ context }, use) => {
      await use(await guardAutomation(context))
    },
    { auto: true },
  ],
})

export { expect }
