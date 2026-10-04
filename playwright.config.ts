import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    launchOptions: {
      args: ["--use-fake-device-for-media-stream"],
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    },
    trace: "retain-on-failure",
  },
});
