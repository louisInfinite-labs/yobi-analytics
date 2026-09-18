# Dashboard Layout Implementation Microtasks

This execution plan decomposes [`DASHBOARD_LAYOUT_GUIDELINES.md`](./DASHBOARD_LAYOUT_GUIDELINES.md) into independently verifiable microtasks.

It is written for coding agents such as Claude Code and Codex. An agent must not decide that a result is acceptable from personal judgment.

## Completion Protocol

A microtask is complete only when every acceptance criterion under that task has objective evidence.

Criterion-relevant evidence may include:

1. The exact targeted test command and process exit code.
2. The relevant test name or source assertion when needed to identify the evidence.
3. For rendered behavior, measured DOM values or browser assertions.
4. For network behavior, captured request counts and request parameters.
5. For persistence behavior, state before the action, state after the action, and state after reload.

The following are not completion evidence:

- “Looks correct.”
- “Implemented as requested.”
- “The build passes.”
- “No TypeScript errors.”
- A screenshot without numeric or state assertions.
- Agent confidence.
- Manual inspection without recorded expected and actual values.

If an acceptance criterion cannot be executed, mark it `UNVERIFIED`. The microtask remains incomplete.

An item that is not an acceptance criterion and is outside the owning microtask is `OUT OF SCOPE / NOT REQUIRED`, not `UNVERIFIED`. Optional visual inspection, future integration work, and existing documented ownership gaps do not become completion criteria merely because they are mentioned. An existing dependency or gap remains a dependency, not a failure, unless the current microtask owns it.

Do not combine microtasks unless the user explicitly changes the scope. Complete them in dependency order.

## Microtask Coding Scope

- Change only code required by the current microtask's explicit acceptance criteria.
- Do not perform adjacent refactors, cleanup, architecture redesign, speculative abstraction, or work assigned to a future microtask.
- Once the relevant implementation path is known, do not repeatedly scan unrelated repository areas.
- Prefer the smallest correct diff.
- Do not add unnecessary comments, docstrings, helpers, wrappers, abstractions, or future-proofing structures.
- Reuse an existing helper or abstraction when it already owns the required behavior; do not create a new one merely to make the current microtask look cleaner.
- If an acceptance criterion requires substantial work outside the owning microtask, stop and report the dependency or ownership gap. Do not silently expand scope.

## Risk-Based Validation Policy

Every microtask does not require the full frontend suite. Explicit acceptance criteria and Required Evidence in the owning microtask remain mandatory; the rules below determine the breadth of additional validation.

### Local, module, or component microtask

Required:

- Relevant targeted tests.

Add typecheck only when TypeScript types, shared interfaces, hooks, or changed production TS/TSX code make it materially useful.

### Shared state, canonical core, or integration-sensitive microtask

Required:

- Relevant targeted tests.
- Directly affected integration tests.
- Frontend typecheck.

### Full frontend test suite

Run the full frontend test suite only when:

- Broad or shared infrastructure is affected and targeted coverage is insufficient.
- An accumulated accepted batch is about to be committed or pushed.
- A task explicitly requires full regression.
- MT-17 is running.
- The user explicitly requests it.

### Production build

Run the production build only when:

- Bundling or build behavior is relevant.
- A commit or push checkpoint requires accumulated-batch validation.
- MT-17 requires it.
- The user explicitly requests it.

### Lint

Run lint only when:

- Changed files need lint verification under repository rules.
- A commit or push checkpoint requires accumulated-batch validation.
- The task or user explicitly requires it.

Do not run broad checks merely to make a microtask report appear stronger.

When targeted validation passes, record only the command, exit code, and relevant test count or concise evidence. Do not include full successful command output.

Do not repeat MT-17-level validation after every microtask.

## Commit Checkpoints and Git State

For normal microtasks:

- Do not commit.
- Do not push.
- Do not stage files unless explicitly requested.
- Do not run or report Git-status and cached-diff commands as mandatory handoff evidence.

Report Git state only when commit, push, or staging is in scope; unexpected unrelated changes are discovered; branch state affects correctness; or the user explicitly asks.

When the user explicitly says an accumulated accepted batch is ready to commit or push, run once for that batch:

- The relevant full frontend test suite.
- Frontend typecheck.
- Production build.
- Lint where applicable.
- Git diff, check, and status review.

