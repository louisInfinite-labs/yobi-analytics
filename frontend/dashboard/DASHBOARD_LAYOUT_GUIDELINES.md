# Dashboard Authoritative Specification

This document is the authoritative Dashboard contract for `frontend/dashboard`.
It supersedes older Dashboard layout notes and must be read with
[`AGENTS.md`](./AGENTS.md). No Dashboard implementation task may proceed when a
rule below is unresolved or contradicted.

This is a specification document. It does not authorize code changes by itself.

## 1. Authority Rules

- Product, UX, taxonomy, and data semantics must come from repository data,
  repository code, or explicit human direction.
- When the repository does not define a behavior or taxonomy precisely, write:
  `SPECIFICATION GAP -- HUMAN DECISION REQUIRED`.
- Do not infer missing creator metadata from names, public knowledge, UI labels,
  or hardcoded component arrays.
- `All` and equivalent all-state values are UI sentinels, not master-data values.
- i18n may change display text only. It must not change filter identity, source
  value, matching creator set, sorting, or aggregation.

## 2. Source Inventory

Required source files for this rewrite:

- `frontend/dashboard/AGENTS.md`
- `frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md`
- `frontend/dashboard/DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md`
- `frontend/dashboard/src/pages/dashboard/DashboardPage.tsx`
- `frontend/dashboard/src/features/dashboard/**`
- `frontend/dashboard/src/features/analytics/**`
- `frontend/dashboard/src/features/notifications/**`
- `frontend/dashboard/src/features/oshi/**`
- `frontend/dashboard/src/pages/settings/**`
- `frontend/dashboard/src/pages/settings/styles/settings.css`
- `frontend/dashboard/src/features/notifications/data/creators.json`
- `frontend/dashboard/src/entities/creator/model/domain.ts`
- `frontend/dashboard/src/entities/creator/data/mockCreators.ts`

The authoritative current creator roster is:

```text
frontend/dashboard/src/features/notifications/data/creators.json
```

`src/creators.json` and `tests/fixtures/creators.json` also exist, but the
Dashboard/Notification Settings frontend roster source inspected for this
contract is the Dashboard copy above.

## 3. Creator Roster Audit

Read-only audit of
`frontend/dashboard/src/features/notifications/data/creators.json`:

```text
record count: 112
unique creator IDs: 112
duplicate IDs: none
missing displayName: 0
missing organization: 0
missing branch: 0
missing groupKey: 0
missing lifecycleStage: 0
missing channelType: 0
missing active: 0
missing youtubeChannelId: 0
missing avatar/avatarUrl: 112
```

Available creator classification fields:

```text
creatorId
displayName
organization
youtubeChannelId
active
branch
channelType
lifecycleStage
groupKey
discoveryEnabled
graduatedAt
```

Missing creator classification fields:

```text
avatar/avatarUrl
generation
unit
region
favorite identity
```

Favorite identity is not a `creators.json` field. Existing frontend favorite
logic bridges identities elsewhere; Dashboard must document and verify the exact
key before using favorites in Dashboard-specific UI.

Distinct source values:

| Field | Values |
| --- | --- |
| `organization` | `hololive`, `vspo` |
| `branch` | `holo_en`, `holo_id`, `holo_jp`, `vspo_en`, `vspo_jp` |
| `channelType` | `group`, `member`, `staff` |
| `lifecycleStage` | `active`, `graduated`, `pre_debut` |
| `active` | `true` |
| `groupKey` | `0期生`, `1期生`, `2期生`, `3期生`, `4期生`, `5期生`, `6期生`, `Advent`, `aNnounce`, `FLOWGLOW`, `FUWAMOCO`, `Justice`, `mekpark`, `Myth`, `NO`, `Promise`, `ReGLOSS`, `ゲーマーズ` |

`groupKey` is the only currently available generation/unit-like creator field.
It is free-form, multi-valued, and mixes numbered generations, named units,
group/project labels, and the placeholder `NO`. The repository does not define
separate `generation`, `unit`, `project`, `team`, `wave`, and `group` fields.

```text
SPECIFICATION GAP -- HUMAN DECISION REQUIRED
```

The human decision required is whether Dashboard should expose one combined
`Generation / Unit` filter backed by `groupKey`, or split heterogeneous concepts
into separate dimensions after creator master data is expanded.

## 4. Creator Master Field Contract

| Dashboard meaning | Authoritative source | Source field | Current status |
| --- | --- | --- | --- |
| Creator ID | `creators.json` | `creatorId` | Present, unique |
| Display name | `creators.json` | `displayName` | Present |
| Organization | `creators.json` | `organization` | Present |
| Branch/region | `creators.json` | `branch` | Present; UI labels are mapped in `domain.ts` |
| Generation | none as separate field | none | `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` |
| Unit/group/project/wave | `creators.json` | `groupKey` | Present but heterogeneous |
| Lifecycle/status | `creators.json` | `lifecycleStage`; `active`; optional `graduatedAt` | Present |
| Avatar | none in roster | none | Missing |
| Favorite identity key | favorites feature bridge | not in roster | Must be verified before Dashboard use |

Do not derive generation, unit, branch, lifecycle, avatar, or favorite status
from `displayName`.

## 5. Filter Authority

Every Dashboard filter must document all of the following before implementation:

```text
Filter:
Entity level:
Authoritative source:
Source file/module:
Source field(s):
Option derivation:
Upstream dependencies:
Downstream effect:
Empty-option behavior:
Mock source:
```

No filter may exist merely because a component hardcodes an option array.

### Filter Classification

| Filter | Entity level | Authoritative source | Source field(s) | Current implementation note |
| --- | --- | --- | --- | --- |
| Organization | creator-level metadata | `creators.json` | `organization` | Current filter options are hardcoded in `OrganizationFilter.tsx`; must reconcile to roster values. |
| Branch | creator-level metadata | `creators.json` | `branch` | Current options are derived from `mockCreators` via `availableBranches`. |
| Generation / Unit | creator-level metadata, currently heterogeneous | `creators.json` | `groupKey` | Current options are derived from `mockCreators`; must reconcile to real roster and human taxonomy decision. |
| Channel Type | creator-level metadata | `creators.json` | `channelType` | Current options are hardcoded as `member`, `group`, `staff`; source-backed. |
| Lifecycle | creator-level metadata | `creators.json` | `lifecycleStage` | Current options include `retired`, which exists in `domain.ts` but has zero current roster records. |
| Content Tags | content/video-level metadata | analytics response / mock video stats | `contentTags` | Not from `creators.json`; current canonical label enum is in `domain.ts`. |
| Format | content/video-level metadata | analytics response / mock video stats | `contentFormat` | Not from `creators.json`; current canonical label enum is in `domain.ts`. |
| Date Range | analytics query metadata | Dashboard state / analytics source | `Period` | Affects fetch/scaling before widget processing. |
| Data Source | UI/data-source selector | Dashboard state | `mock` / `live` state | Selects analytics fetch path; not creator master data. |
| Creator comparison selection | widget UI state and persisted widget config | widget comparison config | ordered `creatorIds`, `comparisonItemIds` | Affects comparison-capable widgets only. |

