import { expect, test } from "@playwright/test";

for (const hash of ["#/fa/%", "#/fa/%E0%A4%A", "#/fa/fa-Arab.standard/%FF"]) {
  test(`a malformed link recovers to home: ${hash}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?sound=off${hash}`);
    await expect(page.locator("[data-progress]")).toBeVisible();
    expect(errors).toEqual([]);
    // Recovery must leave navigation usable, including a subsequent hashchange.
    await page.evaluate(() => { window.location.hash = "#/preferences"; });
    await expect(page.locator("[data-preferences]")).toBeVisible();
    await page.evaluate((bad) => { window.location.hash = bad; }, hash);
    await expect(page.locator("[data-progress]")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
