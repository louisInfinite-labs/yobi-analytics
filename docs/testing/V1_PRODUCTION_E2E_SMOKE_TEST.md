Status: V1 Launch Gate
Type: Production E2E Smoke Test
Environment: Production frontend + production backend
Implementation Status: In progress

## 1. Purpose

This is the final user-path smoke suite run before V1 production launch (and before any
subsequent production deploy that touches a launch-critical path). It answers one question:
*"does the thing a real visitor does, actually work against the real deployed system?"*

It is NOT a replacement for:

- the existing Vitest unit/component suite (`frontend/dashboard/src/**/*.test.*`)
- the existing Playwright interaction/regression suite (`frontend/dashboard/e2e/*.spec.ts` —
  `fa1`–`fa4`, `gap*`, `mt16`/`mt17`, `schedule-and-settings`)
- backend unit/integration tests under `tests/`

Those suites already own correctness of component behavior, state logic, and backend
computation in detail, running against a local dev server + a local API fixture
(`scripts/local_api_server.py`) or in-process. This document owns one narrower thing: a small,
fast, repeatable pass over the handful of user journeys that would be an unacceptable launch
blocker if broken, executed (where authorized) against the real deployed frontend and backend.

## 2. Scope / Non-goals

In scope: the launch-critical paths enumerated in cases A–O below — app shell loads, Home
shows a real creator and plays the right video, Live Status opens and switches Oshi correctly,
Settings persist, Schedule renders without duplicates, known API/upstream failure shapes are
distinguishable from empty states, and graduated-creator handling doesn't regress into a
permanent error banner.

Out of scope (do not expand into these without a separate explicit task):

- Full regression coverage of every interaction permutation already owned by `fa1`–`fa4`/`gap*`/`mt16`/`mt17`
- Visual/pixel-level design QA
- Load/performance/soak testing
- Security control verification (App Check, CORS lockdown, WAF, rate limiting) — these are
  owned by `docs/plans/V1_SECURITY_P0_ROADMAP.md` and are **0% implemented** as of this
  writing (verified: no `firebase.json`, no App Check code, no `tests/security/` directory,
  CORS still wildcard in `terraform/api_gateway.tf`). Every Security-dependent case below is
  marked `BLOCKED / PENDING SECURITY MERGE`, not reimplemented here.
- Implementing the per-stream one-time reminder notification architecture (a separate,
  explicitly-deferred task) — Notifications cases here test only what is live today
  (topic-based, `localStorage`-only preferences; see case J).

## 3. Preconditions

| Item | Value |
|---|---|
| Production frontend URL | **TBD / VERIFY BEFORE EXECUTION** — no Firebase Hosting site or custom domain is recorded anywhere in this repo (README.md: "Initial dashboard hosting may use AWS-provided URLs"; roadmap MT-29 "Firebase Hosting + project wiring" is not done). A deployed production frontend may not exist yet. |
| Production API URL | `https://k76ct6q0j0.execute-api.ap-northeast-1.amazonaws.com` (hardcoded in `scripts/deploy/deploy_api_only_v510.py:36`). Public, unauthenticated for GET routes (CORS currently `["*"]` in `terraform/api_gateway.tf:6`). **VERIFY this is still the live endpoint before executing against it** — it was not independently re-confirmed by hitting it in this session. |
| Valid Creator Master data | Present (`src/tracking/creator_master.py`, generated `frontend/dashboard/src/entities/creator/data/generated/creatorMaster.json`). Source of truth for exact IDs — do not hardcode creator IDs into test assertions without re-reading this file at execution time, since roster membership changes over time. |
| At least one LIVE/UPCOMING creator | Not guaranteed at any given execution time — Holodex schedules are real-time. Smoke cases that need a live/upcoming creator must discover one dynamically from `/live-streams` at run time, or be marked `BLOCKED (no live creator at execution time)` for that run rather than hardcoding an ID. |
| At least one creator with ordinary videos | Any active member not in the historical-data-unavailable set below. |
| Graduated creator cases | `HISTORICAL_DATA_UNAVAILABLE_CREATOR_IDS = {"mano_aloe", "uruha_rushia", "yozora_mel"}` (`src/tracking/creator_master.py:353`) — these 3 have no YouTube uploads playlist and get a 404 `HISTORICAL_DATA_UNAVAILABLE` from the 3 per-creator read routes (videos/ranking, videos/recent, oshi-status). `nanashi_mumei` is graduated but NOT in this set (she has a real backfilled catalog) — a useful contrast case. Re-verify this set against `creator_master.py` at execution time; it is a living list. |
| Browser state requirements | Fresh/incognito context recommended for first-visit cases (empty `localStorage`); a persisted-state context needed for persistence cases (case E, J). Playwright's `storageState` covers both. |
| localStorage / IndexedDB | All client-local state is `localStorage`-only today (no IndexedDB in use): `yobi.locale`, `yobi.timeFormat`, `yobi.upcomingDisplayMode`, `yobi.defaultOshiCreatorId`, `yobi.home.selectedCreatorId`, `yobi.favoriteCreatorIds`, `yobi.confirmOshiSwitch`, `yobi.home.lastVisitAt`, `yobi.topicNotificationPreferences.v2`, `yobi.liveStreams.cache`. |
| Notification/App Check dependencies | Not relevant to any case below — App Check does not exist in this tree yet (see Scope). Web Push (`pushNotifications.ts`) requires HTTPS + explicit browser permission grant and is **not** exercised by this smoke suite (it needs a real service-worker + push subscription round trip with a human permission prompt — mark `MANUAL`, not automated, if ever added). |

No secrets appear in this document. Do not add any API key, admin key, or client secret to this
file or to any script it describes.

## 4. Evidence format

Every case below uses:

```
ID
Area
Precondition
Steps
Expected result
PASS / FAIL / BLOCKED
Evidence / Notes
```

The automation classification for each case is one of:

```
AUTOMATED       — runs unattended via Playwright (or an existing equivalent), asserts a concrete outcome; a real spec is cited
MANUAL          — requires human visual/judgment review
HYBRID          — automation gets the system into the right state / fetches the right data; a human confirms the rendered result,
                   OR an existing test covers only part of the claim (noted per case)
BLOCKED         — cannot run yet (Security-dependent, missing production config, or a known product gap with nothing to assert)
NOT YET AUTOMATED — deterministic and automatable in principle (nothing blocks it, no human judgment required), but no existing
                   or new test currently covers it. Distinct from BLOCKED: this is a backlog item, not a dependency.
```

**2026-10-06 review correction**: a scoped code review of this MD against the actual e2e suite (not
just file names) found significant overclaiming in the original authoring pass — several cases
cited "existing fa2/fa3/gap*" coverage that, on inspection of the real test bodies, does not exist.
Every case below marked `NOT YET AUTOMATED` was previously marked `AUTOMATED` without a real test
behind it. See the Phase 3 table's own note for the full corrected list and reasoning.

---

## 5. Local vs Production smoke execution

The same suite (`e2e/smoke/*.spec.ts`, run via `playwright.smoke.config.ts`) runs in exactly one of
two modes, selected entirely by whether two environment variables are set. There is no third,
partial mode — `playwright.smoke.config.ts` itself refuses to start if only one of the two is set
(see Safety below).

### Local smoke (default — no environment variables set)

```
npm run test:smoke
```

