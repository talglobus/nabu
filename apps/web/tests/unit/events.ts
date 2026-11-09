import type { ProgressReset } from "@nabu/schema";

/** Fixed events: order, identity and payload are independent of the production clock. */
export const event = (n: number, course = "fa"): ProgressReset => ({
  type: "progress_reset",
  id: `019c0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  schema: 1,
  device: "test-device",
  course,
  orthography: "fa-Arab/standard" as ProgressReset["orthography"],
  support: "en",
  bundle: "test-bundle",
  session: "019c0000-0000-7000-8001-000000000000",
  clientTime: "2026-04-01T09:00:00Z",
  localDate: "2026-04-01",
  tz: "UTC",
});
