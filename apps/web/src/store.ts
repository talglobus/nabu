/**
 * The on-device event log (gameplan §1 decision 5, §14.2 local-first): an
 * append-only IndexedDB store of learner events, keyed by event id, so writing
 * an event twice changes nothing. Projections (memory, XP, the path) are
 * replayed from it by @nabu/core; nothing derived is stored.
 *
 * The outbox holds the ids of events the server has not acknowledged. Every
 * event recorded on this device enters it, account or not, so signing up later
 * uploads the whole history as an ordinary sync, and a queue that could not be
 * sent survives reloads. Events pulled from the server skip it.
 *
 * Where IndexedDB is unavailable (some private windows) everything lives in
 * memory for the page's lifetime and `persistent` is false, so the app can say
 * that progress will not be kept.
 */
import type { LearnerEvent } from "@nabu/schema";
import { uuidv7 } from "./clock.ts";
import { done, EVENTS, META, openDb, OUTBOX, outboxOf, persist, promised, RECEIVED, receivedTimes } from "./idb.ts";

export interface EventStore {
  /** Random id of this installation, sent with every event. */
  readonly device: string;
  readonly persistent: boolean;
  /**
   * Events recorded here (`synced` false: they enter the outbox) or pulled from the server, with
   * when the server received them (`received`, by id). Returns the ids that were new.
   */
  readonly append: (events: readonly LearnerEvent[], options?: { readonly synced?: boolean; readonly received?: Readonly<Record<string, string>> }) => Promise<readonly string[]>;
  readonly eventsOf: (course: string) => Promise<readonly LearnerEvent[]>;
  readonly allEvents: () => Promise<readonly LearnerEvent[]>;
  /** The oldest events the server has not acknowledged, up to `limit`. */
  readonly pending: (limit: number) => Promise<readonly LearnerEvent[]>;
  readonly pendingCount: () => Promise<number>;
  /** The server has these events; `received` says when it first got each. */
  readonly acknowledge: (ids: readonly string[], received?: Readonly<Record<string, string>>) => Promise<void>;
  /** When the server received each synced event: the game folds it in as the server does (§12.2). */
  readonly receivedTimes: () => Promise<ReadonlyMap<string, string>>;
  readonly getMeta: (key: string) => Promise<unknown>;
  readonly setMeta: (key: string, value: unknown) => Promise<void>;
  readonly deleteMeta: (key: string) => Promise<void>;
}

const deviceId = async (db: IDBDatabase): Promise<string> => {
  const tx = db.transaction(META, "readwrite");
  const meta = tx.objectStore(META);
  const existing: unknown = await promised(meta.get("device"));
  if (typeof existing === "string") return existing;
  const id = uuidv7();
  meta.put(id, "device");
  await done(tx);
  return id;
};

const indexedStore = async (): Promise<EventStore> => {
  const db = await openDb();
  const device = await deviceId(db);
  const outbox = outboxOf(db);
  // Ask the browser not to evict the log under storage pressure; it may say no.
  void persist();
  return {
    device,
    persistent: true,
    append: async (events, options = {}) => {
      const tx = db.transaction([EVENTS, OUTBOX, RECEIVED], "readwrite");
      const store = tx.objectStore(EVENTS);
      const outbox = tx.objectStore(OUTBOX);
      const fresh: string[] = [];
      for (const e of events) {
        const at = options.received?.[e.id];
        if (at !== undefined) tx.objectStore(RECEIVED).put(at, e.id);
        const key = await promised(store.getKey(e.id));
        if (key !== undefined) continue;
        fresh.push(e.id);
        store.put(e);
        if (options.synced !== true) outbox.put(e.id, e.id);
      }
      await done(tx);
      return fresh;
    },
    eventsOf: async (course) => promised(db.transaction(EVENTS).objectStore(EVENTS).index("course").getAll(course)) as Promise<LearnerEvent[]>,
    allEvents: async () => promised(db.transaction(EVENTS).objectStore(EVENTS).getAll()) as Promise<LearnerEvent[]>,
    pending: outbox.pending,
    pendingCount: async () => promised(db.transaction(OUTBOX).objectStore(OUTBOX).count()),
    acknowledge: outbox.acknowledge,
    receivedTimes: () => receivedTimes(db),
    getMeta: async (key) => promised(db.transaction(META).objectStore(META).get(key)) as Promise<unknown>,
    setMeta: async (key, value) => {
      const tx = db.transaction(META, "readwrite");
      tx.objectStore(META).put(value, key);
      await done(tx);
    },
    deleteMeta: async (key) => {
      const tx = db.transaction(META, "readwrite");
      tx.objectStore(META).delete(key);
      await done(tx);
    },
  };
};

const memoryStore = (): EventStore => {
  const log = new Map<string, LearnerEvent>();
  const outbox = new Set<string>();
  const received = new Map<string, string>();
  const meta = new Map<string, unknown>();
  const receive = (times: Readonly<Record<string, string>> = {}): void => {
    for (const [id, at] of Object.entries(times)) received.set(id, at);
  };
  return {
    device: uuidv7(),
    persistent: false,
    append: (events, options = {}) => {
      receive(options.received);
      const fresh: string[] = [];
      for (const e of events) {
        if (log.has(e.id)) continue;
        fresh.push(e.id);
        log.set(e.id, e);
        if (options.synced !== true) outbox.add(e.id);
      }
      return Promise.resolve(fresh);
    },
    eventsOf: (course) => Promise.resolve([...log.values()].filter((e) => e.course === course)),
    allEvents: () => Promise.resolve([...log.values()]),
    pending: (limit) => Promise.resolve([...outbox].sort().slice(0, limit).flatMap((id) => log.get(id) ?? [])),
    pendingCount: () => Promise.resolve(outbox.size),
    acknowledge: (ids, times) => {
      for (const id of ids) outbox.delete(id);
      receive(times);
      return Promise.resolve();
    },
    receivedTimes: () => Promise.resolve(new Map(received)),
    getMeta: (key) => Promise.resolve(meta.get(key)),
    setMeta: (key, value) => {
      meta.set(key, value);
      return Promise.resolve();
    },
    deleteMeta: (key) => {
      meta.delete(key);
      return Promise.resolve();
    },
  };
};

export const openStore = async (): Promise<EventStore> => {
  try {
    return await indexedStore();
  } catch {
    return memoryStore();
  }
};