### Required Per-Filter Detail

| Filter | Entity level | Source file/module | Option derivation | Upstream dependencies | Downstream effect | Empty-option behavior | Mock source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Organization | Creator | `creators.json`; labels in `domain.ts` | Unique `organization` values; `All` sentinel prepended by UI | none | Narrows Branch and Generation/Unit populations | If no records, show only `All` and block source-backed options | `mockCreators` today; must be replaced/reconciled |
| Branch | Creator | `creators.json`; labels in `domain.ts` | Unique `branch` values inside current organization scope | Organization | Narrows Generation/Unit population | Hide empty branch filter if no source-backed options | `mockCreators` today; must be replaced/reconciled |
| Generation / Unit | Creator | `creators.json` | Unique non-`NO` `groupKey` values inside current organization/branch scope | Organization, Branch | Filters matching creators by OR within selected group keys | Hide or disable zero-match options: `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` | `mockCreators` today; must be replaced/reconciled |
| Channel Type | Creator | `creators.json`; `domain.ts` | Source-backed distinct values, not closed enum alone | none | Filters creator-owned analytics rows | Options with zero current records must not look source-backed | `mockCreators` today |
| Lifecycle | Creator | `creators.json`; `domain.ts` | Source-backed distinct values; `retired` is a spec gap until roster contains it or product requires it | none | Filters creator-owned analytics rows | Zero-record options require human decision to hide/disable/show as future state | `mockCreators` today |
| Content Tags | Video/content | analytics Read API / mock stats | Distinct response values or explicit backend taxonomy | none | Filters video rows before widget aggregation | Zero-record options require defined hide/disable behavior | `mockVideoStats`; enum labels in `domain.ts` |
| Format | Video/content | analytics Read API / mock stats | Distinct response values or explicit backend taxonomy | none | Filters video rows before widget aggregation | Zero-record options require defined hide/disable behavior | `mockVideoStats`; enum labels in `domain.ts` |

## 6. Creator Taxonomy Matrix

| Dimension | Authoritative source | Source field | Current distinct values | Option derivation | Dependency |
| --- | --- | --- | --- | --- | --- |
| Organization | `creators.json` | `organization` | `hololive`, `vspo` | Unique values plus `All` sentinel | none |
| Branch | `creators.json` | `branch` | `holo_en`, `holo_id`, `holo_jp`, `vspo_en`, `vspo_jp` | Unique values scoped by Organization | Organization |
| Generation | none as separate dimension | none | none | `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` | Organization, Branch if created |
| Unit/group/project/wave | `creators.json` | `groupKey` | See roster audit | Unique non-`NO` values scoped by Organization/Branch | Organization, Branch |
| Lifecycle | `creators.json` | `lifecycleStage` | `active`, `graduated`, `pre_debut` | Unique values plus `All` sentinel | none |

## 7. Current Filter Option Audit

`All` is omitted from source-backed counts because it is a UI sentinel.

| Filter | Current UI option | Source-backed? | Matching record count | Correct action |
| --- | --- | ---: | ---: | --- |
| Organization | Hololive (`hololive`) | yes | 80 | KEEP |
| Organization | VSPO (`vspo`) | yes | 32 | KEEP |
| Branch | Hololive JP (`holo_jp`) | yes | 67 | KEEP |
| Branch | Hololive EN (`holo_en`) | yes | 19 | KEEP |
| Branch | Hololive ID (`holo_id`) | yes | 9 | KEEP |
| Branch | VSPO JP (`vspo_jp`) | yes | 25 | KEEP |
| Branch | VSPO EN (`vspo_en`) | yes | 7 | KEEP |
| Channel Type | Member (`member`) | yes | 103 | KEEP |
| Channel Type | Group (`group`) | yes | 7 | KEEP |
| Channel Type | Staff (`staff`) | yes | 2 | KEEP |
| Lifecycle | Active (`active`) | yes | 93 | KEEP |
| Lifecycle | Pre-debut (`pre_debut`) | yes | 2 | KEEP |
| Lifecycle | Graduated (`graduated`) | yes | 17 | KEEP |
| Lifecycle | Retired (`retired`) | no current roster record | 0 | SPEC GAP |
| Generation / Unit | `0期生` | yes | 5 | KEEP |
| Generation / Unit | `1期生` | yes | 8 | KEEP, but label spans JP and ID branches |
| Generation / Unit | `2期生` | yes | 8 | KEEP, but label spans JP and ID branches |
| Generation / Unit | `3期生` | yes | 8 | KEEP, but label spans JP and ID branches |
| Generation / Unit | `4期生` | yes | 5 | KEEP |
| Generation / Unit | `5期生` | yes | 5 | KEEP |
| Generation / Unit | `6期生` | yes | 5 | KEEP |
| Generation / Unit | `Advent` | yes | 4 | KEEP |
| Generation / Unit | `aNnounce` | yes | 1 | DO NOT EXPOSE; not in approved official category order |
| Generation / Unit | `aNounce` | no | 0 | REMOVE or REMAP to `aNnounce` only by human-approved mapping |
| Generation / Unit | `FLOWGLOW` | yes | 6 | KEEP |
| Generation / Unit | `FUWAMOCO` | yes | 1 | DO NOT EXPOSE separately; use `Advent` |
| Generation / Unit | `Justice` | yes | 4 | KEEP |
| Generation / Unit | `mekpark` | yes | 2 | DO NOT EXPOSE; not in approved official category order |
| Generation / Unit | `Myth` | yes | 5 | KEEP |
| Generation / Unit | `NO` | yes as placeholder | 32 | SPEC GAP: do not expose unless product defines it |
| Generation / Unit | `Promise` | yes | 5 | KEEP |
| Generation / Unit | `ReGLOSS` | yes | 6 | KEEP |
| Generation / Unit | `ゲーマーズ` | yes | 4 | KEEP |
| Content Tags | `valorant`, `sf6`, `karaoke`, `chat`, `gaming`, `collab`, `announcement`, `3d_live`, `clip`, `translation` | source-backed by current mock/domain | mock count varies | KEEP for mock; real API taxonomy must be verified |
| Format | `shorts`, `live_archive`, `normal_video`, `live_upcoming`, `live_now`, `premiere`, `unknown` | partially source-backed by current mock/domain | mock has `shorts`, `live_archive`, `normal_video`, `live_now` | SPEC GAP for zero-record real/API options |

