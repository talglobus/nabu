/**
 * The web client (gameplan §11.1): the course list, a course's path, and
 * sessions (a lesson, review or mistakes). Routes live in the URL hash so the
 * static build works anywhere (GitHub Pages):
 *   #/ · #/<course>/<orthography> · #/<course>/<orthography>/<node | review | mistakes | placement>
 *   · #/<course>/<orthography>/story/<node> · #/<course>/<orthography>/roleplay/<scenario>
 *
 * Local-first (§14.2): every learner event goes to the on-device log, and the
 * path, XP and the next session are projections of it, computed by @nabu/core.
 * An account is optional; with one, the log syncs to the server.
 */
import { applyEvents, dueFacets, pathNodes, pathOf, plan, practicableMistakes, replay, scriptPathOf, type LearnerState, type NodeStatus, type PathEntry, type SessionRequest } from "@nabu/core/learner";
import { createGrader, LISTENING, seededRng, SPEAKING, speechSupportOf, type TemplateId } from "@nabu/core/lesson";
import type { GameConfig, GameState } from "@nabu/core/game";
import { draftCount } from "@nabu/core/corrections";
import { restrictMedia } from "@nabu/core/offline";
import { storyAt, storyScript } from "@nabu/core/story";
import { directionOf } from "@nabu/i18n";
import type { AnswerSubmitted, LearnerEvent, SchemeId, SentenceReported } from "@nabu/schema";
import { CorrectIcon, CourseUiProvider, LockIcon, T, useTranslator } from "@nabu/ui";
import { fetchCourse, fetchCourseIndex, LessonPlayer, type CourseIndexEntry, type LoadedCourse } from "@nabu/ui/player";
import { StoryReader } from "@nabu/ui/story";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from "react";
import { AnswerHelp, Conversations, RoleplayPage, useAccount, useAiStatus, type AiStatus } from "./ai.tsx";
import { serverAllowed, speechServices, useSpeechTiers } from "./voice.ts";
import styles from "./App.module.css";
import { localDate } from "./clock.ts";
import { MarkExercise, MarkIncorrect, SentencesPage, useCorrections } from "./Corrections.tsx";
import { ReviewHome, ReviewPage, useReviewer } from "./Review.tsx";
import { WordsPage } from "./Words.tsx";
import { reportIntake } from "./reports.ts";
import { AudioCheckPage } from "./AudioCheck.tsx";
import { CardsPage, debugOn } from "./Debug.tsx";
import { GamePanel, loadGameConfig, sessionAllowed, useGame } from "./game.tsx";
import { Progress } from "./Progress.tsx";
import { OfflineNotice, OfflinePanel } from "./Offline.tsx";
import { PreferencesPage } from "./Preferences.tsx";
import { offlineSupported, registerWorker, useOnline, useStored } from "./offline.ts";
import { startNative } from "./native.ts";
import { isNative } from "./platform.ts";
import { LeaguePanel } from "./social.tsx";
import { recorder, resetEvent, storyRecorder } from "./session.ts";
import { StartOver } from "./StartOver.tsx";
import { openStore, type EventStore } from "./store.ts";
import { createSync, type Account, type Sync } from "./sync.ts";
import { href, parseRoute, slug, type Route } from "./routes.ts";

const BUNDLES = `${import.meta.env.BASE_URL}bundles/`;

/**
 * Courses offline in the browser (Phase 10): production builds with a service worker. The dev
 * server serves modules the worker cannot keep, and native builds ship every course inside.
 */
const OFFLINE = import.meta.env.PROD && offlineSupported() && !isNative();

/** Debug mode (?debug=1, remembered on this device): every card says its kind; a gallery of every kind. */
const DEBUG = debugOn();

export { href } from "./routes.ts";

const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
};

type Translator = ReturnType<typeof useTranslator>;

const courseName = (t: Translator, id: string): string => {
  const key = `course.name.${id}`;
  return t.has(key) ? t.format(key) : id;
};

const orthographyName = (t: Translator, id: string): string => {
  const key = `orthography.${slug(id)}`;
  return t.has(key) ? t.format(key) : id;
};

interface GameProps {
  readonly game: GameState | null;
  readonly gameConfig: GameConfig | null;
}

