# v0.2.2 release record — one compact roster, one graph view

A client-side release on top of 0.2.1, in two owner rounds: the round-2 panel rework
(compact member node, phases as chains, one graph view) plus the screenshot follow-up that
removed the row-per-phase progress block. The client bundle and the client's model module
changed; no state, tool, schema, profile key or quality gate moved.

## What shipped

| Change | Where |
| --- | --- |
| A member row is one flex line: 24 px portrait, 12 px role symbol (the role in words moved into its `title`), name, model badge, action symbol with its state label, the member's task chips, and the work plaque last (`align-self: stretch`) | `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css` |
| `.memberStatusLine`, `.memberRole`, `.assignmentLabel`, `memberStatusText()` and the nine `member.status.*` locale keys are gone | `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css`, `src/client/locales.ts` |
| `phaseBoardLayout` gives a task its intra-column **chain depth** as `x` and keeps a predecessor's row when its predecessors agree; a column's `width` grows to its longest chain and `columns[]` carries `taskIds` | `src/client/activity-model.ts` |
| `.dagNode[data-state='cancelled']` paints the card in `color-mix(#f2b8b5 14%, bg-layer-1)` with a 45° pale-scarlet hatch, dot/head/label tinted to match | `src/client/ActivityPanel.module.css` |
| The Tree view (`DependencyMap`), the Queues view (`QueueView`), the view switcher, `ActivityViewMode`, `ACTIVITY_VIEW_STORAGE_KEY`, ~60 `view.*`/`queue.*`/`dependency.*`/`assignment.*` locale keys, and the model projections that only served them (`taskStages`, `compactDagLayout`, `relatedTaskIds`, `usesParallelTaskGrid`, `dependencyFocusTaskId`, `agentSwimlanes`, `agentQueue`, `queueOverview`, `idleReasonSummary` + their types) are deleted; a clicked node opens `TaskDetail` under the board | `src/client/ActivityPanel.tsx`, `src/client/activity-model.ts`, `src/client/locales.ts` |
| The progress block is **one** bar: the per-phase rows, `ProgressPhaseView`, `PlanProgressView.phases`, five `.progressPhase*` rules and the `progress.phase` locale key are gone. The snapshot still publishes `progress.byPhase` for other clients | `src/client/ActivityPanel.tsx`, `src/client/activity-model.ts`, `src/client/ActivityPanel.module.css`, `src/client/locales.ts` |
| **Fixed:** a plan whose declared phases covered every task rendered an **empty board** (shipped in 0.2.1). `phaseColumns` now keeps the declared columns whenever they exist and pushes `unphased` only for what the plan left out | `src/client/activity-model.ts` |
| **Fixed:** `css.viewHint` (the board's footnote) and `css.archivedWrap` were rendered without a rule; the footnote has `.phaseHint` now and the dead class reference is gone | `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css` |

## Checks added or re-pointed (`scripts/verify.mjs`)

- `every style class the panel renders exists in its stylesheet` — the guard that found
  `css.viewHint`; it compares each `css.<name>` used by `ActivityPanel.tsx` and
  `StagingPlanEditor.tsx` against the selectors of `ActivityPanel.module.css`.
- `declared phases that cover every task are kept without an unphased column` and
  `a fully declared plan lays out every task it declares` — RED before the fix.
- `sequential work inside one phase lines up in a row`, `parallel work in the same phase takes
  its own row`, `a phase column stretches to the length of its longest chain`,
  `a chain edge is a short forward curve inside the row`.
- `a cancelled node is a pale hatched card, not an alarm`; `the panel keeps the phase board as
  its only graph view`; `the member row is one compact line that ends in the work plaque`.
- `the panel selector switches the snapshot number, not the math`,
  `a card without a snapshot payload falls back to the equal count it can compute`,
  `both locales carry the percent, mode and checklist keys, and no per-phase key` and
  `the panel renders the percent bar and the checklist, without a row per phase` — re-pointed
  RED-first for the progress-block removal.
- Removed with the views (owner decision, named in the file): the tree, queue, swimlane and
  `usesParallelTaskGrid`/`compactDagLayout`/`relatedTaskIds` checks.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **271 PASS / 0 FAIL** |
| full chain | `pnpm verify` | exit 0 |
| visual check | `node .local/preview-round2.mjs` → `.local/logs/ui-round2/phase-board.png` | member list and board rendered from the built bundle with the real CSS sheet, the real layout function and headless Chrome (2× scale) |

The full chain run above is the release gate: `verify.mjs`, `fallback-tdd`,
`member-failure-tdd`, `quality-gates-tdd` (+ two `node --test` files), `lifecycle-verify`,
`stress-verify`, `multi-team-panel-tdd`, `web-routes`, `release-metadata`, `readme-version`,
`sync-skill --check`, `harness-compat-tdd`, `stability-tdd`, `compatibility` (+ its test and
`doctor.mjs`), `http-body`, `capabilities`, `member-spawn-recovery`, `command-source` and
`verify-package`.

## Not verified here (left for CI)

- `scripts/compatibility.test.mjs` in isolation and the real-host matrix
  `scripts/harness-runtime-verify.mjs` (needs a host cohort and credentials);
- the live animation and the pinned-node interaction: the preview is a still frame, so motion
  and click-through were reviewed in the source and in the rendered layout, not frame by frame
  in a browser.
