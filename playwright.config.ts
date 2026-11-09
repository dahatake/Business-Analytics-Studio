import { defineConfig, devices } from '@playwright/test';

// BAS_PORT / BAS_OUT let several runs build and serve in parallel without sharing a dist folder.
const port = Number(process.env.BAS_PORT ?? 4173);
const outDir = process.env.BAS_OUT ?? 'dist';

export default defineConfig({
  testDir: './e2e',
  outputDir: outDir === 'dist' ? 'test-results' : `test-results-${outDir}`,
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: [/touch\.spec\.ts/, /measure\.spec\.ts/], grepInvert: /@perf|@measure/ },
    // D-8: timing-sensitive tests run alone and serially (npm run e2e runs this project with --workers=1).
    { name: 'perf', use: { ...devices['Desktop Chrome'] }, grep: /@perf/ },
    // D-8 measurement tool, not part of verify: npm run measure (add --headed on the reference PC with a 4K display).
    { name: 'measure', use: { ...devices['Desktop Chrome'], viewport: { width: 3840, height: 2160 } }, testMatch: /measure\.spec\.ts/, grep: /@measure/ },
    { name: 'touch', use: { ...devices['Pixel 7'] }, testMatch: /touch\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite build --outDir ${outDir} && npx vite preview --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    // E2E never touches the user's real vault (.bas-local): each build output gets its own relay folder.
    env: { BAS_RELAY_DIR: process.env.BAS_RELAY_DIR ?? `.bas-local/e2e-${outDir}` },
    timeout: 180_000,
  },
});