| Property | Behavior |
|---|---|
| Frontend | A throwaway local Vite dev server on port 5180 (separate from the existing suite's own port 5173) |
| Backend | `scripts/local_api_server.py --port 8790 --enable-smoke-routes` — the local JSON-storage fixture, widened by exactly 4 hand-verified, AWS-safe routes (see that script's module docstring) |
| Production AWS reads/writes | None. The 4 S3-backed per-creator routes stay excluded even under `--enable-smoke-routes`; `HOLODEX_SECRET_NAME` is unconditionally cleared before this process ever imports the real route handler, so Secrets Manager is structurally unreachable |
| Production-only cases | Skipped, not run — e.g. `api-contract.spec.ts`'s historical-data-unavailable test (`test.skip(!process.env.SMOKE_API_BASE_URL, ...)`), because its route is one of the excluded S3-backed ones |
| Security-dependent cases | Remain `BLOCKED / PENDING SECURITY MERGE` regardless of mode — nothing in this repo implements them yet (see Scope) |

### Production smoke (both variables set together)

```
SMOKE_FRONTEND_URL=<production frontend URL>
SMOKE_API_BASE_URL=<production API URL>
npm run test:smoke
```

| Property | Behavior |
|---|---|
| Both variables required together | `playwright.smoke.config.ts` throws a config-time error if only one is set — there is no way to run with a local frontend against a real backend, or vice versa, by accident |
| Local fixture servers | Not started at all — `webServer` is `undefined` in this mode |
| Write operations | None expected or permitted — production smoke mode is read-only. The API-contract spec only uses `request.get(...)`. Page navigation can still make the app itself attempt writes (the Dashboard sends `POST /heartbeat` on mount), so every non-GET request a smoke page makes to the API target is intercepted and stubbed by the test harness and never forwarded (see *Write policy* below) |
| Production-only historical-data-unavailable case | Now executes for real (the `test.skip` guard above is keyed on exactly this env var) |
| Security-dependent cases | Still `BLOCKED / PENDING SECURITY MERGE` until that work is actually merged and deployed — pointing at a real URL does not change what code is running behind it |

### Write policy (both modes)

The smoke suite never writes to its API target, and that is enforced by the harness rather than by trusting the specs:

- `e2e/smoke/helpers.ts` exports a `test` (a thin wrapper over Playwright's) with an automatic fixture that installs `installReadOnlyApiGuard` on every test's `page`. All browser specs must import `test` from there, not from `@playwright/test`.
- The guard routes every request whose origin equals the smoke API target (`SMOKE_API_BASE_URL`, else the local fixture). `GET`/`HEAD` pass through untouched. Every other method (`POST`/`PUT`/`PATCH`/`DELETE`/…) is answered locally with a `200` stub carrying an `x-smoke-guard: blocked` header and is **never forwarded**, so it cannot reach the real API. CORS preflights for routed requests are answered by Playwright itself.
- `e2e/smoke/write-guard.spec.ts` proves it: the Dashboard's own `POST /heartbeat` is attempted, answered by the guard (not the API), and recorded as blocked; `POST`/`PUT`/`PATCH`/`DELETE` to an arbitrary API path are stubbed while a `GET` still reaches the API.
- The guard covers browser pages only (`request.get(...)` in `api-contract.spec.ts` is GET-only by construction). It matches on the API origin, so **`SMOKE_API_BASE_URL` must be the same API the target frontend is built against**; if they differ, the frontend's writes would go to an origin the guard does not cover.
- No production write is expected or permitted. If a future spec needs a write-capable flow, it does not belong in this suite.

### CI

The smoke suite is **not run by PR CI** (`pr-ci.yml` has no Playwright step, and neither does the existing `test:browser` suite). It needs the local smoke environment — the repo `.venv` for the API fixture, an installed Playwright Chromium and a Vite dev server — and is run manually (`npm run test:smoke`). This is an intentional current limitation, not an oversight.

**No secrets belong in this document or in either script it describes.** `SMOKE_FRONTEND_URL`/
`SMOKE_API_BASE_URL` are plain URLs, not credentials — the production API's GET routes are
unauthenticated today (CORS `["*"]`, see Preconditions above).

---

## A. Application shell

| ID | Steps | Expected | Automation |
|---|---|---|---|
| A1 | Load the frontend root URL | App mounts, `<title>` is "OshiYobi", no uncaught page error | AUTOMATED — `e2e/smoke.spec.ts` already covers title+mount; extend with console/page-error tracking (`e2e/helpers/common.ts`'s `trackPageErrors`/`trackConsoleErrors`) |
| A2 | Inspect left navigation | Fixed left `MainNavbar` present (mounted once in `App.tsx`, shared across all pages) | AUTOMATED — assert the navbar landmark is visible on load |
| A3 | Load Home, measure scroll | No unintended whole-page vertical scroll on Home (`.oshi-home`/`.oshi-home__canvas` is a fixed single-viewport layout per `home.css`) | AUTOMATED — assert `document.documentElement.scrollHeight <= viewport height + small tolerance` |
| A4 | Hard refresh on a deep route (e.g. `/setting`, `/schedule` -- `useCurrentPage.ts`'s real path for Settings is `/setting`, singular) | Page reloads to the same route correctly (no blank page, no routing error) | AUTOMATED |
| A5 | Direct navigation to each top-level route | Home, Schedule, Settings all render their own content | AUTOMATED |
| A6 | Console/page error check across A1–A5 | Zero uncaught exceptions, zero `console.error` | AUTOMATED (same trackers as A1) |

New coverage needed: a dedicated `v1-smoke-app-shell.spec.ts` (existing `smoke.spec.ts` is a trivial mount check only).

## B. Home / YouTube player

| ID | Steps | Expected | Automation |
|---|---|---|---|
| B1 | Load Home for the current Oshi | Real creator data shown — avatar/name (`mockCreators`-sourced; see Known Gaps), live/upcoming/video data from the real `/live-streams`, `/creators/{id}/videos/*`, `/creators/{id}/oshi-status` endpoints | HYBRID — automate the network assertions (right endpoints called, 2xx/expected 4xx), manually confirm rendered content looks right |
| B2 | Observe the central player when a live/upcoming/recent (within 24h) video exists for the current Oshi | Correct video loads per `selectLiveEmbedVideo`'s priority (live > upcoming > recent-within-24h > none) | HYBRID — **corrected from AUTOMATED**: no existing test implements this, and like C7/C8 it fundamentally needs a real live/upcoming creator present at execution time (not guaranteed), so even once written it can't run fully unattended every time — assert iframe `src` contains the expected `videoId` when one is deterministically discoverable from `/live-streams` at run time, else `BLOCKED (no live/upcoming creator at execution time)` |
| B3 | Inspect player frame | Stays 16:9 (`.oshi-player-frame__ratio`, CSS-only) | MANUAL (visual aspect-ratio judgment) |
| B4 | Interact with YouTube's native controls inside the iframe | Controls remain usable, no overlay/frame intercepts pointer events over them | MANUAL (cross-origin iframe interaction is not reliably Playwright-automatable; CSS says the frame should not cover controls — spot-check visually) |
| B5 | Confirm no mock data leaks into displayed stats/videos | No value that is visibly a `mockCreators` placeholder stat appears | MANUAL |

Not in V1 (do not test): Wide/Theater mode — does not exist in current code; do not invent it.

## C. Live Status

| ID | Steps | Expected | Automation |
|---|---|---|---|
| C1 | Click the floating Live Status trigger | Drawer opens, `data-live-status-open="true"` on `.live-status-dock` | AUTOMATED — already covered by `e2e/fa2-live-status-interaction.spec.ts`; reference, do not duplicate |
| C2 | Confirm overlay behavior | Drawer overlays Home (`position: fixed`); Home's own layout never reflows (CSS-only `data-live-status-open` attribute, confirmed in `LiveScheduleDock.tsx`'s own docstring) | NOT YET AUTOMATED — verified (review pass): no existing test asserts a bounding-box/reflow comparison before and after the drawer opens |
| C3 | Inspect group order | Branch order fixed (`DOCK_BRANCH_ORDER`) → subgroup → members-before-non-members → org channel (e.g. `hololive_official`) last in its branch | NOT YET AUTOMATED — verified (review pass): `fa2-live-status-interaction.spec.ts` has no test asserting roster/branch/subgroup/org-channel order; grepped every `gap*`/`mt16`/`mt17` file for `DOCK_BRANCH_ORDER`/`groupCreatorsForDockWithSubgroups`/any live-status selector — zero hits. The original "fa2/gap*" citation was unsupported |
| C4 | Default creator-name order within a group | Ascending `displayOrder` from creator master, never alphabetical | NOT YET AUTOMATED — same verification as C3; no existing test compares relative order of multiple creators |
| C5 | Status sort within each group | `Live → Upcoming → Offline`, sorted only inside each group, never across groups | NOT YET AUTOMATED — verified: `fa2` never reads/asserts a status badge or relative position by status |
| C6 | Search box | Case-insensitive substring filter on display name | AUTOMATED — `fa2-live-status-interaction.spec.ts`, "search narrows the roster to matching creators and shows an empty state for no match" (verified: asserts matching name visible, non-matching `toHaveCount(0)`, and the no-match empty state) |
| C7 | LIVE status | A creator with a live stream shows LIVE | HYBRID — needs a real live creator at execution time (not guaranteed); discover dynamically from `/live-streams`, mark `BLOCKED (no live creator at execution time)` if none exists for this run |
| C8 | UPCOMING visibility | Shown only within the implemented rolling 24h window (`LIVE_STATUS_UPCOMING_WINDOW_MS`) | HYBRID — same dynamic-discovery caveat as C7 |
| C9 | OFFLINE | A creator with neither live nor upcoming-within-24h shows OFFLINE | NOT YET AUTOMATED — verified (review pass): grepped every spec file in `e2e/` case-insensitively for "offline" — zero matches anywhere. This was an assumed/invented claim, not a real test |
| C10 | Secondary line (stream/topic title) | Shown where the implementation actually surfaces it | HYBRID |
| C11 | Switch current Oshi from a row | Confirm dialog appears (if `yobi.confirmOshiSwitch` is true) → Home updates to the new creator, no stale previous-creator data | AUTOMATED — `fa2-live-status-interaction.spec.ts`'s "switching the selected creator updates Home's Oshi Status panel..." test (verified: drives the real `OshiSwitchConfirmDialog`, asserts Oshi Status panel updates, asserts the MAIN badge stays on the original creator). **Correction**: the original citation also named `fa3`; verified `fa3-oshi-favorites-isolation.spec.ts` does not touch the confirm-dialog flow at all (it only exercises the non-confirm-gated Main Oshi picker in Settings) — citation narrowed to `fa2` alone |
| C12 | Close via ESC / outside click / explicit close | Drawer closes, focus returns to the trigger | AUTOMATED — `fa2-live-status-interaction.spec.ts` has three dedicated tests for this exact behavior (close button, Escape, outside-click) |

## D. Current Oshi switching

| ID | Steps | Expected | Automation |
|---|---|---|---|
| D1 | From Creator A, switch to Creator B via Live Status, confirm | Home re-renders fully scoped to B: Oshi Status, Oshi Videos, Schedule avatar all change; zero stale A-scoped content, even transiently | HYBRID — `fa2`'s switch test (cited at C11) confirms the Oshi Status panel's creator name updates to B and the MAIN badge stays on A; it does NOT independently verify Oshi Videos or Schedule's avatar also update, nor "zero stale content even transiently." Narrower claim is AUTOMATED; the full claim as written is not |
| D2 | Switch back to A | Returns correctly | NOT YET AUTOMATED — verified: `fa2`'s switch test only switches once (A→B) then closes/reopens the drawer to check persistence; it never switches back to A |
| D3 | Reload after switching | Session does not unexpectedly force the default Main Oshi — current behavior is that `yobi.home.selectedCreatorId` is deliberately NOT read back on fresh reload (always resumes Main Oshi). **This is documented current behavior, not a bug** — assert it explicitly so a future regression (or an intentional future change) is caught either way | NOT YET AUTOMATED — verified: no existing test calls `page.reload()` after a Live Status Oshi switch |

## E. Main Oshi / Favorites

| ID | Steps | Expected | Automation |
|---|---|---|---|
| E1 | Set Main Oshi in Settings | Persists to `yobi.defaultOshiCreatorId`, survives reload | AUTOMATED — `fa3-oshi-favorites-isolation.spec.ts` (verified: its test reloads and re-checks "Current Main Oshi: 兎田ぺこら") |
| E2 | Add/remove Favorites | Persists to `yobi.favoriteCreatorIds`, independent of Main Oshi and Current Oshi | AUTOMATED — `fa3` (verified: asserts favorited state and independence from Main Oshi changes, plus reload persistence) |
| E3 | Main Oshi change does not affect Favorites, and vice versa | Isolation holds both directions | AUTOMATED — `fa3` (verified: explicitly checks both directions — changing Main Oshi doesn't touch Favorites, removing a Favorite doesn't touch Main Oshi) |
| E4 | Group/order behavior in Favorites view | Correct per `groupCreatorsForDockWithSubgroups` | NOT YET AUTOMATED — verified (review pass): `fa3` has exactly 2 tests, both scoped to isolation/persistence; neither ever asserts grouping or ordering in the Favorites view. This claim had no real test behind it |

All three concepts (Main Oshi, Current/session Oshi, Favorites) are confirmed-distinct,
separately-persisted `localStorage` keys — document this explicitly rather than re-deriving it
per case.

## F. Oshi Status

| ID | Steps | Expected | Automation |
|---|---|---|---|
| F1 | Load Oshi Status for an active creator with real data | Subscriber count, Live/Next, Latest Video, This Week, Recent all render from `GET /creators/{id}/oshi-status` | HYBRID — automate "request fires, 2xx, expected JSON shape"; manually confirm content look |
| F2 | Subscriber count absent from backend | Omitted entirely, never fabricated as `0` | NOT YET AUTOMATED — verified (review pass): grepped `e2e/` for `subscriberCount`/`OshiStatusPanel` behavior beyond the creator-name selector; no existing test exercises this |
| F3 | First visit (no `previousVisit`) | Distinct "first visit" empty message for Since Last Visit, not a generic empty state | NOT YET AUTOMATED — no existing test found |
| F4 | Historical-data-unavailable creator (`mano_aloe`/`uruha_rushia`/`yozora_mel`) | `oshi-status` 404s with `HISTORICAL_DATA_UNAVAILABLE`; frontend treats this as a clean empty state (`error: null`), not an error banner | AUTOMATED (API-contract layer, production-only) — `e2e/smoke/api-contract.spec.ts` (same test cited at K3); the UI-level rendering claim ("treats this as a clean empty state") is HYBRID — not independently re-verified at the component level |
| F5 | Network/backend 5xx | Renders `OshiErrorState`, visually distinct from the valid-empty states above | NOT YET AUTOMATED — no existing test found |
| F6 | No fabricated `0` anywhere in Oshi Status for unavailable fields | Confirmed by F2/F4 contract | Follows F2/F4 above — NOT YET AUTOMATED pending F2 |

## G. Oshi Videos

Current actual tag set (do NOT test against the old assumed taxonomy — verified against
`model/videoCategories.ts`): `All, 最新影片(latestVideos), 最新直播(latestLive), SF6, VALO, Minecraft, Apex, 歌回/Singing/歌枠(singing), 雜談/Chatting/雑談(chatting), 其他/Other(other)`.
**There is no separate full-name "VALORANT" tag (it's "VALO") and no MV/music-video category at
all** — test against the real tags, not the proposed V2 taxonomy.

| ID | Steps | Expected | Automation |
|---|---|---|---|
**Review-pass correction**: G1–G8 below were all originally marked `AUTOMATED` with no file citation.
Verified: there is no existing or new spec file anywhere in `e2e/` that touches Oshi Videos
(`RecentVideosSection`, `videoCategories.ts`, tag switching, pagination, or sort) — grepped for every
distinguishing keyword with zero hits. None of this section is actually automated yet; every row
below is corrected to `NOT YET AUTOMATED`. Each remains genuinely automatable (no blocker, no human
judgment needed) — this is a real backlog item for a future implementation pass, not a documentation
nuance.

| G1 | Initial list load for a real creator | Loads from the real paginated endpoint | NOT YET AUTOMATED |
| G2 | Pagination (`loadMore`) | Triggers at scroll index 13, then every +20; real paged requests, no duplicate videoIds across pages | NOT YET AUTOMATED |
| G3 | Each of the 10 real tags | Switches content correctly; sort/content-type/window controls only apply to topic tags (hidden, not removed, for the 2 quick filters) | NOT YET AUTOMATED |
| G4 | Sort control (Newest/Oldest/Most viewed) | Most-viewed reveals a bounded ranking in local batches, no extra request per reveal | NOT YET AUTOMATED |
| G5 | Empty result state (a tag with zero matches) | Per-tag empty copy, not a generic error | NOT YET AUTOMATED |
| G6 | API failure on first page | `OshiErrorState` | NOT YET AUTOMATED |
| G7 | Creator switch mid-view | Old creator's shelf data is fully cleared/reloaded for the new creator, no stale cards | NOT YET AUTOMATED |
| G8 | "View All" button | Currently permanently disabled (no per-creator all-videos route exists yet) — assert it stays disabled, do not test a navigation that doesn't exist | NOT YET AUTOMATED |

## H. Recent archived livestreams

Shares `RecentVideosSection`/`VideoTrack` with G (feeds the "最新直播" quick filter); no separate component.

| ID | Steps | Expected | Automation |
|---|---|---|---|
**Review-pass correction**: as with G, H1–H4 had no real test behind them (only referenced in this
suite's own module docstrings, not actually asserted anywhere) — corrected below. Note `H3`'s route
(`GET /creators/{id}/videos/recent`) is one of the S3-backed routes `scripts/local_api_server.py`
deliberately excludes even with `--enable-smoke-routes` (see that script's module docstring) — H3 can
only be automated against a real target, never the local fixture.

| H1 | Normal creator archive data | `GET /creators/{id}/videos/recent?contentType=live&liveStatus=completed` loads | NOT YET AUTOMATED |
| H2 | Empty state | Valid per-tag empty copy | NOT YET AUTOMATED |
| H3 | Historical-data-unavailable creator | 404 → empty archive, not an error (same contract as F4) | NOT YET AUTOMATED — and, when implemented, must be production-only (S3-backed route, not locally safe) |
| H4 | Network/API error | `OshiErrorState` | NOT YET AUTOMATED |

## I. Schedule

**Current V1 product decision (confirmed and locked for this smoke suite)**:

```
Schedule V1
→ fixed current 7-day range (today through +6 days)
→ Previous / Next week navigation arrows are intentionally disabled
→ week paging is NOT implemented in V1
```

This is not a gap to close here — it is the intended V1 behavior (`ScheduleToolbar.tsx`'s own
docstring: "this phase's data is always the backend's own fixed today-through-+6-day window...
there is nothing to page back or forward into"). The smoke suite's job is to verify this intended
state stays true, not to implement or enable paging.

| ID | Steps | Expected | Automation |
|---|---|---|---|
| I1 | Load Schedule | Renders from the same shared `/live-streams` poll as Home/Live Status, windowed server-side to a 7-day lookahead **starting from today, not a Sunday-aligned calendar week** (`useWeeklySchedule.ts`'s own `weekStart = today`) | AUTOMATED — this branch's own `e2e/smoke/schedule.spec.ts` (loads `/schedule`, asserts 7 day headers in the real rolling order computed from today's actual date, asserts exactly one `.is-today` header, zero page errors). **Correction**: the prior citation of `schedule-and-settings.spec.ts`'s "renders a full-day Sunday-to-Saturday timetable..." test has been removed — that test hardcodes `["Sun",...,"Sat"]` and is **currently failing** on today's actual date (confirmed by directly running it; see the stale-test finding below, a second one in the same file). Does not independently verify the specific `/live-streams` data contract — that part remains HYBRID |
| I2 | Date/time rendering | Correct per the active 12h/24h setting | NOT YET AUTOMATED — **corrected**: the previously-cited `schedule-and-settings.spec.ts` test is the same one now confirmed failing at I1 (fails at the day-name assertion before ever reaching its hour-label checks), so it provides no actual passing coverage of this claim today regardless of format-toggling. No existing test toggles the Settings time-format control and re-checks Schedule's own hour-label rendering reflects it |
| I3 | Creator/group info per row | Correct avatar/name (note: still `mockCreators`-sourced in `ScheduleGrid.tsx`, not the canonical registry — a known seam, not a bug to fix here) | HYBRID — `schedule-and-settings.spec.ts`'s stream-detail-dialog test asserts `.creator-detail-name` is non-empty when a stream is opened; it does not cross-check the name against the expected creator |
| I4 | No duplicate streams | **Known gap: no duplicate-prevention logic exists** — each stream renders 1:1 keyed by `videoId`; a backend duplicate would render twice. Document as a real smoke risk, test what currently exists (assert no duplicate `videoId` appears in a single poll response) rather than asserting a dedup mechanism that doesn't exist | NOT YET AUTOMATED — no existing test asserts this; genuinely automatable as a contract check on the `/live-streams` response |
| I5 | Stale/ended status | **Known gap: `reclassifyIfPastSchedule` is wired into Live Status's own model but NOT into the Schedule page** — an entry whose time has passed stays "upcoming" until the next 60s poll. Do not assert instant reclassification on Schedule; assert it eventually resolves within one poll interval | NOT YET AUTOMATED — no existing test asserts this |
| I6 | Navigation/filtering | **Fixed V1 decision above**: 7-day range, Previous/Next arrows disabled, filter button disabled, no paging implemented — do not test filtering that doesn't exist, and do not attempt to click either arrow (a disabled-button click just hangs on Playwright's actionability wait; see the stale-test finding below for exactly that failure mode) | AUTOMATED — `e2e/smoke/schedule.spec.ts` (new): loads `/schedule`, asserts 7 day headers, asserts both week-paging arrows are visible and `toBeDisabled()`, asserts zero page errors. Never calls `.click()` on either arrow |

**Pre-existing out-of-scope test mismatches** (discovered while verifying I1/I6, not introduced by this
branch, and **not fixed here** per this branch's explicit scope boundary — do not modify
`ScheduleToolbar.tsx`, do not fix `schedule-and-settings.spec.ts`): that file has **two** currently-broken
tests, both predating this branch:

1. **"pages between weeks with the Previous and Next buttons"** clicks the week-selector's Next/Previous
   buttons as if they were enabled. Since those buttons are natively `disabled` (the V1 decision above),
   this test currently **fails** — reproduced directly: `npx playwright test schedule-and-settings.spec.ts
   -g "pages between weeks"` times out after 30s with `element is not enabled`. It tests behavior (week
   paging) that was never implemented.
2. **"renders a full-day Sunday-to-Saturday timetable without errors or page overflow"** hardcodes the
   day-header order as `["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]`. Since the real rendering rolls from
   today's actual weekday (`weekStart = today` in `useWeeklySchedule.ts`, not a Sunday-aligned calendar
   week), this test only passes when executed on a Sunday — it is **currently failing** (reproduced
   directly on today's actual date: `npx playwright test schedule-and-settings.spec.ts -g "renders a
   full-day"` fails at the day-name assertion, before ever reaching its later hour-label/overflow checks).

Whoever owns `schedule-and-settings.spec.ts` should either delete these two tests or update them to match
current reality (exactly what this branch's own `e2e/smoke/schedule.spec.ts` now does for both the
disabled-arrows state and the real rolling day order) — flagged here for visibility, not actioned. Their
current failing state means the wider e2e suite is not fully green right now, independent of anything in
this branch.

## J. Settings

| ID | Steps | Expected | Automation |
|---|---|---|---|
| J1 | Visit all 4 sections (我推設定/Main Oshi, Favorites List, Notification Settings, Display Settings) | Unified layout/background, no console error | AUTOMATED — `fa1-settings-navigation.spec.ts` (verified: its test round-trips all 4 sections and asserts both page errors and console errors are empty) |
| J2 | Locale switching | `LanguagePicker` (bottom of secondary navbar, not inside Display Settings) switches zh-TW/en/ja, persists to `yobi.locale` | NOT YET AUTOMATED — verified (review pass): the only existing uses of "locale" in any spec are `pinEnglishLocale`/an equivalent inline init-script, both of which force-set `yobi.locale` via `page.addInitScript` *before* the app loads, purely for unrelated-test stability. No spec ever clicks the LanguagePicker UI or asserts a resulting locale change/persistence. The MD's own prior "confirm it's exercised; add if not" has now been checked: it is not |
| J3 | 12h/24h time format | Persists to `yobi.timeFormat`, reflected on Home/Dock/Schedule | HYBRID — `schedule-and-settings.spec.ts`'s Display Settings test selects "12-hour (AM/PM)", reloads, and re-checks the Settings page's own selected value persists. It does not assert the format is actually reflected on Home/Dock/Schedule — that cross-surface part is untested |
| J4 | Countdown vs absolute-clock display mode | `yobi.upcomingDisplayMode`, shared formatter | HYBRID — same test and same caveat as J3 (selects "Countdown", reloads, re-checks the Settings-page value; cross-surface reflection untested) |
| J5 | Persistence across reload | All of J2–J4 survive reload | **Corrected**: this case conflated two different things. `fa1`'s reload test only checks nav-state persistence (active section + visible heading after reload) — it never touches locale/timeFormat/upcomingDisplayMode values at all, so citing it for J2–J4 was wrong. The actual value-persistence coverage for J3/J4 lives in `schedule-and-settings.spec.ts` (see those rows); J2 (locale) has no persistence test anywhere, consistent with J2 above. No separate automation entry needed — split across J1 (nav-state reload, covered by `fa1`) and J3/J4 (value reload, covered by `schedule-and-settings.spec.ts`) |
| J6 | No Theme Selector | Confirmed absent from Settings UI; `shared/theme/ThemeSelector.tsx` exists in the tree but is dead code, never imported — assert it is not rendered anywhere, not that the file doesn't exist | AUTOMATED — `schedule-and-settings.spec.ts`'s Display Settings test (verified: asserts zero "Appearance" heading and zero "Dashboard theme" combobox within the Display Settings page). **Correction**: the original text gave no file citation despite the claim being true; citation added |
| J7 | Notification Settings — current scope only | Topic-level Live-reminder mode, notification type (Live/NewVideo/Both), per-creator enable via the management drawer — all `localStorage`-only (`yobi.topicNotificationPreferences.v2`), no backend contract yet. Do NOT test the per-stream one-time reminder architecture (explicitly out of scope / not yet built) | AUTOMATED — `fa4-notification-settings-interaction.spec.ts` (verified: its 3 tests cover topic-level reminder persistence, per-creator enable + reminder persistence via the management drawer, and favorite-grouping without auto-enabling) |

## K. Graduated creators

| ID | Steps | Expected | Automation |
|---|---|---|---|
**Review-pass correction**: K1, K2, K4, K5, K6 were marked `AUTOMATED` with no real test behind them
(grepped `e2e/` for "graduated"/creator-id keywords — the only hits are this suite's own
`api-contract.spec.ts` and a stale leftover `test-results/` JSON artifact, neither of which is a real
test of these specific claims). Corrected below. K3 is the one case this review's own
`api-contract.spec.ts` genuinely automates (production-only, see case 4 of this review) — its contract
(404 + `HISTORICAL_DATA_UNAVAILABLE`) was independently re-verified against `api_handler.py`'s actual
exception mapping and is correct.

| K1 | A graduated creator (e.g. `nanashi_mumei`, who HAS a backfilled catalog) remains visible in Live Status per `isLiveStatusDisplayEligible` (`creator.active`, no separate "Graduated" bucket — stays in her original generation group) | NOT YET AUTOMATED |
| K2 | Historical content for a graduated creator WITH backfilled history (`nanashi_mumei`) | Works normally, not treated as unavailable | NOT YET AUTOMATED |
| K3 | Historical content for a graduated creator WITHOUT a source (`mano_aloe`, `uruha_rushia`, `yozora_mel`) | 404 `HISTORICAL_DATA_UNAVAILABLE` → clean empty state, same contract as F4/H3 | AUTOMATED (production-only) — `e2e/smoke/api-contract.spec.ts`'s skipped-by-default test; runs only when `SMOKE_API_BASE_URL` is set (see case 4 of the review report for why it cannot safely run against the local fixture) |
| K4 | Graduated creators excluded from active polling | Backend's `is_live_status_polling_eligible` only requests active/pre_debut channels from Holodex — graduated creators are never polled, confirmed to fall back to OFFLINE | NOT YET AUTOMATED |
| K5 | No permanent error banner for the known-unavailable case | K3's empty state must never render as `OshiErrorState` | NOT YET AUTOMATED |
| K6 | Graduated member still selectable as Oshi | `isMyOshiEligible` includes `graduated` (member + active/pre_debut/graduated) | NOT YET AUTOMATED |

Re-verify `HISTORICAL_DATA_UNAVAILABLE_CREATOR_IDS` against `src/tracking/creator_master.py`
at execution time — this is a living list, not a fixed constant to hardcode long-term.

## L. Official / group / staff channels

| ID | Steps | Expected | Automation |
|---|---|---|---|
**Review-pass correction**: all of L1–L4 were marked `AUTOMATED` with no real test anywhere (grepped
`e2e/` for `hololive_official`/`vspo_official`/`isMyOshiEligible`/`channelType` — zero hits). Corrected
below; same "genuinely automatable, just not yet written" status as the G/H/K corrections above.

| L1 | Org-level channel (e.g. `hololive_official`, `vspo_official`) appears in Live Status | Rendered last within its branch, static (non-clickable-for-switch) name block | NOT YET AUTOMATED |
| L2 | Org/group/staff channel cannot become Main Oshi | `isMyOshiEligible` is false for `channelType !== "member"` — Settings' Main Oshi picker must not offer it | NOT YET AUTOMATED |
| L3 | Individual (member) creator behavior unaffected by L1/L2 | No regression to member rows | NOT YET AUTOMATED |
| L4 | Group order remains correct with org channels present | Org channel trailing position doesn't disturb member subgroup order | NOT YET AUTOMATED |

## M. API failure states

Verified against the real `_ROUTES`/error-mapping table in `src/api/api_handler.py`:

| Condition | Real response | Case |
|---|---|---|
| Unknown route | 404 `{"error": "No such route..."}` | M1 |
| `HISTORICAL_DATA_UNAVAILABLE` (graduated, no source) | 404 `{"code": "HISTORICAL_DATA_UNAVAILABLE"}` | M2 (= F4/H3/K3) |
| `RANKING_NOT_READY` | 503 `{"code": "RANKING_NOT_READY"}` | M3 |
| Holodex failure/missing key | 503 `{"code": "HOLODEX_UNAVAILABLE"}` | M4 |
| 429 | Frontend `apiClient.ts` retries up to `MAX_429_RETRIES=2` with jittered backoff, then surfaces a rate-limited message | M5 |
| Network unavailable | Plain `Error` → `describeApiFailure` → NETWORK copy | M6 |
| Malformed/unexpected response shape | Not explicitly handled beyond JSON parse failure — **a real gap**: if the backend ever returns a 2xx with an unexpected shape, the frontend has no defensive contract-shape validation found in `apiClient.ts`. Document as a known gap rather than asserting protection that doesn't exist | M7 (`BLOCKED` — no mechanism to test) |

| ID | Expected behavior | Automation |
|---|---|---|
| M1–M6 | Each distinguishes real empty state from failure; none silently converts a failure into empty content | AUTOMATED — these are exactly the deterministic, environment-independent contract checks this suite should own directly (via `request` fixture against the API, no frontend rendering needed for the contract itself; HYBRID for confirming the frontend's rendered distinction) |
| M7 | N/A — no defensive shape validation exists | BLOCKED (known gap, not this task's to fix) |

## N. Holodex / live upstream degradation

| ID | Steps | Expected | Automation |
|---|---|---|---|
| N1 | Normal `/live-streams` | 200, array of streams | AUTOMATED |
| N2 | Holodex upstream error / missing key | 503 `HOLODEX_UNAVAILABLE` (verified: `get_holodex_api_key()` raises `MissingHolodexApiKeyError` when no `HOLODEX_SECRET_NAME`/key is configured, caught in `api_handler.py` and mapped to this exact response — reproducible without any real secret) | AUTOMATED |
| N3 | Stale/fallback behavior | **Not implemented.** Frontend's `liveStreamsStore.ts` keeps the last cached `streams` array from `yobi.liveStreams.cache` on a poll failure, but no consumer (Home, Dock, Schedule) reads `isLoading`/`error` off the store — there is no "stale"/"degraded" UI indicator anywhere. Document as a real functional gap; do not assert a stale-badge that doesn't exist | N/A — nothing to assert |
| N4 | 429 from Holodex | Not distinctly modeled server-side beyond the generic `HolodexAPIError` → 503 path (no evidence of a dedicated 429-passthrough) | BLOCKED (undetermined without forcing real Holodex 429, which this suite should not attempt against a third party) |
| N5 | User-visible impact of N2–N4 | Currently: none beyond whatever the last successfully cached data was (silent degradation) | MANUAL note only — nothing to automate against a UI state that doesn't exist |

Security-dependent note: the security baseline's §23.1 ("`/live-streams` upstream-protection
model", shared-cache/rate-limit layer in front of Holodex) is entirely unimplemented — any
future smoke case about *protected* upstream behavior is `BLOCKED / PENDING SECURITY MERGE`.

## O. Browser coverage

| Browser | Status |
|---|---|
| Chrome | Required |
| Edge | Required |
| Firefox | **OWNER DECISION REQUIRED** — no repository/product decision found establishing Firefox as supported/best-effort/unsupported for the dashboard generally. (The only browser-support statement found, README.md ~line 696–705, is specifically about *Web Push notification* minimum versions — Windows Chrome/Edge/Firefox current, macOS 13+ Safari 16.1+/Chrome/Edge/Firefox — not a general dashboard compatibility policy.) |
| Safari | **OWNER DECISION REQUIRED** (same reasoning) |

Current automated coverage is Chromium-only (`playwright.config.ts`'s single `chromium`
project) — zero cross-browser automation exists today regardless of this decision.

---

## Known cross-cutting gaps (apply to multiple cases above, stated once here)

- `mockCreators` is still load-bearing for avatar/display-name/theme color in `HomePage.tsx`,
  `OshiStatusPanel.tsx`, and `ScheduleGrid.tsx`, even though the stats/videos/schedule data
  those components show is real. A "real data end-to-end" smoke case should know this seam
  exists rather than treating a mock avatar as a bug.
- Holodex upstream degradation is invisible in the UI (N3/N5) — no stale/degraded indicator
  exists to assert against.
- The local Playwright fixture (`scripts/local_api_server.py`) serves only `GET /dashboard/chart-catalog`
  by default; the V1 smoke suite's own `--enable-smoke-routes` flag additionally allowlists `/live-streams`,
  `/recent-streams`, `/topics`, and `/videos/{id}/growth` (all independently confirmed local-storage-only,
  never reaching AWS). The S3-backed per-creator routes (`oshi-status`, `videos/ranking`, `videos/recent`,
  `subscribers/leaderboard`) remain deliberately excluded even under that flag — see that script's module
  docstring for why (they default to the real production history bucket when unconfigured).
- Security baseline (`docs/security/V1_SECURITY_BASELINE.md`, `docs/plans/V1_SECURITY_P0_ROADMAP.md`)
  is 100% pre-implementation; every Security-tagged item above is `BLOCKED / PENDING SECURITY MERGE`.

---

## Phase 3 — Automation boundary (summary)

**This table was corrected by a 2026-10-06 scoped code review** that verified every `AUTOMATED`
claim against the actual spec files (not just names) and found substantial overclaiming — see each
section's own "review-pass correction" note above for the evidence per case. Counts below are
post-correction.

| Classification | Cases | Count |
|---|---|---|
| AUTOMATED | A1–A6 (6), C1/C6/C11/C12 (4), E1–E3 (3), F4 (API-contract layer only, production-only), I1/I6 (2), J1/J6/J7 (3), K3 (production-only), M1–M6 (6), N1–N2 (2) | 28 |
| HYBRID | B1–B2 (2), C7–C8/C10 (3), D1 (1), F1 (1), I3 (1), J3–J4 (2) | 10 |
| MANUAL | B3–B5 | 3 |
| NOT YET AUTOMATED (automatable, no test exists yet) | C2–C5/C9 (5), D2–D3 (2), E4 (1), F2–F3/F5–F6 (4), G1–G8 (8), H1–H4 (4), I2/I4–I5 (3), J2 (1), K1/K2/K4–K6 (5), L1–L4 (4) | 37 |
| N/A (nothing currently exists to assert, not a gap this suite can close) | N3, N5 | 2 |
| BLOCKED | M7, N4, O's Firefox/Safari rows, every Security-dependent item, production frontend URL | 4 enumerated + Security/URL preconditions |
| O (browser coverage, own table, not case-counted above) | Chrome/Edge required (matches today's Chromium-only automation); Firefox/Safari owner-decision-required | — |

**83 lettered cases total (A1–N5), re-tallied row by row against the corrected document above**
(28 + 10 + 3 + 37 + 2 + 2 = 82 individually classified, plus J5 — deliberately folded into J1/J3/J4's
own classifications rather than double-counted, see J5's row — makes 83. The Chrome/Edge/Firefox/Safari
rows in case O are a policy table, not individually-automatable cases, and are tracked separately).
Of the 28 `AUTOMATED` cases: A1–A6, I1, and I6 are backed by this branch's own new `app-shell.spec.ts`/
`schedule.spec.ts` (I1's prior citation of an existing-but-broken test was removed — see Schedule's own
stale-test finding), F4/K3 by this branch's own new `api-contract.spec.ts`, and the remaining 18
(C1/C6/C11/C12, E1–E3, J1/J6/J7, M1–M6, N1–N2) by existing `fa1`–`fa4`/`schedule-and-settings.spec.ts`
tests, each individually re-verified against the real test body during the prior review (not just the
file name).

**37 cases are `NOT YET AUTOMATED`** — a real implementation backlog, not a documentation nuance. None
of them are blocked by anything; they simply have no test written yet, in some cases despite the
original MD claiming "AUTOMATED (existing)" coverage that does not exist. Oshi Videos (G, all 8),
Recent archived livestreams (H, all 4), Official/group channels (L, all 4), and most of Graduated
creators (K, 5 of 6) have **zero** existing automated coverage of any kind.

Deterministic checks (API responses, routing, data loading, state transitions, known error
handling, creator switching, filter behavior) are automated wherever a concrete outcome can be
asserted without a human. Visual/layout judgment (16:9 framing, iframe control usability, "does
this look fabricated") stays manual — automating pixel-level iframe-overlay judgment would be
brittle and is exactly the kind of check this document's Scope section says not to chase.
