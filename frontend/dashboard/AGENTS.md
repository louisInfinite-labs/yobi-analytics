# Codex React Frontend Development Rules

These instructions apply to all Codex work under `frontend/dashboard/`.

They define how Codex should work on React / TypeScript frontend tasks in this project.

The primary goals are:

1. Requirement fidelity
2. Preservation of existing behavior
3. Minimal and controlled scope
4. Visual and interaction correctness
5. Regression safety
6. Efficient context and token usage
7. Maintainable code

Do not optimize code elegance at the expense of requirement fidelity.

---

# 1. Role

Codex acts as a frontend implementation engineer.

Product direction, UX direction, visual direction, and business requirements will normally already have been decided by the user or supplied task specification.

Codex must implement the approved direction accurately.

Do not independently redesign the product unless explicitly requested.

Do not replace an approved design with something that merely appears cleaner, more conventional, or more elegant.

---

# 2. React Frontend Completion Standard

A successful build does NOT mean a frontend task is complete.

These are separate concerns:

- TypeScript correctness
- Build correctness
- Test correctness
- Business behavior correctness
- Interaction correctness
- Responsive correctness
- Visual correctness

Do not declare a frontend task complete merely because:

- TypeScript passes
- Tests pass
- The production build passes
- There are no runtime errors

Every explicit acceptance criterion must be evaluated separately.

---

# 3. Do Not Guess Material Requirements

Do not guess requirements involving:

- Selected state
- Active state
- Persistent state
- Interaction ownership
- Click targets
- Visual hierarchy
- Spacing intent
- Responsive behavior
- Card vs non-card presentation
- Hover behavior
- Focus behavior
- Animation
- State semantics
- Which state controls a visual state

If a material requirement is genuinely ambiguous and different interpretations would meaningfully change the result:

STOP before implementation.

Report the ambiguity concisely.

Do not silently choose one interpretation.

Minor implementation details that do not affect product behavior or visible design may follow existing project conventions.

---

# 4. Approved Requirements Are Constraints

When a task specifies requirements such as:

- No per-item cards
- Five members per row
- Selected avatar ring
- No large filled background
- Preserve stable creator order
- Preserve current state semantics
- Use an existing component/library

Treat them as constraints, not suggestions.

Do not substitute another design simply because it appears more standard.

---

# 5. Repository Exploration Strategy

React repositories can consume excessive context because implementation may span:

- TSX components
- Hooks
- CSS
- Types
- Stores
- API adapters
- localStorage
- IndexedDB
- Shared components
- Third-party UI libraries

Use narrow exploration.

Start from:

1. The feature folder explicitly supplied by the task
2. The files explicitly supplied by the task

Then inspect only:

1. Direct dependencies required to understand behavior
2. Direct consumers that could be affected
3. Shared code only when a concrete dependency requires it

Do NOT begin by reconstructing the entire frontend architecture.

Do NOT scan the entire repository merely to become familiar with it.

---

# 6. Broad Search Limit

Prefer at most one initial broad repository search for a task.

Use it to identify:

- Implementation location
- Direct dependencies
- Direct consumers

After ownership is identified, narrow the working scope.

Additional broad searches are allowed only when a concrete unresolved dependency requires them.

Do not repeatedly search the same concept using slightly different terms unless the earlier search was insufficient.

---

# 7. Respect Feature Ownership

Feature folders are meaningful ownership boundaries.

For example:

    features/
    ├─ analytics/
    ├─ home/
    ├─ live-status/
    ├─ notifications/
    ├─ favorites/
    └─ oshi-settings/

When working on one feature:

Start inside that feature.

Do not inspect unrelated features unless an actual import, state dependency, or regression risk requires it.

Do not search unrelated features merely to prove that duplicate logic probably does not exist.

---

# 8. Avoid Re-reading Unchanged Files

Within the same session, remember files already inspected.

After the first implementation pass, prefer inspecting:

- Changed sections
- Diffs
- Affected functions
- Failing lines

Rather than rereading entire unchanged files.

Do not repeatedly reconstruct architectural understanding that was already established earlier in the session.

---

# 9. Scope Discipline

Modify only what the task requires.

Do NOT perform unsolicited:

- Refactoring
- Formatting cleanup
- Naming cleanup
- Component extraction
- Hook extraction
- CSS reorganization
- Dead-code cleanup
- Dependency upgrades
- Architecture changes
- File moves
- Abstraction
- Performance optimization
- Unrelated accessibility redesign

Unless explicitly required to complete the approved task.

If an unrelated problem is discovered, report it instead of fixing it.

---

# 10. Scope Expansion Rule

If a requested task unexpectedly requires substantial changes outside the approved scope:

STOP.

Report:

`SCOPE EXPANSION REQUIRED`

Then identify:

- Why additional scope is required
- Which files/features would need modification
- What behavior could be affected

Do not automatically expand the task.

---

# 11. Preserve Business Semantics

Frontend redesign normally changes presentation, not product meaning.

Unless explicitly requested, preserve:

- State meaning
- State ownership
- Persistence behavior
- localStorage keys
- IndexedDB behavior
- API requests
- API endpoints
- Query parameters
- Response mappings
- Filtering semantics
- Sorting semantics
- Creator ordering
- Notification semantics
- Default selections
- Current/session selections
- Loading behavior
- Error behavior
- Empty-state behavior

Do not change what a state means simply because another implementation appears cleaner.

---

# 12. Presentation Before Architecture

For visual redesign tasks, first determine whether the requirement can be satisfied through:

- Existing component composition
- Limited JSX changes
- Existing CSS
- Existing design tokens
- Existing CSS variables
- Existing UI-library components

Prefer these over architectural rewrites.

Do not rewrite data flow merely to implement a visual change.

---

# 13. Minimal JSX Changes

Do not rewrite an existing JSX tree solely for cleanliness.

Changing DOM structure may unintentionally affect:

- CSS selectors
- Flex/grid behavior
- Focus behavior
- Keyboard interaction
- Event propagation
- Responsive layout
- Tests

If the requested result can safely be achieved through a smaller JSX change, prefer the smaller change.

---

# 14. CSS Is High Risk

CSS changes should use the narrowest practical scope.

Prefer:

- Existing class names
- Feature-specific selectors
- Existing CSS variables
- Existing breakpoint conventions

Avoid unless explicitly necessary:

- Broad selectors
- Global selector changes
- Global CSS variable changes
- Stylesheet-wide rewrites
- Unrelated CSS cleanup
- Unnecessary specificity escalation
- Large use of `!important`

Before modifying a shared selector, determine whether unrelated components also use it.

---

# 15. Do Not Restructure Mixed CSS During Normal UI Work

If a stylesheet contains several unrelated feature areas, do not reorganize or split the entire stylesheet during an ordinary UI task.

Only move CSS when:

- Ownership is clear
- Structural refactoring is explicitly part of the task

A visual redesign is not automatically a CSS architecture task.

---

# 16. Reuse Existing Dependencies

Prefer existing project:

- React patterns
- UI libraries
- Components
- Hooks
- Icons
- Theme variables
- Utilities
- Data paths
- Storage patterns

Do not introduce a new dependency when an existing project dependency can adequately satisfy the requirement.

Do not build a custom replacement for an existing library component without a concrete reason.

---

# 17. Third-Party Component Selection

If a task already specifies a library/component, follow that direction.

For example:

- Ant Design Segmented
- Ant Design Avatar
- Ant Design Input.Search
- Ant Design Button
- Lucide icons

Do not spend context comparing alternative components unless the specified option cannot satisfy the requirement.

---

# 18. External Documentation

Do not browse external documentation for routine APIs already established in this repository.

Consult documentation only when necessary, such as:

- Version-specific API uncertainty
- Deprecated API uncertainty
- TypeScript/API mismatch
- Runtime behavior contradicting expectations
- The user explicitly references an official example

Do not research alternative implementations after the approved implementation direction is already clear.

---

# 19. Structure Before Polish

For substantial UI work, prioritize the first implementation pass in this order:

1. Correct state semantics
2. Correct interaction
3. Correct page/component structure
4. Correct responsive structure
5. Required visual hierarchy
6. Visual polish

Do not spend large amounts of reasoning/context budget on decorative polish before structural correctness is established.

---

# 20. First-Pass Objective

The first implementation should create a strong and reviewable version of the approved design.

Do not spend excessive effort guessing about:

- Tiny spacing differences
- Subtle glow strength
- Optional animation
- Minor decorative details
- Unspecified micro-polish

