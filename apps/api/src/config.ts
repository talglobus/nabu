import type { DatabaseOptions } from "./db/index.ts";

/** Resolve startup settings before opening a database or listening on a socket. */
export const serverConfig = (env: Readonly<Record<string, string | undefined>>, development = false): {
  hostname: string;
  port: number;
  database: DatabaseOptions;
} => {
  const port = Number(env["PORT"] || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  if (env["NODE_ENV"] === "production" && env["NABU_TEST_HOOKS"] === "1") {
    throw new Error("NABU_TEST_HOOKS must not be enabled in production");
  }
  return {
    hostname: development ? "127.0.0.1" : env["NABU_HOST"] || "127.0.0.1",
    port,
    // Development never inherits a deployment's database URL or PGlite directory.
    database: development
      ? { url: env["NABU_DEV_DATABASE_URL"] || undefined, pglite: env["NABU_DEV_PGLITE"] || ".data/dev-pglite" }
      : { url: env["DATABASE_URL"] || undefined, pglite: env["NABU_PGLITE"] || ".data/pglite" },
  };
};
