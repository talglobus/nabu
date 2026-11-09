import { describe, expect, it } from "vitest";
import { serverConfig } from "../src/config.ts";

describe("server startup configuration", () => {
  it("defaults to loopback and a local database", () => {
    expect(serverConfig({})).toEqual({ hostname: "127.0.0.1", port: 8787, database: { pglite: ".data/pglite", url: undefined } });
  });

  it("isolates development from inherited deployment settings", () => {
    expect(serverConfig({ DATABASE_URL: "postgres://production/nabu", NABU_PGLITE: "/production", NABU_HOST: "0.0.0.0" }, true))
      .toEqual({ hostname: "127.0.0.1", port: 8787, database: { pglite: ".data/dev-pglite", url: undefined } });
  });

  it("accepts a separately configured development database", () => {
    expect(serverConfig({ NABU_DEV_DATABASE_URL: "postgres://localhost/dev", NABU_DEV_PGLITE: "memory" }, true).database)
      .toEqual({ url: "postgres://localhost/dev", pglite: "memory" });
  });

  it("allows deployment to opt into network access and Postgres", () => {
    expect(serverConfig({ NABU_HOST: "0.0.0.0", PORT: "9000", DATABASE_URL: "postgres://db/nabu" }))
      .toMatchObject({ hostname: "0.0.0.0", port: 9000, database: { url: "postgres://db/nabu" } });
  });

  it.each(["-1", "0", "65536", "1.5", "NaN", " "])("rejects invalid port %s before database startup", (port) => {
    expect(() => serverConfig({ PORT: port })).toThrow("PORT must be an integer");
  });

  it("rejects test routes in production", () => {
    expect(() => serverConfig({ NODE_ENV: "production", NABU_TEST_HOOKS: "1" })).toThrow("NABU_TEST_HOOKS");
    expect(() => serverConfig({ NABU_TEST_HOOKS: "1" })).not.toThrow();
  });
});
