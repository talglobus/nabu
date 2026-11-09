# Nabu

An open-source, script-first, Duolingo-style language-learning app. Writing systems are data:
Persian, Cantonese, Uzbek and Lebanese Arabic fixtures (RTL, ZWNJ, ruby, vertical text,
modifier-letter apostrophes, unstandardized spelling) shape the architecture before any Latin-only
shortcut can.

- Architecture and roadmap: [docs/gameplan.md](docs/gameplan.md)
- Decisions: [docs/adr/](docs/adr/) (0001–0012 are gameplan §1; 0013+ came out of Phases 0–3)
- Working agreement for contributors and agents: [CLAUDE.md](CLAUDE.md)

## Status: Phase 10 (offline and mobile) on top of Phases 0–9

The gameplan's ten phases are built, and the four fixture courses have grown to ten units each
(about 300 sentences, 55–60 lessons and 10 stories per course; [ADR 0050](docs/adr/0050-ten-unit-courses.md)).
What comes next, and what needs people rather than code, is in [docs/next-steps.md](docs/next-steps.md).

| Path | What |
|---|---|
| `schemas/` | JSON Schema 2020-12: TaggedText, Token, RubySegment, OrthographyProfile, MessageCatalog, CourseSource, BundleManifest, LearnerEvent, AI outputs (judge, explanations, roleplay, reports, evaluations) |
| `packages/schema` | TS types generated from `schemas/` (branded, deeply readonly) |
| `pipeline/` | uv project: Pydantic v2 models generated from `schemas/`; the course compiler (`nabu build`, 51 lints with fixtures, stories, roleplay scenarios, deterministic content-addressed bundles), analyzer adapters (PyCantonese, hazm), CLDR RBNF number drills (PyICU), a LibreLingo importer; DuckDB calibration of the performance model (`nabu calibration`, `notebooks/calibration.py`); audio (`nabu audio`: eSpeak NG / Piper synthesis from pinned readings, or hosted ElevenLabs / Cartesia voices with keys from the environment; forced alignment, Whisper round-trip QA, human-recording ingestion); `nabu reports promote` (approved answers into accept sets, with the pull request's description), `nabu corrections apply` (learners' corrections to sentences and story lines into the unit files, value by value, with what needs a person listed by file:line) and `nabu author draft` (LLM-drafted sentences, linted, for review); `nabu refs` (the reference library: a private Drive folder through its relay, ADR 0079); `nabu speech serve` (tiers 1–2: unprompted faster-whisper and wav2vec2 phones, audio never kept) |
| `packages/i18n` | Generated CLDR 49 tables (script metadata, likely subtags, parent locales, exemplars) and Unicode 16 security data (confusables, identifier status), locale negotiation, MF2 catalogs (`en`) and pseudo-locales (`en-XA`, `ar-XB`), font stacks |
| `packages/ui` | `<T>` (the only way language data reaches the DOM; tappable words for glossing), the lesson player (templates, word bank, IME-safe input, feedback, ruby and harakat toggles), the story reader (dialogue, tap-for-gloss, questions, vertical reading), Explain My Answer and the roleplay chat (every segment in its own language and direction), scored speaking and tone choice, Storybook, visual matrix |
| `packages/lint` | Custom ESLint rules (§11.9) and strict logical-properties stylelint config, with fixtures |
| `packages/core` | Pure core: TaggedText checks, letters and case folding, the normalization engine, profile compiler, accept-set notation → lattice, closest-path matcher, typo models, grading, the runtime glossary (longest match, exact and folded passes); lessons (templates, seeded lesson builder, player state machine); the learner model (event projection: FSRS-6 facets, Elo performance model, XP, mistakes, path) and the seeded session planner; stories (scripts and the reader state machine); game rules (streaks with freezes and date-line bridging, quests, achievements, gates, league XP) and UTS #39 username checks; AI rules (the judge's gates and retroactive revisions, explanations as language-tagged segments, roleplay turn checks); speech (YIN pitch tracking, Cantonese tone scoring with self-calibration, speech grading as feedback, the tone evaluation); offline courses (what a device must keep, download plans, a course restricted to the media it has) |
| `packages/core-cli` | JSON-lines CLI over core (the Python pipeline's only way in), profile loader, conformance and property tests, throttled grading benchmark |
| `apps/web` | Vite + React client: course list, the streak and quests panel, the course path (lessons and stories unlock in order), placement, review and mistakes sessions, listening exercises with karaoke, XP; every learner event kept in an on-device IndexedDB log, with optional account sync, a profile, the weekly league and practice reminders (service worker); a sentence list where any sentence or story line can be marked wrong with a correction (also from a lesson's feedback and a story line; downloadable for `nabu corrections apply`); reporting a wrong answer (lessons and stories), and with a model on the server a second check by the judge, Explain My Answer and roleplay conversations; scored speaking (tones on the device, words and phones on the server) with voice privacy settings; offline use: a TypeScript service worker (the app shell, course files, audio ranges, push, Background Sync of the outbox) and per-unit downloads of audio and pictures; reads the committed bundles (`public/bundles`); Playwright e2e |
| `apps/mobile` | Capacitor 8 shell for Android and iOS around the web build, every course inside; native practice reminders; CI builds the Android debug APK (`apps/mobile/README.md`) |
| `apps/api` | Hono server: optional accounts, the learner event log (Postgres via Drizzle, or PGlite with no setup), idempotent uploads, sync by cursor, server projections by the same core replay; profiles (UTS #39 usernames), opt-in leagues with an idempotent weekly rollover, opt-in Web Push reminders (RFC 8291/8292 on node:crypto); the LLM gateway (Ollama, OpenAI-compatible or Anthropic, from the environment; schema-validated, cached, budgeted, with provenance), the judge behind per-language gates, Explain My Answer, roleplay, the review queue; speech scoring through the speech service; the game state projected from the log with each event's receipt time (`/v1/game`), which devices check against their own; reminders to the Android and iOS apps through FCM and APNs |
| `apps/references` | The reference library relay (ADR 0079): a Cloudflare Worker that reaches one private Google Drive folder of grammars, dictionaries and notes for course authors, through `nabu refs`; never part of the app (`apps/references/README.md`) |
| `profiles/` | Orthography profiles: fa-Arab, yue-Hant-HK, uz-Latn, uz-Cyrl, ar-Arab, apc-Arab, apc-Latn (Arabizi), tg-Cyrl, tr-Latn; data tables and interim keyboard layouts |
| `courses/` | Fixture courses, ten units each (A1 to early A2), with their audio (`audio/`, clips and index): `fa` (ZWNJ plurals, ezafe, می‌ present, subjunctive, past), `yue` (Jyutping ruby, particles, classifiers, aspect), `uz` (Latin + Cyrillic, script-convert node, suffix morphology), `apc` (Arabic script or Arabizi, script-convert node, the b- present; twenty units to A2, checked against a reference grammar, ADR 0080); a story per unit (the apc ones vocalized) and six roleplay scenarios each. LLM-drafted, awaiting review (`courses/REVIEW.md`) |
| `prompts/`, `evals/` | Prompt templates (referenced by hash); the judge's golden sets (193 items: adversarial near misses and paraphrases per orthography) and gates (`pnpm --filter @nabu/api evals`); tone sets (`pnpm --filter @nabu/core tone-eval`; the committed one is synthetic) |
| `conformance/` | 340 shared test vectors (graphemes, UnicodeSets, direction, case folding, normalization, segmentation, accept sets, grading, TaggedText, glossing), run in TS and Python |

## Getting started

Requirements: Node ≥ 22.18 (with corepack), [uv](https://docs.astral.sh/uv/), and Docker for the
pixel half of the visual tests.

```sh
corepack enable
pnpm install
(cd pipeline && uv sync)        # add --all-groups for PyICU (needs libicu-dev, pkg-config)
pnpm lint && pnpm typecheck && pnpm test
pnpm courses                   # compile the fixture courses
pnpm dev                       # web + loopback-only API, with an isolated development database
pnpm test:e2e                  # lessons by keyboard and by touch, IME, axe, progress, placement, sync
pnpm --filter @nabu/core simulate --out /tmp/sim.jsonl && (cd pipeline && uv run nabu calibration /tmp/sim.jsonl)
pnpm storybook                 # http://localhost:6006
pnpm test:visual:docker        # the visual matrix, in the same container CI uses
```

The development API ignores `DATABASE_URL`, `NABU_PGLITE`, and `NABU_HOST` inherited from your
shell. It uses `apps/api/.data/dev-pglite`; set `NABU_DEV_PGLITE=memory` for a disposable database
or `NABU_DEV_DATABASE_URL` to deliberately use a development Postgres database. Migrations run
on startup. `pnpm start` in `apps/api` uses the deployment database settings and binds to loopback
unless `NABU_HOST` is explicitly set; Docker Compose sets it for the container network.

Navoiy/CosyVoice generation is currently [disabled](pipeline/runtimes/cosyvoice/README.md) because
its legacy dependencies have known vulnerabilities. Committed audio remains usable. The optional
OmniVoice environment also retains an unresolved Pillow advisory set through Gradio's `<13`
constraint; avoid installing optional model environments for ordinary feature development.

## Licence

Code: [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE), at your option. Course content
defaults to CC BY-SA 4.0. Bundled fonts are OFL-1.1, and CLDR data is Unicode-3.0.
