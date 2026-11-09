# Testing and recovery

## Repeatable checks

Use the Node version in `.node-version` and the pnpm version in `package.json`. Install the
matching Playwright browser before the first browser run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nabu/web exec playwright install chromium
pnpm --filter @nabu/web test
pnpm --filter @nabu/web typecheck
pnpm --filter @nabu/web lint
pnpm --filter @nabu/web build
pnpm --filter @nabu/web exec playwright test navigation-recovery download-recovery
pnpm test:e2e
```

The web unit suite runs under `pnpm test` too. It exercises actual routing, memory storage,
HTTP requests, outbox uploads, synchronization and downloads. External fetches, browser storage
and timers are controlled by tests; expected batches, event IDs, hashes and request counts are
asserted independently of the implementation. The sync tests replace the unrelated game UI module.

Browser tests use the production build, an in-memory API, and fresh browser contexts. Ports
4174 and 4175 must be free: an occupied port fails the run rather than silently testing a stale
build or retaining another run's accounts. Two workers limit CPU contention. Failed tests retain
traces and screenshots under `apps/web/test-results`; CI also uploads the HTML report. Traces
can contain test-account credentials and request bodies: use disposable accounts only.

```sh
pnpm --filter @nabu/web exec playwright show-trace test-results/<test>/trace.zip
pnpm --filter @nabu/core exec vitest run test/listening.test.ts --maxWorkers=2
pnpm --filter @nabu/core exec vitest run --maxWorkers=2
```

CI runs browser behavior independently of screenshot comparisons and grading performance, so a
visual baseline failure cannot conceal functional failures. The existing full Python, API,
conformance, visual, deployment and native-build checks remain necessary; these focused tests do
not replace them. Python course tests require ICU, and audio-tool tests additionally need ffmpeg
and eSpeak NG; use CI's dependency setup when running the entire suite.

## Findings from the 2026-11-09 regression pass

These findings were reproduced with unit tests or identified in source review. **No interactive
browser observations are claimed.** This workspace's macOS sandbox denies Chromium's Mach IPC
registration before it opens a page. The matching Chromium was installed in temporary storage,
but the browser run still stopped at launch. Interactive Browser Use exploration and the newly
authored browser cases still need execution in an unrestricted local session or CI.

Validation in this workspace: 53 web unit tests passed; web lint, TypeScript checks and the
production build passed. The full core run completed with 1,558 passing tests and one 5-second
timeout in the all-course template-coverage check. That check passed separately after receiving
the same 30-second budget as the neighboring all-course checks. The complete core suite was not
rerun after that timeout adjustment. Playwright discovers 220 cases (10 new), but discovery is
not execution. The full Python, visual, deployment and native suites were not rerun in this pass.

| ID | Finding and reproduction | Status and regression |
| --- | --- | --- |
| R1 | With IndexedDB unavailable, append two payloads with the same ID in one batch. The fallback reported two new events and replaced the first payload. | Fixed. `store.test.ts` asserts first-write preservation, one new ID, one pending event, ordering and receipts. |
| R2 | Parse `#/fa/%`, a truncated UTF-8 escape, or `%FF` in a lesson link. Routing threw `URIError`; initial render or hash navigation could fail. | Fixed. `routes.test.ts` checks malformed links and every route family; `navigation-recovery.spec.ts` covers initial load and subsequent navigation on keyboard/touch. Browser verification pending. |
| R3 | Fail one download while another fetch is held open. The operation returned its error while workers were still writing, allowing Retry to overlap the old operation. | Fixed. `offline.test.ts` holds a fetch and verifies failure is reported only after active work settles. Remaining queued work is stopped. |
| R4 | Reject `caches.open()` with a quota or security error. The rejection escaped the downloader's error handling, potentially leaving its caller busy. | Fixed. `offline.test.ts` checks opening-storage errors, network/HTTP failures, corrupt bytes, quota errors, manifest commit order and preservation of the old manifest on failure. |
| R5 | Call `syncNow()` eight times before the pending-count read resolves. Eight pulls started concurrently. | Fixed. `sync.test.ts` requires one active pull and one coalesced follow-up, and verifies no network traffic without an account. |
| R6 | Hold account A's pull, sign out, sign in to B, then return A's HTTP 401. B's account was erased. | Fixed for the delayed-response case. `sync.test.ts` checks both in-memory and persisted account identity. |
| R7 | Repeat R6 with a successful A response containing cursor 99. B's first pull incorrectly used `since=99`, potentially skipping B's events. | Fixed for the delayed-pull case. `sync.test.ts` requires B to start at `since=0`; stale pulls are discarded. |
| T1 | One listening test combined four full-course, eight-seed scans and exceeded its 60-second limit. | Split into independently named language/reading cases without dropping words, seeds or assertions. The select-word test no longer builds unused minimal-pair exercises. |

