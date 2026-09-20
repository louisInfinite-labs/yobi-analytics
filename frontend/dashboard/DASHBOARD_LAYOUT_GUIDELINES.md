# Dashboard Layout Development Guidelines

This document defines the Dashboard-specific layout rules for `frontend/dashboard`.

Any Dashboard layout implementation, redesign, migration, or refactor must follow both:

1. The shared frontend rules in [`AGENTS.md`](./AGENTS.md).
2. The Dashboard-specific rules in this document.

If the rules conflict, use the priority order defined in `AGENTS.md`. A stricter rule that prevents invalid layouts, data loss, or silent user-facing changes should be preferred and documented in the pull request.

Implementation must be executed through the objective microtasks in [`DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md`](./DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md). An agent must not declare a microtask complete from personal visual judgment or build success alone.

## 0. UI Libraries and Visual Style Contract

### 0.1 Approved stack and transition state

The frontend target is a coordinated **Mantine + Ant Design** UI stack. The Settings work that establishes the Mantine integration is currently on an unmerged branch, while this Dashboard branch already uses Ant Design.

- Until the Settings branch is merged, Dashboard work must continue to use the dependencies and shared components available on the current branch. Do not add a separate Mantine installation, provider, theme, reset, or token set solely for a Dashboard microtask.
- After the Settings branch is merged, Dashboard work must reuse its exact Mantine version, root provider, theme, tokens, and shared components. Do not create a second Dashboard-specific Mantine provider or theme.
- Existing Ant Design components may remain Ant Design. Do not migrate an existing component between Mantine and Ant Design as an incidental part of the layout rebuild.
- New or modified controls must follow the owning feature's established component pattern. Do not mix Mantine and Ant Design inside one control merely to reproduce styling that the owning library already supports.
- When the two libraries offer equivalent components, first reuse an existing project shared component. If none exists, follow the convention already used by the surrounding feature. Do not choose a library from personal preference.
- If a required interaction would introduce a new cross-library pattern, stop and request an explicit component-ownership decision before implementation.

The current Dashboard package provides these implementation libraries:

| Responsibility | Approved library or source |
| --- | --- |
| Settings-aligned UI after its branch is merged | Mantine, using the merged Settings provider and theme only |
| Existing Dashboard UI and controls | Ant Design (`antd`) |
| Existing Ant Design icons | `@ant-design/icons` |
| Existing Lucide icons | `lucide-react`; reuse only where the surrounding feature already uses it |
| Dashboard charts | Recharts (`recharts`) and the existing shared chart components |
| Existing grid runtime | GridStack (`gridstack`) |
| Existing drag-and-drop interactions | `@dnd-kit/core` where already used or explicitly assigned by a microtask |
| Dashboard-specific geometry | Existing scoped CSS and project design tokens |

GridStack's current 12-column representation is an implementation detail. It must not replace or weaken the canonical `1x1` through `3x3` Dashboard contract defined below. Any GridStack adapter must translate to and from canonical layout data and run the canonical validator.

Recharts is the approved chart implementation for this Dashboard. Reuse existing chart components, tooltip conventions, legends, colors, and responsive containers. Do not introduce another chart library or create a parallel chart abstraction during the layout rebuild.

### 0.2 Visual consistency

- The merged Settings theme and shared application tokens are the visual source of truth once available. Before that merge, preserve the current Dashboard theme and structure so that the later integration remains a controlled change.
- Use shared tokens or CSS variables for typography, semantic colors, spacing, borders, radii, shadows, focus states, disabled states, and z-index layers. Do not create a separate Dashboard-only visual language.
- A component keeps the interaction, loading, disabled, error, focus, and accessibility behavior of its owning UI library unless a shared wrapper explicitly standardizes it.
- Custom CSS is allowed for Dashboard-only geometry and editor behavior that the component libraries do not provide, including grid tracks, insertion slots, resize handles, drag previews, and dashed edit guides.
- Custom CSS must be feature-scoped and must not globally override Mantine or Ant Design selectors, resets, portals, overlays, or theme variables.
- The editor's dashed guide is an overlay inside the existing widget border box. It must not add margin, padding, gap, width, or height, and must preserve the `16px` final spacing contract.
- Icon-only actions require an accessible name and tooltip. Do not communicate selection, validity, comparison order, or drag state by color alone.

### 0.3 Dependency and review rules

- Do not add, replace, remove, or upgrade a UI, chart, icon, grid, or drag-and-drop dependency unless a microtask explicitly authorizes it.
- A proposed library change requires an approved architecture decision covering ownership, provider placement, theme integration, bundle impact, migration scope, compatibility risk, and rollback.
- Report shared-component, library, custom-CSS, dependency, or provider details only when the current microtask changed them or when they are necessary to prove an acceptance criterion. Always report any dependency or provider change explicitly.
- Visual evidence must cover the affected view mode, edit mode, dialog/overlay state, and supported breakpoints. Passing TypeScript or unit tests alone is not visual verification.