## 8. Generation / Unit Reconciliation

Audit of options specifically called out by prior rendered Dashboard state:

| Current option | Matching creator count | Source-backed | Organization/Branch | Status |
| --- | ---: | --- | --- | --- |
| `1期生` | 8 | yes | hololive / holo_id, holo_jp | KEEP |
| `ゲーマーズ` | 4 | yes | hololive / holo_jp | KEEP |
| `3期生` | 8 | yes | hololive / holo_id, holo_jp | KEEP |
| `Myth` | 5 | yes | hololive / holo_en | KEEP |
| `0期生` | 5 | yes | hololive / holo_jp | KEEP |
| `2期生` | 8 | yes | hololive / holo_id, holo_jp | KEEP |
| `4期生` | 5 | yes | hololive / holo_jp | KEEP |
| `5期生` | 5 | yes | hololive / holo_jp | KEEP |
| `6期生` | 5 | yes | hololive / holo_jp | KEEP; display as `秘密結社holoX` |
| `ReGLOSS` | 6 | yes | hololive / holo_jp | KEEP |
| `FLOWGLOW` | 6 | yes | hololive / holo_jp | KEEP |
| `mekpark` | 2 | yes | hololive / holo_jp | DO NOT EXPOSE; not in the approved official category order |
| `aNounce` | 0 | no | none | REMOVE or REMAP |
| `Promise` | 5 | yes | hololive / holo_en | KEEP |
| `Advent` | 4 | yes | hololive / holo_en | KEEP |
| `FUWAMOCO` | 1 | yes | hololive / holo_en | DO NOT EXPOSE as a separate category; member remains under `Advent` |
| `Justice` | 4 | yes | hololive / holo_en | KEEP |

`aNounce` does not match roster data. The roster value is `aNnounce`.
Dashboard must not silently normalize or merge this spelling without an
explicit mapping table.

### 8.1 Official Hololive Category Order

Hololive classification and member-selector headings must follow the official
`所属タレント` order below. Render only entries backed by currently successful
Dashboard data; missing-data entries are continuation points and must not be
shown as selectable or disabled options.

```text
0期生
1期生
2期生
ホロライブゲーマーズ
3期生
4期生
5期生
秘密結社holoX
AREA15
holoro
holoh3ro
Myth
Project: HOPE
Council
Promise
Advent
Justice
ReGLOSS
FLOW GLOW
卒業生
holoAN
事務所スタッフ
```

`アソビ★まわり隊！` is intentionally excluded until source data exists.
Raw compatibility aliases may remain in data (`6期生`, `FLOWGLOW`, numbered
Hololive ID generations), but the UI must display the official labels above.

## 9. Filter Dependency Contract

Creator taxonomy dependency is:

```text
Organization -> Branch -> Generation / Unit
```

Rules:

- Organization options are derived from all creator records.
- Branch options are recalculated from creator records matching the selected
  Organization, or all records when Organization is `All`.
- Generation / Unit options are recalculated from records matching selected
  Organization and Branch.
- Generation / Unit is a Hololive-only taxonomy in the current product. Hide
  the entire control when Organization is VSPO or Branch is VSPO JP/VSPO EN,
  and clear any previously selected Hololive group values.
- The analytics Generation / Unit filter uses the full approved, roster-backed
  Hololive taxonomy. The comparison member selector separately limits creator
  rows to creators with successful analytics data; do not apply that narrower
  member eligibility rule to the taxonomy filter.
- Selecting a parent filter clears child selections that are no longer valid.
- Within Generation / Unit, selected values match by OR.
- Across dimensions, filters match by AND.
- A downstream option with zero matching creators in the current upstream
  population must not be presented as valid.
- Zero-match or no-successful-data downstream options are hidden. They are not
  rendered as selectable or disabled choices.

Every taxonomy option must be verifiable as:

```text
display label -> canonical source value -> matching creator IDs -> matching count
```

### 9.1 Analytics Filter Panel Presentation

The Dashboard classification filter and the comparison member selector are two
different product surfaces:

```text
classification filter = narrows analytics data shown by every widget
member selector = chooses creator series for one comparison-capable chart
```

The classification filter must not be presented as one undifferentiated wall
of chips. It must group controls by intent:

```text
Creator scope:
Organization -> Branch -> Generation / Unit
Channel Type
Lifecycle

Content scope:
Content Tags
Format
```

Required usability behavior:

- show a clear panel title and active-filter count
- provide one `Clear all`/`Reset filters` action
- preserve the dependency rules above
- use progressive disclosure or a responsive grouped layout when all options
  cannot remain easily scannable
- keep every selected state visible without relying on color alone
- do not use this panel to select comparison chart members
- do not duplicate the full member roster inside this panel

## 10. Label Mapping

Current stored value to label mappings from `domain.ts`:

| Stored value | UI label | Locale | Reason |
| --- | --- | --- | --- |
| `hololive` | Hololive | neutral | Display label |
| `vspo` | VSPO | neutral | Display label |
| `holo_jp` | Hololive JP | neutral | Display label |
| `holo_en` | Hololive EN | neutral | Display label |
| `holo_id` | Hololive ID | neutral | Display label |
| `vspo_jp` | VSPO JP | neutral | Display label |
| `vspo_en` | VSPO EN | neutral | Display label |
| `active` | 活動中 | current UI locale text | Display label only |
| `pre_debut` | 未出道 | current UI locale text | Display label only |
| `graduated` | 卒業 | current UI locale text | Display label only |
| `retired` | 引退 | current UI locale text | Display label only; zero current records |

No undocumented label normalization is allowed.

## 11. Layout Workspace Contract

Desktop Dashboard is a full application workspace. It must use the remaining
content width after application navigation/sidebar.

Required conceptual structure:

```text
| sidebar | normal gutter | Dashboard workspace ---------------- | gutter |
```

Prohibited:

```text
| sidebar | huge blank area | centered narrow Dashboard | huge blank area |
```

Dashboard must not inherit a Settings/readable-content max-width.

Future implementation reports must measure:

```text
viewportWidth
sidebarRight
dashboardLeft
dashboardRight
leftGutter
rightGutter
workspaceWidth
```

`looks full-width`, `appears aligned`, and screenshots without measurements are
not evidence.

## 12. Canonical Layout Contract

