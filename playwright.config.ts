import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3011",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 3011",
    url: "http://127.0.0.1:3011/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MODEL_API_KEY: "REPLACE_ME",
      META_MODEL: "muse-spark-1.3",
      COUNTERSHOT_ACCESS_CODE: "",
      SESSION_SECRET: "",
      COUNTERSHOT_DATA_DIR: path.resolve(".data", `e2e-${process.pid}`),
      COUNTERSHOT_BUILD_DIR: ".next-e2e",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
