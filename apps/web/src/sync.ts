/**
 * Optional accounts and sync (gameplan §14.2). Without an account nothing
 * leaves the device. With one, the outbox is uploaded in batches (the server
 * ignores ids it already has, so retries are safe), events from the user's
 * other devices are pulled by cursor, and the device checks that the server's
 * projection of each course matches its own replay.
 *
 * Signing up uploads the existing local history: it is already in the outbox.
 *
 * Offline (Phase 10): a sync that cannot reach the server asks the service worker for a
 * Background Sync, so the outbox goes up when the network is back even if the app is closed
 * (where the browser supports it). The app also syncs when it comes back online, when it is shown
 * again (a phone unlocked, the native app resumed), and every minute while events are pending.
 */
import { replay } from "@nabu/core/learner";
import type { AnswerSubmitted, LearnerEvent } from "@nabu/schema";
import type { GameConfig } from "@nabu/core/game";
import { isSyncedMessage, OUTBOX_SYNC } from "./caches.ts";
import { localDate } from "./clock.ts";
import { gameOf } from "./game.tsx";
import { difference } from "./compare.ts";
import { isHttpError, request } from "./http.ts";
import { uploadOutbox } from "./outbox.ts";
import type { EventStore } from "./store.ts";

export { canonical, difference } from "./compare.ts";
export { isHttpError, request, type HttpError } from "./http.ts";

const INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 1_000;

export interface Account {
  readonly server: string;
  readonly token: string;
  readonly user: { readonly id: string; readonly email: string };
}

/** Error codes from the server, plus the client's own. The UI turns them into messages. */
export type SyncError =
  | "invalid-email"
  | "weak-password"
  | "email-taken"
  | "wrong-credentials"
  | "rate-limited"
  /** The server's age gate (ADR 0069) needs the person's age. */
  | "age-required"
  /** The server's age gate turned the person away. */
  | "age"
  | "unreachable"
  | "signed-out"
  | "rejected"
  | "unknown";

export interface SyncState {
  /** The sync server, if this build or URL names one: without it the app is local-only. */
  readonly server: string | undefined;
  readonly account: Account | undefined;
  readonly phase: "idle" | "syncing" | "offline" | "error";
  readonly error: SyncError | undefined;
  /** Events recorded here that the server has not acknowledged. */
  readonly pending: number;
  /** After the last full sync, whether the server's projections matched the device's (undefined: not checked yet). */
  readonly verified: boolean | undefined;
  /** Bumped when events from another device arrive, so open views can replay. */
  readonly pulled: number;
  /** Bumped when a queued second check (the judge) revised an answer: open views replay in place. */
  readonly revised: number;
  /** This server's age gate turned the person away (ADR 0069): the device remembers, and offers no new account there. */
  readonly ageRefused: boolean;
}

export interface Sync {
  readonly get: () => SyncState;
  readonly subscribe: (listener: () => void) => () => void;
  /** `age` in years, when the server asks for it (ADR 0069); it is sent for that check alone. */
  readonly signUp: (email: string, password: string, age?: number) => Promise<SyncError | undefined>;
  readonly signIn: (email: string, password: string) => Promise<SyncError | undefined>;
  readonly signOut: () => Promise<void>;
  /** Everything the server holds for the account (§14.4), as GET /v1/export gives it. */
  readonly exportAccount: () => Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: SyncError }>;
  /** Deletes the account and its data on the server (the password confirms it); this device keeps its progress. */
  readonly deleteAccount: (password: string) => Promise<SyncError | undefined>;
  /** Sync soon (debounced), e.g. after recording an event. */
  readonly schedule: () => void;
  readonly syncNow: () => Promise<void>;
}

const ACCOUNT = "account";
/** The servers whose age gate turned the person away (ADR 0069). */
const AGE_REFUSED = "age-refused";
const CURSOR = "cursor";

const errorOf = (e: unknown): SyncError => {
  if (isHttpError(e)) {
    if (e.status === 401 && e.code === "unauthorized") return "signed-out";
    if (e.status === 429) return "rate-limited";
    const known: readonly SyncError[] = ["invalid-email", "weak-password", "email-taken", "wrong-credentials", "age-required", "age"];
    if (known.includes(e.code as SyncError)) return e.code as SyncError;
    return e.status === 400 ? "rejected" : "unknown";
  }
  return e instanceof TypeError ? "unreachable" : "unknown";
};

const JUDGE_QUEUE = "judge-queue";

/** Queues an answer for the judge while offline; the next sync asks for it (§8.3). */
export const queueJudge = async (store: EventStore, answer: AnswerSubmitted): Promise<void> => {
  const queued = ((await store.getMeta(JUDGE_QUEUE)) ?? []) as AnswerSubmitted[];
  if (!queued.some((a) => a.id === answer.id)) await store.setMeta(JUDGE_QUEUE, [...queued, answer]);
};

