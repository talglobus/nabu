import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadOutbox } from "../../src/outbox.ts";
import { openStore } from "../../src/store.ts";
import { event } from "./events.ts";

const destination = { server: "https://sync.example.test", token: "test-token" };
beforeEach(() => vi.stubGlobal("indexedDB", undefined));
afterEach(() => vi.unstubAllGlobals());

it("sends ordered batches of at most 200 and retains history and receipt times", async () => {
  const store = await openStore();
  const events = Array.from({ length: 401 }, (_, i) => event(i, i % 2 === 0 ? "fa" : "uz"));
  await store.append([...events].reverse());
  const sent: unknown[][] = [];
  const received = "2026-04-02T12:00:00Z";
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    const body = JSON.parse(init.body as string) as { events: { id: string }[] };
    sent.push(body.events);
    return Promise.resolve(Response.json({ received: Object.fromEntries(body.events.map((e) => [e.id, received])) }));
  }));
  expect(await uploadOutbox(store, destination)).toEqual(new Set(["fa", "uz"]));
  expect(sent.map((b) => b.length)).toEqual([200, 200, 1]);
  expect(sent.flat()).toEqual(events);
  expect(await store.pendingCount()).toBe(0);
  expect(await store.allEvents()).toHaveLength(401);
  expect((await store.receivedTimes()).size).toBe(401);
});

it.each(["network", "unauthorized", "server", "invalid-json"])("keeps the failed batch after %s and retries without losing events", async (failure) => {
  const store = await openStore();
  const events = Array.from({ length: 201 }, (_, i) => event(i));
  await store.append(events);
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({}));
  if (failure === "network") fetch.mockRejectedValueOnce(new TypeError("offline"));
  else fetch.mockResolvedValueOnce(failure === "invalid-json" ? new Response("{") : Response.json({ error: "unauthorized" }, { status: failure === "unauthorized" ? 401 : 503 }));
  vi.stubGlobal("fetch", fetch);
  await expect(uploadOutbox(store, destination)).rejects.toThrow();
  expect(await store.pending(200)).toEqual(events.slice(200));
  expect(await store.allEvents()).toHaveLength(201);
  fetch.mockResolvedValue(Response.json({}));
  await uploadOutbox(store, destination);
  expect(await store.pendingCount()).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse((fetch.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({ events: events.slice(200) });
});