### 0.4 Lean microtask execution

Dashboard requirements in this document define the complete product contract. They do not require every microtask to reimplement, retest, or rereport the complete contract.

For normal microtasks:

- Change only the code required by the owning microtask's acceptance criteria.
- Prefer the smallest correct production diff.
- Do not add unnecessary comments, docstrings, helpers, wrappers, abstractions, refactors, or future-proofing structures.
- Test detailed behavior at the lowest owning layer. Higher layers should test only the integration behavior or risk they uniquely own.
- Do not repeat the same detailed test matrix across canonical state, component, integration, and E2E layers unless a distinct integration risk requires it.
- Run only the targeted validation required by the owning microtask and the shared frontend rules.
- Do not run the complete Section 13 test matrix after each microtask.
- Broader regression, production build, complete visual verification, and the full acceptance matrix belong to the documented final/commit checkpoints, especially MT-17.
- Successful validation reports should contain only concise command/result evidence, not full successful logs.
- Do not repeat already-accepted lower-layer behavior in a microtask report unless it is necessary to explain a regression, failure, or dependency.

## 1. Goals

The Dashboard layout must be predictable, validated, reversible, and free of overlapping widgets.

Required outcomes:

- Widgets never overlap or render outside the Dashboard boundary.
- A Dashboard cannot contain duplicate widget instances.
- The editor clearly shows grid lines, available insertion slots, and the pending layout.
- Widget coordinates and sizes use defined grid units rather than arbitrary pixel values.
- Invalid gaps such as `0.25X` cannot be created.
- Editing uses an isolated draft. The saved layout is not changed until the user explicitly saves.
- Any action that will force existing widgets to change size, proportion, or position requires a clear confirmation before it is committed.

## 2. Terminology

- `X`: the full height of one standard layout row.
- `0.5X`: half of one standard row height.
- `columns x rows`: the dimensions of the editable Dashboard grid.
- `2x2`: two columns and two rows.
- `1x1` to `3x3`: the supported custom grid range. Both values must be integers from 1 through 3.
- `canonicalLayout`: the current saved layout.
- `draftLayout`: the isolated layout used while the editor is open.
- `insertion slot`: an explicit drop target between widgets or at the beginning/end of a row or column.
- `chart catalog`: the list of chart definitions returned by the backend that the user is allowed to add.
- `widgetId`: the stable identifier of one widget instance.
- `widgetType`: the chart or widget definition. Multiple instances may share a type when the product allows it.

Grid dimensions and widget height units are separate concepts. For example, a `3x2` grid may contain widgets whose individual heights are `1X` or `0.5X`.

## 3. Dashboard Initialization

### 3.1 Default layout

- A new Dashboard, or a Dashboard without a saved layout, starts with a `2x2` grid.
- The default grid displays the product-defined default number of charts.
- Default chart types and ordering must come from an explicit configuration. They must not change because the backend returned items in a different order.
- A valid saved user layout takes precedence over the default. Loading the page must not overwrite it with `2x2`.
- Default widgets must have unique `widgetId` values and must pass the same validation as user-added widgets.

### 3.2 Chart catalog source

The backend chart catalog endpoint is the source of truth for charts that can be added.

- Do not maintain a separate hard-coded frontend list that can drift from the backend.
- A chart not returned by the backend must not appear in the add-widget UI.
- A new chart returned by the backend should become available on the next valid catalog load without requiring a hard-coded list update.
- Each catalog item must have a stable chart definition identifier.
- Adding a catalog item to the Dashboard creates a widget instance with a separate, unique `widgetId`.

### 3.3 Load exactly once per Dashboard page lifecycle

1. Load the chart catalog once when the Dashboard page is initially loaded or explicitly reloaded.
2. Store the result in the existing page-level store or query cache.
3. View mode and edit mode must use the same cached result.
4. Clicking **Edit** must only switch local UI state. It must not call the chart catalog endpoint again.
5. Repeatedly opening and closing the editor in the same page lifecycle must not cause additional catalog requests.
6. A new request is allowed only after an explicit refresh/retry, a full page reload, or expiration under the project's existing cache policy.
7. Prevent duplicate requests caused by React Strict Mode, repeated effects, or concurrent rendering by using the project's existing cache or request-deduplication mechanism.

Loading and error behavior:

- Show a loading state during the initial catalog request.
- Do not display “no charts available” while the request is still pending.
- A catalog error must not remove widgets already present in the saved layout.
- Provide an explicit retry action after an error.
- Show an empty state when the backend successfully returns an empty catalog.

### 3.4 Creator comparison from the Creator List

Creator comparison must use creators from the existing Creator List. Users must be able to configure comparisons such as:

- `A vs B`
- `A vs B vs C`
- Additional creators up to an explicit product or backend limit

Do not require users to manually enter creator names or IDs in the Dashboard.

Selection rules:

- Use the Creator List's existing data source, permissions, filtering, and stable ordering.
- Identify every selected creator by stable `creatorId`, never by display name or array index.
- Require at least two distinct creators before enabling the comparison action.
- Do not invent a maximum selection count. Use an explicit product or backend limit when one exists.
- Do not derive the number of comparable creators from the number of chart widgets currently placed on the Dashboard.
- Creator count and comparison-item count are independent: creators become data series, while comparison items determine which charts are required.
- Reject duplicate `creatorId` values.
- Preserve creator order by click order. The first creator clicked is order 1, the second is order 2, and so on.
- Display the selection order as a circular ordinal badge at the top-right of each selected creator avatar: `①`, `②`, `③`, and so on.
- Use a rendered numeric badge for larger values rather than depending on the availability of Unicode circled-number characters.
- If a creator is deselected, renumber the remaining creators consecutively while preserving their relative click order.
- If a deselected creator is selected again, append that creator to the end of the order.
- Use the same creator order for request parameters, chart series, legends, tooltips, and the saved widget configuration.
- Filtering or searching the Creator List must not silently remove an already selected creator.
- A creator the current user cannot access must not appear as a selectable comparison candidate.
- The order badge must have an accessible label such as “Comparison order 1”; do not communicate the order visually only.

The comparison configuration must use stable IDs:

```ts
type CreatorComparisonConfig = {
  creatorIds: string[]; // ordered, unique, minimum length: 2
  comparisonItemIds: string[]; // ordered, unique backend-supported items
};
```

#### Flow 1: Open the Creator List from a chart widget

1. A comparison-capable chart widget must expose a clear action such as **Select Creators** or **Edit Comparison**.
2. The action opens the existing Creator List using the project's established dialog, drawer, or panel pattern.
3. The list must show which creators are already included in the widget.
4. The user can select A and B, or A, B, and C, and continue adding creators until the documented limit is reached.
5. The creator avatar badges must immediately show the current click order.
6. Apply the confirmed selection to that widget's `draftLayout` configuration.
7. Closing or cancelling the picker must preserve the widget's previous creator selection.
8. Changing the selected creators must not immediately save `canonicalLayout`.

#### Flow 2: Start from the Creator List and automatically add required charts

1. The user opens the Creator List before selecting a target widget.
2. The user selects creators in the desired comparison order.
3. The user selects one or more backend-supported comparison items, such as the metrics or chart definitions to compare.
4. The **Save** action remains disabled until at least two distinct creators and at least one valid comparison item are selected.
5. Before saving, sort the current widget containers into deterministic visual row-major order: top to bottom, then left to right.
6. Define the top-left widget as `widget[0]`. Do not rely on incidental array or API response order.
7. Assign the first selected comparison item to `widget[0]`, the second item to `widget[1]`, and continue in selected comparison-item order.
8. When reusing an existing widget container, preserve its `widgetId`, grid coordinates, width, and height. Update only the chart definition and comparison configuration required by this operation.
9. Show a mapping preview before saving so the user can see which existing widget containers will display each selected comparison item.
10. If fewer comparison items are selected than existing widget containers, leave every unassigned widget unchanged.
11. If more comparison items are selected than existing widget containers, append exactly the missing number of chart widgets after the existing visual sequence.
12. Every newly appended widget must receive a unique `widgetId`.
13. Place appended widgets into the next valid unoccupied slots without moving or resizing existing widgets.
14. If the Dashboard has no valid capacity for all missing charts, keep **Save** disabled and explain the capacity problem. Do not force existing widgets to move.
15. Apply the same ordered `creatorIds` to every chart assigned or appended by this operation.
16. Clicking **Save** in this dialog is the explicit commit action for the comparison transaction. Validate and persist the assigned and appended charts atomically.
17. The comparison dialog save must not accidentally commit unrelated Dashboard draft changes.
18. Close the dialog only after the comparison save succeeds.
19. Immediately render the requested charts in their assigned widget containers after the dialog closes. Do not require a page reload, a second Dashboard save, or manual widget movement.
20. If chart data is still loading, render the chart container and its loading state immediately.
21. If the save fails, keep the dialog open, show an actionable error, and leave the Dashboard unchanged.

Example:

```text
Selected creators: A①, B②, C③
Selected comparison items: Revenue, Engagement, Growth

Existing widget containers in visual order:
- widget[0] at the top-left
- widget[1] next to widget[0]

Save result:
- widget[0] displays Revenue for A, B, C
- widget[1] displays Engagement for A, B, C
- Append one new widget for Growth after the existing widgets
- Do not move or resize widget[0] or widget[1]
- Close the dialog and show all three charts immediately
```

