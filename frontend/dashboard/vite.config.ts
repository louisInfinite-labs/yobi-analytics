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
  },
})
