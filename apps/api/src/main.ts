/**
 * Runs the API. The database is Postgres when DATABASE_URL is set; otherwise
 * PGlite in NABU_PGLITE (a directory, or "memory"), defaulting to .data/pglite
 * With --dev, only NABU_DEV_DATABASE_URL / NABU_DEV_PGLITE are used (default .data/dev-pglite).
 * Listening defaults to 127.0.0.1; NABU_HOST can opt deployment into another interface.
 *
 * Per-instance options (gameplan §12):
 *   NABU_LEAGUES=1              weekly leagues (off by default)
 *   NABU_PUSH=1                 practice reminders by Web Push (off by default)
 *   NABU_VAPID_SUBJECT          mailto: or https: contact for push services
 *   NABU_VAPID_PRIVATE_JWK      VAPID key (else generated once and kept in the database)
 *   NABU_TEST_HOOKS=1           test-only routes: a push sink and a job runner (never in production)
 *   NABU_RATE_LIMITS=off        no abuse limits (default on: limits.ts DEFAULT_LIMITS)
 *   NABU_RATE_LIMIT_SIGN_UP, _SIGN_IN, _EVENTS   one limit as <max>/<seconds>, e.g. 5/3600
 *   NABU_TRUST_PROXY=1          the client address is the first X-Forwarded-For entry (behind a proxy you run)
 *   NABU_MIN_AGE                the age gate (ADR 0069): sign-up asks the age and needs at least this (unset: no gate)
 *
 * AI (gameplan §13; ai/providers.ts lists the model settings):
 *   NABU_LLM, NABU_LLM_MODEL, NABU_LLM_URL, NABU_LLM_KEY   the model (unset: every AI feature off)
 *   NABU_AI_KILL                switch features off: judge,explain:yue,roleplay:uz/uz-Cyrl
 *   NABU_AI_BUDGET_USER         model calls per learner per day and feature (default 100)
 *   NABU_AI_BUDGET_INSTANCE     model calls per day in all (default 5000)
 *   NABU_GATES                  judge gates file (default evals/gates.json)
 *   NABU_BUNDLES                compiled course bundles (default the web app's)
 *   NABU_ADMIN_TOKEN            bearer token for the review queue (/admin/v1)
 *
 * Speech (gameplan §10.4; tier 3, tone, runs on the device):
 *   NABU_SPEECH_URL             the speech service (`nabu speech serve`): tiers 1–2 (unset: off)
 *   NABU_FCM_SERVICE_ACCOUNT    reminders to the Android app: a Firebase service-account JSON (needs NABU_PUSH=1)
 *   NABU_APNS_KEY, NABU_APNS_KEY_ID, NABU_APNS_TEAM_ID, NABU_APNS_TOPIC (NABU_APNS_SANDBOX=1)
 *                               reminders to the iOS app: an APNs auth key (.p8) and its ids (needs NABU_PUSH=1)
 *   NABU_GAME                   the game rules: the game.json the web app is deployed with (default: the defaults)
 */
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { DEFAULT_GAME, DEFAULT_LEAGUE, gameConfig } from "@nabu/core/game";
import { createAccounts } from "./accounts.ts";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { EvalGate } from "@nabu/schema";
import { createCourses, DEFAULT_BUNDLES } from "./ai/courses.ts";
import { createGateway, DEFAULT_BUDGETS, validAi } from "./ai/gateway.ts";
import { providerFromEnv } from "./ai/providers.ts";
import { createApp } from "./app.ts";
import { serverConfig } from "./config.ts";
import { minAgeFromEnv } from "./age.ts";
import { limitsFromEnv } from "./limits.ts";
import { openDatabase } from "./db/index.ts";
import { rollover } from "./leagues.ts";
import { nativeSendersFromEnv } from "./nativepush.ts";
import { sendReminders } from "./reminders.ts";
import { sendPush, vapidKeys, type Vapid } from "./webpush.ts";

const env = process.env;
const { hostname, port, database } = serverConfig(env, process.argv.includes("--dev"));
const on = (name: string): boolean => env[name] === "1";
const { db, close } = await openDatabase(database);

const leagues = on("NABU_LEAGUES") ? DEFAULT_LEAGUE : undefined;
let vapid: Promise<Vapid> | undefined;
// An empty setting is an unset one: deploy/compose.yaml passes every option, set or not.
const keys = on("NABU_PUSH") ? () => (vapid ??= vapidKeys(db, process.env["NABU_VAPID_SUBJECT"] || "mailto:nabu@localhost")) : undefined;