/**
 * Asks the judge about every queued answer. A revision joins the log (the server issued it, so
 * it is already synced). Answers stay queued only while the server is unreachable; any answer
 * the server refuses or the judge declines leaves the queue. Returns the courses revised.
 */
const flushJudgeQueue = async (store: EventStore, base: string, token: string): Promise<string[]> => {
  const queued = ((await store.getMeta(JUDGE_QUEUE)) ?? []) as AnswerSubmitted[];
  if (queued.length === 0) return [];
  const left: AnswerSubmitted[] = [];
  const revised: string[] = [];
  for (const answer of queued) {
    try {
      const res = await request<{ revision?: LearnerEvent }>(base, "/v1/ai/judge", { token, body: { answer } });
      if (res.revision !== undefined) {
        await store.append([res.revision], { synced: true });
        revised.push(answer.course);
      }
    } catch (e) {
      if (!isHttpError(e) || e.status === 503) left.push(answer);
    }
  }
  await store.setMeta(JUDGE_QUEUE, left);
  return revised;
};

/** Asks the browser to wake the service worker to upload the outbox when the network is back. */
const requestBackgroundSync = async (): Promise<void> => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await (registration as { sync?: { register: (tag: string) => Promise<void> } } | undefined)?.sync?.register(OUTBOX_SYNC);
  } catch {
    // No Background Sync here (or refused): the online and visibility triggers still sync.
  }
};

export interface SyncOptions {
  /** The deployment's game rules, to check the server's game projection against the device's. */
  readonly gameConfig?: () => Promise<GameConfig>;
}

/** Back in view within this long of the last pass, with nothing pending: no new pass. */
const VISIBLE_QUIET_MS = 30_000;

