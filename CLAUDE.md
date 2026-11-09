# CLAUDE.md: Nabu

Open-source, script-first, Duolingo-style language-learning app.
Architecture and roadmap: docs/gameplan.md (Phases 0–10, built). Next phases: docs/next-steps.md.
§1 lists the decisions; any change to one needs an ADR in docs/adr/.

## Non-negotiables
- Language data is never a bare string. Use `TaggedText` (a BCP 47 tag with script, plus tokens) and render it only through `<T>`.
- No physical CSS (left/right, margin-left, text-align: left, width/height in components). Use logical properties.
  stylelint enforces this. Never disable the rule.
- No user-facing string literals. Add MF2 messages in packages/i18n/messages/.
- Never index, slice, reverse or count user-visible text by UTF-16 unit or code point. Use the grapheme utilities in @nabu/core/text.
- NFC at every boundary. NFKC only through a named orthography-profile step.
- No toLowerCase()/toUpperCase() on language data without a locale. Prefer the profile's case folding.
- packages/core is pure: no I/O, no Date.now(), no Math.random(). Inject the clock and a seeded RNG.
- Direction comes from the script subtag (Intl.Locale#maximize plus generated script metadata), never from a language name.
- During IME composition: never submit, never normalize, never reset the input value.
- Every new normalization or matching behavior needs vectors in conformance/ that pass in BOTH the TS and Python harnesses.
- Every content item and asset needs provenance and an SPDX license.
- What the prompt does not decide, the learner may choose (ADR 0085): accept sets take every order, word choice,
  optional word and form whose translation would be the prompt, in both directions; never one that would translate
  otherwise. The grader stays literal: the answers are listed in the accept set.
- The fixture courses (fa, yue-Hant-HK, uz, apc, lzh, es, hbo, tok, grc) must stay green, and UI changes must pass the visual matrix (LTR, RTL, vertical).
- Never hand-edit packages/schema or the Pydantic models. Edit schemas/ and regenerate.

## Style
- TypeScript: strict; functional; discriminated unions; Result types for expected failures; no classes in core.
- Python: uv; generated Pydantic models; Typer CLIs; pytest + Hypothesis; type-checked with pyright.
- Conventional commits. Small PRs, one roadmap deliverable each.

## Commands
- pnpm i && pnpm dev               # web + loopback API (isolated PGlite in apps/api/.data/dev-pglite)
- pnpm lint · pnpm typecheck · pnpm test   # all packages incl. the Python pipeline (via turbo)
- pnpm test:visual:docker          # visual matrix in the pinned Playwright image (needs Docker)
- pnpm test:visual:update          # same, rewriting baselines: review every changed PNG
- pnpm storybook                   # toolbar: UI locale, pseudo-locale, target, dir, writing mode
- pnpm codegen                     # schemas/ → packages/schema (TS) + pipeline (Pydantic); CSS module types
- pnpm cldr                        # regenerate packages/i18n/src/generated from the pinned CLDR packages
- pnpm conformance                 # TS + Python harnesses over conformance/ (≥300 vectors)
- pnpm test:perf                   # grading p95 < 5 ms, 4× CPU throttling, cold caches (Chromium)
- pnpm tables                      # regenerate profiles/tables from pinned Unihan/OpenCC
- pnpm courses                     # compile every course in courses/ (lint only; diagnostics as file:line)
- cd pipeline && uv run nabu build ../courses/<id>   # write the bundle to dist/<id>; `uv run nabu lints` lists lints
- pnpm bundles                     # rebuild apps/web/public/bundles (committed; CI fails if stale)
- pnpm test:e2e                    # lesson per course by keyboard and touch, IME composition, axe
- pnpm license-check               # what ships (web, API, mobile) has only allowed licenses (packages/lint/src/licenses.ts)
- pnpm check:catalogs              # every UI catalog in packages/i18n/messages passes the catalog check (ADR 0070)

## Phase 0–1 notes (see docs/adr/0013–0026)
- TypeScript is pinned to 6.0.x: typescript-eslint's type-aware rules need the JS compiler API, which TS 7 lacks.
- Workspace packages ship TS source; relative imports carry `.ts` extensions; Node ≥ 22.18 runs scripts directly.
- Generated, never hand-edited: packages/schema/src/generated, pipeline/src/nabu/schema/models.py,
  packages/i18n/src/generated, **/*.module.d.css.ts. CI fails if they are stale.
- Visual baselines are only valid from the pinned container; never update them from a bare host run.
- Lint rules and their fixtures live in packages/lint. A new rule needs a fixture that proves it fires.
- Write invisible characters (ZWNJ, bidi controls) as \u escapes in source, never literally.
- Grading lives in @nabu/core (accept/, match/, normalize/, profile/); profiles get their data passed in.
- A new grading behaviour needs conformance vectors (conformance/*.json) that pass in both harnesses.
- Endings that carry meaning (ADR 0066): a profile's `typo.contrasts` (person, possessive, case endings, pronouns;
  REVIEW). A slip trading one member for another is WRONG_WORD, not a typo. Group allomorphs (ga, ka, qa) in one member.
- A typo that spells another word of the course is WRONG_WORD (the lexicon). Key lexicon words and lookups with
  `lexiconKey` (marks the profile ignores stripped), or a vocalized course's marked words never match typed answers.
- Contrast sets can be prefixes (`at: start`, `after` proclitics) and can apply only to inflected words (`inflected`,
  ADR 0081): bundled tokens carry their `form`, and createGrader passes the words whose sense has one. A slip that makes
  a word ungrammatical is WRONG_WORD even when it looks like a typo; a noun's first letter stays a typo.
- Profile policies marked REVIEW await Ben's linguistic sign-off.

## Phase 2 notes (see docs/adr/0027–0033)
- Course sources: courses/<id>/course.yaml + units/*.yaml (schemas/course-source.schema.json). Every orthography's
  form is pinned; tokens are aligned to `text`; translations and `reverse` are accept sets.
- Fixture courses fa, yue, uz, apc are LLM-drafted (`llm:` provenance, status draft) and await native review.
  Ten units each (ADR 0050); courses/REVIEW.md lists what a reviewer should check first. Tests pin intro.yaml's
  sentences, readings and glossary forms: change them with care.
- A new lint needs a registry entry (pipeline/src/nabu/compiler/diagnostics.py) and a fixture: add a mutation to
  pipeline/tests/fixtures/make_lint_fixtures.py and run it. clean.yaml must stay diagnostic-free.
- Write course YAML with nabu.yamlio.dump (keeps invisibles as \u escapes), never yaml.safe_dump.
- Analyzers (PyCantonese, hazm) are a default uv group; PyICU is the `icu` group (apt install libicu-dev pkg-config,
  then uv sync --all-groups). NABU_REQUIRE_TOOLS=1 turns tool-dependent skips into failures (CI sets it).
- CLDR exemplar gaps go in a profile's `exemplarsExtra` (marked REVIEW), never by loosening the script audit.

## Phase 3 notes (see docs/adr/0034–0035)
- Lessons: pure @nabu/core/lesson (templates, buildLesson, step). Distractors come from the item's own unit or an
  earlier one (ADR 0050), so adding a unit never changes earlier lessons. The player shell and views are @nabu/ui/player;
  views render state and dispatch PlayerEvents, never grade or advance themselves.
- After changing courses/ or profiles/, run `pnpm bundles`: the web app, Storybook and tests read the committed bundles.
- Typing is left to the device keyboard or IME; on-screen keyboards are deferred (ADR 0034). Keep the field IME-safe.
- Quote YAML values like "on"/"off"/"yes": PyYAML (YAML 1.1) reads them as booleans; the JS parser does not.
- Keyboard shortcuts live in the player's capturing window listener; views register digit/Backspace handlers.
- Bring an action into view with `focusInReach` (player/shared.ts), never a bare focus(): a phone browser's bottom
  toolbar covers the viewport's last strip. Pages hosting the player keep `--nabu-space-reach` below the card.

## Phase 4 notes (see docs/adr/0036–0039)
- Learner state is a projection: @nabu/core/learner `replay(events)`. Never store derived state; change the fold.
  Never delete events to undo progress: starting a course over is a `progress_reset` event (ADR 0049).
- The planner is pure: (request, state, bundle, now, seed) → plan. Re-tune CALIBRATION_WEIGHT only against
  test/simulation.test.ts (every course within ±5pp of 85%, no lesson dropping a new KC); golden files:
  UPDATE_GOLDEN=1 after a deliberate change. Every new KC of a lesson is presented in it (a hard constraint, ADR 0050).
- Card keys: "kc|facet", and "kc|facet|orthography" for read-script/write-script (§6.3).
- The web app stamps events (apps/web/src/clock.ts, session.ts) and keeps them in IndexedDB (store.ts).
- e2e sessions depend on the log and clock: fix the clock (page.clock.setFixedTime), seed history through
  window.nabu, and plan with the solver's `planned()`. Seeded history that gets uploaded needs `freshIds()`.
- The API (apps/api) runs on PGlite unless DATABASE_URL is set; migrations are SQL in src/db/migrations.ts
  (append, never edit). Events are validated against schemas/learner-event.schema.json with Ajv.
- `pnpm dev` passes `--dev`: deployment database settings are ignored; only `NABU_DEV_DATABASE_URL`
  and `NABU_DEV_PGLITE` can override the isolated development database. Development binds to loopback.
- Navoiy/CosyVoice generation is quarantined; do not install its legacy runtime. See its README.
- API tests open their database with test/database.ts: PGlite, or with NABU_TEST_DATABASE_URL a fresh Postgres
  database per test file (CI's api-postgres job).
- Sync is optional: the web app talks to a server only with VITE_NABU_API (dev: .env.development) or ?api=.
  Every recorded event enters the IndexedDB outbox; sign-up uploads it. Never derive state on the server
  differently from core's replay.
- Calibration: `pnpm --filter @nabu/core simulate --out f.jsonl`, then `cd pipeline && uv run nabu calibration f.jsonl`
  or `uv run python notebooks/calibration.py f.jsonl`.
- Count open mistakes with @nabu/core/learner `practicableMistakes` (the course page does), never `state.mistakes`:
  a session leaves out templates on a break, items the course no longer makes, and items needing unseen KCs.
- The word list (`#/<course>/<orth>/words`): @nabu/core/learner `learnedWords` (word KCs with a reviewed card; script
  facets count only in their orthography), `orderWords`, `wordMatcher` (letters as the profile compares them, marks
  stripped; glosses folded in their own language); @nabu/ui/words WordList. It reads the log; it records nothing.

## Phase 5 notes (see docs/adr/0040–0042)
- Audio is committed source: courses/<id>/audio/{index.yaml,clips/}. `cd pipeline && uv run nabu audio generate
  ../courses/<id> [--check]` writes it (needs espeak-ng and ffmpeg; --check needs `uv sync --group speech`). The compiler only
  reads it; after changing a reading, regenerate (the compiler warns `audio.stale`), then `pnpm bundles`.
- Synthesize from pinned readings (Jyutping), never raw characters. Human recordings: `nabu audio ingest`.
- One synthesized clip an item, at normal speed: "slow" is the player slowing it (0.75×, pitch kept;
  ADR 0062). Never synthesize slow clips; a recorded slow take (`ingest`) still plays as it is.
- `finalStop: true` on a voice (ADR 0063) ends unpunctuated text (word cards) with its script's full stop
  (nabu/audio/punctuation.py: by script subtag, language overrides). Turning it on makes those clips stale.
- apc's voices (ADR 0058, 0078): Lahgtna on OmniVoice, local (`uv sync --group omnivoice`, CI skips it), reading the
  vowel-marked text, each cloning its reference (beirut-m, beirut-f; `nabu audio cast`; recasting makes clips stale). Clips are CC-BY-NC-4.0
  (the weights are non-commercial). bfloat16; CPU ~15 s a clip; generation resumes. Live test: NABU_OMNIVOICE=1.
- OmniVoice clips are trimmed to their speech (`trim_edges`: 80 ms before, 150 ms after); a clip cloned from a recorded
  reference credits it (speaker, license, source).
- uz's voice (ADR 0059): Navoiy (CosyVoice2) runs in its own uv project, pipeline/runtimes/cosyvoice (older torch and
  transformers); the pipeline starts its worker.py. CI never installs it. ~6 GB RAM: run it alone. Clips Apache-2.0.
  `nabu audio align` gives clips without timings (OmniVoice, Navoiy) word timings by forced alignment. Live: NABU_NAVOIY=1.
- Clips that fail the round-trip check stay out of bundles until reviewed (`nabu audio report`).
- Audio check (ADR 0060): `#/<course>/<orth>/audio` (debug link) plays every clip, held-back ones too; clips come from
  courses/ via apps/web/audio-check.ts (Vite plugin; Pages writes a copy), never from bundles. Its verdicts file goes
  through `nabu audio verdicts <course> <file> --reviewer human:<id>`: right → reviewed (ships), wrong → rejected (held);
  the next `generate` makes a rejected clip again as its next take (another seed; seeded voices only).
- Speech tests need NABU_SPEECH=1 and the speech group; CI runs only the espeak-ng tests.
- Listening templates exist only where a clip does; "Can't listen now" uses the planner's exclude (LISTENING).
  Once answered, a listening card shows what was heard and what it means: a sentence's translation, a word's gloss
  (`translation` on the exercise, shown by ListenPrompt). Never before the answer: it would give it away.
- Every card says its clip once answered (ADR 0064: `useSayWhenAnswered`, `AnswerAudio` in Views.tsx); each view owns
  its clip (never the shell), so nothing plays twice. New views with a clip use the same hook.
- A clip said on answering waits for the feedback sound (`SAY_AFTER_ANSWER_MS`), never over it. Clip elements load with
  the card and are reused (`useClipElements`); never `new Audio()` at play time (choppy starts, Firefox on Android).
- fa's voice (ADR 0065): Mana-Persian-Piper (Piper, pinned `model`, MIT). Its `carrier` says items of at most
  `maxWords` words inside "حالا این کلمه را تکرار کن، …" with durations set from the carrier (the graph split at
  /Ceil, nabu/audio/carrier.py) and cuts them out exactly; lone words otherwise collapse. Piper is seeded.
  A longer item's sentence the duration predictor collapses (`carrier.collapses`) is carried too; that route is in
  the clip's own identity (`item_settings`), so changing how some items are said never makes every clip stale.
- Hosted voices (ADR 0042): provider elevenlabs/cartesia with `model` and `language`. Keys only from the environment
  (ELEVENLABS_API_KEY, CARTESIA_API_KEY): never in course files, commits or chat. `pronounce: jyutping` sends IPA for
  tokens whose characters do not settle the pinned reading. `--voice <id>` picks a cast voice. Live tests: NABU_HOSTED=1.

## Phase 6 notes (see docs/adr/0043)
- Stories: `stories:` in a unit (schemas/course-source), each on a node of kind story. Lines compile like sentence
  forms and need every course orthography; questions are `choose` steps or lines with `ask: complete|arrange`.
- One glossary matcher: @nabu/core `glossTokens` (exact and folded passes, longer wins). The app's tap-for-gloss and
  stage 7's lints both use it (core-cli `gloss`); never re-implement matching in Python.
- The story reader nests the lesson player per question (@nabu/core/story); story sessions are mode "story".
- `pathNodes` (lessons and stories) drives the path; placement and the planner use lessons only.
- Tappable words: `<T onTokenPress>`; never wrap tokens by hand.

## Phase 7 notes (see docs/adr/0044)
- Game state is a projection: @nabu/core/game `replayGame(events, config, clock)`. Never store it; change the rules.
  Deployments configure it in `game.json` beside the app; the gate (hearts/energy) is off unless set there.
- Streak tests are properties (date line, DST, 48 h offline): keep them generating physically possible timelines, and
  within the anti-gaming caps (≤3 time-zone changes a week: `withinZoneCap`) unless the cap is what they test.
- Usernames go through `checkUsername` with the UTS #39 data in packages/i18n/src/generated (regenerate with
  `pnpm --filter @nabu/i18n generate:security`; pinned sha256). Render every user-chosen name inside <bdi>.
- API options: NABU_LEAGUES=1, NABU_PUSH=1 (VAPID key kept in the database unless NABU_VAPID_PRIVATE_JWK),
  NABU_TEST_HOOKS=1 only in tests (push sink, job runner). Reminder copy lives in packages/i18n (push.reminder.*).
- Web Push is our own RFC 8291/8292 code (apps/api/src/webpush.ts); its test pins the RFC's example bytes.

## Phase 8 notes (see docs/adr/0045)
- AI goes through the gateway (apps/api/src/ai): providers from the environment only (NABU_LLM, NABU_LLM_MODEL,
  NABU_LLM_URL, a key), outputs validated against schemas/ai.schema.json, provenance on every output. No model: AI off.
- Prompts live in prompts/*.md, referenced by hash. Learner text goes in as data (asData). Changing judge.md closes
  every judge gate until `pnpm --filter @nabu/api evals -- --run` with a model writes new ones.
- evals/gates.json: never hand-write a gate or a result. Golden items must stay real judge cases (check mode, in CI).
- A judge accept is an outcome_revised event the server issues; projections fold logs through withRevisions.
  A learner's answer_reported is their own revision (claim accept or reject, ADR 0052); it counts at once.
- Reports are answer_reported events. Review: /admin/v1 (NABU_ADMIN_TOKEN); `nabu reports promote` edits accept sets.
- Roleplay scenarios are course content (`scenarios:`, no target text); model turns are checked before shown.
- Explanations: segments render through <T>; the paragraph takes the support language's direction, never the UI's.
- Tests use a scripted provider for plumbing only; never present stand-in output as a model's result.

## Phase 9 notes (see docs/adr/0046)
- Tones are scored on the device: @nabu/core/speech (pitchTrack, scoreTones, gradeSpeech). Expected tones come from
  pinned surface readings. Never tune templates to synthetic speech; tune on native recordings (evals/tones).
- Tiers 1–2: `cd pipeline && uv run nabu speech serve`, API NABU_SPEECH_URL. Never prompt the recognizer with the
  sentence. Per-orthography tiers live in apps/api/src/speech.ts (SPEECH_SETUP, REVIEW).
- Recordings are never stored or logged anywhere; speaking answers log method voice with no raw text.
  A scored speaking card (speak, listen-speak) can be claimed right ("I said it right", ADR 0052): the claim's
  text is the prompt sentence, never what was heard; `nabu reports promote` skips it.
- `speak`/`listen-speak` replace tier 0 only with SpeechSupport (speechSupportOf); `tone-identify` needs a one-syllable
  clip. Lessons keep their rotation length (golden files): substitute slots, never add rotation entries.
- `pnpm --filter @nabu/core tone-eval [set]` reports per-tone accuracy; evals/tones/synthetic-espeak is synthetic.
- Speech e2e uses Chromium's fake microphone (tests/e2e/fixtures); speech service tests need NABU_SPEECH=1.

## Phase 10 notes (see docs/adr/0047–0048)
- Offline: @nabu/core/offline (coreFiles, downloadPlan, restrictMedia). The manifest's units list their `assets`;
  never make a template depend on media without the builder checking course.audio or kc.image (restrictMedia drops them).
- The service worker is apps/web/sw/sw.ts (built by vite-sw.ts, its own tsconfig with the WebWorker lib). Code it
  shares with the app (idb.ts, outbox.ts, http.ts, caches.ts) must not touch window or import React.
- Course files are cached by URL in "nabu-bundles"; downloads check sha256 and store the manifest last.
- Game state on the server: GET /v1/game; devices replay with the server's receipt times (store.receivedTimes).
  Instances set NABU_GAME to the game.json the web app is deployed with.
- e2e that needs Background Sync uses `channel: "chromium"` (the headless shell has none); the CI image has it.
- Tests import projection helpers from src/compare.ts (src/sync.ts pulls in React and CSS).
- Native apps (ADR 0048): apps/mobile (Capacitor 8; android/ and ios/ are committed, generated projects). After a web
  change: `pnpm --filter @nabu/mobile build`. Capacitor plugins load only in the native shell (src/native.ts, dynamic
  imports). Native reminders: apps/api/src/nativepush.ts; credentials only as file paths in the environment
  (NABU_FCM_SERVICE_ACCOUNT, NABU_APNS_*): never in the repo or chat. CI builds the Android debug APK.

## Corrections notes (see docs/adr/0051)
- A correction is a `sentence_reported` event: `shown` (what the device displayed) and `correction` (only what
  changed). Build drafts and events with @nabu/core/corrections; never hand-assemble them. Projections ignore it.
- Words are addressed by their index among a form's words (not spaces or punctuation) plus their surface.
- The UI (`@nabu/ui/corrections`) gives every field its own text's lang/dir/font; never normalize while composing.
- Modal content renders outside UiRoot: wrap it with `useChrome()` (lang, dir, font) and `chromeClass`.
- `nabu corrections apply <jsonl>` edits values in place and skips anything whose `shown` no longer matches the
  source; changes that need new tokens or senses are listed with file:line, never guessed. Regenerate audio after.
- "My answer should be accepted" also covers story questions (answerTextOf); promote skips them (no accept set).
- Words are correctable too (ADR 0057): `item` is the KC id; `correctablesOf(course, ex)` gives what an exercise
  offers (each pair's word for match-pairs). apply edits the KC's first form and gloss; readings stay with sentences.

## Vowel marks notes (see docs/adr/0053)
- Course sources stay as written; `vocalization:` files (courses/<id>/vocalization.yaml) give words their marks
  at compile time. A token pins its own with `vocalized` (needed for `ambiguous` words). New word: add an entry.
- Compare letters, never marks: grading, credit, glossary, corrections apply. Voices read `Compiled.written`
  (the source's surfaces), so a vocalization never changes clips.
- Pronunciation cards (ADR 0054): `vocalize` (abjads, needs vocalized KC forms) and `transcribe` (a ruby scheme
  with a syllable shape in core match/pronounce.ts: only Jyutping). A new scheme needs a shape, a READING_TAGS
  entry and conformance vectors (conformance/pronounce.json). Optional marks: the profile's `match.marks.optional`.

## Report intake notes (see docs/adr/0055, docs/reports.md)
- Reports (sentence_reported, answer_reported) also go to the deployment's Firestore intake (`reports.json` beside
  the app; Pages writes it from repo variables). What leaves the device: @nabu/core/reports `submissionOf`, never
  device/user/session ids. The Reports workflow files them as GitHub issues (apps/api/scripts/file-reports.ts).
- Firebase keys and the service account live only in repo settings (variables/secrets): never in chat or commits.
  The rules in deploy/firebase/ are merged into a shared project's rules, never deployed on their own.
- Learner text in issues stays in code spans (no mentions, links, markup); keep it so when changing the rendering.

## Morphology notes (see docs/adr/0061)
- A KC's forms are its lemma (first: what word cards show) and its variants, never an inflected word; the compiler's
  `kc.inflected-form` catches forms the sentences analyse into several KCs. Verbs: infinitive (ichmoq, خوردن).
- Taps on analysed words show their morphs (`glossAt`); annotate morphs rather than listing inflected forms.

## Persons and register notes (see docs/adr/0056, 0075)
- `persons` on a sentence (speaker m/f; addressee m/f, sg (number but no gender: yue 你), du, pl) is shown as tags
  under l1-l2 prompts; tag where the target marks gender/number and English cannot, and keep the accept set to the
  forms that fit. Untagged means every form is accepted. The same goes for "it" and a bare "this": unless the
  sentence names the thing, accept both genders (mish b3id / mish b3ide, jarrbo / jarrba).
- Exercise every person the language marks, never one default (ADR 0075): a woman speaking as well as a man, to a
  woman, to one/two/several people. Draft the set together (kifak / kifik / kifkon) and check the spread per course
  before committing (counts in docs/adr/0075). Never let "a man speaking to one man" be the norm.
- Register is the same idea, not yet modelled: Javanese speech levels (ngoko/krama/krama inggil), T–V (fa تو/شما,
  uz sen/siz), Korean/Japanese honorifics. When a register language arrives: an ADR, a tag the prompt shows, accept
  sets that fit it, and every level exercised. Gendered plurals (Hebrew atem/aten) will need a gendered pl.
- A course's voices share its items (ADR 0078): each sentence, word and story character gets one voice at random
  (seeded by its id: `assignment` in nabu/audio/course.py), except where grammar says who speaks (`persons.speaker`, a
  story character's `speaker`): then a voice of that gender, if cast. A one-voice cast reads everything (a man reading a
  woman's line is fine). Checked clips keep their voice. Set a character's `speaker` only where the text fixes it
  (agreement, kinship words), never from a name alone. Adding a voice re-draws about half the items: regenerate.

## Account data notes (see docs/adr/0067, 0069)
- `GET /v1/export` and `DELETE /v1/account` (src/privacy.ts): a new table that names a learner (user id or subject) must
  be in both. Deleting asks for the password; the device keeps its log.
- Abuse limits (src/limits.ts): sign-up, sign-in, uploads; 429 + Retry-After. `NABU_RATE_LIMITS=off` (the e2e API sets it),
  `NABU_TRUST_PROXY=1` only behind a proxy the instance runs.
- Age gate (ADR 0069, src/age.ts): `NABU_MIN_AGE` makes sign-up ask the age (400 age-required, 403 age). Keep nothing of
  the answer anywhere, never show the threshold, and parse digits with `parseDigits` (@nabu/i18n), never Number().

## Sign-off notes (see docs/adr/0072–0074)
- Reviewers sign off sentences, whole stories or a unit in the sentence list (debug mode); the file goes through
  `cd pipeline && uv run nabu review apply ../courses/<id> <file> --reviewer human:<id>`, which edits provenance in place.
- A sign-off pins the sha256 of `signoffText` (@nabu/core/corrections); its Python twin is nabu/review. Change both,
  with the pinned text in packages/core/test/signoff.test.ts and pipeline/tests/test_review.py.
- Release builds (ADR 0073): `uv run nabu build ../courses/<id> --release` keeps only reviewed sentences, stories and
  scenarios. Committed bundles and the demo stay full builds. The manifest's summary counts come from
  `compiled.counted` (compiler/counts.py): count through `count()`, never by editing the dicts.
- Review workspace (ADR 0074): reviewer accounts (`PUT /admin/v1/reviewers {email, handle, courses}`) work at `#/review`
  through /v1/review/* (apps/api/src/review.ts, apps/web/src/Review.tsx, @nabu/ui/review). Every route checks the course is
  the reviewer's. Sign-offs wait on the server; `GET /admin/v1/signoffs` is a file `nabu review apply` takes as it is.
  An accepted answer is an approved report (`addAccepted`); promote writes it. The tables are in export and delete.

## UI catalogs notes (see docs/adr/0070)
- A translated catalog (packages/i18n/messages/<locale>.json) carries `provenance`; drafts are `llm:` and status draft.
  It ships (CATALOGS in src/catalog.ts) only when reviewed, complete and clean under `pnpm check:catalogs`.
  Until then it is listed in DRAFTS: reviewers see it with `?ui=<locale>&drafts=1` or in Storybook's UI-locale menu.
- Each translated message records `source`, the fingerprint of the English it translates (`check-catalogs.ts --stamp`).
  Changing an English message's meaning means a new key; a wording change makes translations stale until re-stamped.
- A plural selector covers the locale's CLDR categories; a language that needs no plural forms drops the `.match`.
- Invisible characters in catalogs are JSON escapes (\u200c), never literal; bidi controls never (MF2 isolates).

## Classical Chinese notes (see docs/adr/0071)
- A course's `facets` (course.yaml, manifest) rule out every template of another facet (`facetExclusions`, wherever
  speechExclusions applies). lzh is [recognize, produce]: no audio, never spoken, heard or drilled on its readings.
- An orthography may pin several ruby layers (lzh: pinyin, jyutping, baxter). Every Han word token pins all of them,
  chosen by sense (說.yue is yuè / jyut6 / ywet); the compiler checks they line up per character. Jyutping is the
  literary reading; Baxter is Baxter & Sagart 2014 ASCII from the Guangyun. The player shows one layer or none.
- A layer's `lang` tags its ruby text (`<rt lang>`): zh-Latn-pinyin, yue-Latn-jyutping, ltc-Latn-x-baxter.
- Senses spelled alike are KCs with a suffix (知, 知.zhi); a token names its sense, and glossAt glosses it as that.
- Each unit's lessons teach the words of its story, an authentic passage; stories may use no word taught later.
- Target-language text is sized apart from the rest: a profile's `fonts.scale` (lzh 1.25), times the learner's size
  for the language being learned (Preferences; `--nabu-target-scale` on <T> text marked `data-target`). Render course
  pages inside `CourseUiProvider` so <T> knows which orthographies are targets.

## Cuban Spanish notes (see docs/adr/0076–0077)
- courses/es: thirty units A1–B2 for heritage speakers; courses/es/README.md is the brief, syllabus and conventions.
  Cuban forms are canonical (guagua, ¿Qué tú quieres?); pan-Hispanic ones are accepted, never the reverse.
- Verb tenses are `form:` KCs on the token (form:pres-1s, form:pret-3s, form:impf, form:subj…), not morphs;
  `iPlusOne: 2`. A unit that first teaches a tense defines its form KC.
- es-Latn/standard: a missing accent is CORRECT_MARKS; one that spells another word of the course is WRONG_WORD
  (`marks.distinguishes`, the grader's lexicon). ñ is a letter, not a mark.
- Placement is adaptive (ADR 0077: a block per unit, gallop then bisect, then node steps); `placement: {production:
  typed}` makes its production typed. The test is data and `runTest` a pure function: never make it stateful.
- Two voices clone Cuban recordings (`nabu audio cast --recording`; a man's CC BY, a woman's CC0); clips are CC-BY-NC-4.0
  (OmniVoice weights) and credit the recording. Cut a reference on whole words, no breath at either end.

## Reference library notes (see docs/adr/0079)
- Grammars, dictionaries and notes are copyrighted: they live in the owner's private Drive folder behind the relay
  (apps/references), never in the repo, bundles, issues or commits; nor does text extracted from them.
- `cd pipeline && uv run nabu refs ls -r`, `pull <path>` (into NABU_REFS_DIR, default ~/nabu-references; refuses a git
  work tree), `put <file> notes/<course>/<name>.md --parents` for notes. Extract text and page images there, not here.
- Courses take facts from references (forms, paradigms, glosses), never example sentences or definitions verbatim.
- Cloud sessions: NABU_REFS_URL is an environment variable; the key is the relay host's network secret (never chat).
  The relay trashes, never deletes; uploads stop at 25 MB (scans go into Drive directly).
- The PDF text layer garbles Arabic (presentation forms, loose shaddas, words out of order): read Latin from the text
  and check every Arabic spelling on a page image (`pdftoppm -png -f N -l N`).

## apc twenty units notes (see docs/adr/0080)
- apc has twenty units, checked against Kline (2022). Senses spelled alike take a suffix (ra7.fut, fi.can, men.than,
  ba3d.still, jem3a.uni); multi-word patterns are `construction:` KCs (used-to, was-doing, shu-excl).
- Spelling: -o/-a (his/her, him/her; enno, la2anno) are ـه/ـها as Kline writes them, ـو/ـا accepted; -on (their) is ـهن.
  Vowel marks put a damma before ـه (بَيُّه): the voice says -o from it. New vocalizations mark ج as a sun letter.
- A voice's `spoken` may name only items that voice reads: in a two-voice cast an item's voice can change (ADR 0078),
  and `nabu audio generate` then refuses. Use it for homographs in one-voice casts, not to keep old clips.

## Biblical Hebrew notes (see docs/adr/0082–0084, 0089)
- courses/hbo is Biblical Hebrew, never Modern: no voice may read its text. Voices read the pinned `tiberian`
  reading (SBL transliteration, acute on non-final stress, final "-" for maqaf-bound words), which
  nabu/audio/tiberian.py turns into phonemes. The voice is Piper's Arabic `ar_JO-kareem-medium` (ADR 0089), given
  IPA (`tiberian.piper`, `PIPER_PHONEME_SCHEMES` in nabu/audio/course.py): Khan's vowels and stress, Arabic-bent
  consonants (vav [w], alveolar [r], ṭ ṣ as the voice's t̪ s̪, [jj], no aspiration). After a reading changes,
  `nabu audio generate ../courses/hbo` (speech group; minutes; MIT), `nabu audio align ../courses/hbo` (word
  timings), then `pnpm bundles`. It is read, not heard: its `facets` leave out listen (no listening exercises;
  clips still play once a card is answered).
- Text is written pointed (WLC pointing, no accents, no meteg); `reverse` unpointed. The profile's marks set is
  the points only (what "Show vowel marks" hides and a vocalize card asks for); accents and meteg are removed in
  normalization. Write points and escapes in profiles with Python (chr(92)), never a heredoc.
- Every word token pins `readings: {tiberian: …}`, taken from the same pointed form in the Westminster Leningrad
  Codex (stress from its accent): never guess one. Copy the word with its accents from the WLC and run
  `cd pipeline && uv run nabu tiberian <word>` (nabu/audio/pointing.py); keep a verse's ׃ on its last word (its
  meteg sign is then silluq). The divine name is ʾăḏōnāy (its qere).
- Readings stay SBL's (šāmərû); `tiberian.ipa` says them as Khan, vol. I, describes (ADR 0084: silent shewa after a long
  vowel, the echo vowel, uvular resh, [ɟɟ]). A sound rule changes only with a page of Khan; listed rules are not modelled.
  The voice's Arabic consonants (ADR 0089) are Ben's choice, not Khan's: keep them apart (`arabic=True`).
- References (ADR 0084; notes in the library's notes/hbo): Khan for sounds, Joüon–Muraoka for forms and stems,
  Holladay for glosses. Contrast sets limited by `forms` (words pinned as those forms) carry the verb's person
  prefixes and endings and agreement; a noun's first letter and an infinitive's -ôṯ stay typos.
- Units read a Bible passage (the WLC, public domain) as their story; lessons teach its words. Verbs are KCs by
  stem; prefixes and suffixes are morphs; verb forms are `form:` KCs by conjugation and person (iPlusOne 2).
- A sentence's `reverse` lists its own order, then the other order of subject and predicate where Biblical Hebrew has
  both and the English translation would be the same (ADR 0084): nominal and participle clauses, plain qatal/yiqtol,
  a distinct jussive. Never a subject before wayyiqtol or weqatal; not identity clauses (קין אחי), the blessing
  formula, a wish in a plain yiqtol, or an order that reads unpointed as a construct chain (בגן האדם). Keep it so.
- Then the forms the English cannot tell apart (ADR 0085): a wayyiqtol's X-qatal (האשה אמרה, והאשה אמרה) or bare
  qatal with or without its pronoun (ברח, הוא ברח, והוא ברח; never וברח), a weqatal's yiqtol, a pronoun before a plain
  qatal/yiqtol; only Codex-attested forms; vav forms only where every English line has its "and".

## Toki Pona notes (see docs/adr/0086)
- courses/tok is in two orthographies, every sentence pinned in both: tok-Latn/standard (sitelen Lasina) and
  tok-Qaap/sitelen-pona. Qaap is a private-use ISO 15924 code until one is assigned (the proposal asks for Stpn).
- sitelen pona text is UCSUR code points (U+F1900..U+F19FF): words run together, U+3000 between sentences, no ! ? or
  commas, a name as a cartouche whose logographs begin with its letters. Never write it by hand: `cd pipeline &&
  uv run nabu sitelen-pona "mi moku." --name "Sonja=sona olin nasin jan a"`. The compiler checks it against the Latin.
- Typed Latin is graded as logographs in sitelen pona (the `logographs` step), names against their cartouches. Every
  logograph token pins `readings: {lasina: word}` (ruby, char-read); Latin tokens pin it too: it is what the voices say,
  as eSpeak NG phonemes (nabu/audio/toki_pona.py). After a sentence changes, `nabu audio generate ../courses/tok`.
- The font (sitelen seli kiwen juniko, OFL) is in packages/ui/src/fonts; its README says how it was subset.
- Toki Pona marks no person: no `persons` tags. English accept sets give I/we, she/he/they/it and the tenses.
- Toki Pona accept sets (ADR 0085; kinds in ADR 0086): mi or mi mute li for we, ona (mute) li for they, jan mije or
  mije, mama or mama meli/mije, X ala X or anu seme, tenpo pini/kama la or none, kule + colour, ali for ale.

## Attic Greek notes (see docs/adr/0087)
- courses/grc is Attic, never Modern Greek: no voice may read its text. Every word token pins `readings: {attic: …}`,
  its spelling with each α, ι, υ outside a diphthong marked long (ᾱ) or short (ᾰ) unless a circumflex or subscript
  settles it; `cd pipeline && uv run nabu attic <reading>` checks one. After a change, `nabu audio generate ../courses/grc`
  (needs piper-tts in the pipeline venv). The voice is Piper's Greek rapunzelina given IPA (`attic.piper`), a stopgap;
  its clips are CC-BY-NC-SA-4.0.
- Grave = acute (silent); missing marks are CORRECT_MARKS unless they spell another course word. Write graves and
  enclitic accents as editions do, in every accept-set alternative too. KC forms are lemmas (a grave-only variant
  is a dead glossary entry). Units read public-domain passages (Perseus); take only facts from CGCG and the CGL.

## Script tracks notes (see docs/adr/0088)
- A `script` node with `alphabet: {orthography, words}` teaches an orthography's letters (grapheme KCs, by their forms:
  letters, diphthongs, marks); the compiler adds each letter's and word's Latin spelling (the profile's `romanize`, e.g.
  nabu/greek_translit.py) and the graphemes it credits. `script.untaught-letter` stops a word with untaught letters.
- Its four templates (letter-read, letter-pairs, word-read, word-write; @nabu/core/lesson/script.ts) are built only
  for script nodes: never add them to SENTENCE_TEMPLATES (every course's lessons and goldens would change).
- The row (`scriptPathOf`) sits above the units and never gates them; a script node is planned as `{mode: "lesson"}`.
  Grapheme KCs are not glossary entries. Convert nodes (uz, apc) still do not run.

## Themes notes (see docs/adr/0083)
- Colours come only from tokens (packages/ui/src/tokens.css): light on :root, dark in two blocks that must match
  (`:root[data-theme="dark"]`, and `prefers-color-scheme: dark` when nothing is chosen). A new colour gets a value in
  both themes and, if it carries text, a pairing in packages/ui/test/tokens.test.ts (AA in both). No colours in components.
- The choice (Match the browser, Light, Dark) is per device (`nabu.theme`); index.html applies it before the first paint.
- Pictures are drawn for a light page: dark sets them on `--nabu-color-picture`. Storybook has a Theme switch; every
  story is in the dark pass (tests/visual/theme.spec.ts: LTR, RTL, vertical, axe colour contrast).

## Working in this repo
- Pushing straight to main is always fine here. CI (.github/workflows/ci.yml) must stay green.
- Self-hosting: deploy/compose.yaml (deploy/README.md). The images keep the workspace layout (Node runs TS source, never
  from node_modules); `VITE_NABU_API=/` means this origin. CI runs deploy/smoke.sh against it. Locally, build with
  `--network host`, the proxy build args and `--secret id=ca,src=/root/.ccr/ca-bundle.crt`.
- GitHub Pages (pages.yml) publishes Storybook and the web demo on every push to main.
- ADRs 0013–0089 are Proposed, awaiting acceptance. docs/gameplan-errata.md lists where the gameplan was wrong.
- Fresh cloud container setup:
  - `pnpm i`
  - `sudo apt-get install -y libicu-dev pkg-config` (skip `sudo` when root)
  - `sudo apt-get install -y espeak-ng ffmpeg` (audio)
  - `cd pipeline && uv sync --frozen` (default compiler/dev groups; leave optional model environments out)
- For `pnpm test:visual:docker` in a container, start the Docker daemon first:
  `(dockerd > /tmp/dockerd.log 2>&1 &)`
- Agents: shell heredocs can turn a typed `\uXXXX` into the literal character. Build escapes in code (chr(92)),
  then grep for literal invisibles before committing.