- Canonical widget/grid sizes are `1x1` through `3x3`.
- `4x4`, `5x5`, and any 4/5-row or 4/5-column canonical layout are not valid
  Dashboard sizes.
- GridStack's 12-column representation is an implementation detail only.
- Any third-party grid adapter must translate to/from canonical data and run the
  canonical validator.
- Widgets are not permanently bound to left/right/top/bottom regions.
- Valid movement must support both horizontal and vertical changes.
- For compatible same-size occupied positions, swap semantics are:

```text
A takes B's previous canonical x/y
B takes A's previous canonical x/y
sizes remain unchanged
```

Move acceptance evidence must include:

```text
widget ID
before x/y/w/h
after x/y/w/h
validator result
overlap result
persistence result
```

At least one horizontal and one vertical move must be verified in a browser.

## 13. Edit Layout -- Grid Reflow & Viewport Lock Contract

This contract is mandatory. Edit Layout is a canonical grid editor. Widgets
must always resolve against the visible dashed grid/cell positions. A
free-floating visual placement is not a valid Dashboard layout state.

### 13.1 Dashed Grid Positions Are Authoritative

During Edit Layout, the visible dashed grid positions are the valid placement
structure. A widget may visually follow the pointer while being dragged, but
the layout system must continuously resolve that drag against valid grid
positions.

The following states are prohibited during a resolved preview or after drop:

- dragged widget visually between left/right cells
- neighboring widgets frozen in their old cells beneath the dragged widget
- widgets overlapping each other
- dragged widget covering unrelated cells without a valid canonical placement
- layout detached from the dashed grid

### 13.2 Live Reflow Must Occur During Drag

When a dragged widget moves far enough into another valid grid position, the
surrounding layout must respond immediately. The user must see the valid reflow
before or when the target position becomes active; validating only the final
drop is insufficient.

For compatible same-size widgets:

```text
Initial:
| A | B |
| C | D |

Drag A across the midpoint toward B:
| B | A |
| C | D |
```

`A` targets `B`'s previous canonical position and `B` occupies `A`'s vacated
position. `A` must not float over `B` while `B` remains underneath it.

### 13.3 Horizontal Reflow

```text
Before:              Resolved preview:
A | B                B | A
```

For compatible occupied cells, the target widget must relocate automatically
to the valid vacated position according to canonical collision rules.

### 13.4 Vertical Reflow

```text
Before:              Resolved preview:
A                    C
C                    A
```

The lower widget must not remain underneath the dragged widget.

### 13.5 Multi-Widget Reflow

If a move affects more than one occupied grid position, the editor must produce
a valid deterministic reflow using the canonical layout and collision rules.
Every resolved preview state must have:

- no overlap
- no duplicated canonical position
- no widget outside the valid grid
- no widget between canonical cells
- no invalid saveable layout

Arbitrary absolute-position placement is prohibited.

### 13.6 Vacated Space Must Be Reused

When widget `A` leaves a valid position, that space becomes available to the
layout engine. If another widget can validly occupy it as part of reflow, it
must do so. The editor must not leave an unnecessary permanent hole while
displaced widgets are pushed into overlapping or off-grid positions.

### 13.7 Temporary Drag Layer

A temporary pointer-following drag representation may be used internally, but:

```text
pointer-following drag layer != canonical layout position
```

The canonical grid preview underneath must remain valid. A drag overlay must
not change document layout, create page height or width, push content, become
the persisted widget position, or suppress the valid placeholder/reflow state.

### 13.8 Final Drop and Cancellation

On pointer release, the widget must snap to a valid canonical grid position.
The following final states are prohibited:

- half-cell position
- floating between columns or rows
- overlap with another widget
- arbitrary pixel `x/y`
- position inconsistent with the dashed grid
- position inconsistent with canonical `x/y`

If no valid target exists, restore the previous valid layout. Never persist an
invalid intermediate state. Save must persist the validated canonical result;
Cancel must restore the pre-edit canonical layout.

### 13.9 Dragging Must Never Scroll the Page

Starting a widget drag must preserve the current viewport position. Dragging
alone must not change:

```text
window.scrollX
window.scrollY
document scroll position
Dashboard outer-scroll position
```

### 13.10 Pointer Movement Is Not Scroll Input

None of the following may scroll the page:

- pointer movement in any direction
- pointer reaching any viewport edge
- movement beyond the widget's original row
- GridStack reflow or placeholder movement
- collision resolution
- widget resize/move transform
- drag overlay movement

Automatic drag-edge scrolling is prohibited.

### 13.11 Only Explicit User Scroll Input May Move the Viewport

While Edit Layout is active, viewport movement is allowed only after explicit
user scroll input, such as a mouse-wheel action. Normal widget dragging must not
call or trigger behavior equivalent to:

```text
scrollIntoView()
window.scrollTo()
window.scrollBy()
automatic drag-edge scrolling
focus-induced scrolling
```

### 13.12 Scroll Position Must Be Preserved Across Drag

Record `scrollX_before` and `scrollY_before` at drag start. If the user does not
explicitly scroll during the drag:

```text
scrollX_after == scrollX_before
scrollY_after == scrollY_before
```

This invariant applies during pointer movement, grid reflow, collision
handling, drop, and drag cancellation.

### 13.13 Drag Must Not Expand the Document

Moving a widget must not temporarily make the page taller or wider. Prohibited
causes include:

- drag transform increasing document `scrollHeight`
- absolute-positioned widget increasing page bounds
- placeholder creating excessive rows
- GridStack temporary geometry expanding the page
- dragged element creating horizontal overflow
- body width/height changing because of the drag

The edit grid must retain its intended bounded geometry.

### 13.14 Mid-Grid Failure Mode

The following observed sequence is an explicit failure:

```text
drag widget into the middle of the layout
-> widget becomes positioned outside normal grid flow
-> document height or position changes
-> browser scrolls automatically
```

### 13.15 Required Horizontal Drag Test

With `A` left and `B` right, drag `A` across the midpoint toward `B`. Before
drop, verify:

```text
A target = right valid grid cell
B preview = left valid grid cell
A/B overlap = false
both aligned with dashed grid = true
```

After drop, verify that canonical positions are swapped.

The required concrete Dashboard fixture is:

```text
Before:
left  = Contribution
right = KPI

Contribution crosses the two-cell midpoint:
left preview  = KPI / deterministic displaced-widget result
right preview = Contribution target
overlap       = false
```

At the active midpoint preview, `Contribution` must not float between cells,
`KPI` must not remain underneath it, and the viewport must not move by even one
CSS pixel unless the user supplied explicit scroll input.

### 13.16 Required Vertical Drag Test

