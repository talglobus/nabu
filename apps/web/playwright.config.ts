/**
 * Phase 3 and 4 acceptance (gameplan §16): one lesson per fixture course, by
 * keyboard and by touch; the IME composition test; axe on every screen; the
 * local-first loop and sync. Runs against the production build served by
 * `vite preview`, and the API on PGlite in memory.
 */
import { defineConfig } from "@playwright/test";
import { API_PORT, WEB_PORT as PORT } from "./tests/e2e/ports.ts";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  timeout: 120_000,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    // Listening exercises play their clip when they open, as after a tap on a phone.
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [
    { name: "keyboard", use: { viewport: { width: 1280, height: 900 } } },
    { name: "touch", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
  webServer: [
    {
      command: `pnpm build && pnpm exec vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/bundles/index.json`,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
    {
      command: "node ../api/src/main.ts --dev",
      // Leagues and reminders on, with the test hooks (a push sink and a job runner) for Phase 7;
      // the review queue for Phase 8. No model: AI features are off, as on most instances.
      env: { PORT: String(API_PORT), NABU_DEV_PGLITE: "memory", NABU_DEV_DATABASE_URL: "", NABU_LEAGUES: "1", NABU_PUSH: "1", NABU_TEST_HOOKS: "1", NABU_ADMIN_TOKEN: "e2e-review-token", NABU_RATE_LIMITS: "off" },
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
  ],
});