const Home = ({ courses, store, sync, game, gameConfig, version, online }: { courses: readonly CourseIndexEntry[]; store: EventStore; sync: Sync; version: string; online: boolean } & GameProps): JSX.Element => {
  const t = useTranslator();
  const account = useSyncExternalStore(sync.subscribe, () => sync.get().account);
  const reviewer = useReviewer(sync);
  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>{t.format("app.home.title")}</h1>
      {!online && <OfflineNotice />}
      {game !== null && gameConfig !== null && <GamePanel state={game} config={gameConfig} />}
      {account !== undefined && <LeaguePanel account={account} version={version} />}
      <ul className={styles.list} data-course-list="">
        {courses.map((c) => (
          <li key={c.id} className={styles.course} data-course={c.id}>
            <h2 className={styles.courseName}>{courseName(t, c.id)}</h2>
            {c.orthographies.length > 1 && <p className={styles.muted}>{t.format("app.home.writing")}</p>}
            <div className={styles.links}>
              {c.orthographies.map((o) => (
                <a key={o} className={styles.link} href={href({ tag: "course", course: c.id, orthography: o })} data-orthography={o}>
                  {orthographyName(t, o)}
                </a>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <Progress store={store} sync={sync} />
      <div className={styles.links}>
        <a className={styles.link} href={href({ tag: "preferences" })} data-preferences-link="">
          {t.format("app.preferences.link")}
        </a>
        {reviewer.kind === "reviewer" && (
          <a className={styles.link} href={href({ tag: "review" })} data-review-link="">
            {t.format("review.workspace.link")}
          </a>
        )}
      </div>
    </main>
  );
};

const STATUS_LABEL = { done: "app.path.done", available: "app.path.start", locked: "app.path.locked" } as const;

const Status = ({ status }: { status: NodeStatus }): JSX.Element => {
  const t = useTranslator();
  return (
    <span className={styles.status} data-status-label="">
      {status === "done" && <CorrectIcon size={20} />}
      {status === "locked" && <LockIcon size={18} />}
      {t.format(STATUS_LABEL[status])}
    </span>
  );
};

/** The course's path (§11.1): practice, XP, and the lessons in order, each done, open or locked. */
/** The course's offline state, where this build keeps courses offline. */
interface OfflineProps {
  readonly online: boolean;
  readonly root: string;
  readonly stored: ReadonlySet<string> | undefined;
  readonly onChange: () => void;
}

const CoursePath = ({
  loaded,
  state,
  persistent,
  ai,
  offline,
  speechTiers,
  onReset,
}: {
  loaded: LoadedCourse;
  state: LearnerState;
  persistent: boolean;
  ai: AiStatus;
  offline: OfflineProps;
  speechTiers: readonly number[];
  onReset: () => void;
}): JSX.Element => {
  const t = useTranslator();
  const [off, setOff] = useState(() => ({ listening: onBreak("listening"), speaking: onBreak("speaking") }));
  const { course } = loaded;
  const orthography = course.orthography;
  const now = new Date();
  const status = new Map(pathOf(course, state).map((n) => [n.node, n.status]));
  // A script track (ADR 0088): the alphabet, a row of its own that never gates the units.
  const scriptRow = scriptPathOf(course, state);
  const due = dueFacets(state, orthography, now.toISOString()).length;
  const studied = Object.keys(state.cards).length > 0;
  // What a mistakes session would hold now: a mistake on a listening card waits out a listening
  // break, and one the course no longer makes is not counted (practicableMistakes).
  const mistakes = useMemo(
    () => practicableMistakes(course, state, { exclude: excludedBy(off), speech: speechSupportOf(course, serverAllowed() ? speechTiers.length : 0) }).length,
    [course, state, off, speechTiers],
  );
  const today = state.xp.byDate[localDate(now)] ?? 0;
  // The demo's full builds keep drafts and say so (ADR 0073); a release build has none.
  const drafts = draftCount(course.units);
  const units = pathNodes(course).reduce<{ unit: PathEntry["unit"]; entries: PathEntry[] }[]>((acc, entry) => {
    const last = acc.at(-1);
    if (last?.unit === entry.unit) last.entries.push(entry);
    else acc.push({ unit: entry.unit, entries: [entry] });
    return acc;
  }, []);
  let number = 0;
  const to = (request: SessionRequest): string => href({ tag: "session", course: course.id, orthography, request });

  return (
    <main className={styles.page} data-course-path={course.id}>
      <p>
        <a className={styles.back} href={href({ tag: "home" })}>
          {t.format("app.lessons.back")}
        </a>
      </p>
      <h1 className={styles.heading}>
        {courseName(t, course.id)} · {orthographyName(t, orthography)}
      </h1>
      <p className={styles.stats} data-xp={state.xp.total} data-xp-today={today}>
        <span className={styles.stat}>{t.format("app.xp.total", { xp: state.xp.total })}</span>
        <span className={styles.stat}>{t.format("app.xp.today", { xp: today })}</span>
      </p>
      {!offline.online && <OfflineNotice />}
      {drafts.drafts > 0 && (
        <p className={styles.notice} role="note" data-drafts={drafts.drafts}>
          {t.format("app.course.drafts", { drafts: drafts.drafts, total: drafts.total })}
        </p>
      )}
      {!persistent && (
        <p className={styles.notice} role="note" data-not-saved="">
          {t.format("app.store.memory")}
        </p>
      )}
      {off.listening && (
        <p className={styles.notice} role="note" data-listening-off="">
          {t.format("app.listening.off")}{" "}
          <button
            type="button"
            className={styles.inlineButton}
            onClick={() => {
              setBreakUntil("listening", 0);
              setOff({ ...off, listening: false });
            }}
            data-action="listening-on"
          >
            {t.format("app.listening.on")}
          </button>
        </p>
      )}
      {off.speaking && (
        <p className={styles.notice} role="note" data-speaking-off="">
          {t.format("app.speaking.off")}{" "}
          <button
            type="button"
            className={styles.inlineButton}
            onClick={() => {
              setBreakUntil("speaking", 0);
              setOff({ ...off, speaking: false });
            }}
            data-action="speaking-on"
          >
            {t.format("app.speaking.on")}
          </button>
        </p>
      )}

      {state.completedNodes.length === 0 && (
        <p>
          <a className={styles.back} href={to({ mode: "placement" })} data-practice-mode="placement">
            {t.format("app.practice.placement", { language: courseName(t, course.id) })}
          </a>
        </p>
      )}

      <h2 className={styles.subheading}>{t.format("app.practice.title")}</h2>
      <div className={styles.links} data-practice="">
        {studied ? (
          <a className={styles.link} href={to({ mode: "review" })} data-practice-mode="review" data-count={due}>
            {t.format("app.practice.review")}
            <span className={styles.count}>{t.format("app.practice.due", { count: due })}</span>
          </a>
        ) : (
          <span className={`${styles.link} ${styles.disabled}`} aria-disabled="true" data-practice-mode="review" data-count={0}>
            {t.format("app.practice.review")}
          </span>
        )}
        {mistakes > 0 ? (
          <a className={styles.link} href={to({ mode: "mistakes" })} data-practice-mode="mistakes" data-count={mistakes}>
            {t.format("app.practice.mistakes")}
            <span className={styles.count}>{t.format("app.practice.to-fix", { count: mistakes })}</span>
          </a>
        ) : (
          <span className={`${styles.link} ${styles.disabled}`} aria-disabled="true" data-practice-mode="mistakes" data-count={0}>
            {t.format("app.practice.mistakes")}
          </span>
        )}
      </div>

      <h2 className={styles.subheading}>{t.format("app.lessons.title")}</h2>
      {scriptRow.length > 0 && (
        <section className={styles.unit} data-script-track="">
          {(() => {
            const first = course.units.find((u) => u.id === scriptRow[0]?.unit);
            const title = first?.title?.[course.supportKey];
            return title === undefined ? null : (
              <h3 className={styles.unitTitle}>
                <T text={title} />
              </h3>
            );
          })()}
          <ol className={styles.list}>
            {scriptRow.map((entry, k) => {
              const unit = course.units.find((u) => u.id === entry.unit);
              const node = unit?.nodes.find((n) => n.id === entry.node);
              const letters = node?.alphabet?.letters.map((l) => l.text) ?? [];
              const body = (
                <>
                  <span className={styles.lessonHead}>
                    <span className={styles.lessonName}>{t.format("app.path.letters", { number: k + 1 })}</span>
                    <Status status={entry.status} />
                  </span>
                  <span className={styles.preview} role="group" aria-label={t.format("app.path.new-letters")} dir={letters[0] === undefined ? undefined : directionOf(letters[0].lang)}>
                    {letters.map((l, i) => (
                      <T key={i} text={l} />
                    ))}
                  </span>
                </>
              );
              return (
                <li key={entry.node}>
                  {entry.status === "locked" ? (
                    <div className={`${styles.lesson} ${styles.locked}`} aria-disabled="true" data-script-node={entry.node} data-status={entry.status}>
                      {body}
                    </div>
                  ) : (
                    <a className={`${styles.lesson} ${entry.status === "available" ? styles.next : ""}`} href={to({ mode: "lesson", node: entry.node })} data-script-node={entry.node} data-status={entry.status}>
                      {body}
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {units.map(({ unit, entries }) => {
        const title = unit.title?.[course.supportKey];
        return (
          <section key={unit.id} className={styles.unit}>
            {title !== undefined && units.length > 1 && (
              <h3 className={styles.unitTitle}>
                <T text={title} />
              </h3>
            )}
            <ol className={styles.list} data-lesson-list="">
              {entries.map(({ node, kind }) => {
                const s = status.get(node.id) ?? "locked";
                const story = kind === "story" ? (unit.stories ?? []).find((st) => st.node === node.id) : undefined;
                const storyTitle = story?.title[course.supportKey];
                if (kind === "lesson") number++;
                const words = node.introduces.flatMap((id) => unit.kcs.find((k) => k.id === id)?.forms?.[orthography]?.[0] ?? []);
                const body =
                  kind === "story" ? (
                    <>
                      <span className={styles.lessonHead}>
                        <span className={styles.lessonName}>{t.format("app.path.story")}</span>
                        <Status status={s} />
                      </span>
                      {storyTitle !== undefined && (
                        <span className={styles.preview}>
                          <T text={storyTitle} />
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className={styles.lessonHead}>
                        <span className={styles.lessonName}>{t.format("app.lessons.lesson", { number })}</span>
                        <Status status={s} />
                      </span>
                      <span className={styles.preview} role="group" aria-label={t.format("app.lessons.new-words")} dir={words[0] === undefined ? undefined : directionOf(words[0].lang)}>
                        {words.map((w, k) => (
                          <T key={k} text={w} />
                        ))}
                      </span>
                    </>
                  );
                const link = kind === "story" ? href({ tag: "story", course: course.id, orthography, node: node.id }) : to({ mode: "lesson", node: node.id });
                const data = kind === "story" ? { "data-story-node": node.id } : { "data-lesson": node.id };
                return (
                  <li key={node.id}>
                    {s === "locked" ? (
                      <div className={`${styles.lesson} ${styles.locked}`} aria-disabled="true" {...data} data-status={s}>
                        {body}
                      </div>
                    ) : (
                      <a className={`${styles.lesson} ${s === "available" ? styles.next : ""}`} href={link} {...data} data-status={s}>
                        {body}
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      <Conversations course={course} state={state} status={ai} link={(scenario) => href({ tag: "roleplay", course: course.id, orthography, scenario })} />
      <p>
        <a className={styles.link} href={href({ tag: "words", course: course.id, orthography })} data-words-link="">
          {t.format("words.title")}
        </a>
      </p>
      <p>
        <a className={styles.link} href={href({ tag: "sentences", course: course.id, orthography })} data-sentences-link="">
          {t.format("corrections.page.open")}
        </a>
      </p>
      {DEBUG && (
        <p>
          <a className={styles.link} href={href({ tag: "cards", course: course.id, orthography })} data-cards-link="">
            {t.format("debug.cards.open")}
          </a>
        </p>
      )}
      {DEBUG && course.audio !== undefined && Object.keys(course.audio).length > 0 && (
        <p>
          <a className={styles.link} href={href({ tag: "audio", course: course.id, orthography })} data-audio-check-link="">
            {t.format("audio.check.open")}
          </a>
        </p>
      )}
      {OFFLINE && offline.stored !== undefined && <OfflinePanel loaded={loaded} root={offline.root} stored={offline.stored} onChange={offline.onChange} />}
      <StartOver language={courseName(t, course.id)} hasProgress={studied || state.completedNodes.length > 0 || state.mistakes.length > 0} onReset={onReset} />
    </main>
  );
};

/**
 * "Can't listen now" and "Can't speak now" (§10): those exercises stay out of new sessions for an
 * hour. A per-device convenience, so it lives in localStorage; without storage it lasts the page.
 */
type Break = "listening" | "speaking";
const BREAK_KEYS: Readonly<Record<Break, string>> = { listening: "nabu.listening-off-until", speaking: "nabu.speaking-off-until" };
const BREAK_MS = 3_600_000;
const breakFallback: Record<Break, number> = { listening: 0, speaking: 0 };

const breakUntil = (b: Break): number => {
  try {
    return Number(localStorage.getItem(BREAK_KEYS[b]) ?? 0);
  } catch {
    return breakFallback[b];
  }
};

const setBreakUntil = (b: Break, until: number): void => {
  breakFallback[b] = until;
  try {
    if (until === 0) localStorage.removeItem(BREAK_KEYS[b]);
    else localStorage.setItem(BREAK_KEYS[b], String(until));
  } catch {
    // Storage unavailable: the in-memory value above still holds for this page.
  }
};

const onBreak = (b: Break): boolean => breakUntil(b) > Date.now();

/**
 * The reading layer the learner last chose for an orthography (ADR 0071): Pinyin, Jyutping, Middle
 * Chinese or none for Classical Chinese. A per-device preference in localStorage; without storage
 * the player starts from the profile's default each time.
 */
const READING_KEY = "nabu.reading.";

const storedReading = (orthography: string): SchemeId | false | undefined => {
  try {
    const value = localStorage.getItem(READING_KEY + orthography);
    return value === null ? undefined : value === "" ? false : (value as SchemeId);
  } catch {
    return undefined;
  }
};

const storeReading = (orthography: string, scheme: SchemeId | false): void => {
  try {
    localStorage.setItem(READING_KEY + orthography, scheme === false ? "" : scheme);
  } catch {
    // Storage unavailable: the choice lasts this session.
  }
};

/** What sessions leave out: listening and speaking while they are on a break. */
const excludedBy = (off: { readonly listening: boolean; readonly speaking: boolean }): ReadonlySet<TemplateId> =>
  new Set<TemplateId>([...(off.listening ? LISTENING : []), ...(off.speaking ? SPEAKING : [])]);

/** What a new session leaves out, as the breaks stand when it opens. */
const excluded = (): ReadonlySet<TemplateId> => excludedBy({ listening: onBreak("listening"), speaking: onBreak("speaking") });

/** The session seed: ?seed=… for reproducible runs (tests), else fresh randomness. */
const seedFor = (): number => {
  const param = new URLSearchParams(window.location.search).get("seed");
  if (param !== null && /^\d+$/u.test(param)) return Number(param);
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
};

/** The session gate is empty (§12.3, only where an instance turns it on): practice stays open. */
const GateEmpty = ({ course }: { course: LoadedCourse["course"] }): JSX.Element => {
  const t = useTranslator();
  const to = (mode: "review" | "mistakes"): string => href({ tag: "session", course: course.id, orthography: course.orthography, request: { mode } });
  return (
    <main className={styles.page}>
      <p className={styles.notice} role="note" data-gate-empty="">
        {t.format("game.gate.empty")}
      </p>
      <div className={styles.links}>
        <a className={styles.link} href={to("review")} data-practice-mode="review">
          {t.format("app.practice.review")}
        </a>
        <a className={styles.link} href={to("mistakes")} data-practice-mode="mistakes">
          {t.format("app.practice.mistakes")}
        </a>
        <a className={styles.back} href={href({ tag: "course", course: course.id, orthography: course.orthography })}>
          {t.format("app.practice.back")}
        </a>
      </div>
    </main>
  );
};

interface SessionProps extends GameProps {
  readonly loaded: LoadedCourse;
  readonly request: SessionRequest;
  readonly state: LearnerState;
  readonly device: string;
  readonly record: (event: LearnerEvent) => void;
  readonly store: EventStore;
  readonly account: Account | undefined;
  readonly ai: AiStatus;
  /** What the server's speech service can score here (Phase 9); empty without one. */
  readonly speechTiers: readonly number[];
  /** This device's corrections in the course (ADR 0051). */
  readonly corrections: ReadonlyMap<string, SentenceReported>;
}

/** Plans one session from the learner's state when it opens (§9.4), then plays it. */
const Session = (props: SessionProps): JSX.Element => {
  const { loaded, request, game, gameConfig } = props;
  // Decided once, when the session opens: answering inside it never closes the gate on it.
  const [allowed] = useState(() => sessionAllowed(game, request.mode, gameConfig));
  return allowed ? <SessionBody {...props} /> : <GateEmpty course={loaded.course} />;
};

const SessionBody = ({ loaded, request, state, device, record, store, account, ai, speechTiers, corrections }: SessionProps): JSX.Element => {
  const t = useTranslator();
  const { course, manifest, imageUrl } = loaded;
  // Each exercise's latest answer, for what the feedback offers under it (Phase 8).
  const [answers, setAnswers] = useState<ReadonlyMap<string, AnswerSubmitted>>(new Map());
  const [setup] = useState(() => {
    const seed = seedFor();
    // Speaking is scored where tones can be judged here or the server scores it (§10.4).
    const speech = speechSupportOf(course, serverAllowed() ? speechTiers.length : 0);
    const exclude = excluded();
    const planned = plan(course, state, request, { now: new Date().toISOString(), seed, speech, ...(exclude.size > 0 ? { exclude } : {}) });
    const keep = (event: LearnerEvent): void => {
      if (event.type === "answer_submitted") setAnswers((m) => new Map(m).set(event.exercise.id, event));
      record(event);
    };
    return { seed, planned, xpBefore: state.xp.total, onEvent: recorder({ course, bundle: manifest.id, device, plan: planned, seed, record: keep }) };
  });
  const grader = useMemo(() => createGrader(course), [course]);
  const speech = useMemo(() => speechServices(course, account, speechTiers), [course, account, speechTiers]);
  const sound = new URLSearchParams(window.location.search).get("sound") !== "off";
  const exit = (): void => {
    window.location.hash = href({ tag: "course", course: course.id, orthography: course.orthography });
  };
  if (setup.planned.exercises.length === 0) {
    return (
      <main className={styles.page}>
        <p data-empty-session="">{t.format("app.practice.empty")}</p>
        <a className={styles.back} href={href({ tag: "course", course: course.id, orthography: course.orthography })}>
          {t.format("app.practice.back")}
        </a>
      </main>
    );
  }
  return (
    <main className={styles.player}>
      <LessonPlayer
        course={course}
        lessonId={request.mode === "lesson" ? request.node : request.mode}
        exercises={setup.planned.exercises}
        grader={grader}
        imageUrl={imageUrl}
        language={courseName(t, course.id)}
        onEvent={setup.onEvent}
        sound={sound}
        retries={request.mode !== "placement"}
        adaptive={setup.planned.placement?.test}
        debug={DEBUG}
        reading={storedReading(course.orthography)}
        onReadingChange={(scheme) => storeReading(course.orthography, scheme)}
        onCantListen={() => setBreakUntil("listening", Date.now() + BREAK_MS)}
        onCantSpeak={() => setBreakUntil("speaking", Date.now() + BREAK_MS)}
        xpEarned={state.xp.total - setup.xpBefore}
        onExit={exit}
        speech={speech}
        feedbackExtra={(ex, _outcome, response) => {
          const answer = answers.get(ex.id);
          return (
            <>
              <AnswerHelp key={answer?.id ?? ex.id} answer={answer} ex={ex} response={response} status={ai} account={account} store={store} record={record} />
              <MarkExercise key={`mark:${ex.id}`} course={course} bundle={manifest.id} device={device} record={record} ex={ex} corrections={corrections} />
            </>
          );
        }}
      />
    </main>
  );
};

interface StorySessionProps extends GameProps {
  readonly loaded: LoadedCourse;
  readonly node: string;
  readonly state: LearnerState;
  readonly device: string;
  readonly record: (event: LearnerEvent) => void;
  readonly corrections: ReadonlyMap<string, SentenceReported>;
  readonly store: EventStore;
  readonly account: Account | undefined;
  readonly ai: AiStatus;
}

/** Reads one story (Phase 6): a session of mode story at its node. */
const StorySession = (props: StorySessionProps): JSX.Element => {
  const [allowed] = useState(() => sessionAllowed(props.game, "story", props.gameConfig));
  return allowed ? <StoryBody {...props} /> : <GateEmpty course={props.loaded.course} />;
};

const StoryBody = ({ loaded, node, state, device, record, corrections, store, account, ai }: StorySessionProps): JSX.Element => {
  const t = useTranslator();
  const { course, manifest, imageUrl } = loaded;
  // Each question's latest answer, for "My answer should be accepted" under its feedback.
  const [answers, setAnswers] = useState<ReadonlyMap<string, AnswerSubmitted>>(new Map());
  const [setup] = useState(() => {
    const story = storyAt(course, node);
    if (story === undefined) return undefined;
    const seed = seedFor();
    const keep = (event: LearnerEvent): void => {
      if (event.type === "answer_submitted") setAnswers((m) => new Map(m).set(event.exercise.id, event));
      record(event);
    };
    return { script: storyScript(course, story, seededRng(seed)), xpBefore: state.xp.total, onEvent: storyRecorder({ course, bundle: manifest.id, device, node, seed, record: keep }) };
  });
  const grader = useMemo(() => createGrader(course), [course]);
  const sound = new URLSearchParams(window.location.search).get("sound") !== "off";
  const back = href({ tag: "course", course: course.id, orthography: course.orthography });
  if (setup === undefined) {
    return (
      <main className={styles.page}>
        <p data-empty-session="">{t.format("app.practice.empty")}</p>
        <a className={styles.back} href={back}>
          {t.format("app.practice.back")}
        </a>
      </main>
    );
  }
  return (
    <main className={styles.player}>
      <StoryReader
        course={course}
        script={setup.script}
        grader={grader}
        imageUrl={imageUrl}
        language={courseName(t, course.id)}
        onEvent={setup.onEvent}
        sound={sound}
        xpEarned={state.xp.total - setup.xpBefore}
        reading={storedReading(course.orthography)}
        onReadingChange={(scheme) => storeReading(course.orthography, scheme)}
        onExit={() => {
          window.location.hash = back;
        }}
        lineAction={(line) => <MarkIncorrect course={course} bundle={manifest.id} device={device} record={record} item={setup.script.id} step={line.step} corrections={corrections} />}
        feedbackExtra={(ex, _outcome, response) => {
          const answer = answers.get(ex.id);
          return <AnswerHelp key={answer?.id ?? ex.id} answer={answer} ex={ex} response={response} status={ai} account={account} store={store} record={record} />;
        }}
      />
    </main>
  );
};

/**
 * The sync server: ?api= (tests, trying a server), else the build's VITE_NABU_API, else none
 * (local-only). "/" is this origin: a self-hosted instance serves the app and the API together
 * (deploy/compose.yaml), so one build works under any domain.
 */
const apiBase = (): string | undefined => {
  const value = new URLSearchParams(window.location.search).get("api") ?? import.meta.env.VITE_NABU_API;
  if (value === undefined || value === "") return undefined;
  return value === "/" ? window.location.origin : value.replace(/\/+$/u, "");
};

/** The open store and sync, for tests and debugging (import history, read the log). */
declare global {
  interface Window {
    nabu?: EventStore;
    nabuSync?: Sync;
  }
}
/** The deployment's game rules, loaded once. */
const gameRules = loadGameConfig(import.meta.env.BASE_URL);
const ready = openStore().then(async (store) => {
  const sync = await createSync(store, apiBase(), { gameConfig: () => gameRules });
  window.nabu = store;
  window.nabuSync = sync;
  return { store, sync };
});

const noSync = { subscribe: () => () => undefined, get: () => undefined };

/** One course's event log and the state it projects to. */
interface Log {
  readonly course: string;
  readonly state: LearnerState;
}

export const App = (): JSX.Element => {
  const t = useTranslator();
  const route = useRoute();
  const [index, setIndex] = useState<readonly CourseIndexEntry[] | null>(null);
  const [{ store, sync }, setDevice] = useState<{ store: EventStore | null; sync: Sync | null }>({ store: null, sync: null });
  // Events pulled from another device: replay the open course.
  const pulled = useSyncExternalStore(sync?.subscribe ?? noSync.subscribe, () => sync?.get().pulled ?? 0);
  // A second check revised an answer: replay in place (an open session stays open).
  const revised = useSyncExternalStore(sync?.subscribe ?? noSync.subscribe, () => sync?.get().revised ?? 0);
  const account = useAccount(sync);
  const [log, setLog] = useState<Log | null>(null);
  const [gameConfig, setGameConfig] = useState<GameConfig | null>(null);
  const [recorded, setRecorded] = useState(0);
  const version = `${recorded}:${pulled}:${href(route)}`;
  const game = useGame(store, gameConfig, version);
  const [loaded, setLoaded] = useState<{ key: string; value: LoadedCourse } | { key: string; error: string } | null>(null);
  // The route's course, if it has one (home and preferences have none).
  const inCourse = route.tag === "home" || route.tag === "preferences" || route.tag === "review" ? null : route;
  const courseKey = inCourse === null ? null : `${inCourse.course}:${inCourse.orthography}`;
  const courseId = inCourse === null ? null : inCourse.course;
  const ai = useAiStatus(account, courseId ?? "", inCourse === null ? "" : inCourse.orthography);
  const speechTiers = useSpeechTiers(account, courseId ?? "", inCourse === null ? "" : inCourse.orthography);
  const online = useOnline();
  const [downloads, setDownloads] = useState(0);
  const root = courseId === null ? undefined : `${BUNDLES}${courseId}/`;
  // Re-read after a course loads (the worker keeps what the app fetched) and after a download.
  const stored = useStored(OFFLINE ? root : undefined, `${downloads}:${loaded?.key ?? ""}:${online}`);
  const corrections = useCorrections(store, courseId, version);

  useEffect(() => {
    void fetchCourseIndex(BUNDLES).then(setIndex);
    void gameRules.then(setGameConfig);
    void ready.then(setDevice);
    if (OFFLINE) void registerWorker(import.meta.env.BASE_URL);
    // The native app: sync when it comes back to the foreground; reminders open where they point.
    void ready.then(({ sync: s }) => startNative(() => void s.syncNow()));
  }, []);
  useEffect(() => {
    if (pulled > 0) setLog(null);
  }, [pulled]);
  useEffect(() => {
    if (revised === 0 || store === null || courseId === null) return;
    void store.eventsOf(courseId).then((events) => setLog({ course: courseId, state: replay(events) }));
  }, [revised, store, courseId]);
  useEffect(() => {
    if (inCourse === null || courseKey === null || loaded?.key === courseKey) return;
    fetchCourse(BUNDLES, inCourse.course, inCourse.orthography).then(
      (value) => setLoaded({ key: courseKey, value }),
      (e: unknown) => setLoaded({ key: courseKey, error: String(e) }),
    );
  }, [inCourse, courseKey, loaded]);
  useEffect(() => {
    if (store === null || courseId === null || log?.course === courseId) return;
    void store.eventsOf(courseId).then((events) => setLog({ course: courseId, state: replay(events) }));
  }, [store, courseId, log]);

  // Live events are the newest in the log, so folding them onto the state equals a replay. A
  // revision rewrites an earlier answer (§8.3): the server issued it, and the log is replayed.
  const record = useCallback(
    (event: LearnerEvent): void => {
      // Corrections and claims go to the deployment's report intake too (ADR 0055), if it has one.
      if (event.type === "sentence_reported" || event.type === "answer_reported") void reportIntake().then((intake) => intake?.submit(event));
      // A revision (the judge's, or the learner's own claim, ADR 0052) rewrites an earlier answer: replay.
      // The server issued a judge's revision, so it is already synced; a learner's report still uploads.
      if (event.type === "outcome_revised" || event.type === "answer_reported") {
        const fromServer = event.type === "outcome_revised";
        void store
          ?.append([event], fromServer ? { synced: true } : undefined)
          .then(() => store.eventsOf(event.course))
          .then((events) => {
            setLog((prev) => (prev === null || prev.course !== event.course ? prev : { course: prev.course, state: replay(events) }));
            if (!fromServer) sync?.schedule();
            setRecorded((n) => n + 1);
          });
        return;
      }
      setLog((prev) => (prev === null || prev.course !== event.course ? prev : { course: prev.course, state: applyEvents(prev.state, [event]) }));
      void store?.append([event]).then(() => {
        sync?.schedule();
        setRecorded((n) => n + 1);
      });
    },
    [store, sync],
  );

  if (route.tag === "preferences") return <PreferencesPage back={href({ tag: "home" })} />;
  if (route.tag === "review") {
    const names = { course: (id: string) => courseName(t, id), orthography: (id: string) => orthographyName(t, id) };
    return index === null || sync === null ? (
      <p className={styles.page}>{t.format("player.loading")}</p>
    ) : (
      <ReviewHome courses={index} sync={sync} names={names} back={href({ tag: "home" })} hrefOf={(course, orthography) => href({ tag: "review-course", course, orthography })} />
    );
  }
  if (route.tag === "home") {
    return index === null || store === null || sync === null ? <p className={styles.page}>{t.format("player.loading")}</p> : <Home courses={index} store={store} sync={sync} game={game} gameConfig={gameConfig} version={version} online={online} />;
  }
  if (loaded === null || loaded.key !== courseKey || store === null || log === null || log.course !== route.course) {
    return <p className={styles.page}>{t.format("player.loading")}</p>;
  }
  if ("error" in loaded) return <p className={styles.page} role="alert" data-load-error="">{t.format(online ? "app.error.load" : "app.offline.unavailable")}</p>;
  if (route.tag === "course") {
    const offline: OfflineProps = { online, root: root ?? BUNDLES, stored, onChange: () => setDownloads((n) => n + 1) };
    const value = loaded.value;
    const onReset = (): void => record(resetEvent(value.course, value.manifest.id, store.device));
    return <CoursePath loaded={value} state={log.state} persistent={store.persistent} ai={ai} offline={offline} speechTiers={speechTiers} onReset={onReset} />;
  }
  if (route.tag === "cards") {
    const { course } = loaded.value;
    return (
      <CourseUiProvider course={course}>
        <CardsPage loaded={loaded.value} language={courseName(t, course.id)} back={href({ tag: "course", course: course.id, orthography: course.orthography })} />
      </CourseUiProvider>
    );
  }
  if (route.tag === "audio") {
    const { course } = loaded.value;
    return (
      <CourseUiProvider course={course}>
        <AudioCheckPage loaded={loaded.value} base={import.meta.env.BASE_URL} back={href({ tag: "course", course: course.id, orthography: course.orthography })} />
      </CourseUiProvider>
    );
  }
  if (route.tag === "review-course") {
    const { course, manifest } = loaded.value;
    return sync === null ? (
      <p className={styles.page}>{t.format("player.loading")}</p>
    ) : (
      <CourseUiProvider course={course}>
        <ReviewPage loaded={loaded.value} sync={sync} course={course} bundle={manifest.id} device={store.device} record={record} corrections={corrections} back={href({ tag: "review" })} />
      </CourseUiProvider>
    );
  }
  if (route.tag === "words") {
    const { course } = loaded.value;
    return (
      <CourseUiProvider course={course}>
        <WordsPage loaded={loaded.value} state={log.state} back={href({ tag: "course", course: course.id, orthography: course.orthography })} />
      </CourseUiProvider>
    );
  }
  if (route.tag === "sentences") {
    const { course, manifest } = loaded.value;
    const back = href({ tag: "course", course: course.id, orthography: course.orthography });
    return (
      <CourseUiProvider course={course}>
        <SentencesPage course={course} bundle={manifest.id} device={store.device} record={record} corrections={corrections} back={back} review={DEBUG} />
      </CourseUiProvider>
    );
  }
  // Offline, a session uses only the media on this device: no listening without the clip.
  const playable: LoadedCourse = online || stored === undefined ? loaded.value : { ...loaded.value, course: restrictMedia(loaded.value.course, (path) => stored.has(path)) };
  if (route.tag === "roleplay") {
    const back = href({ tag: "course", course: route.course, orthography: route.orthography });
    return (
      <CourseUiProvider course={loaded.value.course}>
        <RoleplayPage key={href(route)} course={loaded.value.course} scenario={route.scenario} account={account} status={ai} back={back} />
      </CourseUiProvider>
    );
  }
  if (game === null && gameConfig?.gate.policy !== "none") return <p className={styles.page}>{t.format("player.loading")}</p>;
  if (route.tag === "story")
    return (
      <StorySession
        key={href(route)}
        loaded={playable}
        node={route.node}
        state={log.state}
        device={store.device}
        record={record}
        game={game}
        gameConfig={gameConfig}
        corrections={corrections}
        store={store}
        account={account}
        ai={ai}
      />
    );
  return (
    <Session
      key={href(route)}
      loaded={playable}
      request={route.request}
      state={log.state}
      device={store.device}
      record={record}
      store={store}
      account={account}
      ai={ai}
      speechTiers={speechTiers}
      game={game}
      gameConfig={gameConfig}
      corrections={corrections}
    />
  );
};