With `A` above `C`, drag `A` across the midpoint toward `C`. Before drop,
verify:

```text
A target = bottom valid grid cell
C preview = top valid grid cell
overlap = false
both aligned with dashed grid = true
```

After drop, verify the canonical positions.

### 13.17 Required Viewport-Lock Test

Before drag, record:

```text
window.scrollX
window.scrollY
document.documentElement.scrollHeight
document.documentElement.scrollWidth
```

Without wheel scrolling, drag horizontally, vertically, through the middle of
the layout, near the viewport bottom, and near the viewport top. At every drag
phase verify that `scrollX` and `scrollY` are unchanged and that the drag does
not expand the document.

### 13.18 Required Reflow Evidence

Implementation reports must include actual values:

```text
Widget A before: x, y, w, h
Widget B before: x, y, w, h
Drag target: x, y
Widget A preview: x, y
Widget B preview: x, y
Widget A after drop: x, y
Widget B after drop: x, y
overlap: true/false
validator result: PASS/FAIL
```

`dragging works` and `GridStack reflow works` are not evidence.

### 13.19 Required Viewport Evidence

Implementation reports must include:

```text
scrollX before:
scrollY before:
scrollX during horizontal drag:
scrollY during horizontal drag:
scrollX during vertical drag:
scrollY during vertical drag:
scrollX after drop:
scrollY after drop:
scrollHeight before/during/after:
scrollWidth before/during/after:
explicit wheel scroll performed: yes/no
```

For the no-wheel test, every corresponding scroll coordinate must remain
unchanged and document dimensions must not expand because of the drag.

### 13.20 Canonical Layout Still Wins

This contract does not bypass the canonical Dashboard model:

```text
valid canonical sizes = 1x1 through 3x3
GridStack = adapter/runtime editor only
saved layout = canonical x/y/w/h that passes the canonical validator
```

Do not persist GridStack pixel coordinates or 12-column coordinates directly as
the product layout model.

## 14. Widget Overflow Contract

Normal/default Dashboard widgets must display intended content fully.

Prohibited:

- internal vertical scrollbar
- clipped ranking content
- clipped chart content
- clipped KPI content
- using `overflow: hidden` to conceal missing content

Acceptance requires representative normal-state widgets to satisfy:

```text
scrollHeight <= clientHeight
```

For KPI, Growth, Contribution, and Ranking, future browser reports must include:

```text
clientHeight
scrollHeight
computed overflowY
scrollbar yes/no
content clipped yes/no
```

## 15. Settings Relationship

Settings is a visual-language reference only. Shared language includes:

- dark surface treatment where applicable
- typography scale
- control scale
- accent and selected states
- borders/radius language
- Ant Design usage where already established

Dashboard must not inherit Settings-specific:

- max-width
- centered layout
- roster dimensions
- Settings breakpoints

### 15.1 Dashboard and Settings Control Ownership

The Dashboard header is an operational analytics header, not a general
preferences bar.

The following controls are prohibited on the Dashboard:

```text
Time Zone selector
Theme selector
Upcoming display selector
Countdown language selector
```

Ownership is:

| Preference/control | Required owner | Dashboard behavior |
| --- | --- | --- |
| Theme | Settings | Apply saved preference; do not render selector. |
| Upcoming display | Settings | Apply saved preference to live/upcoming surfaces; do not render selector. |
| Countdown language | Settings, conditional on countdown mode | Do not render selector on Dashboard. |
| Reporting time zone | Login/profile preference when available; Settings/profile may expose an editor | Resolve automatically; no Dashboard selector. |
| Analytics period | Dashboard | Remains an operational Dashboard control. |
| Mock / Live source | Development environment only | Never expose in production UI. |

Moving Theme and Upcoming controls means moving their entry point only. Their
existing persisted user preference semantics must remain shared app-wide.

### 15.2 Automatic Time-Zone Resolution

Dashboard time zone must be resolved without a Dashboard selector, using this
strict precedence:

```text
1. authenticated user profile IANA time zone, when the login/profile model provides one
2. browser/device IANA time zone
3. UTC fallback only when neither source is valid
```

The current application has no authenticated location/time-zone profile
contract. Until that dependency exists, browser/device IANA time zone is the
authoritative fallback. Implementation must not invent a login-area value.

Use IANA identifiers such as `Asia/Tokyo` and `Asia/Hong_Kong`, not a raw fixed
offset as the stored identity. `GMT+9` and `GMT+8` are display descriptions,
not canonical time-zone values.

The Dashboard may display the resolved zone beside `Last updated` as
read-only metadata. It must not render an editable time-zone control.

### 15.3 Local 18:00 Refresh Boundary

Dashboard data refresh follows the resolved user's local civil time:

```text
Asia/Tokyo       -> refresh boundary at 18:00 Japan time (GMT+9)
Asia/Hong_Kong   -> refresh boundary at 18:00 Hong Kong time (GMT+8)
```

Mandatory behavior:

- calculate the boundary with the resolved IANA time zone
- when an open Dashboard crosses local `18:00`, request the newly available
  report once without requiring a page reload
- a Dashboard opened after local `18:00` requests the current local report
  period immediately
- before local `18:00`, use the latest completed report period defined by the
  data-source contract; do not guess future/unavailable data
- keep the previous successful cached data visible while refreshing
- failed refresh must expose stale/error state and must not erase valid cached
  data
- changing the resolved profile time zone must recompute the next boundary and
  cache/report key
- do not implement this requirement as one global UTC `18:00` refresh

The backend availability time and meaning of `reportDate` must be verified
before implementation. If the backend does not publish by each user's local
18:00, stop and reconcile the API/schedule contract rather than fabricating
freshness in the UI.

### 15.4 Development-Only Data Source Control

`Mock / Live` is a developer/QA control.

- It may render only when the build/runtime is explicitly a development
  environment.
- A configured API endpoint alone is not permission to show it in production.
- Production must use the production data-source policy automatically.
- Production must never silently fall back to mock analytics when live
  configuration is missing or fails; show the defined error/stale state.
- Mock data remains available to tests and development without appearing as a
  normal user preference.

For creator selection/management, the structural UI reference is:

```text
Settings -> Notification Settings -> Manage Members
```

Dashboard creator selection must reuse the established pattern:

- search
- Favorites first
- stable grouping
- avatar
- name
- selection state
- section headings
- separators
- compact roster layout

Reuse the information architecture and visual language, not Notification
Settings' notification semantics. Dashboard rows must not contain Live, New
Video, or reminder-time controls.

The comparison member selector must provide:

- search field at the top
- Favorites section first, without duplicate rows in normal groups
- Agency -> Region/Branch -> Generation/Unit hierarchy
- optional compact Agency/Region/Generation filters derived from the same
  authoritative roster
- creator avatar/initial and full display name
- explicit per-row selection control
- visible ordered-selection indicator for comparison series order
- dedicated drag affordance for a single creator
- selected-members summary/tray for multi-selection
- clear selection action
- empty-search and empty-filter states

The member selector may be a drawer, dialog, or bounded side panel, but it must
match the established Manage Members density and hierarchy. It must not become
a giant flat chip wall beneath the grid.

Do not use a giant flat creator-chip wall.

Favorites:

- appear first where this roster pattern requires it
- are not duplicated below
- do not alter eligibility
- do not equal selection state

Search:

- searches actual creator names
- shows matching creators only
- removes empty groups
- maintains stable group ordering
- preserves Favorites semantics

### 15.5 Member Selection and Drag Workflows

The same selector supports two compatible Dashboard workflows:

```text
Single creator:
drag one creator row/handle -> comparison-capable chart -> append creator

Multiple creators:
select A/B/C in order -> drag selected bundle to a comparison-capable chart
or open the selector from that chart and Apply -> chart receives A/B/C
```

Rules:

- selection click and drag initiation must be distinct interaction targets so
  beginning a drag does not accidentally toggle selection
- a bulk drag carries the ordered selected creator IDs, not a visual-only count
- the target preview must state whether one creator or multiple creators will
  be added
- duplicate IDs already present in the target chart are ignored/rejected
  deterministically without duplicating a series
- if only part of a bundle is eligible, the operation must not silently create
  an ambiguous partial result; accepted/rejected IDs must be explicit
- Cancel discards pending selector changes
- Apply writes to the invoking chart only
- saved canonical comparison state remains the source of truth

## 16. Comparison Contract

Each widget type must explicitly declare either:

```text
comparison-capable
non-comparison
```

Current comparison-capable widget type:

```text
creator-comparison-chart
```

Current non-comparison widget types:

```text
kpi-summary
growth-bar-chart
contribution-ring
ranking
insights
video-stats-table
```

During creator drag:

- comparison-capable widgets show valid target state, accept valid creators, and
  update the widget's comparison state
- non-comparison widgets do not show valid target state and do not accept drops
- normal UX must not be `drag -> drop -> Not a comparison chart`
- a selected multi-creator bundle follows the same target eligibility rules as
  a single creator
- target feedback states the incoming creator count

Comparison-capable charts require a `Select Creators` workflow:

```text
open
-> existing selected creators preselected
-> multiple selection
-> deselection
-> selected count
-> Apply
-> Cancel
-> reopen reflects committed state
```

Drag and Select Creators share one state:

```text
drag A -> open Select Creators -> A selected
select B/C -> Apply -> chart contains A/B/C
remove B -> reopen -> B absent
```

Bulk selection and drag also share that state:

```text
select A/B/C in roster order
-> drag selected bundle to comparison chart
-> chart state contains A/B/C in that order
-> open Select Creators
-> A/B/C are selected in the same order
```

No keyboard-specific Dashboard product mode is defined for drag/drop, widget
move/resize, or comparison. Standard accessibility remains required. Approved
copy:

```text
Drag a creator onto a comparison chart to add it. You can also use Select Creators to manage creators on that chart.
```

The phrase `keyboard-friendly alternative` is not approved Dashboard copy.

## 17. Mock Completeness Contract

Mock mode must support real feature testing with:

```text
0 production AWS dependency
0 production API dependency
0 external comparison service
0 CORS dependency
```

Minimum creator mock coverage must use existing real project creator records
and include at least two creators for every supported core creator group
confirmed by the authoritative roster, including:

```text
VSPO JP
VSPO EN
Hololive JP
Hololive EN
Hololive ID
```

Minimum favorite mock coverage:

```text
3 favorite creators across at least two valid source groups
```

Minimum normal Dashboard mock content:

| Area | Requirement |
| --- | --- |
| KPI | Total Views and Daily Gain |
| Growth | at least 7 points |
| Contribution | enough entities to prove documented composition behavior |
| Ranking | at least 5 rows |
| Comparison | at least 4 comparison-capable creators, at least 2 initially selected, visible series data |

Forbidden mock states:

```text
all zero values
all identical series
one creator only
one data point
empty comparison as normal state
disabled comparison as normal state
No data as normal state
```

## 18. Data Lineage Matrix

| Widget | Purpose | Source | Raw fields | Processing | Time/filter scope | Output data | Chart type | Why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Total Views | What is the total audience reach of the current filtered video set? | analytics cache from live API or `mockVideoStats` | `totalViews`, filter fields | Sum `totalViews` for filtered stats | Current report date/period/data source and all Dashboard filters except comparison | number | KPI | Single aggregate answer |
| Daily Gain | How many confirmed views were gained in the current filtered set? | analytics cache from live API or `mockVideoStats` | `dailyIncrease`, `status`, filter fields | Sum `dailyIncrease` for `status === "ok"` only | Current report date/period/data source and all Dashboard filters except comparison | number | KPI | Single aggregate answer |
| Growth | How is growth distributed over time or by channel for the filtered set? | `mockDailySeries` scaled by filtered/all daily gain ratio; `deriveChannelContribution` for channel mode | `dailyIncrease`, `date`, `channelName` | Day mode scales fixture series by ratio; channel mode uses top contribution values | Current filters; day mode uses filtered daily gain ratio | labeled numeric points | Bar chart | Compares magnitudes across discrete buckets |
| Contribution | Which channels account for positive daily growth in the filtered set? | `deriveChannelContribution(filteredStats)` | `channelId`, `channelName`, `dailyIncrease`, `status` | Sum by channel, discard non-positive net, percent of positive total, sort descending | Current filters and period label | channel contribution rows | `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` | Current ring encodes only top contributor while legend lists more; contract below prohibits that ambiguity |
| Ranking | Which videos rank highest by selected ranking metric? | filtered analytics rows | `totalViews`, `growthPercent`, `dailyIncrease`, `status`, `videoTitle` | Exclude non-`ok`, sort descending by selected metric, top 5 | Current filters and selected ranking type | ranked rows | Ordered list | Ranking is categorical order plus value, not a continuous chart |
| Comparison | How do selected creators compare on selected metric over the same period? | comparison backend source or injected mock source | ordered `creatorIds`, `comparisonItemIds`, series points | Request in selected order; render one series per ok creator; preserve unavailable/error states | Comparison selection plus backend report date/time zone | ordered series per creator | Multi-series line chart | Compares trajectories between creators |

## 19. Data Processing Contract

