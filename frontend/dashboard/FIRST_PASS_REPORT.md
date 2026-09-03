# Yobi Analytics Dashboard — First Pass Report

This report covers `frontend/dashboard` only: a React + TypeScript dashboard
(Roadmap Phase 3.5, plus 3.6's local cache), built against mock data shaped
like the future Read API response. Nothing in `frontend/dashboard` touches
the Python collector, DynamoDB, Lambda, API Gateway, EventBridge, or
production data.

(The same working session also implemented Roadmap 3.1–3.4 on the Python
backend — `src/view_growth_analytics.py`, `src/trending.py`,
`src/read_api.py` and their tests — as separate, intentional Phase 3 work
tracked in `Roadmap.md`, not as part of this frontend-only pass or its
authorized scope.)

## Summary

A complete default-layout dashboard: theme system (Hololive soft-idol / VSPO
tactical / VSPO momentum), the full hierarchical creator filter set plus
independent content-tag/format filters, four KPI cards, a growth bar chart
(by day / by channel), an animated contribution ring, a trending ranking
card, data-driven insight copy, and a sortable/searchable/paginated video
table — all sharing one filter state. A `localStorage` cache keyed by
`(timeZone, reportDate, period)` (Roadmap 3.6) displays the last-known data
immediately on load, then replaces it in the background only if a fresh
fetch is actually newer. Verified in a real browser at desktop/tablet/mobile
widths, with two live theme switches, a filter interaction, and a
reload-shows-cache-instantly check, in addition to the automated test suite.

## Files created

```
frontend/dashboard/                      (new Vite React-TS project)
  src/types/domain.ts                    Classification + analytics types, label maps
  src/types/theme.ts                     MemberTheme type
  src/data/mockCreators.ts               12 creators covering every required scenario
  src/data/mockVideoStats.ts             13 videos covering every required scenario
  src/data/mockDailySeries.ts            14-day aggregate series for the bar chart
  src/theme/themePresets.ts              Hololive JP / VSPO JP (Tactical/Momentum) presets
  src/theme/memberAccent.ts              Deterministic per-creator accent color
  src/theme/MemberThemeProvider.tsx      Theme context provider, injects CSS vars
  src/theme/ThemeContext.ts              useMemberTheme hook + context (split for fast-refresh)
  src/lib/filterState.ts                 Hierarchical filter state + OR/AND matching
  src/lib/deriveAnalytics.ts             KPI + channel-contribution derivation
  src/lib/deriveInsights.ts              Insight copy generation
  src/lib/rankVideos.ts                  Frontend mirror of src/trending.py's ranking rules
  src/lib/period.ts                      comparisonDateFor (mirrors view_growth_analytics.py) +
                                          scaleStatsForPeriod (mock-only period-selector demo values)
  src/lib/format.ts                      Number/percent/date formatting helpers
  src/lib/timezone.ts                    Device time zone detection
  src/lib/analyticsCache.ts              Roadmap 3.6: localStorage cache, keyed by (timeZone, reportDate, period)
  src/hooks/useFilterState.ts            React state wrapper around lib/filterState.ts
  src/hooks/usePrefersReducedMotion.ts
  src/hooks/useCountUp.ts                Ring-chart number count-up animation
  src/hooks/useCachedDashboardData.ts    Roadmap 3.6: cache-first-then-background-refresh flow
  src/components/DashboardPage.tsx       Top-level composition
  src/components/DashboardHeader.tsx
  src/components/ThemeSelector.tsx
  src/components/TimeZoneSelector.tsx
  src/components/DateRangeTabs.tsx
  src/components/KpiCard.tsx
  src/components/GrowthBadge.tsx
  src/components/GrowthBarChart.tsx
  src/components/AnimatedRingChart.tsx
  src/components/RankingCard.tsx
  src/components/InsightCard.tsx
  src/components/StaleDataNotice.tsx
  src/components/VideoStatsTable.tsx
  src/components/filters/*.tsx           OrganizationFilter, BranchFilter, TagFilter,
                                          ChannelTypeFilter, LifecycleStageFilter,
                                          ContentTagFilter, ContentFormatFilter,
                                          ClassificationFilterBar (composes all seven)
  src/components/states/*.tsx            LoadingState, EmptyState, ErrorState, PendingState
  src/index.css                          Design tokens, reset, base typography
  src/styles/dashboard.css               All component styles
  *.test.ts(x)                           42 tests — see Test result below
  src/test/setup.ts                      jest-dom matchers + explicit cleanup registration
```

Modified: `vite.config.ts` (test config), `package.json` (test script),
`index.html` (title), `main.tsx`/`App.tsx` (wire up the real app).
Also added `.claude/launch.json` at the repo root so `/run` can preview this
project going forward.

## Dependencies installed

Core (pre-approved): `recharts`, `clsx`, `lucide-react`.
Dev/test (pre-approved): `vitest`, `jsdom`, `@testing-library/react`,
`@testing-library/jest-dom`, `@testing-library/user-event`.
Vite's own current-stable template brought `oxlint` instead of `eslint` and
uses `recharts@3`/`react@19` — both accepted as "equivalent official
packages generated by the current stable template."

**Deviation from the allowlist's suggested `@tanstack/react-table`**: the
installed version (9.2.4) ships a completely rearchitected, very new API
(no `useReactTable`; a signals-based `useTable`/`createTableHook` core, with
the old v8-style API only reachable via an undocumented `legacy` subpath).
Building against it reliably was not something I could do with confidence,
and the allowlist itself names exactly this situation — "a small local
implementation would be less maintainable" is the bar for using the
library, not the default — as license to skip it. `VideoStatsTable` is a
~250-line local implementation (search, click-to-sort per column, simple
pagination) instead. Not installed; not left as a dangling dependency.

Not installed: `motion` (Recharts' own bar/ring animation plus a small
`requestAnimationFrame` count-up hook covered every documented motion case
without it).

## Commands run

```
npm create vite@latest frontend/dashboard -- --template react-ts
npm install
npm install recharts clsx lucide-react @tanstack/react-table
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
npm uninstall @tanstack/react-table        # see Deviation above
npx tsc -b
npm run lint
npm run build
npm run test
```

## Results

- **TypeScript**: clean, no errors.
- **Lint** (`oxlint`): clean, no warnings (two `react/only-export-components`
  and one `react/use-memo` warning were fixed by splitting the theme
  context into its own file and using an inline `useMemo` callback, rather
  than left as accepted noise).
- **Build**: succeeds. Single JS chunk is 602 KB (178 KB gzipped) — over
  Vite's 500 KB warning threshold, driven mostly by Recharts. Not code-split
  in this first pass; noted below as a visual/perf follow-up, not a defect.
- **Test**: **73/73 passing** across 9 files — `filterState.test.ts` (20,
  including every scenario from auto.txt's required list below, plus
  `setBranch` rejecting a branch that doesn't belong to the current
  organization), `deriveAnalytics.test.ts` (12, including
  channel-contribution netting: a channel's own positive and negative
  videos are summed before deciding whether it contributed positively at
  all), `rankVideos.test.ts` (9, including rejecting a non-integer/negative
  `limit`), `period.test.ts` (6: comparisonDate arithmetic, and scaleStatsForPeriod —
  see the period-selector note below), `analyticsCache.test.ts` (9:
  round-trip, key-identity isolation across timeZone/reportDate/period,
  corrupt-JSON and storage-throws fallbacks, newer-wins comparison),
  `useCachedDashboardData.test.tsx` (7: loading with no cache, cached data
  shown immediately without waiting on the fetch, cache replaced only when
  actually newer, stale fetch result correctly ignored, a rejected fetch
  surfaces as `error` without an unhandled rejection, cached data stays
  visible through a failed background refresh, switching keys shows the new
  key's own cache synchronously rather than flashing the old key's stale
  entry for a render), `GrowthBadge.test.tsx` (5), `TimeZoneSelector.test.tsx`
  (3: commits a typed valid zone, never commits a raw numeric UTC offset
  even though Chromium's `Intl.DateTimeFormat` accepts one as a `timeZone`
  value without throwing, reverts to the last committed zone on blur after
  garbage input), `DashboardPage.test.tsx` (2 integration tests: loading →
  KPI section, and a real filter interaction producing the empty state).

### Required scenarios (auto.txt section 20) — all covered by automated tests

`卒業` · `Hololive + 卒業` · `Hololive + JP + 1期生 + 卒業` (added a graduated
Hololive JP creator retaining `1期生` to the mock fixture specifically for
this case) · `1期生 + ゲーマーズ` (OR-within-dimension) · `Hololive + EN` ·
`VSPO + JP` · `SF6` · `歌回` · `Shorts` · empty filter result.

### Manually verified in a real browser (Chromium, via the Browser pane)

Desktop (785px and 1440px pane widths), tablet-equivalent, and mobile
(375×812) layouts; VSPO JP — Tactical theme switch (colors, button shape,
badge shape all changed live); a real click through Lifecycle → 卒業,
confirming KPI cards, the bar chart, ranking, and insights all updated
together to the graduated-only subset (Top Performer correctly became
桐生ココ, average growth dropped to the graduated cohort's near-zero rate);
the video table's mobile card conversion; pagination (13 videos → 2 pages);
Roadmap 3.6's cache flow — a reload immediately shows the previous
session's data with no loading flash, confirmed by inspecting the
`yobi-analytics-cache:*` key actually written to `localStorage`; the period
selector actually changing the displayed numbers (Daily Gain 1.34M → 7.39M
switching Today → 7 Day); the searchable time zone input accepting a typed
zone (`Europe/London`) keystroke by keystroke instead of reverting itself;
and the `DateRangeTabs`/`GrowthBarChart`/`RankingCard` toggle buttons — a
CodeRabbit review round found these used `role="tab"` without the tabpanel
structure that role implies (misleading to assistive tech), and that fixing
it to `aria-pressed` toggle buttons exposed a real, separate bug: only
`DateRangeTabs` ever had a visible "selected" style — the other two toggle
groups had *no* visual indicator of which option was active at all, even
before the ARIA fix. Both are now fixed together with one shared
`.soft-button[aria-pressed="true"]` CSS rule, confirmed live
(`aria-pressed="true"` → theme-primary background, white text).
No console errors at any point.

## Known limitations / follow-ups

- **`period` (1d/7d/30d) selector now visibly changes the numbers shown**,
  via `scaleStatsForPeriod` (`src/lib/period.ts`) — a mock-only sub-linear
  multiplier applied to each video's `dailyIncrease`/`growthPercent`
  (`totalViews` and `status` are untouched). This is explicitly *not* real
  period-specific data (a real 7-day growth figure isn't "1-day × 5.5"), so
  it exists purely so the selector has something honest-looking to
  demonstrate against; it disappears entirely once the real Read API (3.4)
  is connected, since a real `calculate_growth(period=7d)` call already
  returns the correct period-specific value directly — `fetchAnalytics` in
  `DashboardPage.tsx` is the single, already-isolated place both the mock
  delay and this scaling call get replaced by that real call.
- **`ErrorState` is now fully wired** to `useCachedDashboardData`'s `error`
  (a rejected `fetchFn` surfaces there without an unhandled promise
  rejection, tested in `useCachedDashboardData.test.tsx`), shown only when
  there's no cache to fall back on — a failed background refresh with
  existing cached data keeps showing that data instead. There's no real
  network failure in a mock-only pass to trigger this live in the browser,
  but the whole path is exercised by tests.
- **Bundle size** (602 KB / 178 KB gzip) is a Recharts-driven warning, not
  an error; `dynamic import()` code-splitting is a reasonable follow-up but
  wasn't done here to keep this pass focused on the dashboard itself.
- Only the default layout was built (per the brief's own priority: "Complete
  and verify the default layout before creating alternatives... do not
  sacrifice completion or build quality of the default layout merely to
  create variants") — no chart-focused/ranking-focused layout variants.
- Per-member individual `MemberTheme` objects are not hand-authored for all
  ~70 real creators; page-level theme presets (Hololive/VSPO×2) plus a
  deterministic per-row accent color (`memberAccent.ts`) cover the same
  visual intent at real-roster scale without 70 authored objects.

## Running locally

```
cd frontend/dashboard
npm install
npm run dev       # http://localhost:5173
npm run test       # vitest
npm run build       # production build to dist/
```

A `dashboard` entry was also added to the repo root's `.claude/launch.json`
for previewing via Claude Code's `/run`/browser-preview tooling.