#### Flow 3: Drag a creator cell from the Creator List into a chart widget

1. The user may open the Creator List first and drag a creator cell onto a comparison-capable chart widget.
2. During drag, compatible chart widgets must show a clear active drop target.
3. Incompatible chart widgets must show a disabled drop target and must reject the drop.
4. The drag payload must use the creator's stable `creatorId`; do not use display text as identity.
5. Dropping creator B onto a widget containing A prepares `A vs B`.
6. Dropping creator C onto a widget containing A and B prepares `A vs B vs C`.
7. Dropping a creator already present in the widget must not create a duplicate series or duplicate `creatorId`.
8. A newly dropped creator is appended to the end of the creator order and receives the next order badge.
9. A successful drop updates only the widget configuration in `draftLayout`.
10. Dragging a creator cell must not remove, reorder, or mutate the source Creator List.
11. Cancelling the drag or leaving the widget drop target must leave the widget unchanged.

Shared comparison behavior:

- A comparison widget must have its own unique `widgetId`.
- Flow 1 and Flow 3 update the draft editor and use the normal Dashboard save flow.
- Flow 2 uses its own explicit dialog **Save** as the atomic persistence boundary.
- Automatically appended Flow 2 widgets still follow boundary, collision, size, and capacity validation.
- Do not change the application's current/active creator merely because a creator was selected or dropped for comparison.
- If multiple comparison widgets are allowed, every instance must have a different `widgetId`, even when their selected creator sets are identical.
- The chart must clearly distinguish every selected creator using the project's existing series, legend, tooltip, and accessibility patterns.

Comparison data:

- Request comparison data using the selected stable `creatorId` values and the backend's documented contract.
- Load available comparison items from a backend-supported definition or existing catalog. Do not invent frontend-only items.
- Do not fabricate missing creators, metrics, time ranges, or values in the frontend.
- Show loading, partial-error, full-error, and empty states without destroying the widget configuration.
- If a previously selected creator becomes unavailable, show an actionable unavailable state and preserve the remaining valid selections.
- The Creator List selection and the resulting comparison widget configuration must survive the transition into edit mode without re-fetching the chart catalog.

## 4. Widget Identity and Duplicate Prevention

Every widget instance must have a stable and unique `widgetId`.

Mandatory rules:

1. Create the `widgetId` when the widget instance is created.
2. Preserve it during drag, resize, save, load, responsive reflow, and migration.
3. Enforce uniqueness in the frontend state layer and again before an API submission.
4. The backend or persistence layer must also reject duplicate instance IDs.
5. Never silently overwrite an existing instance when a duplicate ID is detected.
6. Two widgets may share `widgetType` only when they have different `widgetId` values.
7. React lists must use `widgetId` as the key. Do not use the array index.
8. Rapid repeated clicks on Add must not create the same instance more than once.

Recommended model:

```ts
type DashboardWidget = {
  widgetId: string;
  widgetType: string;
  x: number;
  y: number;
  width: number;
  height: 0.5 | 1;
};
```

## 5. Supported Grid and Widget Sizes

### 5.1 Custom grid range

Users may select a grid from `1x1` through `3x3`.

- Column count and row count must both be integers from 1 through 3.
- Reject invalid values such as `0x3`, `2.5x2`, `4x3`, `3x4`, `4x4`, `5x5`, or `6x5`. `4x4` and `5x5` are not supported product configurations.
- Show the target column count, row count, and grid preview before applying a manual grid-size change.
- An empty Dashboard may apply a valid grid size directly.
- A Dashboard containing widgets must follow the confirmation rules in Section 8 when a grid change will alter those widgets.

### 5.2 Widget height

Supported widget heights are:

- One `1X` widget; or
- Two vertically stacked `0.5X` widgets.

Unsupported heights include `0.25X`, `0.75X`, `1.25X`, and any arbitrary pixel height.

Every column segment representing one full row must be filled by either:

- `1X`; or
- `0.5X + 0.5X`.

Do not allow:

- `0.75X` plus an unusable `0.25X` gap.
- A lone `0.5X` widget with an unexplained, unusable half-row.
- Empty DOM elements, margins, or absolute-positioning hacks that imitate a filled slot.
- A resize that pushes another widget into an overlap or outside the Dashboard.

### 5.3 Exact 16px spacing contract

The final visible separation between neighboring Dashboard elements must be exactly `16px`. It must never become `16px + 16px = 32px`.

Adjacent widgets:

- Each widget contributes `8px` on the edge facing the neighboring widget.
- Two facing `8px` contributions produce one `16px` visual gap.
- This rule applies horizontally and vertically.
- Use a non-collapsing layout model so vertical margins cannot collapse into an unexpected value.
- Grid placeholders, drag previews, and the saved layout must use the same spacing calculation.

Widget next to a non-widget component:

- The layout owner must know the spacing contribution of both sides. Do not guess.
- The required equation is `widgetContribution + componentContribution = 16px`.
- If the neighboring component contributes `0px`, the widget-facing side must contribute the full `16px`.
- If the neighboring component contributes `8px`, the widget-facing side contributes `8px`.
- Never apply a default `16px` margin to both sides.
- If the neighboring component's margin contract is unknown, define or normalize it at the shared layout boundary before implementation. Do not read computed styles at runtime to negotiate spacing.

Editor guide and preview geometry:

- In edit mode, the dashed widget guide and the widget preview together must still occupy the same layout box used by the saved widget.
- The dashed guide must be drawn as an overlay, inset outline, pseudo-element, or border included by `box-sizing: border-box`.
- The guide must not add margin, padding, grid gap, width, or height.
- Do not add separate spacing for the dashed guide.
- Measure the 16px gap from the outer visual bound of the combined guide/preview to the outer visual bound of its neighbor.
- Entering edit mode must not change any widget's `x`, `y`, `width`, `height`, grid track size, or 16px neighbor gap.
- Saving an unchanged draft and returning to view mode must render every widget at exactly the same position and size as its edit preview.
- The insertion placeholder must use the same border-box geometry as the widget that will replace it.

Recommended tokens:

```css
--dashboard-element-gap: 16px;
--dashboard-widget-edge-gap: 8px;
```

Use existing project tokens instead when they already represent these exact values. Do not change a global token that is shared by unrelated features.

Objective spacing measurement:

```ts
const horizontalGap = rightRect.left - leftRect.right;
const verticalGap = lowerRect.top - upperRect.bottom;

expect(horizontalGap).toBe(16);
expect(verticalGap).toBe(16);
```

Do not approve spacing from a screenshot by eye. Validate it from rendered bounding rectangles at every supported breakpoint.

## 6. Editor Mode

### 6.1 Entering the editor

Opening the editor must:

- Clone `canonicalLayout` into `draftLayout`.
- Display clear dashed grid guides.
- Display all valid empty slots and insertion slots.
- Display **Save**, **Cancel**, and **Restore Default** actions.
- Reuse the already-loaded chart catalog.
- Avoid any additional chart catalog request.

View mode must not show editing grid lines or insertion markers.

### 6.2 Editor actions

**Save**

- Validate the complete draft.
- If the draft forces existing widgets to change size, proportion, or position, show the confirmation dialog defined in Section 8.
- Commit the complete layout atomically only after validation and any required confirmation.

**Cancel**

- Discard the entire draft.
- Restore the exact grid, widget sizes, positions, order, and IDs that existed before the editor opened.
- Do not send a save request.

**Restore Default**

- Replace only the draft with the product-defined `2x2` default layout.
- Do not save immediately.
- Require the user to press **Save**.
- Warn before committing if the action replaces an existing custom layout.

## 7. Insertion-Slot Preview Behavior

Widget placement is determined by explicit insertion slots. It is not determined by whether the pointer is in the upper or lower half of an existing widget.

Given this initial `2x2` layout:

```text
┌─────┬─────┐
│  A  │  B  │
├─────┼─────┤
│  C  │  D  │
└─────┴─────┘
```

### 7.1 Insert E between A and B

When E is dragged into the insertion slot between A and B:

- A and B temporarily become narrower in `draftLayout`.
- The editor opens a visible middle slot.
- The preview order is `A | E | B`.
- For this example, the temporary grid may become `3x2`.

```text
┌────┬────┬────┐
│ A  │ E  │ B  │
└────┴────┴────┘
```

### 7.2 Insert E to the right of B

When E is dragged into the insertion slot to the right of B:

- A and B temporarily narrow toward the left.
- The editor opens a visible slot at the far right.
- The preview order is `A | B | E`.
- For this example, the temporary grid may become `3x2`.

```text
┌────┬────┬────┐
│ A  │ B  │ E  │
└────┴────┴────┘
```

If left-edge insertion is supported, it must behave symmetrically.

The same principle applies to supported row insertion: the user must target an explicit slot between rows or at a row edge. Do not infer row insertion from an ambiguous region inside a widget.

### 7.3 Preview requirements

- Show a dashed slot, insertion marker, or placeholder at every valid insertion position.
- Highlight the exact slot currently targeted by the pointer.
- Use the same layout calculation for the preview and the final draft result.
- Adjust only widgets that must change to create the insertion space.
- Do not silently reorder unrelated widgets.
- If the underlying grid changes other rows, the preview must show all affected widgets.
- Existing widgets may temporarily become narrower in the draft, but their saved dimensions remain unchanged.
- Widgets must remain above their defined minimum readable width.
- Reject an insertion slot when the new widget cannot fit without overlap, clipping, or an invalid size.
- Leaving the insertion slot, cancelling the drag, or failing the drop must restore the last valid draft.
- A successful drop updates only `draftLayout`.
- Preview changes must not change `widgetId`, `widgetType`, chart settings, or catalog data.