For every widget, implementation reports must show:

```text
raw data -> filters -> time range -> entity selection -> aggregation -> formula -> sorting -> rounding -> output
```

Current formulas:

| Metric | Formula |
| --- | --- |
| Total Views | `sum(filteredStats.totalViews)` |
| Daily Gain | `sum(filteredStats where status == "ok" of dailyIncrease)` |
| Average Growth Rate | `average(growthPercent)` for `status == "ok"` and non-null `growthPercent` |
| Top Performer | `ok` stat with greatest `dailyIncrease` |
| Contribution channel daily increase | `sum(ok dailyIncrease)` by `channelId`; remove channels with net `<= 0` |
| Contribution percent | `channelPositiveDailyIncrease / totalPositiveDailyIncrease * 100` |
| Ranking Trending | Current code uses `dailyIncrease`; repository says it mirrors backend `src/trending.py`, but a product-level trending algorithm is not otherwise documented. |
| Ranking Most Viewed | `totalViews` descending |
| Ranking Fastest Growing | `growthPercent` descending, non-null only |

Trending requires explicit product confirmation:

```text
SPECIFICATION GAP -- HUMAN DECISION REQUIRED
```

## 20. Filter -> Widget Effect Matrix

Each cell states whether/how the filter applies.

| Filter | KPI | Growth | Contribution | Ranking | Comparison |
| --- | --- | --- | --- | --- | --- |
| Date range / period | Yes, before aggregation via analytics source/scaling | Yes, before chart input | Yes, before percent denominator and label | Yes, before ranking source rows | Yes, request context if backend supports it |
| Organization | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No, except roster eligibility if product defines it |
| Branch | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No, except roster eligibility if product defines it |
| Generation / Unit | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No, except roster eligibility if product defines it |
| Channel Type | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No, except roster eligibility if product defines it |
| Lifecycle | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No, except roster eligibility if product defines it |
| Content Tags | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No |
| Format | Yes, before aggregation | Yes, before chart input | Yes, before denominator | Yes, before sorting | No |
| Creator comparison selection | No | No | No | No | Yes, defines series population |
| Data source | Yes, selects raw source before filtering | Yes | Yes | Yes | Comparison has independent source boundary |

## 21. Chart Visual-Encoding Matrix

| Chart | Entity | Displayed value | Visual element | Legend mapping | Summary/center meaning |
| --- | --- | --- | --- | --- | --- |
| KPI / Total Views | Filtered video set | Sum of views | Text value | none | none |
| KPI / Daily Gain | Filtered ok video set | Sum of daily gain | Text value | none | none |
| Growth bar | Day or channel bucket | Growth value | One bar per bucket | X-axis labels; no separate legend | none |
| Contribution | Channel/member contribution entity | Percent and daily increase | Must be one visible segment/bar/gauge element per chart entity | Every legend item must map to a visual element | If present, center value must identify exactly which entity/total it represents |
| Ranking | Video | Ranking metric | Ordered row with rank and value | none | none |
| Comparison | Selected creator | Series values | One line/series per ok selected creator | Legend entry per rendered series in selected order | none |

## 22. Contribution Contract

Current implementation renders one radial bar for the top contributor while also
listing up to four contributors in the legend. That state is not an acceptable
multi-member composition chart because text rows B/C/D do not have corresponding
visual segments.

Authoritative contract:

```text
purpose: Which channels account for positive daily growth in the current filtered set?
source: deriveChannelContribution(filteredStats)
metric: positive net dailyIncrease by channel
population: channels in filtered stats with status ok and net dailyIncrease > 0
numerator: one channel's positive net dailyIncrease
denominator: total positive net dailyIncrease across the population
percentage: numerator / denominator * 100
rounding: display to 1 decimal place; calculations use unrounded numbers
chart type: SPECIFICATION GAP -- HUMAN DECISION REQUIRED
why: depends on selected chart type
segment meaning: if multi-member composition, one segment per contributor
legend meaning: every legend row maps to one visual entity
center value: if shown, must state exactly whose/what value it is
Top-N behavior: SPECIFICATION GAP -- HUMAN DECISION REQUIRED
Other/remainder behavior: required if Top-N omits any population member
```

Allowed semantic choices, pending human decision:

- complete composition breakdown
- Top-N composition breakdown with explicit `Other`
- single selected-creator share gauge
- another explicitly defined metric

If Contribution is a multi-member composition chart:

- every contributor represented in the legend must have a corresponding visual
  segment
- every segment must have a legend identity
- represented total must be approximately 100%, allowing only documented
  rounding
- if Top-N is used, `Other` or explicit Top-N-only presentation is required

### Contribution Worked Example

Example input:

```text
Creator A dailyIncrease 600
Creator B dailyIncrease 175
Creator C dailyIncrease 95
Creator D dailyIncrease 89
total positive dailyIncrease 959
```

Processed member values:

```text
A = 600 / 959 * 100 = 62.6%
B = 175 / 959 * 100 = 18.2%
C = 95 / 959 * 100 = 9.9%
D = 89 / 959 * 100 = 9.3%
```

For a complete composition chart:

```text
chart data: [A 62.6, B 18.2, C 9.9, D 9.3]
legend: A, B, C, D
expected visual entities: 4 segments/bars/arcs
```

The chart fails if only A has a visible arc while B/C/D appear only as text.

## 23. Growth Contract

```text
purpose: How does the current filtered growth compare across days or channels?
source: DashboardPage byDay/byChannel inputs
x-axis: day label in day mode; channel label in channel mode
y-axis: growth value
interval: day mode uses the fixture/current period series; channel mode uses current filtered channel totals
point/bar meaning: one bar equals one bucket's value
tooltip: bucket label and formatted numeric value
missing-period behavior: SPECIFICATION GAP -- HUMAN DECISION REQUIRED for real API gaps
filters: Dashboard filters apply before chart input construction
```

## 24. Ranking Contract

| Mode | Metric | Sort key | Sort direction | Tie rule | Displayed value | Source | Filters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Trending | Current code uses daily increase | `dailyIncrease` | descending | `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` | signed compact number | filtered analytics rows | before sorting |
| Most Viewed | Total views | `totalViews` | descending | `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` | compact number | filtered analytics rows | before sorting |
| Fastest Growing | Growth percent | `growthPercent` | descending | `SPECIFICATION GAP -- HUMAN DECISION REQUIRED` | percent badge | filtered analytics rows | before sorting |

Non-`ok` rows are excluded. Rows with null metric are excluded.

## 25. Comparison Data Contract

