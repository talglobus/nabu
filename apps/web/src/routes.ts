import type { SessionRequest } from "@nabu/core/learner";

export type Route =
  | { readonly tag: "home" }
  | { readonly tag: "preferences" }
  | { readonly tag: "course"; readonly course: string; readonly orthography: string }
  | { readonly tag: "session"; readonly course: string; readonly orthography: string; readonly request: SessionRequest }
  | { readonly tag: "story"; readonly course: string; readonly orthography: string; readonly node: string }
  | { readonly tag: "roleplay"; readonly course: string; readonly orthography: string; readonly scenario: string }
  | { readonly tag: "sentences"; readonly course: string; readonly orthography: string }
  | { readonly tag: "cards"; readonly course: string; readonly orthography: string }
  | { readonly tag: "audio"; readonly course: string; readonly orthography: string }
  | { readonly tag: "words"; readonly course: string; readonly orthography: string }
  | { readonly tag: "review" }
  | { readonly tag: "review-course"; readonly course: string; readonly orthography: string };

/** Orthography ids carry a "/" (fa-Arab/standard): "." in the URL. */
export const slug = (orthography: string): string => orthography.replace("/", ".");
const unslug = (s: string): string => s.replace(".", "/");

/** Node ids are course-prefixed ("fa.book"), so they never collide with "review", "mistakes" or "placement". */
const requestOf = (segment: string): SessionRequest =>
  segment === "review" || segment === "mistakes" || segment === "placement" ? { mode: segment } : { mode: "lesson", node: segment };

export const parseRoute = (hash: string): Route => {
  let segments: string[];
  try {
    segments = hash.replace(/^#\/?/u, "").split("/").filter((p) => p !== "").map(decodeURIComponent);
  } catch {
    // A truncated or malformed shared link must not prevent the app from rendering.
    return { tag: "home" };
  }
  const [course, orthography, session, node] = segments;
  if (course === "preferences" && orthography === undefined) return { tag: "preferences" };
  // The review workspace (ADR 0074): #/review, and #/review/<course>/<orthography>.
  if (course === "review") return orthography === undefined || session === undefined ? { tag: "review" } : { tag: "review-course", course: orthography, orthography: unslug(session) };
  if (course === undefined || orthography === undefined) return { tag: "home" };
  if (session === undefined) return { tag: "course", course, orthography: unslug(orthography) };
  if (session === "sentences") return { tag: "sentences", course, orthography: unslug(orthography) };
  if (session === "cards") return { tag: "cards", course, orthography: unslug(orthography) };
  if (session === "audio") return { tag: "audio", course, orthography: unslug(orthography) };
  if (session === "words") return { tag: "words", course, orthography: unslug(orthography) };
  if (session === "story" && node !== undefined) return { tag: "story", course, orthography: unslug(orthography), node };
  if (session === "roleplay" && node !== undefined) return { tag: "roleplay", course, orthography: unslug(orthography), scenario: node };
  return { tag: "session", course, orthography: unslug(orthography), request: requestOf(session) };
};

const segmentOf = (request: SessionRequest): string => (request.mode === "lesson" ? encodeURIComponent(request.node) : request.mode);

export const href = (route: Route): string =>
  route.tag === "home"
    ? "#/"
    : route.tag === "preferences"
      ? "#/preferences"
      : route.tag === "review"
        ? "#/review"
        : route.tag === "review-course"
          ? `#/review/${route.course}/${slug(route.orthography)}`
      : route.tag === "course"
      ? `#/${route.course}/${slug(route.orthography)}`
      : route.tag === "story"
        ? `#/${route.course}/${slug(route.orthography)}/story/${encodeURIComponent(route.node)}`
        : route.tag === "roleplay"
          ? `#/${route.course}/${slug(route.orthography)}/roleplay/${encodeURIComponent(route.scenario)}`
          : route.tag === "sentences" || route.tag === "cards" || route.tag === "audio" || route.tag === "words"
            ? `#/${route.course}/${slug(route.orthography)}/${route.tag}`
            : `#/${route.course}/${slug(route.orthography)}/${segmentOf(route.request)}`;