## 8. Confirmation Before Forced Layout Changes

If the Dashboard already contains widgets and saving the draft will force any existing widget to change size, proportion, or position, show a confirmation dialog before writing to `canonicalLayout`.

The dialog must show:

- Current grid size.
- Target grid size.
- Number of affected widgets.
- A clear warning that existing widget sizes or positions will change.
- A layout preview when one can be calculated.
- A secondary **Cancel** action.
- A primary **Continue and Save** action.

Example copy:

```text
Save layout changes?

The grid will change from 2x2 to 3x2. The system will resize or
reposition 2 existing widgets. Review the preview before continuing.

[Cancel] [Continue and Save]
```

Dialog behavior:

1. Opening the dialog must not change `canonicalLayout`.
2. Cancelling or closing the dialog must preserve the saved layout.
3. The current draft may remain available for further editing after dialog cancellation.
4. Only explicit confirmation may atomically commit the draft.
5. Preserve every existing `widgetId` after the commit.
6. Re-run identity, size, boundary, collision, and fill validation before committing.
7. If the target grid cannot contain all widgets, disable confirmation and explain the problem.
8. Never delete, hide, or overlap widgets to force the layout to fit.
9. If the save fails, roll back to the complete saved layout and show an actionable error.

## 9. Drag, Resize, and Collision Rules

### 9.1 Drag

- Show the exact target placeholder during drag.
- The placeholder and final draft position must match.
- Show a clear disabled state for invalid targets.
- Validate identity, boundaries, collisions, supported sizes, and fill rules before accepting the drop.
- Do not render an overlap first and repair it in a later render.

### 9.2 Resize

- Resize handles must snap to supported grid dimensions.
- Widget height may only switch between `0.5X` and `1X`.
- Widget width must use a width supported by the active grid.
- Reject a resize that causes overlap, overflow, unusable fragments, or an incomplete required area.
- Return to the last valid size after a rejected resize.
- Display the target size while resizing.

### 9.3 Collision detection

Run collision detection during add, move, resize, load, preview, and save.

```ts
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
```

Collision validation must use canonical grid data or draft grid data as appropriate. Do not use the rendered DOM as the source of truth.

## 10. State and Save Validation

`canonicalLayout` is the saved source of truth. `draftLayout` is an isolated editing copy derived from it.

DOM coordinates, CSS transforms, or temporary third-party grid-library state must not be the only layout data source.

Recommended validation result:

```ts
type LayoutValidationResult = {
  valid: boolean;
  errors: Array<{
    code:
      | 'DUPLICATE_WIDGET_ID'
      | 'WIDGET_OVERLAP'
      | 'OUT_OF_BOUNDS'
      | 'INVALID_GRID_SIZE'
      | 'INVALID_HEIGHT'
      | 'INVALID_WIDTH'
      | 'INCOMPLETE_COLUMN';
    widgetIds?: string[];
    message: string;
  }>;
};
```

Validate in this order:

1. Schema and required fields.
2. Grid size is between `1x1` and `3x3`.
3. Unique `widgetId` values.
4. Supported widget dimensions.
5. Grid boundaries.
6. Widget collisions.
7. Required row/column fill.

Reject the save if any validation fails.

An invalid legacy layout must enter a recoverable error or an explicit, tested migration. Do not silently render overlapping widgets.

A previously saved layout with 4 or 5 columns or rows is outside the `1x1` through `3x3` contract and is a legacy layout under this rule. Existing persisted 4/5-column layouts require a defined migration/recovery behavior before the 3x3 implementation is considered complete. This document does not yet define that behavior, and such layouts must not be silently discarded.

## 11. Responsive Behavior

- Define supported column counts and widths for every existing breakpoint.
- Product maximum canonical/editable grid: desktop `3x3`, tablet `3x3`, mobile view-only.
- The minimum-readable-width rule may reduce the usable column count below 3 at a given width. It must never raise the usable column count above the product maximum of 3.
- Responsive reflow must preserve `widgetId`.
- Reflow must not create overlaps or overflow.
- On small screens, use deterministic stacking rather than shrinking charts below their readable size.
- Reloading at the same breakpoint must produce the same order.
- Do not introduce new breakpoints unless the task explicitly requires them.

## 12. Accessibility and Feedback

- Widget drag and resize may be pointer-driven (mouse/touch). A keyboard-equivalent move/resize interface is not required. Pointer drag/resize must still expose validity/error feedback and preserve the canonical validation rules; all other controls keep their normal keyboard-accessibility requirements.
- Provide visible focus and selected states.
- Do not communicate valid and invalid slots by color alone.
- Announce the targeted insertion position and pending layout change to assistive technology.
- Use actionable errors, for example: “This widget cannot fit in the selected slot.”
- The confirmation dialog must trap focus, support `Escape`, and return focus to the triggering control.