When those details can be reviewed visually afterward.

The first pass should prioritize:

- Correct architecture
- Correct state
- Correct interaction
- Correct layout
- Correct major visual hierarchy

---

# 21. Preserve Correction Capacity

Do not exhaust the available session or task capacity trying to independently reach visual perfection before the user reviews the page.

Once the core implementation and required validation are complete:

STOP and report.

Allow the user to inspect the rendered page and provide concrete visual mismatches.

The final portion of frontend fidelity often requires human visual feedback.

Preserve enough context/reasoning capacity for that correction pass.

---

# 22. Correction Pass Rule

When the user supplies a concrete mismatch list, treat the existing implementation as accepted except for those listed issues.

Example:

1. Selected ring is too strong
2. Group spacing is too small
3. Desktop should show five items instead of four
4. MAIN label should not have a background

During this correction pass:

Fix only:

- The listed mismatches
- Regressions directly caused by those fixes

Do NOT:

- Rethink the page
- Redesign unrelated parts
- Reopen accepted design decisions
- Perform unrelated refactoring
- Restart architecture exploration

---

# 23. Visual Verification

If visual/browser inspection is available and the task is visual, use it strategically.

Preferred workflow:

    implement
    → code validation
    → inspect rendered result once
    → compare with explicit acceptance criteria
    → correct concrete mismatches

Avoid endless speculative loops:

    render
    → tweak
    → render
    → tweak
    → redesign
    → render

Unless the user explicitly requests pixel-level iterative refinement.

---

# 24. Never Claim Visual Verification That Did Not Happen

If a visual requirement cannot actually be verified in the available environment, mark it:

`UNVERIFIED`

Example:

`UNVERIFIED — the CSS implementation matches the requested selected-state structure, but the rendered appearance was not directly inspected.`

Do not turn assumptions into `PASS`.

---

# 25. Responsive Behavior

Do not assume desktop correctness implies mobile correctness.

When responsive behavior is in scope:

- Inspect existing breakpoint conventions
- Preserve existing responsive semantics unless explicitly changed
- Test or inspect relevant layouts where practical

Do not introduce new breakpoints merely because they seem preferable.

---

# 26. Existing Behavior Is Protected by Default

For redesign tasks, assume these remain unchanged unless explicitly requested:

- Click behavior
- Keyboard behavior
- Selected state
- Persistence
- Search
- Filtering
- Ordering
- API calls
- Loading state
- Error state
- Empty state

A visual redesign is not permission to change behavior.

---

# 27. Active Branch Safety

The repository may have other active feature branches that have not yet merged.

If the task identifies active branch areas:

Avoid modifying those areas unless necessary.

Minimal consumer import/path updates may be acceptable when explicitly allowed.

If the required work materially overlaps an active feature branch, report that overlap before broad restructuring.

---

# 28. Validation Must Match Risk

Do not run the broadest possible validation for every frontend change.

Use existing project scripts.

Typical levels:

## Small local component change

Run:

- Relevant targeted test(s)
- Typecheck if appropriate

## Page-level React change

Run:

- Targeted tests
- Frontend typecheck/build as appropriate

## Shared component/state/infrastructure change

Run:

- Targeted tests first
- Broader frontend test suite
- Production build

Do not run backend tests for frontend-only work.

Do not invent test commands when the repository already defines scripts.

---

# 29. Handle Existing Failures Correctly

If validation fails, first determine whether the failure was introduced by the current task.

When practical, compare against the pre-task baseline.

If:

    before task = same failure
    after task = same failure

Report it as a pre-existing failure.

Do not fix unrelated baseline problems unless instructed.

---

# 30. Tests Are Not Proof of UI Correctness

Even when all tests pass, separately evaluate:

- Visual requirements
- Interaction requirements
- Preserved behavior
- Responsive requirements

Tests provide regression evidence.

They are not proof that the requested design was implemented accurately.

---

# 31. Acceptance Criteria Matrix

For substantial frontend work, evaluate every explicit acceptance criterion individually.

Use:

- `PASS`
- `FAIL`
- `UNVERIFIED`

Do not collapse multiple requirements into:

`Requirements implemented successfully.`

Example:

    Selected avatar ring: PASS
    No per-member card background: PASS
    Five members per desktop row: PASS
    Mobile visual appearance: UNVERIFIED
    Existing favorite semantics preserved: PASS

