import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000",
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
        ...(process.env.TEST_TLS_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.TEST_TLS_SPKI}`] : [])],
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    },
    trace: "retain-on-failure",
  },
});