```text
selected creator source: widget.comparison.creatorIds
minimum count: 2 before starting comparison workflow
maximum count: SPECIFICATION GAP -- HUMAN DECISION REQUIRED unless backend/product defines it
data source: ComparisonSource boundary; production is backendComparisonSource
one series meaning: one selected creator's metric over response points
x-axis: response point label
y-axis: response point value
legend identity: selected creator display name resolved from roster, in selected order
missing-data behavior: preserve selected creator and show unavailable/error/empty state without fabricated data
```

Required mapping:

```text
selected creator IDs
<-> comparison dataset creator IDs
<-> rendered series
<-> legend identities
```

The backend boundary maps frontend roster IDs prefixed with `ch_` to bare backend
creator IDs. This mapping must remain explicit at the network boundary.

## 26. Browser/Test Acceptance Contract

Source inspection alone is never enough for visual behavior. Future
implementation tasks require real browser evidence for:

- workspace width
- widget overflow
- horizontal move
- vertical move
- live horizontal and vertical reflow before drop
- dashed-grid alignment throughout resolved drag preview
- viewport lock with no wheel input
- no drag-edge auto-scroll
- no document expansion during drag
- creator taxonomy rendering
- creator search
- Notification-style Favorites/Agency/Region/Generation member grouping
- valid comparison drop
- invalid comparison target
- multi-select
- ordered multi-creator bundle drop
- Theme, Upcoming, and Time Zone selectors absent from Dashboard
- Theme and Upcoming preferences present in Settings
- Mock / Live control absent from production and present only in development
- resolved IANA time zone and local 18:00 refresh-boundary behavior
- chart entity rendering
- member/percentage mapping

Filter browser verification must test at least:

```text
Organization = VSPO
Organization = Hololive
one Branch within each
one generation/unit option backed by real source data
```

For each state report:

```text
displayed options
expected options from source
unexpected options
missing options
matching creator count
```

Expected:

```text
unexpected = 0
missing = 0
```

Member-selector browser verification must prove:

```text
Favorites visible first and not duplicated
search removes non-matches and empty headings
Agency/Region/Generation ordering matches source
single-creator drag carries one creator ID
ordered multi-selection A/B/C carries A/B/C
comparison target receives A/B/C in order
non-comparison target receives nothing
Cancel preserves prior chart state
```

Control-ownership verification must run both development and production
build/runtime conditions. Report whether each Dashboard control is present and
the Settings location for Theme and Upcoming preferences.

Time-zone verification must use a controllable clock/profile seam and test at
least:

| Resolved zone | Before boundary | Boundary | Required result |
| --- | --- | --- | --- |
| `Asia/Tokyo` | 17:59 local | 18:00 local | one refresh for Japan-local report key |
| `Asia/Hong_Kong` | 17:59 local | 18:00 local | one refresh for Hong-Kong-local report key |

The test must report resolved source (`profile`, `browser`, or `UTC fallback`),
IANA zone, local clock, report/cache key before and after, request count, and
whether cached data remained visible during refresh.

Contribution browser verification must report:

| Member | Expected value/% | Displayed value/% | Visual segment exists | Legend mapping correct |
| --- | --- | --- | --- | --- |

AI may report measured facts. AI must not declare:

```text
looks good
matches Settings
visually approved
Dashboard complete
```

Final visual acceptance belongs to the user.

## 27. Existing Conflicts Removed

| Previous ambiguity/conflict | New authoritative rule |
| --- | --- |
| 4x4/5x5 sizes appeared as possible layouts | Canonical Dashboard contract is `1x1` through `3x3`; 4/5 sizes are invalid legacy/recovery cases only. |
| Dashboard could inherit centered Settings layout | Dashboard is a full-width application workspace and must be measured. |
| Internal widget scrollbars could be accepted | Normal widgets must satisfy `scrollHeight <= clientHeight`; no hidden clipping. |
| Widgets could be region-locked | Widgets are not left/right/top/bottom locked; horizontal and vertical movement are required. |
| Grid drag could float widgets, overlap occupied cells, or move the viewport | Resolved drag previews must reflow into canonical dashed-grid positions; no overlap, auto-scroll, or drag-induced document expansion is allowed. |
| Keyboard-specific drag/drop product mode | No keyboard-specific Dashboard product mode; ordinary accessibility still required. |
| Giant flat creator roster | Notification Settings Manage Members is the structural reference; Dashboard adds selection order and drag affordances without notification switches. |
| Analytics filters and comparison-member selection could be conflated | Analytics filters narrow all widget data; the Notification-style member selector configures one comparison chart. |
| Theme, Upcoming, and Time Zone selectors appeared in Dashboard header | Theme and Upcoming belong to Settings; time zone resolves automatically from profile/browser and is read-only on Dashboard. |
| Mock / Live appeared as a user-facing production preference | The switch is development-only; production follows automatic live-source policy and never silently uses mock data. |
| Refresh used one global clock or required manual time-zone selection | Refresh boundary is each resolved IANA zone's local 18:00, with cached-data preservation and explicit backend schedule validation. |
| Hardcoded taxonomy | Options must be derived from authoritative source records or flagged. |
| Undefined generation/unit meaning | `groupKey` is current source but heterogeneous; human taxonomy decision required. |
| Invalid comparison drop after-the-fact error | Non-comparison widgets must not present valid targets or accept drops. |
| Insufficient mock data | Mock mode must exercise all documented features without production dependencies. |
| Chart component existence as justification | Every chart needs purpose, data lineage, visual encoding, and acceptance. |
| Percentages without geometry mapping | Every displayed chart entity/value must map to a visual element. |
| Test-only completion | Browser evidence is required for visual/interaction behavior. |

## 28. Specification Gaps

Open questions that must not be resolved by implementation agents:

- Whether `groupKey` should remain one combined `Generation / Unit` filter or be
  split into generation/unit/project/team/wave/group dimensions.
- Whether downstream zero-match filter options should be hidden or disabled.
- Whether `NO` should ever be shown as a filter option.
- Whether `retired` should be visible despite zero current records.
- Real API taxonomy for content tags and formats.
- Tie rules for all ranking modes.
- Product definition of `Trending` beyond current daily-increase code.
- Contribution chart type and Top-N/Other behavior.
- Maximum creator count for comparison.
- Backend publication schedule and `reportDate` meaning relative to each
  user's local 18:00 boundary.
- Authenticated profile field/API for an authoritative user IANA time zone;
  browser/device resolution remains the fallback until it exists.
- Product policy for an ordered multi-creator bundle when only a subset is
  eligible or within the chart's maximum creator count.
- Avatar source for roster UI.
- Favorite identity key contract for Dashboard use.
- Missing-period behavior for Growth in real API data.