## 13. Required Tests

### 13.1 Unit tests

- Accept every integer grid from `1x1` through `3x3`.
- Reject `4x3`, `3x4`, `4x4`, and `5x5`.
- Reject out-of-range or non-integer grid sizes.
- Create the default `2x2` layout only when no saved layout exists.
- Do not overwrite a valid saved layout with the default.
- Reject duplicate `widgetId` values.
- Reject duplicate `creatorId` values in a comparison.
- Preserve explicit creator selection or drop order when building comparison configuration.
- Require at least two distinct creators before comparison can start.
- Assign consecutive comparison-order badges from click order.
- Renumber remaining creators after deselection and append a reselected creator to the end.
- Calculate missing comparison charts from selected `comparisonItemIds`, not from the number of selected creators.
- Derive `widget[0]` from visual row-major coordinates rather than storage-array order.
- Map comparison items to widget containers in selected item order.
- Preserve reused widget identity and geometry.
- Append exactly `max(0, comparisonItemCount - existingWidgetCount)` new widgets.
- Give every automatically appended comparison chart a unique `widgetId`.
- Allow the same `widgetType` with different `widgetId` values when supported.
- Accept `1X`.
- Accept two stacked `0.5X` widgets.
- Reject `0.25X`, `0.75X`, and other unsupported heights.
- Detect overlaps, overflow, and incomplete required areas.
- Preserve widget IDs after move, resize, insertion, and grid migration.
- Calculate adjacent widget edge contributions as `8px + 8px = 16px`.
- Calculate a widget-to-component boundary as `16px - componentContribution`.

### 13.2 Integration and E2E tests

- Load the chart catalog once when the Dashboard page opens.
- Do not reload the catalog when **Edit** is clicked.
- Do not reload the catalog when view/edit mode is toggled repeatedly.
- Show only chart definitions returned by the backend.
- Open the Creator List from inside a compatible chart widget and configure `A vs B`.
- Add C through the in-widget Creator List and configure `A vs B vs C`.
- Show `①`, `②`, and `③` at the top-right of creator avatars in click order.
- Preserve creator click order in chart series, legends, tooltips, requests, and saved configuration.
- Select creators plus multiple comparison items from the Creator List and confirm.
- Sort existing widget containers by visual row-major order and assign the first comparison item to the top-left `widget[0]`.
- Assign later comparison items to `widget[1]`, `widget[2]`, and so on in selected item order.
- Preserve the `widgetId`, position, width, and height of every reused widget container.
- Leave unassigned existing widgets unchanged.
- Append only the missing number of charts when selected items exceed existing widget containers.
- Give all appended charts unique `widgetId` values and place them after the existing visual sequence without moving existing widgets.
- Disable dialog **Save** when there is insufficient capacity rather than forcing existing widgets to move.
- Save the comparison transaction atomically, close the dialog after success, and show the requested charts immediately.
- Do not require a page reload, second Dashboard save, or manual widget movement after the Flow 2 dialog save.
- Keep the dialog open and the Dashboard unchanged when the comparison save fails.
- Open the Creator List first, then drag creator B onto a chart containing A to prepare `A vs B`.
- Drag creator C onto a chart containing A and B to prepare `A vs B vs C`.
- Highlight compatible chart drop targets and reject incompatible targets.
- Reject dropping a creator already contained in the comparison.
- Cancelling the picker or drag operation preserves the previous widget configuration.
- Create a comparison widget containing ordered, stable `creatorId` values and a unique `widgetId`.
- Preserve selected creators while Creator List search or filtering changes.
- Do not change the current/active creator when a comparison selection changes.
- Place the comparison widget through the normal draft and insertion-slot flow without silently saving.
- Handle an unavailable selected creator without deleting the comparison widget configuration.
- Show dashed guides plus **Save**, **Cancel**, and **Restore Default** in edit mode.
- Given `A | B`, dragging E between A and B previews `A | E | B`.
- Given `A | B`, dragging E to the right of B previews `A | B | E`.
- Existing widgets temporarily narrow while the insertion preview is active.
- The canonical layout remains unchanged during the preview.
- Leaving the slot or cancelling the drag restores the previous draft.
- Measure exactly `16px` between every horizontal and vertical neighboring widget pair.
- Measure exactly `16px` between a widget and a neighboring component whose own margin is `0px`.
- Confirm that no adjacent pair produces a `32px` double margin.
- Repeat bounding-rectangle spacing assertions at every supported breakpoint and during drag preview.
- Confirm that enabling dashed edit guides does not change widget bounding rectangles, grid tracks, or 16px gaps.
- Confirm that an unchanged edit preview and its saved view-mode widget have identical x, y, width, and height.
- Confirm that the insertion placeholder and the resulting widget have identical border-box geometry.
- **Cancel** restores the exact pre-edit layout without a save request.
- **Restore Default** creates a `2x2` draft but does not save automatically.
- **Save** shows confirmation when existing widgets will be forcibly resized or repositioned.
- A failed save restores the prior canonical layout.
- Rapid repeated Add clicks do not create duplicate instances.
- An invalid drop target does not accept a widget.
- Resize handles stop only at valid sizes.
- Saved layout and widget identity survive reload and breakpoint changes.