Stage, commit, or push only with explicit authorization. Never stage local-only or unrelated files.

## Shared Deterministic Fixtures

All relevant tests must use stable fixtures with these identifiers:

```ts
const creators = [
  { creatorId: 'creator-a', displayName: 'A' },
  { creatorId: 'creator-b', displayName: 'B' },
  { creatorId: 'creator-c', displayName: 'C' },
];

const comparisonItems = [
  { comparisonItemId: 'revenue', label: 'Revenue' },
  { comparisonItemId: 'engagement', label: 'Engagement' },
  { comparisonItemId: 'growth', label: 'Growth' },
];
```

The initial layout fixture is:

```text
┌─────┬─────┐
│  A  │  B  │
├─────┼─────┤
│  C  │  D  │
└─────┴─────┘
```

Visual widget order is derived from grid coordinates: top to bottom, then left to right. The top-left widget is `widget[0]`.

---

## MT-01 — Canonical Layout Types and Validation Contract

### Goal

Create one typed layout model and one validation result contract shared by load, edit, preview, and save paths.

### Dependencies

None.

### Scope

- Grid size.
- Widget identity.
- Coordinates and dimensions.
- Canonical and draft layout types.
- Validation error codes.

### Acceptance Criteria

1. The grid type rejects column or row values outside 1 through 5.
2. The widget height type accepts only `0.5` and `1`.
3. Every widget instance requires `widgetId` and `widgetType`.
4. Comparison configuration requires ordered `creatorIds` and `comparisonItemIds`.
5. Validation returns machine-readable codes for duplicate ID, overlap, out-of-bounds, invalid grid, invalid width, invalid height, and incomplete fill.
6. Widget coordinates are finite and aligned to supported grid units: `x` is an integer and `y` is a multiple of `0.5`.
7. A `1X` widget starts on an integer row boundary; a `0.5X` widget starts on an integer or half-row boundary.
8. The module exports exactly one canonical `validateLayout` entry point for later production consumers.

### Required Evidence

- Typecheck exit code 0.
- Unit tests proving every accepted and rejected boundary value.
- Tests rejecting `NaN`, infinity, fractional `x`, quarter-row `y`, and a `1X` widget starting at `y = 0.5`.
- Search result showing exactly one canonical validator implementation. Production consumer wiring is verified by the later owning microtasks.

---

## MT-02 — Widget Identity and Duplicate Prevention

### Goal

Guarantee stable, unique widget instances across every Dashboard operation.

### Dependencies

MT-01.

### Acceptance Criteria

1. Creating two widget instances produces two different non-empty `widgetId` values.
2. Rapidly activating Add multiple times cannot insert the same instance twice.
3. The production Add path imports the canonical `validateLayout` function and rejects duplicate IDs before frontend state commit.
4. `widgetId` uniqueness is enforced in the frontend state layer before every MT-02 mutation commits (add, and a generic geometry update standing in for move/resize). Enforcing this again at the persistence/submission boundary is owned by MT-09's production save path — MT-02 has no submission boundary to verify against yet.
5. `widgetId` is immutable and is preserved by every mutation MT-02 actually provides: add, a generic geometry update (standing in for move/resize), and a serialize/deserialize round trip (standing in for save/reload). End-to-end preservation through each real production path is verified again where that path is first built, not gated on MT-02 completion:
   - Move and resize -> MT-05 (`the production drag and resize paths import the canonical validateLayout function`).
   - Save -> MT-09 (production save path).
   - Reload -> MT-15 (production load path), in addition to MT-02's own round-trip proof.
   - Comparison configuration -> MT-12 (`Reused widgets preserve widgetId, x, y, width, and height`).
   - Responsive reflow -> MT-16 (`Widget IDs are identical before and after responsive reflow`).

Not an MT-02 completion criterion: MT-02 owns no production widget-list renderer, so "React lists use `widgetId` as the key, not array index" (Section 4, rule 7) cannot be checked against production code here. It is a full completion criterion of MT-07 (`the production widget-list renderer keys each widget by widgetId`, MT-07 AC13) — the first microtask that builds a production renderer for the canonical model.

### Required Evidence

- Unit test for duplicate rejection.
- E2E test for rapid repeated Add.
- Unit test proving a geometry-only update (standing in for move/resize) never changes `widgetId`.
- Serialize/deserialize round-trip assertion comparing the complete ordered ID list before and after "reload."

