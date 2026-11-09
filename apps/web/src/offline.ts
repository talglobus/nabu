/**
 * Courses offline in the browser (gameplan §16 Phase 10). Course files live in the Cache API
 * (BUNDLE_CACHE) under their own URLs, so the service worker answers the app's ordinary fetches
 * from it with no network; @nabu/core/offline decides what to fetch and what is ready.
 *
 * A download fetches each missing file, checks its sha256 against the manifest (files are
 * content-addressed, so a stored copy is valid as long as its course lists it) and stores it;
 * the manifest goes in last, so a stored manifest only ever names files that are there. Older
 * versions' files are deleted after a download. The fonts the course's text needs are fetched
 * too (each script's font comes in unicode-range pieces), so it renders offline as it does online.
 *
 * Native builds (Capacitor) ship every course inside the app and need none of this.
 */
import { downloadPlan, removable, stalePaths } from "@nabu/core/offline";
import type { BundleManifest } from "@nabu/schema";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { BUNDLE_CACHE } from "./caches.ts";
import { persist } from "./idb.ts";

/** Whether this browser can keep courses offline: a service worker and the Cache API. */
export const offlineSupported = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof caches !== "undefined";

/** Registers the service worker (production builds; the dev server leaves fetches alone). */
export const registerWorker = async (base: string): Promise<ServiceWorkerRegistration | undefined> => {
  if (!offlineSupported()) return undefined;
  try {
    return await navigator.serviceWorker.register(`${base}sw.js`);
  } catch {
    return undefined;
  }
};

const subscribeOnline = (listener: () => void): (() => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};

/** navigator.onLine, live. False is reliable; true may still mean no route to the server. */
export const useOnline = (): boolean => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

const absolute = (url: string): string => new URL(url, window.location.href).href;

/** Paths stored for the course at `root` (the course's bundle directory URL, ending in "/"). */
export const storedPaths = async (root: string): Promise<Set<string>> => {
  if (typeof caches === "undefined") return new Set();
  const prefix = absolute(root);
  const keys = await (await caches.open(BUNDLE_CACHE)).keys();
  return new Set(keys.map((r) => r.url).filter((u) => u.startsWith(prefix)).map((u) => u.slice(prefix.length)));
};

export type DownloadError = "network" | "integrity" | "quota";

export interface Progress {
  readonly done: number;
  readonly total: number;
}

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

type DownloadFailure = Error & { readonly reason: DownloadError };
const failure = (reason: DownloadError): DownloadFailure => Object.assign(new Error(reason), { reason });
const isFailure = (e: unknown): e is DownloadFailure => e instanceof Error && typeof (e as Partial<DownloadFailure>).reason === "string";

const PARALLEL = 4;

/** Every script's font, for the course's text: each family fetches the pieces the text needs. */
const fetchFonts = async (text: string): Promise<void> => {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const families = new Set([...document.fonts].map((f) => f.family.replace(/^["']|["']$/gu, "")));
  await Promise.all([...families].flatMap((family) => ["400", "700"].map((weight) => document.fonts.load(`${weight} 1em "${family}"`, text).catch(() => []))));
};

/**
 * Stores the course's core and the given units (all by default). Resolves with an error code, or
 * undefined when everything listed is stored. `text` is the course's text, to fetch its fonts.
 */
export const downloadCourse = async (root: string, manifest: BundleManifest, text: string, units: readonly string[] | undefined, onProgress: (p: Progress) => void): Promise<DownloadError | undefined> => {
  try {
    const cache = await caches.open(BUNDLE_CACHE);
    const plan = downloadPlan(manifest, await storedPaths(root), units);
    let done = 0;
    onProgress({ done, total: plan.bytes });
    void persist();
    const queue = [...plan.files];
    const one = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const url = absolute(`${root}${file.path}`);
        let response: Response;
        try {
          response = await fetch(url, { cache: "no-cache" });
        } catch {
          throw failure("network");
        }
        if (!response.ok) throw failure("network");
        const body = await response.arrayBuffer();
        if (hex(await crypto.subtle.digest("SHA-256", body)) !== file.sha256) throw failure("integrity");
        await cache.put(url, new Response(body, { headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream" } }));
        done += file.bytes;
        onProgress({ done, total: plan.bytes });
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: PARALLEL }, () => one().catch((error: unknown) => {
      // Stop assigning work, but let active writes settle before the UI offers a retry.
      queue.length = 0;
      throw error;
    })));
    const failed = workers.find((worker) => worker.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    // Last: the manifest that names exactly these files.
    await cache.put(absolute(`${root}manifest.json`), new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
    for (const path of stalePaths(manifest, await storedPaths(root))) if (path !== "manifest.json") await cache.delete(absolute(`${root}${path}`));
    // The course list, so the home screen opens offline too.
    const index = absolute(`${root}../index.json`);
    const listed = await fetch(index, { cache: "no-cache" }).catch(() => undefined);
    if (listed?.ok === true) await cache.put(index, listed);
    await fetchFonts(text);
    return undefined;
  } catch (e) {
    if (isFailure(e)) return e.reason;
    if (e instanceof DOMException && e.name === "QuotaExceededError") return "quota";
    return "network";
  }
};

/** Deletes the media of these units that no other unit uses (the course's text stays). */
export const removeUnits = async (root: string, manifest: BundleManifest, units: readonly string[]): Promise<void> => {
  const cache = await caches.open(BUNDLE_CACHE);
  for (const f of removable(manifest, units)) await cache.delete(absolute(`${root}${f.path}`));
};

/** What this device has stored of a course, refreshed after `version` changes. */
export const useStored = (root: string | undefined, version: unknown): ReadonlySet<string> | undefined => {
  const [stored, setStored] = useState<{ root: string; paths: ReadonlySet<string> } | undefined>(undefined);
  const refresh = useCallback(() => {
    if (root === undefined) return () => undefined;
    let live = true;
    void storedPaths(root).then((paths) => {
      if (live) setStored({ root, paths });
    });
    return () => {
      live = false;
    };
  }, [root]);
  useEffect(() => refresh(), [refresh, version]);
  return stored !== undefined && stored.root === root ? stored.paths : undefined;
};