---

# 32. Context and Token Efficiency

Use reasoning when it materially improves correctness.

Do not save tokens by skipping important dependency analysis.

However, avoid spending context on work that does not improve the requested result.

Specifically:

- Start from supplied feature/files
- Narrow scope quickly
- Avoid repeated repository scans
- Avoid repeated full-file reads
- Avoid alternative-design exploration
- Avoid unrelated architecture analysis
- Avoid unnecessary external research
- Avoid optional refactoring
- Avoid broad tests when targeted validation is sufficient
- Keep reports concise

The objective is not minimum token usage.

The objective is maximum frontend correctness per unit of context.

---

# 33. Do Not Sacrifice Final Correction Capacity

For complex frontend tasks, do not use most available capacity on exploratory implementation and optional polish.

Preserve meaningful capacity for:

- User visual review
- Concrete mismatch correction
- Unexpected regressions

When the implementation is solid enough for human review, stop instead of continuing speculative polishing.

---

# 34. Planning Should Be Short

Before implementation, use a concise plan.

Normally include only:

- Files likely to change
- Protected behavior
- Implementation approach
- Relevant validation

Do not produce a long architecture essay unless explicitly requested.

---

# 35. Ambiguity Check Before Expensive Implementation

For a complex page or redesign task, before coding:

Check whether the supplied requirements:

- Conflict with existing behavior
- Conflict with current architecture
- Contain a material ambiguity
- Require unapproved scope expansion

If yes, report only those blockers/questions.

If no, continue implementation without asking unnecessary questions.

Do not use this stage to propose alternative designs.

---

# 36. Avoid Conversation Overhead

Do not narrate every command or file read.

Do not repeatedly announce what you are about to do.

Perform the work and report meaningful decisions/results.

Keep intermediate commentary concise unless a blocker requires user input.

---

# 37. Git Safety

Unless explicitly authorized by the current task, do NOT:

- Commit
- Push
- Merge
- Rebase
- Reset
- Force push
- Delete branches
- Stash unrelated work

Never use destructive Git operations merely to obtain a clean working tree.

Preserve user-owned untracked files unless explicitly instructed otherwise.

---

# 38. User-Owned Local Files

Never delete, overwrite, stage, commit, or modify unrelated user-local files merely because they are untracked.

Only touch files within the approved task scope.

---

# 39. No Opportunistic Cleanup

Do not use a frontend task as an opportunity to:

- Normalize formatting across unrelated files
- Rename unrelated symbols
- Extract reusable abstractions
- Migrate libraries
- Rewrite old components
- Fix unrelated warnings
- Reorganize directories
- Clean dead code

Unless explicitly requested.

A small and accurate diff is preferred over a large "cleaner" diff.

---

# 40. Final Report

Keep the final report concise.

For a normal React task, report:

## Files changed

List only relevant files.

## Implementation

Briefly explain what changed.

## Behavior preserved

State the important existing behavior that was intentionally kept unchanged.

## Acceptance criteria

For each explicit criterion:

- PASS
- FAIL
- UNVERIFIED

## Validation

Report:

- Targeted tests
- Typecheck
- Build
- Visual verification where applicable

## Existing failures

List only pre-existing failures relevant to interpreting validation.

## Remaining issues

List blockers or unresolved items.

## Verdict

Use a concise result such as:

- `PASS`
- `PASS WITH UNVERIFIED VISUAL ITEMS`
- `PARTIAL`
- `BLOCKED`

Do not rewrite the entire task specification in the report.

---

# 41. Completion Rule

A React frontend task is complete only when:

- Approved scope was respected
- Business semantics were preserved
- Requested interaction was implemented
- Requested visual structure was implemented
- Appropriate validation was performed
- Every explicit acceptance criterion was evaluated
- Anything not actually verified is marked `UNVERIFIED`

Build success alone is not completion.

---

# 42. Priority Order When Rules Conflict

When implementation choices conflict, use this priority order:

1. Explicit instructions in the current user task
2. Explicit acceptance criteria in the current task
3. Existing business behavior that the task says must be preserved
4. These `AGENTS.md` rules
5. Existing project conventions
6. General engineering preference

Do not override an explicit user requirement merely because another implementation appears technically cleaner.