---

## MT-03 — Default 2x2 Layout and Saved-Layout Priority

### Goal

Initialize a new Dashboard predictably without overwriting saved user layouts.

### Dependencies

MT-01 and MT-02.

### Acceptance Criteria

1. No saved layout produces exactly two columns and two rows.
2. Default widget count, types, and order match the explicit default configuration.
3. Every default widget has a unique `widgetId`.
4. A valid saved `3x2` fixture loads as `3x2`; no default widget replaces it.
5. Reloading the same saved layout produces identical widget IDs, coordinates, sizes, and order.

### Required Evidence

- Unit tests for missing-layout and saved-layout branches.
- Reload test with deep equality of serialized layout state.

---

## MT-04 — Chart Catalog Single-Load Behavior

### Goal

Load available chart definitions from the backend once per Dashboard page lifecycle and reuse them in edit mode.

### Dependencies

MT-03.

### Acceptance Criteria

These are MT-04's own module-level contract: a chart-catalog-loader hook,
tested in isolation (a Testing-Library harness, the same "E2E test"
convention MT-02 already used for its Add-button harness), not the live
Dashboard page. No production editor for the canonical model exists yet
(`DashboardPage.tsx` still runs the legacy GridStack `useEditableLayout`
system) for MT-04 to mount into without prematurely building editor-shell
work. See "Production integration ownership gaps" below for the distinct,
still-required production-level behavior this does not yet cover.

1. Mounting the chart-catalog-loader hook makes exactly one catalog request for that mounted instance.
2. Toggling an unrelated local UI state next to an already-mounted loader instance, without unmounting that instance, makes zero additional catalog requests.
3. Toggling that local UI state five times keeps the total catalog request count at one for the same mounted loader instance.
4. React Strict Mode's mount/cleanup/mount replay does not increase the request count above one.
5. Calling the loader's `retry()` after a failed request makes exactly one additional request.
6. The loader's success state exposes exactly and only the items its fetch function returned — no fabricated or omitted entries. (Whether a production UI renders exactly that set is not verifiable here; see GAP-2 below — no such UI exists yet.)
7. The loader's pending, error, empty-success, and success states are distinguishable by test assertions.
8. A catalog error surfaced by the loader does not delete existing widgets held in separate Dashboard widget state.

### Required Evidence

- Network mock assertion with exact request counts.
- E2E test names and exit code.
- State assertion proving existing widget IDs survive an error.

### Production integration ownership gaps

The following production-level behavior is a real requirement of
`DASHBOARD_LAYOUT_GUIDELINES.md` (Sections 3.2/3.3), separate from MT-04's
module-level contract above. It is **not deleted or weakened** by the
rewording above — it remains required — but no microtask in this document
currently owns implementing or verifying it. Do not treat any criterion
above, or any existing microtask, as already covering these until an
explicit owner and acceptance criterion exist.

