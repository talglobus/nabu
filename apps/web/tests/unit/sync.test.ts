import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openStore } from "../../src/store.ts";
import { createSync } from "../../src/sync.ts";

// These tests exercise synchronization without rendering the game panel.
vi.mock("../../src/game.tsx", () => ({ gameOf: vi.fn() }));

const server = "https://sync.example.test";
const emptyPage = () => Response.json({ events: [], cursor: 0, more: false });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("never contacts a server without an account, even after sync triggers", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const sync = await createSync(await openStore(), server);
  sync.schedule();
  await sync.syncNow();
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetch).not.toHaveBeenCalled();
});

it("coalesces simultaneous sync triggers into one active request and one follow-up", async () => {
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let pulls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/auth/")) return Response.json({ user: { id: "a", email: "a@example.test" }, token: "a-token" });
    if (hold) { pulls++; await gate; }
    return emptyPage();
  }));
  const sync = await createSync(await openStore(), server);
  await sync.signIn("a@example.test", "test-password");
  hold = true;
  const pending = Array.from({ length: 8 }, () => sync.syncNow());
  await turn();
  const active = pulls;
  release();
  await Promise.all(pending);
  await turn();
  expect(active).toBe(1);
  expect(pulls).toBe(2);
});

it.each([200, 401])("a delayed %i from the previous account cannot change the new account or its cursor", async (status) => {
  let delayed = false;
  let release!: (response: Response) => void;
  const oldPull = new Promise<Response>((resolve) => { release = resolve; });
  const newAccountPulls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (url.endsWith("/auth/sign-in")) {
      const { email } = JSON.parse(init.body as string) as { email: string };
      return Promise.resolve(Response.json({ user: { id: email, email }, token: email }));
    }
    if (url.endsWith("/auth/sign-out")) return Promise.resolve(new Response(null, { status: 204 }));
    const token = (init.headers as Record<string, string>)["Authorization"];
    if (token === "Bearer b@example.test") newAccountPulls.push(url);
    return delayed && token === "Bearer a@example.test" ? oldPull : Promise.resolve(emptyPage());
  }));
  const store = await openStore();
  const sync = await createSync(store, server);
  await sync.signIn("a@example.test", "test-password");
  delayed = true;
  const pending = sync.syncNow();
  await turn();
  await sync.signOut();
  const entering = sync.signIn("b@example.test", "test-password");
  await turn();
  release(status === 401 ? Response.json({ error: "unauthorized" }, { status }) : Response.json({ events: [], cursor: 99, more: false }));
  await Promise.all([pending, entering]);
  await turn();
  expect(sync.get().account?.user.email).toBe("b@example.test");
  expect(await store.getMeta("account")).toMatchObject({ user: { email: "b@example.test" } });
  expect(sync.get().error).toBeUndefined();
  expect(newAccountPulls).toEqual([`${server}/v1/events?since=0`]);
});

it.each([
  [401, "signed-out", "error"],
  [429, "rate-limited", "error"],
  [503, "unknown", "error"],
  [0, "unreachable", "offline"],
] as const)("still reports a current session's %i failure", async (status, error, phase) => {
  let fail = false;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/auth/")) return Promise.resolve(Response.json({ user: { id: "a", email: "a@example.test" }, token: "a-token" }));
    if (!fail) return Promise.resolve(emptyPage());
    return status === 0 ? Promise.reject(new TypeError("offline")) : Promise.resolve(Response.json({ error: "unauthorized" }, { status }));
  }));
  const store = await openStore();
  const sync = await createSync(store, server);
  await sync.signIn("a@example.test", "test-password");
  fail = true;
  await sync.syncNow();
  expect(sync.get()).toMatchObject({ error, phase });
  if (status === 401) {
    expect(sync.get().account).toBeUndefined();
    expect(await store.getMeta("account")).toBeUndefined();
  } else {
    expect(sync.get().account?.user.email).toBe("a@example.test");
  }
});
