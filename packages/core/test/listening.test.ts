/**
 * Listening templates (gameplan §8.1, §10): they appear only where a clip exists, grade like
 * their reading twins, find minimal pairs from pinned readings or letters, and "can't listen
 * now" drops them from the rest of the lesson. The course views get a stand-in clip for every
 * item, so these tests do not depend on which committed clips passed QA.
 */
import type { BundleAudioItem } from "@nabu/schema";
import { describe, expect, it } from "vitest";
import { emptyLearnerState, plan, replay } from "../src/learner/index.ts";
import {
  allKcs,
  allSentences,
  createGrader,
  gradeExercise,
  isCorrect,
  KC_LISTENING,
  profileOf,
  LISTENING,
  lessonNodes,
  seededRng,
  start,
  step,
  type CourseView,
  type MakeContext,
} from "../src/lesson/index.ts";
import { makeListenSelect, SENTENCE_TEMPLATES } from "../src/lesson/templates.ts";
import { surfaceOf } from "../src/text/index.ts";
import { eventFactory, loadCourse, manifestOf } from "./learner-fixtures.ts";

const clip = (item: string): BundleAudioItem => ({
  normal: { path: `audio/${item}.mp3`, durationMs: 1000, synthetic: true, license: "CC0-1.0", timings: [{ token: 0, startMs: 0, endMs: 500 }] },
});

/** A course view where every sentence and KC has a clip. */
const withAudio = (course: CourseView): CourseView => ({
  ...course,
  audio: Object.fromEntries([...allSentences(course).map((s) => s.id), ...allKcs(course).map((k) => k.id)].map((id) => [id, clip(id)])),
});

const ctxOf = (course: CourseView, seed = 3): MakeContext => ({ course, rng: seededRng(seed), introduced: [] });