- **GAP-1 (production single-load wiring).** Section 3.3 requires the
  production Dashboard page to load the catalog once and reuse it in edit
  mode. No microtask requires mounting a catalog-loader at a point in the
  production tree that survives Edit/view toggling. MT-07 ("Editor Shell and
  Draft Isolation") is the nearest candidate — the first microtask building a
  production editor for the canonical model, and Guidelines Section 6.1
  ("Reuse the already-loaded chart catalog. Avoid any additional chart
  catalog request.") describes exactly this behavior for "Entering the
  editor" — but MT-07's current Acceptance Criteria (1-13) do not enumerate a
  catalog-reuse check. This document does not assign MT-07 this ownership;
  it is recorded here as unresolved.
- **GAP-2 (canonical add-widget UI).** Section 3.2 requires that "a chart not
  returned by the backend must not appear in the add-widget UI." The only
  existing production add-widget UI is the legacy `WidgetTray.tsx`, backed by
  the hard-coded `ALL_WIDGET_TYPES` list in `widgetRegistry.tsx` — exactly
  what Section 3.2 prohibits — and it is not owned or touched by any
  canonical-model microtask. No microtask in this document owns building a
  canonical catalog-driven add-widget UI component (distinct from MT-02's
  abstract Add-mutation path, which places a widget of a given type but does
  not browse the catalog). **UNRESOLVED — no owner.**
- **GAP-3 (backend chart-catalog API).** Section 3.2 requires catalog data to
  come "from the backend." No chart-catalog (or equivalently named) endpoint
  exists in this repository: `src/api_handler.py`'s complete route table
  (videos/growth, creators/trending, organizations/trending, heartbeat,
  remote-config, push-subscription, notification-preference, admin stats)
  has no such route, and neither `Roadmap.md` nor any other repository
  document assigns ownership of building one. **Backend chart-catalog API
  ownership is unresolved and is an external/specification dependency.**
  MT-04's injected `fetchCatalog` parameter is valid frontend architecture
  for isolating this dependency — the same pattern `useCachedDashboardData`
  (`src/features/analytics/hooks/useCachedDashboardData.ts`) already uses for
  its `fetchFn`, with `dashboardAnalyticsSource.ts` supplying real/mock
  implementations for that hook in production — but the injected function
  does not itself satisfy "from the backend"; that requirement stays open
  until GAP-3 is resolved by an explicit owner.

MT-17 AC5 ("The catalog request count remains one through the complete edit
workflow") already exists, is preserved unchanged, and remains the correct
owner of the final end-to-end verification once the complete edit workflow
exists. It is only meaningfully checkable once GAP-1 (and, for a real network
count rather than an injected one, GAP-3) has an owner and is implemented by
some microtask before MT-17 runs — which is not currently guaranteed by this
document's dependency graph. This is recorded here so MT-17 is not later
assumed to satisfy GAP-1/GAP-3 by inheritance alone.

---

## MT-05 — Grid Dimensions, Widget Sizes, Fill, and Collision

### Goal

Prevent invalid grid dimensions, widget sizes, gaps, overlaps, and overflow.

### Dependencies

MT-01.

### Acceptance Criteria

1. Every integer grid from `1x1` through `5x5` is accepted.
2. `0x3`, `2.5x4`, and `6x5` are rejected.
3. Widget heights `0.5X` and `1X` are accepted.
4. Heights `0.25X`, `0.75X`, and `1.25X` are rejected.
5. A column containing one `1X` widget passes fill validation.
6. A column containing two stacked `0.5X` widgets passes fill validation.
7. A lone `0.5X` widget fails with `INCOMPLETE_COLUMN`.
8. Every overlap fixture fails with `WIDGET_OVERLAP`.
9. Every overflow fixture fails with `OUT_OF_BOUNDS`.
10. The production drag and resize paths import the canonical `validateLayout` function.
11. Rejected drag or resize restores the last valid draft coordinates.
12. A successful drag or resize preserves the moved/resized widget's original `widgetId`, carrying forward the identity invariant MT-02 established at the state-layer.

### Required Evidence

- Parameterized unit tests for all listed values.
- E2E test proving rejected resize rollback.
- Before/after assertion that a successful drag or resize changes only geometry, never `widgetId`.

### Production interaction ownership gap

AC10-12's "the production drag and resize paths" are the canonical mutation
layer (`moveWidget`/`resizeWidget` in `dashboardWidgetActions.ts`, delegating
to the same `updateWidgetGeometry` → `validateLayout` MT-02 already wired up)
— the same sense this document already established for "the production Add
path" in MT-02 AC3, which was likewise a non-DOM-wired canonical function,
not a literal mouse gesture. This reading is also the only one structurally
possible at MT-05: MT-05 depends only on MT-01 and is itself a dependency of
MT-07 ("Editor Shell and Draft Isolation"), so no editor/DOM surface to drag
inside of exists yet at MT-05 — requiring a real interactive gesture here
would invert that dependency order.

- **GAP-4 (real production drag/resize gesture).** Guidelines Section 9
  ("Drag, Resize, and Collision Rules") describes an actual pointer-driven
  interaction: showing a target placeholder during drag, snapping resize
  handles to supported sizes, and validating before accepting a drop. No
  microtask in this document builds that interaction for the canonical
  model. MT-06 AC8 ("Drag placeholders and saved widgets produce the same
  16px measurements"), MT-16 AC6 ("Drag/resize has a keyboard-accessible
  equivalent"), and MT-17 AC9 (search proving "add, drag, resize, editor
  preview, load, and save all import the same canonical `validateLayout`
  implementation") all treat a working drag/resize interaction as an
  already-existing fact by the time they run, but none of MT-06 through
  MT-17 assigns the task that actually builds the pointer/keyboard gesture
  handling and wires it to `moveWidget`/`resizeWidget`. The existing live
  drag/resize path (`DashboardGrid.tsx`'s GridStack `"change"` event →
  `useEditableLayout.ts`'s `updateWidgetPositions`) is a different, legacy
  12-column/`instanceId` model and does not call `moveWidget`/`resizeWidget`
  or `validateLayout` at all. **UNRESOLVED — no owner.** Do not assume MT-06,
  MT-07, or MT-16 covers this until an explicit criterion and owner exist.

---

## MT-06 — Exact 16px Spacing

### Goal

Produce one measured 16px gap between neighboring Dashboard elements without double margins.

### Dependencies

MT-05.

### Acceptance Criteria

1. The facing edge contribution of each adjacent widget is exactly `8px`.
2. For every horizontal widget pair, `rightRect.left - leftRect.right === 16`.
3. For every vertical widget pair, `lowerRect.top - upperRect.bottom === 16`.
4. No adjacent pair measures `32px`.
5. When a neighboring non-widget component contributes `0px`, the widget side contributes `16px`.
6. When a neighboring component contributes `8px`, the widget side contributes `8px`.
7. The final widget-to-component bounding-rectangle gap is exactly `16px` in both fixtures.
8. Drag placeholders and saved widgets produce the same 16px measurements.
9. The 8px/16px spacing arithmetic is invariant to grid-unit pixel size: the contribution is a fixed absolute pixel value, not a percentage or a value that depends on column/row width, so the 16px result holds regardless of how large a grid unit renders at any given screen size. This is proven by parametrizing the geometry calculation over multiple representative pixel-per-grid-unit configurations (standing in for different screen sizes), not by rendering the real Dashboard at real breakpoints.
10. Enabling dashed edit guides changes no widget `getBoundingClientRect()` x, y, width, or height value.
11. The dashed guide contributes `0px` additional margin and does not change grid track measurements.
12. The measured gap between the combined guide/preview outer bound and every neighbor remains exactly `16px`.
13. An unchanged edit preview and the saved view-mode widget have identical bounding rectangles.
14. An insertion placeholder and the widget produced by dropping into it have identical border-box rectangles.

### Required Evidence

- Browser tests using `getBoundingClientRect()`.
- Captured expected and actual values for every representative pixel-per-grid-unit configuration used to prove AC9's invariance (not real per-breakpoint browser renders — see "Breakpoint verification ownership" below).
- Computed-style assertions for the 8px widget edge contributions.
- Before/after rectangle snapshots for view mode, edit mode, insertion placeholder, and saved view mode.

### Breakpoint verification ownership

AC9 as written above is the breakpoint-*independent* geometry invariant MT-06
can actually prove now: the 8px/16px contribution is a fixed absolute pixel
value untouched by grid-unit pixel size. It is not, and does not claim to be,
a real rendering of the Dashboard at this project's actual breakpoints
(`useBreakpoint.ts`'s `mobile`/`tablet`/`desktop` thresholds). That real,
production, per-breakpoint verification is a distinct requirement, already
fully preserved, unchanged, and unweakened, as **MT-16 AC3** ("Every
adjacent-element gap measures 16px at every breakpoint") — MT-16 also owns
defining the authoritative per-breakpoint column counts and widths (Section
11) that a real render would need. Do not treat MT-06's AC9 evidence as
satisfying MT-16 AC3, and do not treat MT-16 AC3 as already covered by MT-06.

---

## MT-07 — Editor Shell and Draft Isolation

### Goal

Provide a reversible editor that never mutates saved state before an explicit save.

### Dependencies

MT-03, MT-04, MT-05, and MT-06.

### Acceptance Criteria

1. Clicking **Edit** creates `draftLayout` deeply equal to `canonicalLayout`.
2. Edit mode renders dashed grid guides.
3. Edit mode renders buttons named **Save**, **Cancel**, and **Restore Default**.
4. View mode renders none of the edit guides or insertion markers.
5. Dashed guides are overlays or border-box decorations and add no independent margin, padding, grid gap, width, or height.
6. Entering edit mode keeps every widget bounding rectangle and neighbor gap unchanged.
7. Editor preview validation imports the canonical `validateLayout` function.
8. Editing draft coordinates does not change canonical coordinates.
9. **Cancel** restores all IDs, coordinates, sizes, chart types, and order to the pre-edit snapshot.
10. **Cancel** sends zero save requests.
11. **Restore Default** changes only the draft to `2x2`.
12. **Restore Default** sends zero save requests until **Save** is activated.
13. The production widget-list renderer keys each widget by `widgetId`, not array index — this is the first production renderer for the canonical model, so it owns the end-to-end verification of the React-key requirement MT-02 established as an invariant only.

### Required Evidence

- State snapshots before edit, during edit, and after cancel.
- Network assertion for zero save requests.
- Computed-style assertion that the guide border style is dashed.
- Bounding-rectangle equality assertion before and after enabling edit mode.
- Source/DOM assertion confirming the rendered widget list's React key is `widgetId`.

---

## MT-08 — Widget Insertion-Slot Preview

### Goal

Preview insertion by explicit slots while preserving canonical state.

### Dependencies

MT-07.

### Acceptance Criteria

1. Given `A | B`, targeting the middle insertion slot previews `A | E | B`.
2. Given `A | B`, targeting the right insertion slot previews `A | B | E`.
3. The exact active insertion slot is visibly represented by a placeholder or marker.
4. Existing A and B widths change only in `draftLayout`.
5. Canonical A and B widths remain byte-for-byte unchanged during preview.
6. Leaving the insertion slot restores the previous draft.
7. Cancelling the drag restores the previous draft.
8. An invalid slot accepts no drop and changes no state.
9. Preview and post-drop draft coordinates are identical.
10. Widget spacing remains exactly 16px throughout preview.
11. The insertion placeholder and final widget have identical border-box rectangles.
12. Removing the dashed guide when returning to view mode does not shift the widget.

### Required Evidence

- E2E state assertions for middle and right insertion.
- Bounding-rectangle measurements during preview.
- Canonical-layout equality assertion before and after cancelled drag.
- Placeholder-versus-result rectangle equality output.

---

## MT-09 — Grid-Change Confirmation and Atomic Save

### Goal

Require explicit confirmation before saved widgets are forcibly resized or repositioned.

### Dependencies

MT-07 and MT-08.

### Acceptance Criteria

1. Saving a draft that changes existing widget geometry opens a dialog before the save request.
2. The dialog displays current grid size, target grid size, and affected widget count.
3. Closing the dialog sends zero save requests.
4. Cancelling the dialog leaves canonical state unchanged.
5. The production save path imports the canonical `validateLayout` function.
6. Confirming sends exactly one save request containing the validated draft.
7. A successful response atomically replaces canonical state.
8. A failed response restores the full previous canonical state.
9. A target grid without sufficient capacity disables confirmation.
10. No confirm path deletes, hides, or overlaps a widget.
11. A successful save preserves every existing widget's `widgetId`, and the production save path rejects a draft containing duplicate `widgetId` values before the save request is sent — this is the first persistence/submission boundary for the canonical model, so it owns the end-to-end verification MT-02 could only establish as a state-layer invariant.

### Required Evidence

- Network request-count assertions.
- Payload snapshot.
- Canonical before/after/rollback snapshots.
- Before/after `widgetId` list equality across a successful save; a duplicate-`widgetId` draft assertion proving zero save requests are sent.

---

## MT-10 — Ordered Creator Selection and Badges

### Goal

Create deterministic creator comparison order from user click order.

### Dependencies

MT-04.

### Acceptance Criteria

1. Clicking A, then B, then C stores `['creator-a', 'creator-b', 'creator-c']`.
2. A, B, and C avatars display `①`, `②`, and `③` at the top-right.
3. Every badge has an accessible label with its numeric comparison order.
4. Deselecting B produces A① and C②.
5. Reselecting B produces A①, C②, and B③.
6. Search and filtering do not remove selected IDs.
7. Duplicate creator selection is rejected.
8. Comparison remains disabled with fewer than two distinct creators.
9. Request parameters, chart series, legends, tooltips, and saved configuration use the same creator order.
10. Creator selection does not change the application's active creator.

### Required Evidence

- Unit tests for ordering and renumbering.
- Accessibility query assertions for badge labels.
- Request and saved-state snapshots.

---

## MT-11 — Flow 1: In-Widget Creator Picker

### Goal

Configure creator comparison from inside a compatible chart widget.

### Dependencies

MT-07 and MT-10.

### Acceptance Criteria

1. A compatible chart exposes **Select Creators** or the approved equivalent name.
2. Activating it opens the existing Creator List.
3. Existing widget creator IDs appear selected in the list.
4. Selecting A and B updates only the target widget draft to `A vs B`.
5. Adding C updates only the target widget draft to `A vs B vs C`.
6. Cancelling the picker leaves the previous configuration unchanged.
7. Applying the picker does not immediately save canonical state.
8. The chart catalog request count does not increase.

### Required Evidence

- Target-widget draft snapshot.
- Canonical-state equality assertion.
- Catalog request count before and after the flow.

---

## MT-12 — Flow 2: Creator List Selection and widget[0]-First Save

### Goal

Assign selected comparison items from the top-left widget onward without moving existing widgets, then display the requested charts immediately after dialog save.

### Dependencies

MT-05, MT-06, MT-09, and MT-10.

### Acceptance Criteria

1. Select A, B, and C plus Revenue, Engagement, and Growth.
2. The dialog shows A①, B②, C③ and all three selected item IDs.
3. Widgets are sorted by grid coordinates, not storage-array order.
4. The top-left widget is selected as `widget[0]`.
5. Revenue maps to `widget[0]`, Engagement to `widget[1]`, and Growth to `widget[2]`.
6. Reused widgets preserve `widgetId`, x, y, width, and height.
7. If only two widget containers exist, exactly one new widget is appended.
8. The appended widget has a new unique `widgetId`.
9. Existing widget coordinates and sizes do not change.
10. If five widgets exist and only three items are selected, widgets 3 and 4 remain unchanged.
11. If no valid slot exists for a missing chart, **Save** is disabled and no state changes.
12. The dialog displays a mapping preview before save.
13. Clicking dialog **Save** sends exactly one atomic comparison transaction.
14. The transaction does not include unrelated unsaved Dashboard draft changes.
15. On success, the dialog closes.
16. Assigned chart containers render immediately after close.
17. No page reload, second Dashboard save, or manual widget movement is required.
18. A loading chart container is visible immediately when data has not returned.
19. On save failure, the dialog stays open and Dashboard state remains unchanged.

### Required Evidence

- Deliberately shuffled storage-array fixture proving coordinate-based order.
- Before/after table of every widget ID and geometry field.
- Exact request payload and request count.
- DOM assertion that all assigned chart containers exist after close.
- Failure-path state equality assertion.

---

## MT-13 — Flow 3: Drag Creator Cell into Chart

### Goal

Add a creator to a compatible comparison chart through Creator List drag and drop.

### Dependencies

MT-07 and MT-10.

### Acceptance Criteria

1. Dragging B onto a chart containing A previews `A vs B`.
2. Dragging C onto a chart containing A and B previews `A vs B vs C`.
3. A newly dropped creator receives the next order number.
4. Compatible charts show an active drop target.
5. Incompatible charts show a disabled target and reject the drop.
6. Dropping an existing creator adds no duplicate ID or series.
7. Cancelling drag changes no widget state.
8. A successful drop updates only the target widget in `draftLayout`.
9. The source Creator List order and contents do not change.
10. Canonical state remains unchanged until Dashboard save.

### Required Evidence

- Drag-and-drop E2E tests for compatible, incompatible, duplicate, and cancelled cases.
- Draft and canonical state snapshots.

---

## MT-14 — Comparison Data and Render States

### Goal

Render comparison results without fabricating data or losing configuration.

### Dependencies

MT-10, MT-11, MT-12, and MT-13.

### Acceptance Criteria

1. Comparison requests contain ordered stable creator IDs.
2. Requests contain only backend-supported comparison item IDs.
3. The chart renders one distinguishable series per selected creator.
4. Legend and tooltip order matches creator click order.
5. Loading state preserves creator and item configuration.
6. Partial-error state identifies the failed creator/item without deleting valid data.
7. Full-error state preserves the complete widget configuration.
8. Empty response renders an empty state rather than fabricated zero values.
9. An unavailable creator remains represented by an actionable unavailable state.

### Required Evidence

- Request snapshots.
- DOM assertions for series/legend/tooltip order.
- State snapshots for loading, partial error, full error, empty, and unavailable fixtures.

---

## MT-15 — Persistence, Legacy Layout, and Reload

### Goal

Persist valid layouts and recover safely from invalid legacy data.

### Dependencies

MT-02, MT-05, MT-09, and MT-14.

### Acceptance Criteria

1. A valid save survives full page reload with deep-equal layout configuration.
2. The production load path imports the canonical `validateLayout` function.
3. Duplicate-ID legacy data does not render duplicate widgets.
4. Overlapping legacy data does not render an overlap silently.
5. Every migration has a versioned input fixture and expected output fixture.
6. A non-migratable layout enters a recoverable error state.
7. Recovery does not delete server data without explicit user action.
8. Save failure restores the last persisted canonical layout.

### Required Evidence

- Migration fixture tests.
- Reload deep-equality test.
- Failure rollback snapshot.

---

## MT-16 — Responsive and Accessibility Verification

### Goal

Preserve identity, ordering, spacing, readability, and operability at every supported breakpoint.

### Dependencies

MT-06 through MT-15.

### Acceptance Criteria

1. Every supported breakpoint has a deterministic widget order.
2. No breakpoint produces overlap or overflow.
3. Every adjacent-element gap measures 16px at every breakpoint.
4. Widget IDs are identical before and after responsive reflow.
5. Charts do not render below the documented minimum readable width.
6. Drag/resize has a keyboard-accessible equivalent.
7. Focus is visible on every editor action.
8. Valid and invalid targets are distinguishable without color.
9. Dialog focus is trapped and `Escape` closes it.
10. Closing a dialog returns focus to its triggering control.
11. Insertion position and creator comparison order are exposed to assistive technology.

### Required Evidence

- Automated accessibility results.
- Keyboard-only E2E test.
- Per-breakpoint bounding-rectangle and ID snapshots.

---

## MT-17 — Final Regression Matrix

### Goal

Prove that the complete Dashboard layout behavior satisfies every prior microtask without relying on agent judgment.

MT-17 is intentionally stricter than a normal microtask. The risk-based validation policy does not reduce its complete regression requirements: all required tests, typecheck, production build, acceptance matrix, browser and network evidence, and save/reload evidence remain mandatory.

### Dependencies

MT-01 through MT-16.

### Acceptance Criteria

1. Every required unit test passes.
2. Every required integration/E2E test passes.
3. Frontend typecheck passes.
4. Frontend production build passes.
5. The catalog request count remains one through the complete edit workflow.
6. No rendered fixture contains overlap or overflow.
7. Every measured adjacent gap equals 16px.
8. Creator order, widget IDs, and layout geometry survive save and reload.
9. Search output proves that add, drag, resize, editor preview, load, and save all import the same canonical `validateLayout` implementation.
10. The acceptance matrix contains one row for every criterion in MT-01 through MT-16.
11. Every matrix row contains expected value, actual value, evidence location, and `PASS` or `FAIL`.
12. No row may be marked `PASS` without attached evidence.
13. Any `UNVERIFIED` or `FAIL` row makes MT-17 incomplete.

### Required Evidence

- Test command log with exit codes.
- Build and typecheck logs.
- Machine-readable acceptance matrix.
- Browser measurement output.
- Network request log.
- Save/reload state snapshot.

## Required Handoff Format

After each microtask, report exactly:

```text
Microtask:
Files changed:
Acceptance criteria:
- AC1 PASS | FAIL | UNVERIFIED — concise evidence
- AC2 PASS | FAIL | UNVERIFIED — concise evidence
Validation:
- command → exit code
Remaining dependency:
Verdict: PASS | FAIL | INCOMPLETE
```

The only valid `PASS` condition is that every acceptance criterion for that microtask has objective evidence and none are failed or unverified.

Handoff rules:

- Do not restate the entire microtask.
- Do not list every assertion unless needed to explain a failure.
- Do not list a full-suite count unless the full suite was required and run.
- Do not report Git status, cached diff names, or staging details unless Git-state reporting is required.
- Evidence paths may be included inline with the relevant acceptance criterion rather than repeated in a separate long section.
- Label non-criterion work outside the microtask as `OUT OF SCOPE / NOT REQUIRED`; do not add it to the unverified list.
