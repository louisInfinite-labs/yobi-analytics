# Dashboard Implementation Task Order

This document defines the only approved implementation sequence after the
Dashboard specification rewrite. Do not implement any task until the rewritten
specification is approved by the user.

Every task must follow this template:

```text
Purpose
Exact scope
Authoritative source
Files expected
Forbidden changes
Required source data
Required mock data
Required targeted tests
Required browser interactions
Required measured evidence
Stop/block conditions
Git restrictions
Final status
```

General restrictions for every task:

- Do not combine tasks unless the user explicitly changes scope.
- Do not implement future task work early.
- Do not stage, commit, push, stash, reset, or switch branches unless the user
  explicitly authorizes that action.
- Do not treat passing tests as visual approval.
- Browser-visible behavior requires browser evidence, not source inspection.
- End any unresolved visual acceptance with `WAITING_FOR_USER_VISUAL_REVIEW`.

## Task 1 -- Creator Taxonomy / Filter Data-Source Correction

### Purpose

Correct Dashboard creator taxonomy filters so their options come from the
authoritative creator roster instead of unsupported hardcoded or mock-only
assumptions.

### Exact Scope

Only:

```text
creators.json reconciliation
creator-level taxonomy
Organization
Branch
Generation / Unit
filter dependency
remove unsupported hardcoded options
grouped Creator scope and Content scope presentation
active-filter count
Reset filters
responsive/progressive disclosure
```

### Authoritative Source

- `frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md`
- `frontend/dashboard/src/features/notifications/data/creators.json`
- `frontend/dashboard/src/features/notifications/model/notificationCreatorGrouping.ts`
- `frontend/dashboard/src/entities/creator/model/domain.ts`

### Files Expected

Expected candidates only; implementation must verify exact ownership before
editing:

```text
frontend/dashboard/src/features/analytics/filters/**
frontend/dashboard/src/features/analytics/hooks/useFilterState.ts
frontend/dashboard/src/entities/creator/**
frontend/dashboard/src/features/notifications/model/**
frontend/dashboard/src/features/dashboard/styles/dashboard.css
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
relevant targeted tests
```

### Forbidden Changes

- Do not modify widget layout.
- Do not modify charts.
- Do not change mock numeric analytics values except where required to consume
  the authoritative creator roster.
- Do not resolve `groupKey` taxonomy gaps by assumption.
- Do not mix comparison-member selection into the analytics classification
  filter.
- Do not replace the current filter meaning while redesigning presentation.
- Do not render every dimension as one undifferentiated chip wall.

### Required Source Data

- Full `creators.json` roster.
- Distinct `organization`, `branch`, `groupKey`, `channelType`,
  `lifecycleStage` values.
- Matching creator IDs/counts for every displayed option.

### Required Mock Data

- Mock creators must remain traceable to real roster records.
- No fabricated organization, branch, or groupKey values.
- Hololive categories follow the official `所属タレント` order documented in
  `DASHBOARD_LAYOUT_GUIDELINES.md` Section 8.1.
- Only categories and creators backed by a successful current analytics record
  are selectable. Missing-data entries remain future continuation points and
  are not rendered, including `アソビ★まわり隊！` until data exists.

### Required Targeted Tests

- Organization options match roster values.
- Branch options recalculate from selected Organization.
- Generation / Unit options recalculate from selected Organization and Branch.
- Hide Generation / Unit entirely for VSPO, VSPO JP, and VSPO EN, and clear
  any prior Hololive group selection when entering those scopes.
- Use the approved roster-backed Hololive taxonomy for this analytics filter;
  data-backed-only eligibility applies to comparison member rows, not to the
  Generation / Unit filter options.
- Invalid child selections clear when parent changes.
- No unsupported option such as `aNounce` appears.
- `All` remains a UI sentinel, not source metadata.
- Creator scope and Content scope are visibly distinct.
- Active-filter count matches selected dimensions/values.
- Reset clears every filter and restores the complete analytics population.
- Compact/responsive presentation preserves access to every option.

### Required Browser Interactions

Test at least:

```text
Organization = VSPO
Organization = Hololive
one Branch within each
one source-backed Generation / Unit option
select filters across Creator scope and Content scope
Reset filters
inspect compact and wide viewport layouts
```

### Required Measured Evidence

For each tested filter state:

```text
displayed options
expected source options
unexpected options
missing options
matching creator count
active-filter count
analytics result count before/after Reset
all controls reachable at tested viewport
```

Expected:

```text
unexpected = 0
missing = 0
```

### Stop/Block Conditions

Stop if a required taxonomy distinction needs product direction, including:

- `NO` visibility
- combined vs split Generation/Unit/Project/Team/Wave/Group taxonomy
- `retired` zero-record visibility

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

End with one of:

```text
TASK_1_READY_FOR_REVIEW
TASK_1_BLOCKED_SPEC_GAP
```

## Required Prerequisite -- Dashboard Control Ownership, Time Zone & Local Refresh

### Purpose

Remove general preferences from the Dashboard, resolve reporting time zone
automatically, refresh at the resolved user's local 18:00 boundary, and keep
the Mock / Live switch development-only.

### Exact Scope

Only:

```text
remove Time Zone selector from Dashboard
move Theme entry point to Settings
move Upcoming display and Countdown language entry points to Settings
profile -> browser -> UTC IANA time-zone resolution
read-only resolved-zone metadata
local 18:00 refresh boundary
cached-data preservation during refresh
development-only Mock / Live control
production live-source policy
```

### Authoritative Source

- Settings/control ownership contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Existing persisted Theme and Upcoming preference stores
- Existing analytics cache and fetch pipeline
- Authenticated user profile contract, if one exists at implementation time
- Browser `Intl` IANA time zone only as the defined fallback
- Backend report publication schedule and `reportDate` contract

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/dashboard/editor/components/DashboardHeader.tsx
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
frontend/dashboard/src/pages/settings/**
frontend/dashboard/src/shared/i18n/**
frontend/dashboard/src/shared/theme/**
frontend/dashboard/src/features/live-status/**
frontend/dashboard/src/features/analytics/charts/DataSourceToggle.tsx
frontend/dashboard/src/features/analytics/hooks/**
frontend/dashboard/src/features/analytics/utils/**
relevant targeted tests
```

### Forbidden Changes

- Do not invent an authenticated profile time zone when no profile field/API
  exists.
- Do not store a raw `GMT+8`/`GMT+9` offset as canonical time-zone identity.
- Do not implement one global UTC `18:00` refresh.
- Do not erase valid cached data while refreshing or after refresh failure.
- Do not expose Theme, Upcoming, Countdown language, or editable Time Zone on
  the Dashboard.
- Do not expose Mock / Live in production merely because an API URL exists.
- Do not silently serve mock analytics in production when live configuration
  is unavailable.
- Do not change the backend schedule without explicit backend scope.

### Required Source Data

- Profile IANA time zone and provenance when available.
- Browser/device IANA time zone fallback.
- UTC fallback.
- Verified backend publication time and `reportDate` meaning.
- Existing cached entry, fresh entry, and stale/error metadata.

### Required Mock Data

- `Asia/Tokyo` clock states at 17:59 and 18:00 local.
- `Asia/Hong_Kong` clock states at 17:59 and 18:00 local.
- Profile-zone present, browser-only, and invalid/missing-zone scenarios.
- Successful refresh and failed refresh with an existing cached entry.
- Development and production environment cases.

### Required Targeted Tests

- Profile IANA zone wins over browser zone.
- Browser IANA zone is used when profile zone is unavailable.
- Invalid/missing profile and browser values fall back to UTC.
- Dashboard renders no editable Time Zone, Theme, Upcoming, or Countdown
  language control.
- Settings renders Theme and Upcoming controls and preserves their existing
  persisted state semantics.
- Japan crosses 17:59 -> 18:00 and triggers exactly one refresh for the new
  local report/cache key.
- Hong Kong crosses 17:59 -> 18:00 and triggers exactly one independent local
  refresh.
- Repeated clock ticks after the same boundary do not duplicate requests.
- Existing cached data remains visible during refresh and after failure.
- Mock / Live renders in explicit development mode only.
- Production automatically follows live-source policy and never silently
  falls back to mock.

### Required Browser Interactions

- Open Dashboard in development and production-equivalent builds and inspect
  header controls.
- Open Settings and change Theme and Upcoming display preferences; return to
  the affected app surfaces and verify persistence.
- Run Dashboard with controlled `Asia/Tokyo` and `Asia/Hong_Kong` clocks across
  the local 18:00 boundary without reloading the page.
- Simulate refresh failure while cached data is visible.

### Required Measured Evidence

Report:

```text
environment: development/production
resolved zone source: profile/browser/UTC fallback
resolved IANA zone
local time before/after boundary
report/cache key before/after
refresh request count before/after
cached content visible during refresh: yes/no
cached content visible after failure: yes/no
Dashboard Time Zone selector present: yes/no
Dashboard Theme selector present: yes/no
Dashboard Upcoming selector present: yes/no
Dashboard Mock / Live control present: yes/no
Settings Theme control present: yes/no
Settings Upcoming control present: yes/no
```

### Stop/Block Conditions

Stop and report the exact dependency if:

- backend publication timing cannot satisfy or define each local 18:00
  boundary
- `reportDate` semantics are unknown
- authenticated profile location exists but has no authoritative IANA mapping
- production live-source policy is undefined
- moving a preference entry point would break its persisted cross-page state

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
DASHBOARD_CONTROL_OWNERSHIP_READY_FOR_REVIEW
DASHBOARD_CONTROL_OWNERSHIP_BLOCKED_SPEC_GAP
```

## Task 2 -- Full-Width Dashboard Workspace

### Purpose

Make the Dashboard use the available application workspace width after
navigation/sidebar.

### Exact Scope

Only:

```text
page/container width
left/right gutters
workspace expansion
```

### Authoritative Source

- Workspace contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Current Dashboard page/container implementation
- Current Settings page only as a visual-language reference, not width source

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
frontend/dashboard/src/features/dashboard/styles/dashboard.css
```

### Forbidden Changes

- Do not alter filters, taxonomy, charts, widgets, comparison, mock data, or
  settings layout.
- Do not inherit Settings max-width.

### Required Source Data

None beyond layout source inspection.

### Required Mock Data

Existing Dashboard mock data is sufficient.

### Required Targeted Tests

- Rendered Dashboard root does not use Settings/readable-content max-width.
- Existing non-width Dashboard behavior remains mounted.

### Required Browser Interactions

Open the Dashboard at representative desktop width with sidebar/nav visible.

### Required Measured Evidence

Report:

```text
viewportWidth
sidebarRight
dashboardLeft
dashboardRight
leftGutter
rightGutter
workspaceWidth
```

### Stop/Block Conditions

Stop if application shell/sidebar geometry cannot be measured or ownership of
the shell is outside Dashboard scope.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_2_READY_FOR_REVIEW
TASK_2_BLOCKED
```

## Task 3 -- Widget Internal-Scroll Correction

### Purpose

Ensure normal/default KPI, Growth, Contribution, and Ranking widgets display
intended content without internal vertical scrolling or hidden clipping.

### Exact Scope

Only:

```text
KPI
Growth
Contribution
Ranking
widget sizing
```

### Authoritative Source

- Widget overflow contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Current widget components and CSS

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/analytics/charts/**
frontend/dashboard/src/features/dashboard/editor/utils/widgetRegistry.tsx
frontend/dashboard/src/features/dashboard/styles/dashboard.css
```

### Forbidden Changes

- Do not change chart semantics.
- Do not change filter taxonomy.
- Do not change movement logic.
- Do not use `overflow: hidden` to conceal missing content.

### Required Source Data

Representative filtered stats for each normal widget state.

### Required Mock Data

Mock data must exercise enough rows/points to reveal overflow:

- KPI values and subtext
- Growth chart points
- Contribution rows
- at least 5 Ranking rows

### Required Targeted Tests

- Widget sizing constraints remain valid.
- Components render expected content for representative data.

### Required Browser Interactions

Render normal Dashboard with representative content.

### Required Measured Evidence

For KPI, Growth, Contribution, and Ranking:

```text
clientHeight
scrollHeight
computed overflowY
scrollbar yes/no
content clipped yes/no
```

Acceptance:

```text
scrollHeight <= clientHeight
```

### Stop/Block Conditions

Stop if current widget semantic ambiguity prevents deciding what content must be
visible, especially Contribution.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_3_READY_FOR_REVIEW
TASK_3_BLOCKED_SPEC_GAP
```

## Task 4 -- Edit Layout Grid Reflow, Swap & Viewport Lock

### Purpose

Implement a deterministic canonical grid editor whose live drag preview reflows
occupied widgets, remains aligned to the dashed grid, never overlaps, and does
not move or expand the viewport without explicit user scroll input.

### Exact Scope

Only:

```text
horizontal swap/reflow
vertical swap/reflow
live preview occupancy
dashed-grid alignment
no overlap
canonical snap or invalid-target rollback
viewport scroll lock
no drag-edge auto-scroll
no document expansion during drag
save/cancel/persistence
```

### Authoritative Source

- Canonical layout contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Edit Layout -- Grid Reflow & Viewport Lock Contract in
  `DASHBOARD_LAYOUT_GUIDELINES.md`
- Canonical validator and layout model
- GridStack adapter only as an implementation detail

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/dashboard/editor/**
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
frontend/dashboard/e2e/**
```

### Forbidden Changes

- Do not alter widget content, filters, comparison selection, or mock values.
- Do not add 4x4/5x5 canonical support.
- Do not persist GridStack pixel or 12-column coordinates as the product model.
- Do not implement free-floating absolute placement.
- Do not solve collisions by allowing overlap or off-grid placement.
- Do not enable automatic drag-edge scrolling.
- Do not call `scrollIntoView()`, `window.scrollTo()`, `window.scrollBy()`, or
  equivalent focus-induced scrolling during normal widget drag.

### Required Source Data

Canonical layout fixtures with:

- compatible same-size widgets in adjacent horizontal cells
- compatible same-size widgets in adjacent vertical cells
- an occupied layout requiring deterministic multi-widget reflow
- a known invalid target used to verify rollback

### Required Mock Data

Use identifiable mock widgets so the browser test can prove occupancy changes.
At minimum, use `Contribution` at the left position and `KPI` at the right
position for the required midpoint-crossing scenario.

### Required Targeted Tests

- Crossing the horizontal midpoint activates a valid target preview and moves
  the displaced compatible widget into the vacated canonical cell.
- Crossing the vertical midpoint produces the equivalent valid reflow.
- Live preview occupancy has no duplicate canonical position and no overlap.
- Every resolved preview aligns with visible dashed cells.
- Compatible swaps update canonical `x/y`; widget sizes remain unchanged.
- Multi-widget collision resolution is deterministic and validator-safe.
- An invalid target restores the previous valid layout.
- Without explicit scroll input, `scrollX` and `scrollY` remain unchanged during
  pointer movement, reflow, collision handling, drop, and cancellation.
- Pointer proximity to top, bottom, left, or right viewport edges does not cause
  automatic scrolling.
- Dragging does not increase document `scrollHeight` or `scrollWidth`.
- Save/reload preserves the validated canonical result.
- Cancel restores the pre-edit canonical layout.

### Required Browser Interactions

Perform all of the following in a real browser:

- Drag `Contribution` from the left across the midpoint toward the right-side
  `KPI`; before drop verify that `KPI` previews in the left vacated cell and
  `Contribution` targets the right valid cell.
- Perform an equivalent vertical midpoint crossing and inspect the preview
  before drop.
- Drag through the middle of the layout and near each viewport edge without
  wheel scrolling.
- Drop a valid move, save, reload, and verify persistence.
- Cancel a separate edit and verify restoration.
- Attempt an invalid target and verify rollback.

### Required Measured Evidence

For each horizontal and vertical move, report:

```text
Widget A before: x, y, w, h
Widget B before: x, y, w, h
Drag target: x, y
Widget A preview: x, y
Widget B preview: x, y
Widget A after drop: x, y
Widget B after drop: x, y
validator result
overlap true/false
dashed-grid alignment true/false
persistence result
```

For the no-wheel viewport-lock run, report:

```text
scrollX before
scrollY before
scrollX during horizontal drag
scrollY during horizontal drag
scrollX during vertical drag
scrollY during vertical drag
scrollX after drop
scrollY after drop
scrollHeight before/during/after
scrollWidth before/during/after
explicit wheel scroll performed: no
```

All corresponding scroll coordinates must be identical. Document dimensions
must not expand because of the drag. `dragging works` or `GridStack reflow
works` without these measurements is not acceptable evidence.

### Stop/Block Conditions

Stop and report a blocker if any of the following remains true:

- the grid adapter cannot expose or control live collision/reflow state
- a dragged widget can resolve between dashed cells
- an occupied target remains underneath the dragged widget
- horizontal or vertical movement requires overlap
- viewport coordinates change without explicit scroll input
- drag geometry expands the document
- adapter coordinates cannot be translated back to validated canonical
  `x/y/w/h`
- save, cancel, or invalid-target rollback cannot preserve a valid layout

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_4_READY_FOR_REVIEW
TASK_4_BLOCKED
```

## Task 5 -- Comparison Member Selector Surface

### Purpose

Replace any flat comparison creator-chip wall with a Dashboard member selector
that reuses Notification Settings Manage Members' density, hierarchy, search,
and Favorites-first structure while adding comparison-specific selection and
drag affordances.

### Exact Scope

Only:

```text
Notification-style roster
search
Favorites
Agency -> Region/Branch -> Generation/Unit grouping
optional roster-backed compact filters
avatar/name
per-row selection control
ordered selection indicator
separate single-member drag affordance
selected-members summary/tray
clear selection
empty states
remove flat chip wall
```

### Authoritative Source

- `Settings -> Notification Settings -> Manage Members`
- `notificationCreatorGrouping.ts`
- `TopicCreatorManagementDrawer.tsx`
- Settings CSS visual-language reference
- `creators.json`

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/dashboard/comparison/**
frontend/dashboard/src/features/notifications/**
frontend/dashboard/src/features/favorites/**
frontend/dashboard/src/features/dashboard/styles/dashboard.css
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
relevant targeted tests
```

### Forbidden Changes

- Do not alter comparison data fetching.
- Do not alter chart rendering semantics.
- Do not change creator eligibility.
- Do not render notification Live/New Video/reminder controls in Dashboard.
- Do not couple drag initiation to selection toggling.
- Do not duplicate Favorites in normal groups.
- Do not place the full roster as a giant flat panel below the grid.

### Required Source Data

- Real creator roster.
- Existing favorite IDs through the established favorites bridge.
- Existing Notification grouping order.
- Organization/Agency, Region/Branch, and Generation/Unit filter values derived
  from the same roster.

### Required Mock Data

- At least 3 favorite creators across at least two valid source groups.
- At least two creators in each confirmed core branch group.

### Required Targeted Tests

- Favorites appear first and are not duplicated below.
- Search filters by actual creator names.
- Empty groups are removed.
- Stable group order is preserved.
- Avatar/name/selection state render.
- Dashboard rows contain selection/order/drag controls, not notification
  switches.
- Clicking selection does not begin a drag.
- Beginning a drag does not toggle selection.
- Roster-backed compact filters remove non-matches and empty groups.
- Clear selection resets pending ordered selection without changing a chart.
- Empty search/filter state is explicit.

### Required Browser Interactions

Open the comparison member selector, search, filter by Agency/Region/Generation,
select/deselect creators, clear selection, begin a single-member drag, and
verify Favorites and grouped hierarchy at desktop and compact viewport widths.

### Required Measured Evidence

Report:

```text
visible favorite IDs
visible grouped creator IDs
duplicate IDs yes/no
search query
matching creator IDs
empty groups present yes/no
selected IDs in order
selection target and drag target are distinct yes/no
single drag payload creator ID
notification-only controls present yes/no
panel/drawer bounds and viewport size
```

### Stop/Block Conditions

Stop if favorite identity mapping, roster grouping, or creator ID mapping to
comparison state is not verifiable. Stop if a maximum selected-creator count is
required to complete this surface but remains undefined.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_5_READY_FOR_REVIEW
TASK_5_BLOCKED_SPEC_GAP
```

## Task 6 -- Comparison Target Eligibility

### Purpose

Make comparison-capable and non-comparison widgets behave distinctly during
creator drag.

### Exact Scope

Only:

```text
comparison capability
valid target state
invalid target behavior
single-member payload
ordered multi-member bundle payload
incoming member-count target feedback
```

### Authoritative Source

- Comparison contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Widget registry and comparison widget capability utilities

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/dashboard/comparison/**
frontend/dashboard/src/features/dashboard/editor/**
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
```

### Forbidden Changes

- Do not redesign the member selector owned by Task 5.
- Do not alter chart data semantics.
- Do not add keyboard-specific product mode.

### Required Source Data

Widget type list with explicit comparison capability.

### Required Mock Data

At least one visible comparison-capable widget and at least one visible
non-comparison widget.

### Required Targeted Tests

- Comparison-capable widget accepts valid creator.
- Non-comparison widget does not show valid target state.
- Non-comparison widget rejects drop without mutating state.
- Duplicate creator drop is rejected.
- An ordered multi-member bundle uses the same capability gate.
- Valid target feedback states the incoming member count.
- A non-comparison target accepts neither a single creator nor a bundle.
- Existing target creator IDs are not duplicated by a bundle.
- Partial-bundle behavior is explicit and atomic unless a separately approved
  product rule permits partial application.

### Required Browser Interactions

- Drag creator over comparison widget.
- Drag creator over non-comparison widget.
- Drag an ordered multi-member bundle over both target types.
- Drop single and bundle payloads on both target types.

### Required Measured Evidence

Report:

```text
widget type
capability
target state shown
drop accepted yes/no
state before
state after
announcement/error text if any
incoming ordered creator IDs
accepted creator IDs
rejected creator IDs and reason
```

### Stop/Block Conditions

Stop if widget capability cannot be declared for every widget type, or if the
maximum creator count/partial-bundle policy is required but undefined.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_6_READY_FOR_REVIEW
TASK_6_BLOCKED
```

## Task 7 -- Multi-Creator Comparison Selection

### Purpose

Implement the explicit Select Creators workflow and ordered multi-member bundle
drop for comparison-capable charts, ensuring single drag, bundle drag, and
Apply all converge on one comparison state.

### Exact Scope

Only:

```text
Select Creators
multi-select
click-order selection
selected-members summary/tray
bulk drag payload
Apply
Cancel
preselection
shared single-drag/bundle-drag/Apply state
```

### Authoritative Source

- Comparison contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Creator roster contract from Task 5
- Target eligibility from Task 6

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/dashboard/comparison/**
frontend/dashboard/src/features/dashboard/editor/**
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
```

### Forbidden Changes

- Do not modify underlying comparison data source.
- Do not change non-comparison widgets.
- Do not introduce keyboard-specific product copy.
- Do not create a second selected-creator store disconnected from the target
  chart's pending/canonical comparison state.
- Do not silently reorder selected creator IDs.

### Required Source Data

Ordered creator IDs from the roster.

### Required Mock Data

At least 4 comparison-capable creators and at least 2 initially selected.

### Required Targeted Tests

- Open shows existing selected creators preselected.
- Multiple selection and deselection work.
- Selected count updates.
- Apply commits.
- Cancel preserves previous committed state.
- Reopen reflects committed state.
- Drag A then modal shows A selected.
- Modal select B/C then chart contains A/B/C.
- Remove B then reopen shows B absent.
- Select A/B/C in order and verify the selected-members summary preserves that
  order.
- Drag the selected A/B/C bundle and verify the target receives A/B/C in order.
- Open Select Creators after bundle drop and verify A/B/C are preselected in
  the same order.
- Bundle drop never duplicates a creator already present in the target.
- Clear selection changes only pending selector state until Apply/drop.

### Required Browser Interactions

Exercise the full flow:

```text
drag A
open Select Creators
select B/C
Apply
remove B
reopen
Cancel
select A/B/C in roster
drag selected bundle to comparison chart
reopen Select Creators
```

### Required Measured Evidence

Report ordered selected IDs before/after every step, the exact single/bundle
drag payload, accepted/rejected IDs, target widget ID, and rendered
series/legend identity after Apply/drop.

### Stop/Block Conditions

Stop if maximum comparison creator count or atomic/partial bundle behavior is
required but undefined.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_7_READY_FOR_REVIEW
TASK_7_BLOCKED_SPEC_GAP
```

## Task 8 -- Mock Completeness

### Purpose

Ensure mock mode can exercise every Dashboard feature without production
services.

### Exact Scope

Only:

```text
sufficient creator data
filter data
Favorites
KPI
Growth
Contribution
Ranking
Comparison
self-contained browser flow
```

### Authoritative Source

- Mock completeness contract in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Authoritative creator roster

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/entities/creator/data/mockCreators.ts
frontend/dashboard/src/features/analytics/data/mockVideoStats.ts
frontend/dashboard/src/features/dashboard/comparison/test or mock source files
frontend/dashboard/src/features/favorites/**
```

### Forbidden Changes

- Do not fabricate unsupported groups.
- Do not change production API behavior.
- Do not use all-zero, identical, one-point, or disabled mock states.

### Required Source Data

Real roster records for all mock creators.

### Required Mock Data

Minimum:

- two creators for each confirmed core branch group: VSPO JP, VSPO EN,
  Hololive JP, Hololive EN, Hololive ID
- 3 favorites across at least two valid groups
- KPI Total Views and Daily Gain
- Growth with at least 7 points
- Contribution with enough entities to verify composition
- Ranking with at least 5 rows
- Comparison with at least 4 creators, 2 initially selected, visible series

### Required Targeted Tests

- Mock flow requires no production AWS/API/CORS.
- Every feature above is exercisable in mock mode.
- Mock creator IDs trace to source records.

### Required Browser Interactions

Run a complete mock Dashboard flow covering filters, roster, comparison,
widgets, and charts.

### Required Measured Evidence

Report mock coverage counts by group, favorite IDs, KPI values, Growth point
count, Contribution entity count, Ranking row count, Comparison series count,
and network dependency count.

### Stop/Block Conditions

Stop if required groups are not actually present in the authoritative roster.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_8_READY_FOR_REVIEW
TASK_8_BLOCKED
```

## Task 9 -- Data Collection / Processing Verification

### Purpose

Answer:

```text
Is the underlying data and processing correct?
```

### Exact Scope

Verify:

```text
source
fields
filters
formula
aggregation
sorting
rounding
output
```

### Authoritative Source

- Data lineage and processing sections in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Analytics source modules
- Backend/API contracts when present

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/analytics/**
frontend/dashboard/src/features/dashboard/comparison/data/**
frontend/dashboard/src/features/dashboard/comparison/model/**
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
```

### Forbidden Changes

- Do not change chart types or visual rendering except where necessary to expose
  verified data.
- Do not alter taxonomy filters.

### Required Source Data

Raw analytics rows, comparison responses, and creator master records used by
each widget.

### Required Mock Data

Mock data from Task 8.

### Required Targeted Tests

For each core widget:

- input rows
- applied filters
- aggregation
- formula
- sorting
- rounding
- output model

### Required Browser Interactions

Use representative filters and verify displayed numeric outputs match processed
outputs.

### Required Measured Evidence

Provide a data processing matrix for:

```text
Total Views
Daily Gain
Growth
Contribution
Ranking
Comparison
```

### Stop/Block Conditions

Stop if any metric formula or backend field meaning is undefined.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_9_READY_FOR_REVIEW
TASK_9_BLOCKED_SPEC_GAP
```

## Task 10 -- Chart Selection / Semantic Verification

### Purpose

Answer:

```text
Is this the correct chart for this data and purpose?
```

### Exact Scope

Verify:

```text
chart purpose
chart type
why chosen
visual encoding
legend semantics
center/summary semantics
```

### Authoritative Source

- Chart contracts in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Product decisions supplied by human review for open spec gaps

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/analytics/charts/**
frontend/dashboard/src/features/dashboard/comparison/components/**
frontend/dashboard/src/features/dashboard/editor/utils/widgetRegistry.tsx
```

### Forbidden Changes

- Do not alter data collection formulas.
- Do not resolve Contribution chart type without human decision.

### Required Source Data

Processed widget outputs from Task 9.

### Required Mock Data

Mock data that demonstrates each chart purpose.

### Required Targeted Tests

- Every chart has a concrete user question.
- Every chart type has input shape and justification.
- Legends/tooltips/summary values have defined meanings.

### Required Browser Interactions

Inspect each core chart in normal state and with representative filters.

### Required Measured Evidence

Report:

```text
Widget
Purpose
Chart type
Input data shape
Why this chart
Visual encoding
Legend meaning
Tooltip meaning
Summary/center meaning
```

### Stop/Block Conditions

Stop if Contribution, Trending, or any chart purpose remains a spec gap.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_10_READY_FOR_REVIEW
TASK_10_BLOCKED_SPEC_GAP
```

## Task 11 -- Chart Rendering / Data Calibration

### Purpose

Answer:

```text
Does the chart actually display the processed data correctly?
```

### Exact Scope

Verify:

```text
member identity
displayed value
percentage
legend
segment/series/bar/point
count consistency
```

Contribution receives explicit multi-member verification.

### Authoritative Source

- Visual encoding matrix in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Completed Task 9 processing evidence
- Completed Task 10 semantic decisions

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/analytics/charts/**
frontend/dashboard/src/features/dashboard/comparison/components/**
```

### Forbidden Changes

- Do not change formulas unless Task 9 identified and approved a processing fix.
- Do not hide mismatches with CSS.

### Required Source Data

Processed chart input for each rendered chart.

### Required Mock Data

Mock data with multiple visible entities for Growth, Contribution, Ranking, and
Comparison.

### Required Targeted Tests

- Displayed labels and values match processed data.
- Legend count matches visual entity count where applicable.
- Comparison series count matches selected creator count for ok creators.
- Contribution member/percentage/visual counts follow the documented
  relationship.

### Required Browser Interactions

Render every core chart and inspect DOM/SVG/canvas output as applicable.

### Required Measured Evidence

For Contribution:

| Member | Expected value/% | Displayed value/% | Visual segment exists | Legend mapping correct |
| --- | --- | --- | --- | --- |

For every chart:

```text
source entity
processed item
displayed label
displayed numeric value
legend entry
visual segment/series/bar/point
```

### Stop/Block Conditions

Stop if selected chart type cannot represent the documented data honestly.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_11_READY_FOR_REVIEW
TASK_11_BLOCKED
```

## Task 12 -- Accessibility / Focus Regression

### Purpose

Verify standard accessibility and focus behavior without adding a
keyboard-specific Dashboard product mode.

### Exact Scope

Only:

```text
focus-visible issue
no keyboard-specific product mode
```

### Authoritative Source

- Accessibility/focus rules in `DASHBOARD_LAYOUT_GUIDELINES.md`
- Existing project accessibility patterns

### Files Expected

Expected candidates:

```text
frontend/dashboard/src/features/dashboard/**
frontend/dashboard/src/features/analytics/**
frontend/dashboard/src/pages/dashboard/DashboardPage.tsx
frontend/dashboard/src/features/dashboard/styles/dashboard.css
```

### Forbidden Changes

- Do not add keyboard drag/drop, keyboard widget move, keyboard resize, or
  keyboard-specific comparison workflows.
- Do not advertise keyboard-specific product mode.

### Required Source Data

Interactive controls inventory.

### Required Mock Data

Existing mock data sufficient to expose all controls.

### Required Targeted Tests

- Focus is visible on standard controls.
- Dialogs trap and restore focus where applicable.
- Approved comparison copy is used.
- Forbidden phrase `keyboard-friendly alternative` is absent.

### Required Browser Interactions

Keyboard-tab through ordinary controls, open/close dialogs, verify focus return.

### Required Measured Evidence

Report focused element sequence, visible focus evidence, dialog focus trap
behavior, focus return target, and forbidden-copy search result.

### Stop/Block Conditions

Stop if an accessibility requirement conflicts with the no-keyboard-product-mode
decision and needs human product direction.

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches.

### Final Status

```text
TASK_12_READY_FOR_REVIEW
TASK_12_BLOCKED
```

## Task 13 -- Full Regression + Human Review Gate

### Purpose

Run final automated and browser validation, then hand visual acceptance to the
user.

### Exact Scope

Run all automated validation, launch a real browser, report measured evidence,
and stop for human visual review.

### Authoritative Source

- Full `DASHBOARD_LAYOUT_GUIDELINES.md`
- Completed the required Dashboard control/time-zone prerequisite and Tasks
  1-12

### Files Expected

No new implementation files expected unless regression reveals a defect assigned
to this final task by the user.

### Forbidden Changes

- Do not self-approve visual completion.
- Do not introduce new feature work.
- Do not broaden scope beyond regression fixes explicitly required by failed
  evidence.

### Required Source Data

All source data used by the required prerequisite and Tasks 1-12.

### Required Mock Data

Task 8 mock data.

### Required Targeted Tests

Run all targeted tests required by the prerequisite and Tasks 1-12 plus
project-appropriate full
frontend validation explicitly required for final regression.

### Required Browser Interactions

Verify:

- workspace width
- widget overflow
- horizontal move
- vertical move
- live midpoint reflow before drop
- dashed-grid preview alignment and no overlap
- viewport-lock drag with no wheel input
- no drag-edge auto-scroll
- no drag-induced document expansion
- creator taxonomy rendering
- grouped analytics filter panel, active count, and Reset
- Notification-style member selector search/Favorites/grouping
- valid comparison drop
- invalid comparison target
- ordered multi-select and bulk bundle drop
- Dashboard excludes editable Time Zone, Theme, and Upcoming controls
- Settings owns Theme and Upcoming preferences
- Mock / Live is development-only and absent in production
- `Asia/Tokyo` local 18:00 refresh boundary
- `Asia/Hong_Kong` local 18:00 refresh boundary
- cached data remains visible during refresh/failure
- chart entity rendering
- member/percentage mapping
- accessibility/focus behavior

### Required Measured Evidence

Provide a final evidence matrix with:

```text
criterion
expected
actual
evidence source
PASS/FAIL
```

No row may pass without attached evidence.

### Stop/Block Conditions

Stop on any `FAIL` or `UNVERIFIED` criterion and report it. Stop after passing
measured validation with:

```text
WAITING_FOR_USER_VISUAL_REVIEW
```

### Git Restrictions

Do not stage, commit, push, stash, reset, or switch branches unless explicitly
authorized after review.

### Final Status

End with exactly one of:

```text
WAITING_FOR_USER_VISUAL_REVIEW
TASK_13_BLOCKED
```
