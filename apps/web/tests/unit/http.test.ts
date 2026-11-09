import { afterEach, expect, it, vi } from "vitest";
import { request } from "../../src/http.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([201, 204])("accepts an empty %i response", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
  await expect(request("https://sync.example.test", "/v1/events")).resolves.toBeUndefined();
});

it.each([
  [401, { error: "unauthorized" }, "unauthorized"],
  [429, { error: { code: "rate-limited" } }, "rate-limited"],
  [500, "upstream failed", undefined],
])("preserves HTTP %i even when the error body is not JSON", async (status, body, code) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
  await expect(request("https://sync.example.test", "/v1/events")).rejects.toMatchObject({ kind: "http", status, code });
});

it("rejects corrupt successful JSON instead of treating it as an acknowledgement", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{truncated")));
  await expect(request("https://sync.example.test", "/v1/events")).rejects.toBeInstanceOf(SyntaxError);
});
