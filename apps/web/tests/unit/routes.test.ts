import { expect, it } from "vitest";
import { href, parseRoute, type Route } from "../../src/routes.ts";

const course = { course: "fa", orthography: "fa-Arab/standard" };
const routes: Route[] = [
  { tag: "home" },
  { tag: "preferences" },
  { tag: "review" },
  ...(["course", "review-course", "sentences", "cards", "audio", "words"] as const).map((tag) => ({ tag, ...course })),
  { tag: "story", ...course, node: "fa.story/یک %" },
  { tag: "roleplay", ...course, scenario: "hello/سلام %" },
  { tag: "session", ...course, request: { mode: "lesson", node: "fa.lesson/یک %" } },
  ...(["review", "mistakes", "placement"] as const).map((mode) => ({ tag: "session" as const, ...course, request: { mode } })),
];

it.each(routes)("round trips $tag links, including encoded node IDs", (route) => {
  expect(parseRoute(href(route))).toEqual(route);
});

it.each(["#/fa/%", "#/fa/%E0%A4%A", "#/fa/fa-Arab.standard/%FF", "#/review/%/fa-Arab.standard"])("recovers from malformed URL encoding: %s", (hash) => {
  expect(parseRoute(hash)).toEqual({ tag: "home" });
});

it.each(["", "#", "#/", "#/fa"])("opens home for an incomplete link: %s", (hash) => {
  expect(parseRoute(hash)).toEqual({ tag: "home" });
});
