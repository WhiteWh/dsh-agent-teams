# v0.3.0 release record — closable phases and a three-colour progress bar

The third owner round, released as a minor bump because state and tool behaviour
changed: `agent_teams_replan` gained `close_phase`, `team.json` gained two optional
fields, and the snapshot gained `progress.segments`. The round's panel work (three-row
plaque, collapsible phases, large member node with a fold control) rides along.

## What shipped

| Change | Where |
| --- | --- |
| `close_phase` as one more operation of the captain-only replan batch, allowed only when every task of the phase is terminal, refused with the open tasks named otherwise | `src/replan.ts`, `src/tools.ts` |
| A closed phase refuses `create_task phase:` and a replan `add_task`/`move_phase` into it, pointing at declaring a new phase | `src/replan.ts`, `src/tools.ts` |
| `plan.phases[].closed` / `closedAt`, validated at the durable boundary (both optional, so older state loads as open phases) | `src/types.ts`, `src/state.ts` |
| The snapshot publishes `closed`/`closedAt`; the board marks the column (`Closed` chip, delivered-tone underline) and the running-plan editor disables it as a target | `src/snapshot.ts`, `src/client/activity-model.ts`, `src/client/activity-monitor.ts`, `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css` |
| The captain protocol states the phase bookkeeping obligation (close after acceptance; later work goes into a new phase) | `src/index.ts` |
| `TeamTask.origin` (`plan`/`added`/`followup`) stamped at creation from `planHasSettled()`; replacements and quality-loop repairs inherit their lane's stretch | `src/types.ts`, `src/state.ts`, `src/replan.ts`, `src/tools.ts` |
| `PlanProgress.segments` — the three stretches with `completed`/`total`/`percent` — computed on the host | `src/progress.ts`, `src/snapshot.ts` |
| The progress bar is one line in three coloured zones with a named legend and a tooltip per zone; a payload without segments degrades to one plan zone | `src/client/activity-model.ts`, `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css`, `src/client/locales.ts` |
| Round-3 panel work: the work plaque is three dot rows; the phases section collapses like its siblings; a member node is large by default and folds into a tray on demand (`memberStatusText`, the `member.status.*` and `assignment.*` keys and `.memberRole`/`.memberStatusLine`/`.assignmentLabel` restored; the tray's action symbol un-stuck from the block corner) | `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css`, `src/client/locales.ts` |
| **Field defect fixed:** the phase board's chain walk is memoised — a layered declared phase now costs one visit per task instead of one per dependency path (48 tasks in 12 layers: 7.5 s → 0.4 ms; 56 tasks in 14 layers: 130 s → 0.4 ms). This is the freeze that took the owner's web profile down after 0.2.2 | `src/client/activity-model.ts` |
| **Field defect fixed:** `PanelErrorBoundary` wraps the activity overlay and the conversation card, so a panel fault renders one line instead of unmounting the host's tree (the shell's additive overlay does not isolate a plugin's render exception) | `src/client/ActivityPanel.tsx`, `src/client/index.tsx`, `src/client/ActivityPanel.module.css`, `src/client/locales.ts` |

## Checks added (`scripts/verify.mjs`)

- `a phase closes once every task in it is settled`, `closing a phase with open work is
  refused and names the tasks`, `closing an unknown or already closed phase is refused`,
  `a closed phase refuses new work and points at a new phase`,
  `create_task refuses to place work in a closed phase`, `the snapshot publishes closed
  phases and their tasks`, `the panel marks a closed column and never targets it in the
  plan editor`;
- `progress splits the plan into the three stretches of its life`, `a task added before
  the plan settles is "added", after it settles "followup"`, `the panel draws three
  coloured zones and names them`, `a replanned task records the stretch that created it`;
- `the work plaque is three dot rows tall`, `the phases section collapses like the
  members list and the checklist`, `a member node is large by default and folds into the
  compact tray on demand`, `the compact tray row is one icon line that ends in the work
  plaque`;
- the round-2 badge check was re-pointed to the shared `modelBadge` value plus its
  position in each variant, and the progress-block checks were re-pointed when the
  per-phase rows were removed earlier in this release line.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **285 PASS / 0 FAIL** |
| full chain | `pnpm verify` | pending the owner's go-ahead — recorded here once it has run |
| visual checks | `.local/preview-round3.mjs`, `.local/preview-s27.mjs` | `.local/logs/ui-round3/member-nodes.png` (large node + folded tray), `.local/logs/ui-round3/progress-closed-phase.png` (three-colour bar + closed column) |

## Not verified here (left for CI)

- `scripts/compatibility.test.mjs` in isolation and the real-host matrix
  `scripts/harness-runtime-verify.mjs` (needs a host cohort and credentials);
- the live interaction itself (a click on the fold chevron, a close through the panel):
  the previews are still frames rendered from the built bundle, so behaviour was reviewed
  in the source and in the rendered layout.