## 14. Definition of Done

Dashboard layout work is complete only when:

- The shared frontend rules and this document are satisfied.
- A new Dashboard uses the default `2x2` layout.
- Available charts come from the backend catalog.
- Creator comparison supports both an in-widget Creator List picker and dragging Creator List cells into a compatible chart.
- Comparisons support `A vs B`, `A vs B vs C`, and additional creators up to an explicit product or backend limit.
- Comparison configuration uses ordered, stable, distinct `creatorId` values.
- Creator click order is visible through numbered avatar badges and is preserved across comparison output.
- Flow 2 assigns comparison items from the top-left `widget[0]` in visual order while preserving existing widget geometry.
- Flow 2 appends only missing chart containers and never moves existing widgets.
- A successful Flow 2 dialog save closes the dialog and displays the requested charts immediately.
- Creator capacity is not inferred from the number of widgets already placed on the Dashboard.
- A comparison is added as a normal uniquely identified widget through the draft editor flow.
- The catalog loads once per Dashboard page lifecycle and does not reload when editing starts.
- Edit mode shows dashed guides and all required actions.
- Insertion slots correctly preview between-widget and row-edge placement.
- Existing widgets resize only in the draft until the user saves.
- All adjacent Dashboard elements have a measured `16px` final gap, including widget-to-widget and widget-to-component boundaries.
- Dashed edit guides add no margin or geometry and do not shift the preview relative to the saved widget.
- Forced saved-layout changes require confirmation.
- There are no overlaps, overflows, duplicate IDs, or unusable `0.25X` gaps.
- Custom grid dimensions are limited to `1x1` through `3x3`.
- Add, drag, resize, cancel, restore, save, load, and responsive paths use consistent validation.
- Relevant unit and E2E tests pass.
- Supported desktop, tablet, and mobile breakpoints receive visual verification.

## 15. Pull Request Checklist

- [ ] The shared [`AGENTS.md`](./AGENTS.md) rules were followed.
- [ ] A missing saved layout produces the default `2x2`.
- [ ] Available charts come from the backend endpoint.
- [ ] The chart catalog loads once and is reused by edit mode.
- [ ] A chart widget can open the Creator List to configure `A vs B`, `A vs B vs C`, and larger supported comparisons.
- [ ] Creator avatars show consecutive order badges based on click order.
- [ ] Creator count is independent of the number of chart widgets currently placed.
- [ ] Flow 2 maps comparison items from top-left `widget[0]` in deterministic visual order.
- [ ] Reused widget containers preserve their IDs, positions, widths, and heights.
- [ ] Flow 2 appends only missing charts after the existing sequence without moving existing widgets.
- [ ] Automatically appended charts have unique `widgetId` values.
- [ ] Flow 2 dialog save is atomic and displays the requested charts immediately after closing.
- [ ] A Creator List cell can be dragged into a compatible chart to add that creator.
- [ ] Duplicate creators and incompatible chart targets are rejected.
- [ ] Comparison configuration uses stable `creatorId` values and preserves explicit selection/drop order.
- [ ] A comparison widget has a unique `widgetId` and follows the normal draft/save flow.
- [ ] Every widget instance has a stable, unique `widgetId`.
- [ ] Edit mode shows dashed guides, **Save**, **Cancel**, and **Restore Default**.
- [ ] Inserting E between A and B previews `A | E | B`.
- [ ] Inserting E after B previews `A | B | E`.
- [ ] Existing widgets narrow only in `draftLayout` until save.
- [ ] Adjacent widgets contribute `8px` per facing edge and measure exactly `16px` apart.
- [ ] Widget-to-component boundaries measure exactly `16px`, including when the component contributes `0px`.
- [ ] No neighboring pair produces a doubled `32px` gap.
- [ ] Dashed edit guides are geometry-neutral; edit preview and saved view mode use identical widget boxes.
- [ ] Insertion placeholders use the exact border-box geometry of the resulting widgets.
- [ ] Forced changes require confirmation before canonical state is updated.
- [ ] The custom grid is restricted to `1x1` through `3x3`.
- [ ] Widget height is restricted to `0.5X` or `1X`.
- [ ] Add, move, resize, preview, and save run collision and boundary validation.
- [ ] Invalid legacy layouts have an explicit migration or recoverable error.
- [ ] Unit, integration/E2E, and visual checks were completed.