describe("listening templates", () => {
  const fa = withAudio(loadCourse("fa"));
  const grader = createGrader(fa);

  it("need a clip: none without audio", () => {
    const silent = loadCourse("fa");
    const ctx = ctxOf({ ...silent, audio: {} });
    const s = allSentences(silent).find((x) => x.id === "s.4");
    if (s === undefined) throw new Error("fa has no s.4");
    expect(SENTENCE_TEMPLATES["listen-tap"]?.(ctx, s)).toBeUndefined();
    expect(SENTENCE_TEMPLATES["listen-type"]?.(ctx, s)).toBeUndefined();
  });

  it("listen-tap and listen-type grade what was said, in the target", () => {
    const ctx = ctxOf(fa);
    const s = allSentences(fa).find((x) => x.id === "s.4");
    if (s === undefined) throw new Error("fa has no s.4");
    const tap = SENTENCE_TEMPLATES["listen-tap"]?.(ctx, s);
    const type = SENTENCE_TEMPLATES["listen-type"]?.(ctx, s);
    if (tap?.template !== "listen-tap" || type?.template !== "listen-type") throw new Error("no listening exercise for s.4");
    expect(tap.audio.normal.path).toBe("audio/s.4.mp3");
    expect(tap.orthography).toBe("fa-Arab/standard");
    expect(gradeExercise(tap, { tag: "tiles", order: tap.solution }, grader).verdict).toBe("CORRECT");
    expect(isCorrect(gradeExercise(type, { tag: "text", text: surfaceOf(type.canonical) }, grader).verdict)).toBe(true);
    expect(isCorrect(gradeExercise(type, { tag: "text", text: "qqq" }, grader).verdict)).toBe(false);
  });

  it("listen-select offers the word's written form among others", () => {
    const ctx = ctxOf(fa);
    const made = allKcs(fa).map((kc) => makeListenSelect(ctx, kc)).filter((e): e is NonNullable<typeof e> => e !== undefined);
    expect(made.length).toBeGreaterThan(3);
    for (const ex of made) {
      expect(ex.options).toHaveLength(3);
      expect(gradeExercise(ex, { tag: "choice", index: ex.answer }, grader).verdict).toBe("CORRECT");
    }
  });

  /** A copy of the course with one more word: `like`'s KC respelled `surface` (with its reading). */
  const withWord = (course: CourseView, like: string, surface: string, reading?: string): CourseView => {
    const [unit, ...rest] = course.units;
    if (unit === undefined) throw new Error("no unit");
    const kc = unit.kcs.find((k) => k.forms?.[course.orthography]?.[0]?.tokens.map((t) => t.surface).join("") === like);
    const form = kc?.forms?.[course.orthography]?.[0];
    if (kc === undefined || form === undefined) throw new Error(`no word ${like}`);
    const token = { ...form.tokens[0], surface, ...(reading === undefined ? {} : { readings: { jyutping: reading } }) } as (typeof form.tokens)[0];
    const respelled = { ...form, tokens: [token] };
    const extra = { ...kc, id: `sense:${surface}` as typeof kc.id, forms: { [course.orthography]: [respelled] } };
    const sentence = unit.sentences.find((x) => x.forms[course.orthography] !== undefined);
    const carrier = sentence === undefined ? [] : [{ ...sentence, id: `s.carrier.${surface}`, forms: { [course.orthography]: { ...sentence.forms[course.orthography], text: respelled } } }];
    return withAudio({ ...course, units: [{ ...unit, kcs: [...unit.kcs, extra], sentences: [...unit.sentences, ...carrier] }, ...rest] as CourseView["units"] });
  };

  /** Every pair the template offers, over several seeds (each draw picks one rival per word). */
  const pairsOf = (course: CourseView): string[] => [
    ...new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) =>
        allKcs(course).flatMap((kc) => {
          const ex = KC_LISTENING[1]?.(ctxOf(course, seed), kc);
          return ex?.template === "minimal-pair" ? [ex.options.map((o) => surfaceOf(o)).sort().join("/")] : [];
        }),
      ),
    ),
  ];

  // Keep the full-course, eight-seed coverage; independent cases identify which language broke.
  it("Uzbek minimal pairs differ by exactly one orthographic letter", { timeout: 60_000 }, () => {
    const uz = loadCourse("uz", "uz-Latn/standard");
    // The fixture's own pairs (yoʻl/yoʻq, bor/qor, uch/uy…) are each one letter apart, counted in the
    // orthography's letters (ch, sh, ng, oʻ and gʻ are one letter each), as the template counts.
    const own = pairsOf(withAudio(uz));
    expect(own).toEqual(expect.arrayContaining(["yoʻl/yoʻq"]));
    /** Edit distance in letters: one substitution, insertion or deletion apart is a pair. */
    const distance = (a: readonly string[], b: readonly string[]): number => {
      let row = b.map((_, j) => j + 1);
      for (const [i, g] of a.entries()) {
        const next = [i + 1];
        for (const [j, h] of b.entries()) next.push(Math.min((row[j] ?? 0) + 1, (next[j] ?? 0) + 1, (j === 0 ? i : (row[j - 1] ?? 0)) + (g === h ? 0 : 1)));
        row = next.slice(1);
      }
      return row.at(-1) ?? a.length;
    };
    const letters = profileOf(uz, uz.orthography);
    for (const pair of own) {
      const [a = [], b = []] = pair.split("/").map((w) => letters.units(letters.normalize(w)));
      expect(distance(a, b), pair).toBe(1);
    }
  });

  it("an added Uzbek word participates in minimal pairs", { timeout: 60_000 }, () => {
    expect(pairsOf(withWord(loadCourse("uz", "uz-Latn/standard"), "men", "sen"))).toContain("men/sen");
  });

  it("Cantonese minimal pairs differ by one sound or tone", { timeout: 60_000 }, () => {
    // The fixture's own: 呀 aa3 / 嗎 maa3 (an onset), 係 hai6 / 喺 hai2 (a tone), 五 ng5 / 我 ngo5 (a final);
    // 嗎 maa3 and 啦 laa1 differ in two places, so they are no pair. Add 媽 maa1: 嗎/媽 differ in tone,
    // 啦 laa1/媽 in the onset.
    const yuePairs = pairsOf(withAudio(loadCourse("yue")));
    expect(yuePairs).toEqual(expect.arrayContaining(["呀/嗎", "係/喺", "五/我"]));
    expect(yuePairs).not.toContain("啦/嗎");
  });

  it("an added Cantonese reading participates in tone and onset contrasts", { timeout: 60_000 }, () => {
    const pairs = pairsOf(withWord(loadCourse("yue"), "嗎", "媽", "maa1"));
    expect(pairs).toEqual(expect.arrayContaining(["呀/嗎", "嗎/媽", "啦/媽"]));
    expect(pairs).not.toContain("啦/嗎");
  });

  it("a missed word-level exercise comes back in mistakes mode", () => {
    const ex = allKcs(fa)
      .map((k) => KC_LISTENING[0]?.(ctxOf(fa), k))
      .find((e) => e !== undefined);
    if (ex === undefined) throw new Error("no listen-select in fa");
    const events = eventFactory(fa, manifestOf("fa").id);
    events.at("2026-03-01T08:00:00.000Z");
    const state = replay([events.answer(ex, false, 1)]);
    expect(state.mistakes.map((m) => m.item)).toEqual([ex.item]);
    const m = plan(fa, state, { mode: "mistakes" }, { now: "2026-03-01T09:00:00.000Z", seed: 2 });
    expect(m.exercises.map((e) => `${e.template}:${e.item}`)).toEqual([`listen-select:${ex.item}`]);
  });

  it("the planner mixes listening into lessons, and leaves it out on request", () => {
    const node = lessonNodes(fa)[1]?.node.id as string;
    const state = emptyLearnerState();
    const options = { now: "2026-03-01T08:00:00.000Z", seed: 5 };
    const all = [lessonNodes(fa)[0]?.node.id as string, node].flatMap((n) => plan(fa, state, { mode: "lesson", node: n }, options).exercises);
    expect(all.some((e) => LISTENING.has(e.template))).toBe(true);
    const quiet = plan(fa, state, { mode: "lesson", node }, { ...options, exclude: LISTENING }).exercises;
    expect(quiet.some((e) => LISTENING.has(e.template))).toBe(false);
  });

  it("“Can't listen now” drops the rest of the lesson's listening", () => {
    const ctx = ctxOf(fa);
    const sentences = allSentences(fa).filter((s) => s.id.startsWith("s."));
    const listening = sentences.flatMap((s) => SENTENCE_TEMPLATES["listen-type"]?.(ctx, s) ?? []).slice(0, 2);
    const reading = sentences.flatMap((s) => SENTENCE_TEMPLATES["choose-translation"]?.(ctx, s) ?? []).slice(0, 1);
    let [state] = start("l", [...listening, ...reading]);
    [state] = step(state, { tag: "ready" });
    [state] = step(state, { tag: "skip", reason: "cant-listen" });
    expect(state.tag === "presenting" ? state.ex.template : state.tag).toBe("choose-translation");
  });
});
