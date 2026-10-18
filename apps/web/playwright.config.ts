import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.E2E_PORT ?? 0)
if (!port) throw new Error("Rode pelo `pnpm e2e` (ele escolhe a porta livre e define E2E_PORT).")

/**
 * E2E mobile: viewport 390x844, app em `next dev` numa porta livre e a API simulada no navegador
 * (`page.route`), sem backend, banco nem rede. Ver e2e/README.md.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "e2e/report", open: "never" }]],
  // Fora do projeto: artefatos dentro de apps/web fazem o `next dev` reconstruir (Fast Refresh) e recarregar a página no meio do teste.
  outputDir: join(tmpdir(), "web-e2e-results"),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "mobile-chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm exec next dev --webpack -p ${port} -H 127.0.0.1`,
    url: `http://127.0.0.1:${port}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      ATLAS_API_INTERNAL_URL: "http://127.0.0.1:9",
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    },
  },
})