const count = (name: string, fallback: number): number => {
  const n = Number(env[name] ?? fallback);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};
const dir = (value: string | undefined, fallback: URL): URL => (value === undefined || value === "" ? fallback : pathToFileURL(value.endsWith("/") ? value : `${value}/`));
const provider = providerFromEnv(env, (url, init) => fetch(url, init));
const gateway = createGateway({
  db,
  provider,
  kill: env["NABU_AI_KILL"],
  budgets: { perUser: count("NABU_AI_BUDGET_USER", DEFAULT_BUDGETS.perUser), perInstance: count("NABU_AI_BUDGET_INSTANCE", DEFAULT_BUDGETS.perInstance) },
});
const gatesFile = env["NABU_GATES"] === undefined || env["NABU_GATES"] === "" ? new URL("../../../evals/gates.json", import.meta.url) : pathToFileURL(env["NABU_GATES"]);
const gates = (JSON.parse(readFileSync(gatesFile, "utf8")) as unknown[]).filter((g): g is EvalGate => {
  if (validAi("EvalGate", g)) return true;
  console.warn("ignoring an invalid judge gate in", gatesFile.pathname);
  return false;
});
const courses = createCourses(dir(env["NABU_BUNDLES"], DEFAULT_BUNDLES));
console.info(provider === undefined ? "ai: no model configured; AI features are off" : `ai: ${provider.name} ${provider.model}; judge gates open: ${gates.filter((g) => g.enabled).length}`);

const speechUrl = env["NABU_SPEECH_URL"] === "" ? undefined : env["NABU_SPEECH_URL"];
// Native reminders need NABU_PUSH=1 (reminders on) and a platform's credentials.
const native = on("NABU_PUSH") ? nativeSendersFromEnv(env) : {};
const game = env["NABU_GAME"] === undefined || env["NABU_GAME"] === "" ? DEFAULT_GAME : gameConfig(JSON.parse(readFileSync(env["NABU_GAME"], "utf8")) as Parameters<typeof gameConfig>[0]);
const app = createApp({
  db,
  accounts: createAccounts(db),
  leagues,
  vapid: keys,
  ai: { gateway, courses, gates },
  adminToken: env["NABU_ADMIN_TOKEN"],
  speech: { url: speechUrl, transport: (url, init) => fetch(url, init) },
  game,
  native,
  limits: limitsFromEnv(env),
  minAge: minAgeFromEnv(env["NABU_MIN_AGE"]),
  // Behind a proxy every request comes from it: then the address it forwards counts, and only then,
  // as anyone can send that header.
  clientOf: (c) => (on("NABU_TRUST_PROXY") ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : getConnInfo(c).remote.address) || undefined,
});

/** The periodic jobs: league rollover and reminders. */
const runJobs = async (now: number): Promise<{ rolled: readonly string[]; sent: number }> => {
  const rolled = leagues === undefined ? [] : await rollover(db, now, leagues);
  let sent = 0;
  if (keys !== undefined || Object.keys(native).length > 0) {
    const v = keys === undefined ? undefined : await keys();
    sent = (await sendReminders(db, now, v === undefined ? undefined : (sub, payload) => sendPush(sub, payload, v, now, (url, init) => fetch(url, init)), native)).sent;
  }
  return { rolled, sent };
};

if (on("NABU_TEST_HOOKS")) {
  // A push service stand-in and a way to run the jobs at a chosen time, for end-to-end tests.
  const received = new Map<string, Uint8Array[]>();
  app.post("/test/push/:id", async (c) => {
    received.set(c.req.param("id"), [...(received.get(c.req.param("id")) ?? []), new Uint8Array(await c.req.arrayBuffer())]);
    return c.body(null, 201);
  });
  app.get("/test/push/:id", (c) => c.json({ messages: (received.get(c.req.param("id")) ?? []).map((b) => Buffer.from(b).toString("base64url")) }));
  app.post("/test/jobs", async (c) => c.json(await runJobs(Number(c.req.query("now") ?? Date.now()))));
} else if (leagues !== undefined || keys !== undefined) {
  const tick = (): void => void runJobs(Date.now()).catch((e: unknown) => console.error("jobs", e));
  setInterval(tick, 5 * 60_000).unref();
}

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  const host = info.address.includes(":") ? `[${info.address}]` : info.address;
  console.log(`api listening on http://${host}:${info.port}`);
});

const shutdown = (): void => {
  server.close();
  void close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