`outbox.test.ts` additionally checks 401 events in ordered 200/200/1 batches, and failed second
batches under network loss, HTTP 401/503, and corrupt JSON. Retry must retain and resend only
unacknowledged events while preserving all local history. `http.test.ts` covers empty 201/204
responses and non-JSON server errors.

`download-recovery.spec.ts` adds network and integrity failure/retry cases for desktop and touch:
the UI must not mark bad audio ready, repaired bytes must match the manifest SHA-256, and the
ready state must survive reload. These use blocked service workers to isolate direct download
requests; the existing `offline.spec.ts` covers actual service-worker reload and background sync.

## Suspected bugs still needing browser reproduction

| Priority | Suspected issue | Reproduction to try / expected behavior |
| --- | --- | --- |
| High | Cancellation across sign-out, uploads and background sync is broader than the delayed-pull fixes. `uploadOutbox` and judge flushing can already be in flight when the account changes. | Delay an upload/judge response, sign out or switch accounts, then record more progress. Inspect subsequent request credentials, outbox acknowledgements and cursor metadata. No newly started work should use the forgotten account. Include a second tab and service worker. |
| Medium | Reset confirmation shows success synchronously while persistence happens asynchronously (`StartOver.tsx`, `App.tsx`). | Inject an IndexedDB write failure when confirming a reset. Compare the displayed success, retained log, and progress after reload. Failure should be visible, with progress preserved. |
| Medium | A fetch that never settles has no deadline in `http.ts`; sync/sign-out may remain waiting. | Hold the API response open, navigate away and back, then restore connectivity. Check pending progress, sign-out responsiveness and whether a fresh sync can proceed. |
| Medium | `useStored` reads cache storage without a rejection handler. Handling a failed download's cache opening does not cover initial offline-status loading. | Deny cache access before opening a course. Check unhandled page errors and that ordinary online lessons remain usable with an explicit offline-storage limitation. |

## Interactive exploration checklist

Use a scratch browser profile and a disposable API. Record URL, viewport, language, exact
actions, expected/actual result, console errors, and a screenshot/trace for each finding.

- Open Persian and Cantonese, answer a card manually, finish a lesson, reload and check progress.
  Include an intentionally wrong answer and review its correction. Avoid deriving every expected
  answer from the production planner/solver.
- Switch between Latin/Cyrillic Uzbek, Arabic/Arabizi Levantine, and Toki Pona scripts; check input,
  reading preferences and text direction on a narrow touch viewport.
- Change theme, UI language and target text size; reload and check persistence and keyboard focus.
- Exercise malformed links, back/forward navigation, and links into an unavailable course.
- Download one unit, lose connectivity during a second download, retry, reload offline, and remove
  only that unit's unshared media. Check that local learning history survives.
- Sign up after offline learning, interrupt sync, reload, reconnect, and compare server/device logs.
  Exercise the account-switch races above and incorrect-password deletion in disposable accounts.

Keep confirmed bugs separate from hypotheses. Passing unit tests do not establish browser,
accessibility, screenshot, mobile-native or model-runtime correctness.
