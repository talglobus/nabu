import { createHash } from "node:crypto";
import type { BundleManifest } from "@nabu/schema";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadCourse } from "../../src/offline.ts";

const root = "https://learn.example.test/bundles/fa/";
const bytes = "valid fixture bytes";
const manifest: BundleManifest = {
  course: "fa", formatVersion: 0, id: "test-version", target: "fa-Arab-IR" as BundleManifest["target"],
  orthographies: ["fa-Arab/standard" as BundleManifest["orthographies"][number]], support: ["en-Latn/standard" as BundleManifest["support"][number]],
  licenses: {}, provenance: {}, versions: {}, units: [],
  files: ["first.json", "second.json"].map((path) => ({
    path, role: "unit", license: "CC0-1.0", bytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })),
};
let stored: Map<string, Response>;
let put: ReturnType<typeof vi.fn<(url: string, response: Response) => Promise<void>>>;
beforeEach(() => {
  stored = new Map();
  put = vi.fn((url, response) => { stored.set(url, response); return Promise.resolve(); });
  vi.stubGlobal("window", { location: { href: "https://learn.example.test/" } });
  vi.stubGlobal("caches", { open: () => Promise.resolve({
    keys: () => Promise.resolve([...stored.keys()].map((url) => new Request(url))),
    put,
    delete: (url: string) => Promise.resolve(stored.delete(url)),
  }) });
});
afterEach(() => vi.unstubAllGlobals());

it("commits the manifest after all hashes pass, then removes obsolete files", async () => {
  stored.set(`${root}old.json`, new Response("old"));
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes))));
  const progress = vi.fn();
  expect(await downloadCourse(root, manifest, "", undefined, progress)).toBeUndefined();
  const writes = put.mock.calls.map(([url]) => url);
  expect(writes.slice(0, 2).sort()).toEqual([`${root}first.json`, `${root}second.json`]);
  expect(writes.slice(2)).toEqual([`${root}manifest.json`, new URL("../index.json", root).href]);
  expect(stored.has(`${root}old.json`)).toBe(false);
  expect(progress).toHaveBeenLastCalledWith({ done: bytes.length * 2, total: bytes.length * 2 });
});

it.each(["network", "http", "integrity", "quota"])("does not publish a new manifest after a %s failure", async (failure) => {
  const oldManifest = new Response("old manifest");
  stored.set(`${root}manifest.json`, oldManifest);
  stored.set(`${root}old.json`, new Response("old bytes"));
  if (failure === "quota") put.mockRejectedValue(new DOMException("full", "QuotaExceededError"));
  vi.stubGlobal("fetch", vi.fn(() => failure === "network" ? Promise.reject(new TypeError("offline")) : Promise.resolve(new Response(failure === "integrity" ? "corrupt" : bytes, { status: failure === "http" ? 503 : 200 }))));
  expect(await downloadCourse(root, manifest, "", undefined, () => undefined)).toBe(failure === "http" ? "network" : failure);
  expect(stored.get(`${root}manifest.json`)).toBe(oldManifest);
  expect(stored.has(`${root}old.json`)).toBe(true);
  expect(stored.has(`${root}first.json`)).toBe(false);
});

it("waits for every active download before reporting a failure, so retry cannot overlap it", async () => {
  let release!: (response: Response) => void;
  const slow = new Promise<Response>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("first.json") ? Promise.reject(new TypeError("offline")) : slow));
  let finished = false;
  const download = downloadCourse(root, manifest, "", undefined, () => undefined).then((result) => { finished = true; return result; });
  // Flush promise continuations without relying on network or wall-clock timing.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishedWhileWorkerWasActive = finished;
  release(new Response(bytes));
  expect(await download).toBe("network");
  expect(finishedWhileWorkerWasActive).toBe(false);
});

it.each(["QuotaExceededError", "SecurityError"])("reports %s while opening storage instead of leaving the UI busy", async (name) => {
  vi.stubGlobal("caches", { open: () => Promise.reject(new DOMException("storage unavailable", name)) });
  expect(await downloadCourse(root, manifest, "", undefined, () => undefined)).toBe(name === "QuotaExceededError" ? "quota" : "network");
});