export const createSync = async (store: EventStore, server: string | undefined, options: SyncOptions = {}): Promise<Sync> => {
  const saved = (await store.getMeta(ACCOUNT)) as Account | undefined;
  const refused = ((await store.getMeta(AGE_REFUSED)) ?? []) as string[];
  let state: SyncState = {
    server: saved?.server ?? server,
    account: saved,
    phase: "idle",
    error: undefined,
    pending: await store.pendingCount(),
    verified: undefined,
    pulled: 0,
    revised: 0,
    ageRefused: refused.includes(saved?.server ?? server ?? ""),
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SyncState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  let running: Promise<void> | undefined;
  let again = false;
  let lastPass = 0;

  const pass = async (account: Account): Promise<void> => {
    const { server: base, token } = account;
    const touched = new Set<string>();
    // Upload the outbox, oldest first.
    for (const course of await uploadOutbox(store, account, async () => set({ pending: await store.pendingCount() }))) touched.add(course);
    if (state.account !== account) return;
    // Pull what other devices uploaded.
    let cursor = Number((await store.getMeta(CURSOR)) ?? 0);
    let fresh = 0;
    for (;;) {
      const page = await request<{ events: LearnerEvent[]; cursor: number; more: boolean; received?: Record<string, string> }>(base, `/v1/events?since=${cursor}`, { token });
      // Cursors belong to one account. Discard a response that arrives after an account switch.
      if (state.account !== account) return;
      const added = await store.append(page.events, { synced: true, ...(page.received === undefined ? {} : { received: page.received }) });
      if (state.account !== account) return;
      fresh += added.length;
      // Every course the pull returns is checked: events this device uploaded in the background
      // come back here too, and only now does the window see them on the server.
      for (const e of page.events) touched.add(e.course);
      cursor = page.cursor;
      await store.setMeta(CURSOR, cursor);
      if (!page.more) break;
    }
    // Second checks queued while offline (§8.3): the judge may revise answers retroactively.
    const revisedCourses = await flushJudgeQueue(store, base, token);
    if (state.account !== account) return;
    for (const c of revisedCourses) touched.add(c);
    if (revisedCourses.length > 0) set({ revised: state.revised + 1 });
    // The server is authoritative; the device checks that it agrees (§14.2).
    let verified = true;
    for (const course of touched) {
      const server = await request<{ state: unknown }>(base, `/v1/state?course=${encodeURIComponent(course)}`, { token });
      if (state.account !== account) return;
      const { seen: _seen, ...local } = replay(await store.eventsOf(course));
      const differs = difference(server.state, JSON.parse(JSON.stringify(local)));
      if (differs !== undefined) {
        verified = false;
        console.warn(`nabu sync: the server's projection of ${course} differs from this device's at ${differs}`);
      }
    }
    // And the game state (§12): streak dates, XP, quests, by the device's clock (Phase 10).
    if (touched.size > 0 && options.gameConfig !== undefined) {
      const now = new Date();
      const local = await gameOf(store, await options.gameConfig(), now);
      const remote = await request<{ game: unknown }>(base, `/v1/game?today=${localDate(now)}&now=${encodeURIComponent(now.toISOString())}`, { token }).catch((e: unknown) => {
        if (isHttpError(e) && e.status === 404) return undefined; // a server without it
        throw e;
      });
      const differs = remote === undefined ? undefined : difference(remote.game, JSON.parse(JSON.stringify(local)));
      if (differs !== undefined) {
        verified = false;
        console.warn(`nabu sync: the server's game state differs from this device's at ${differs}`);
      }
    }
    const pending = await store.pendingCount();
    if (state.account !== account) return;
    lastPass = Date.now();
    set({ phase: "idle", error: undefined, pending, ...(touched.size > 0 ? { verified } : {}), ...(fresh > 0 ? { pulled: state.pulled + 1 } : {}) });
  };

  const syncNow = async (): Promise<void> => {
    if (running !== undefined) {
      again = true;
      return running;
    }
    const account = state.account;
    if (account === undefined) return;
    // Claim the run before awaiting storage: simultaneous triggers must share this promise.
    running = (async () => {
      const pending = await store.pendingCount();
      if (state.account !== account) return;
      set({ phase: "syncing", pending });
      await pass(account);
    })()
      .catch(async (e: unknown) => {
        // A response to an old session must not clear a newer sign-in.
        if (state.account !== account) return;
        const error = errorOf(e);
        if (error === "signed-out") {
          await store.deleteMeta(ACCOUNT);
          if (state.account !== account) return;
          set({ account: undefined });
        }
        const pending = await store.pendingCount();
        if (state.account !== account && !(error === "signed-out" && state.account === undefined)) return;
        if (error === "unreachable" && pending > 0) void requestBackgroundSync();
        set({ phase: error === "unreachable" ? "offline" : "error", error, pending });
      })
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          void syncNow();
        }
      });
    return running;
  };

  const enter = async (path: string, email: string, password: string, age?: number): Promise<SyncError | undefined> => {
    const base = state.server;
    if (base === undefined) return "unreachable";
    try {
      const result = await request<{ user: Account["user"]; token: string }>(base, path, { body: age === undefined ? { email, password } : { email, password, age } });
      const account: Account = { server: base, token: result.token, user: result.user };
      await store.setMeta(ACCOUNT, account);
      await store.deleteMeta(CURSOR);
      set({ account, error: undefined });
      await syncNow();
      return undefined;
    } catch (e) {
      const error = errorOf(e);
      if (error === "age") {
        const servers = ((await store.getMeta(AGE_REFUSED)) ?? []) as string[];
        if (!servers.includes(base)) await store.setMeta(AGE_REFUSED, [...servers, base]);
        set({ ageRefused: true });
      }
      return error;
    }
  };

  /** This device no longer has an account: the session and the sync cursor go; its own log stays. */
  const forget = async (): Promise<void> => {
    await store.deleteMeta(ACCOUNT);
    await store.deleteMeta(CURSOR);
    set({ account: undefined, phase: "idle", error: undefined, verified: undefined });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    void store.pendingCount().then((pending) => set({ pending }));
    if (state.account === undefined) return;
    if (!navigator.onLine) void requestBackgroundSync();
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void syncNow(), DEBOUNCE_MS);
  };

  window.addEventListener("online", () => void syncNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (state.pending > 0 || Date.now() - lastPass > VISIBLE_QUIET_MS)) void syncNow();
  });
  // The service worker uploaded in the background: count again, pull and check.
  navigator.serviceWorker?.addEventListener("message", (e: MessageEvent<unknown>) => {
    if (!isSyncedMessage(e.data)) return;
    void store.pendingCount().then((pending) => set({ pending }));
    void syncNow();
  });
  setInterval(() => {
    if (state.account !== undefined && state.pending > 0) void syncNow();
  }, INTERVAL_MS);
  if (state.account !== undefined) void syncNow();

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signUp: (email, password, age) => enter("/v1/auth/sign-up", email, password, age),
    signIn: (email, password) => enter("/v1/auth/sign-in", email, password),
    signOut: async () => {
      const account = state.account;
      if (account !== undefined) await request(account.server, "/v1/auth/sign-out", { token: account.token, body: {} }).catch(() => undefined);
      await forget();
    },
    exportAccount: async () => {
      const account = state.account;
      if (account === undefined) return { ok: false, error: "signed-out" };
      try {
        return { ok: true, data: await request<unknown>(account.server, "/v1/export", { token: account.token }) };
      } catch (e) {
        return { ok: false, error: errorOf(e) };
      }
    },
    deleteAccount: async (password) => {
      const account = state.account;
      if (account === undefined) return "signed-out";
      try {
        await request(account.server, "/v1/account", { token: account.token, method: "DELETE", body: { password } });
      } catch (e) {
        return errorOf(e);
      }
      // The session went with the account: forget it here too, as signing out does.
      await forget();
      return undefined;
    },
    schedule,
    syncNow,
  };
};
