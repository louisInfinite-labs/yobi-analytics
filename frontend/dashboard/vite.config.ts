/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Browser-verification tooling prerequisite (MT-16/MT-17): Playwright's
    // own suite lives in ./e2e and must not be picked up by Vitest's
    // default include glob, which would otherwise try to run
    // `@playwright/test` specs through the jsdom runner. Vitest's own
    // default `exclude` list (node_modules, dist, .git, etc.) is additive
    // via `configDefaults.exclude`, not replaced, so nothing already
    // excluded becomes scannable again.
    exclude: [...configDefaults.exclude, '**/e2e/**'],
    // Vitest's own default worker count scales with the host's logical CPU
    // count (this repo's own dev/CI machines report 32), spawning that many
    // separate forked processes -- each independently loading this suite's
    // full jsdom + antd/recharts/gridstack/dnd-kit import graph. Confirmed
    // by direct measurement: the full suite is 100% green and reproducible
    // at 4 workers, but at the unbounded default it intermittently times out
    // (5000ms) on an arbitrary handful of otherwise-passing tests under
    // full-suite load -- each one passes cleanly in isolation, so this is
    // memory/CPU contention between workers, not a leak or a slow test.
    // Fixed at a known-good value rather than left to scale with core count,
    // which on a memory-constrained host oversubscribes real capacity.
    maxWorkers: 4,
  },
})
