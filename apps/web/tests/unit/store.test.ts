import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../../src/store.ts";
import { event } from "./events.ts";

describe("progress when IndexedDB is unavailable", () => {
  beforeEach(() => vi.stubGlobal("indexedDB", undefined));
  afterEach(() => vi.unstubAllGlobals());

  it("deduplicates within and across batches without replacing the first event", async () => {
    const store = await openStore();
    const first = event(1);
    expect(store.persistent).toBe(false);
    expect(await store.append([first, { ...first, course: "uz" }])).toEqual([first.id]);
    expect(await store.append([first])).toEqual([]);
    expect(await store.allEvents()).toEqual([first]);
    expect(await store.pendingCount()).toBe(1);
  });

  it("uploads oldest first and acknowledging preserves the learner's history", async () => {
    const store = await openStore();
    const first = event(1);
    const second = event(2);
    await store.append([second, first]);
    expect(await store.pending(1)).toEqual([first]);
    const received = "2026-04-02T12:00:00Z";
    await store.acknowledge([first.id], { [first.id]: received });
    expect(await store.pending(200)).toEqual([second]);
    expect(await store.eventsOf("fa")).toHaveLength(2);
    expect((await store.receivedTimes()).get(first.id)).toBe(received);
  });

  it("does not requeue pulled events, or drop an unacknowledged local duplicate", async () => {
    const store = await openStore();
    await store.append([event(1)]);
    await store.append([event(1), event(2, "uz")], { synced: true });
    expect(await store.pending(200)).toEqual([event(1)]);
    expect(await store.eventsOf("uz")).toEqual([event(2, "uz")]);
  });
});
