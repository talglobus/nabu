import { readFileSync } from "node:fs";
import type { BundleManifest } from "@nabu/schema";
import { expect, test } from "@playwright/test";

const manifest = JSON.parse(readFileSync(new URL("../../public/bundles/fa/manifest.json", import.meta.url), "utf8")) as BundleManifest;
const asset = manifest.units.find((u) => u.id === "intro")?.assets?.find((p) => p.endsWith(".mp3"));
if (asset === undefined) throw new Error("The Persian introduction needs an audio fixture");

// Intercept the download's own fetch, without a service worker answering from another cache.
test.use({ serviceWorkers: "block" });

for (const failure of ["network", "integrity"] as const) {
  test(`a ${failure} failure stays retryable and never marks corrupt audio ready`, async ({ page }) => {
    await page.goto("/?sound=off#/fa/fa-Arab.standard");
    const unit = page.locator('[data-offline-unit="intro"]');
    await expect(unit).toHaveAttribute("data-state", "missing");
    const pattern = `**/bundles/fa/${asset}`;
    await page.route(pattern, (route) => failure === "network" ? route.abort("internetdisconnected") : route.fulfill({ contentType: "audio/mpeg", body: "corrupted audio" }));
    await unit.locator("[data-action=download-unit]").click();
    await expect(page.locator("[data-offline-error]")).toHaveAttribute("data-offline-error", failure);
    await expect(unit).not.toHaveAttribute("data-state", "ready");
    expect(await page.evaluate(async (path) => {
      const cache = await caches.open("nabu-bundles");
      return (await cache.match(new URL(`bundles/fa/${path}`, location.href))) !== undefined;
    }, asset)).toBe(false);

    await page.unroute(pattern);
    await unit.locator("[data-action=download-unit]").click();
    await expect(unit).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    await expect(page.locator("[data-offline-error]")).toHaveCount(0);
    // The repaired bytes, rather than just the UI state, must match the manifest.
    const digest = await page.evaluate(async (path) => {
      const response = await (await caches.open("nabu-bundles")).match(new URL(`bundles/fa/${path}`, location.href));
      if (response === undefined) return undefined;
      const hash = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
      return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
    }, asset);
    expect(digest).toBe(manifest.files.find((f) => f.path === asset)?.sha256);
    await page.reload();
    await expect(unit).toHaveAttribute("data-state", "ready");
  });
}
