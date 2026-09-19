# PROGRESS — dsh-agent-teams improvement plan (WP1–WP11)

> Local working file. Branch `agent-teams-hardening` off `87c95c9` (upstream main, v0.1.20).
> Executor: single agent, strictly linear, one step per commit.
> Plan: `D:/OwlCats/AI_Tools/Docs/AGENT_TEAMS_IMPROVEMENT_PLAN.md` §3.
> Spec: `docs/quality-gates.md` §9.1 (tests first).
> Statuses: `todo` → `red` → `green` → `docs` → `done`; `blocked` when a step
> cannot be made green without weakening an existing assertion.

## Documentation language policy (owner instruction, 2026-09-19)

All documentation is English. Chinese is **legacy: frozen, not read, not
maintained**. The authoritative rule is the "Documentation language policy"
section in `AGENTS.md`; the indexer exclusions are in `.socraticodeignore`.

Translated to English so far (verified 0 CJK):

| File | Note |
| --- | --- |
| `docs/quality-gates.md` | execution spec; all 48 `tdd.*` labels preserved (verified with `Compare-Object` against the pre-translation set) |
| `docs/usage.md`, `docs/maintenance-workflow.md`, `docs/verification-guide.md`, `docs/progressive-loading.md` | product documentation |
| `docs/developing-dsh-plugins.md`, `docs/readme-writing-guide.md`, `docs/alpha2-release-acceptance.md`, `docs/harness-0.1.5-rc.2-acceptance.md` | guides and acceptance records |
| `docs/compatibility-audit-2026-09-05/README.md` | summary only; the four attachment tables are still Chinese |

Deliberately **not** translated, and not to be read or maintained:

| Area | Files | Why |
| --- | --- | --- |
| dated audits | `docs/*-audit-*`, `docs/maintenance-*`, `docs/session-latency-audit-*`, `docs/theme-support-*`, `docs/upgrade-skill-study-*`, `docs/releases/*` | historical records; excluded from the index |
| Chinese README | `README_ZH.md` | superseded; version check no longer tracks it |
| vendored skills | `skills/`, `.dsh/skills/` (83 files) | upstream material, "preserve upstream skill files" |
| evidence dumps | `*.jsonl`, `*.json`, `*-snapshot.txt` under the dated audits | raw run data; translating would invalidate the recorded hashes |
| functional code | `src/client/locales.ts` (`zh` dictionary), `src/client/artwork.ts` (CJK role matchers), `src/quality-gates.ts` (gate-test matchers), `scripts/fixtures/*` | product behaviour and test subject matter, not documentation |

Language checks in the release gate:

```sh
node scripts/readme-version.mjs        # README.md only (English)
node .local/lang-check.mjs             # fails on CJK in any English-only path
```

## Baseline (measured 2026-09-19 on this machine, branch agent-teams-hardening @ 87c95c9)

| Suite | Command | Result |
| --- | --- | --- |
| typecheck | `cmd /c ".local\pnpm.cmd typecheck"` | exit 0 |
| build | `cmd /c ".local\pnpm.cmd build"` | exit 0 |
| offline verify | `cmd /c ".local\pnpm.cmd exec node scripts/verify.mjs"` | **183 PASS / 0 FAIL**, exit 0 |
| quality-gates TDD | `... node scripts/quality-gates-tdd.mjs` | exit 0 |
| quality-gates amend | `... node scripts/quality-gates-amend.test.mjs` | exit 0 |
| lifecycle | `... node scripts/lifecycle-verify.mjs` | exit 0 |
| stress | `... node scripts/stress-verify.mjs` | exit 0 |

`.local/logs/baseline-pnpm10.log` records **181 PASS / 0 FAIL** with
`VERIFY_EXIT=1` at `scripts/verify.mjs:1649` (`spawn EPERM`). This session runs
with `danger-full-access`, where that piped-child spawn is permitted; the same
suite now reaches the end (`all checks passed`, exit 0) and reports **183 PASS**
— the two extra PASS lines are group 8's real-Windows-lock checks that the
sandboxed baseline could not run past. The bar for every step: **no FAIL, and
every label green in the baseline log stays green**.

Regression bar when a step changes `verify.mjs`: PASS count must not drop below
the pre-step count, and FAIL must stay 0.

## Step table

| id | WP | status | commit | notes |
| --- | --- | --- | --- | --- |
| S01 | WP9-a single TASK_TRANSITIONS table | done | 3826358 | verify 183 PASS/0 FAIL; qg-tdd 79 PASS/0 FAIL |
| S02 | WP5 transitive overlap-skip | done | 236bfd6 | verify 183 PASS/0 FAIL; qg-tdd 84 PASS/0 FAIL |
| S03 | WP1 waived / no_regression acceptance | done | 2f009bc | verify 188 PASS/0 FAIL; qg-tdd 97 PASS/0 FAIL |
| S04 | WP6.2 Delivery ignores dead tasks, path loop filtered by completed | done | 86d2c4a | verify 188 PASS/0 FAIL; qg-tdd 101 PASS/0 FAIL |
| S05 | WP6.1 profile lint + doctor --profiles | done | 7941ede | verify 188 PASS/0 FAIL; qg-tdd 106 PASS/0 FAIL |
| S06 | WP10 phases / agents / queues views | done | 935be9b | verify 210 PASS/0 FAIL; qg-tdd 106 PASS/0 FAIL |
| S07 | docs + release 0.1.21 | done | 74fc749 | verify 210 PASS/0 FAIL; qg-tdd 106 PASS/0 FAIL; t5-replay 7/7; scheduler fix in 0108c81 |
| F4 | artwork cache revision (hotfix release 0.1.22) | done | | verify 219 PASS/0 FAIL; qg-tdd 106 PASS/0 FAIL; mutation-tested route check; plan releases below shift by one |
| S08 | WP2 amend_task extensions + retry from failed | done | | verify 230 PASS/0 FAIL; qg-tdd 108 PASS/0 FAIL; amend suite 15/15; lifecycle scenario amend→retry→complete |
| S09 | WP3 superseded + atomic dependency redirect | done | | verify 232 PASS/0 FAIL; qg-tdd 115 PASS/0 FAIL; lifecycle +6 checks; stress +3 checks |
| S10 | WP4 accept_paths + sharedInScope + awaiting_scope_review | todo | | needs S03 |
| S11 | WP6.3 known-delta registry | todo | | needs S03 |
| S12 | WP6.4 requiredReviewers enforced | todo | | |
| S13 | docs + release 0.1.23 | todo | | 0.1.22 was taken by the F4 hotfix |
| S14 | WP11 phase 1 team_id addressing | todo | | needs S09; D5: team_id mandatory except create and bare status; D6 minimal guard |
| S15 | docs + release 0.1.24 | todo | | 0.1.23 was taken by the F4 hotfix |
| S16 | WP8 plan progress + task checklist | todo | | needs S09; D3: server-side byKind/equal modes |
| S17 | WP7 replan live team | todo | | needs S08–S10, S02; D4: nearest-ancestor phase fitting + lift-and-flag |
| S18 | WP11 phase 2 N teams in UI + scheduler | todo | | needs S16, S06 |
| S19 | WP11 phase 3 team limits | todo | | |
| S20 | docs + release 0.2.0 | todo | | |

## Release tags (owner instruction, 2026-09-20)

Every release is tagged, and the tag carries the branch marker. Rules recorded
in `docs/maintenance-workflow.md` § "Release tags on this branch" and in
`.local/SETUP.md`:

- annotated tag `v<package.version>`, pushed to `fork`;
- message opens with `AgentTeams <version> — branch agent-teams-hardening (fork
  release)`, because our tags are not upstream NanmiCoder tags (upstream stops at
  `v0.1.20`);
- the tag points at the commit whose build produced the shipped artifact, and the
  message carries the artifact name, size, SHA-256 and the local verification
  result;
- created after the artifact is packed and installed, never before; a later
  documentation commit does not move a pushed tag.

Backfilled on 2026-09-20: `v0.1.21` → `12f245b` (the last commit of the 0.1.21
line — the tree the deployed 0.1.21 artifact was built from, with the release step
`74fc749` and the adopted PRs/artwork before it) and `v0.1.22` → `9f81203`. Both
tags are in `fork`.

## Left for CI (cannot run on this machine)

- `pnpm verify` end to end (it is a chain of suites; each suite is run
  individually here instead).
- `scripts/compatibility.test.mjs` — spawns `doctor.mjs` through a pipe.
- `scripts/harness-runtime-verify.mjs` — the real-host matrix (needs a host
  cohort and LLM credentials).

## Owner decisions (final; plan §5 is now "Решения владельца плана")

Recorded before S07. These supersede the earlier "open questions" text; the
plan's §5 was retitled when the owner answered them.

- **D1 — who may waive (was Q1).** Unchanged. A member may submit
  `status=waived` with non-empty `evidence`; the task gets `hasWaivers=true` and
  the reviewer must confirm the waivers, otherwise Delivery is blocked with
  `<id> has unconfirmed waivers`. `reviewPolicy.allowWaivers=false` disables the
  mechanism. Implemented in S03.
- **D2 — intermediate state (was Q2).** Unchanged. Implement
  `awaiting_scope_review`. Belongs to S10/WP4.
- **D3 — progress percent (was Q3).** Two modes, **both computed server-side in
  the snapshot**: `byKind` (default) and `equal`.
  - `byKind` weights come from `taskPlanning.weights`, with defaults
    `implementation: 3`, `repair: 2`, every other kind `1`.
  - `equal` weights every task the same.
  - The panel switches between the two modes; the profile picks the default via
    `taskPlanning.weights: equal` (which selects the `equal` mode rather than a
    per-kind map).
  - Applies to **S16/WP8**. Not implemented yet; nothing before S16 depends on it.
- **D4 — phases (was Q4).** Phases are dynamic.
  - If the plan defines phases (`plan.phases` from WP7, or
    `taskPlanning.phases`), use them, and fit a task that no phase lists into
    the phase of its **nearest DAG ancestor**.
  - A task whose manual phase is **lower** than a dependency's phase is
    **lifted** to that dependency's phase and **flagged**.
  - Without any phase definitions, derive the columns from topological depth.
  - Manual phases always win over derived ones.
  - **S06 already implements** manual precedence and the depth fallback, so no
    rework is owed there; the "unphased → nearest DAG ancestor's phase" fitting
    and the lift-and-flag rule land in **S17** together with `plan.phases`.
- **D5 — `team_id` (was Q5).** Mandatory on **every** team-scoped tool except:
  - `agent_teams_create`, which returns the id; and
  - `agent_teams_status` called with no arguments, which lists the caller's
    teams (`id`, `name`, `phase`, `halted`, `tasks total/done`, `members`,
    `activeWorkers`).
  A missing `team_id` is an error that lists the caller's team ids and names.
  Members receive `team_id` from their capability context, so the member prompt
  does not change. Existing `team.json` files keep working: their existing `id`
  *is* the `team_id`. The system prompt gains: "remember `team_id` from the
  create result; if unsure, call `status` without arguments". The
  ambiguous-team branches in `findTeamByCaptain` / `findTeamByParticipant` /
  `capabilities.ts` are removed. Applies to **S14**.
- **D6 — team limits (was Q6).** Limits are **state-based, not fixed counts**:
  `create` refuses when the workspace's active workers would exceed
  `maxConcurrentWorkersGlobal`, and guards live teams against
  `maxTeamsPerWorkspace` (default 4) **only as an upper fuse**.
  - The minimal guard ships in **S14** (phase 1 already edits `create`).
  - Configurable keys, `maxTeamsPerSession` and slot reporting ship in **S19**
    (phase 3).
  - If the guard drags the scheduler into S14, move it **whole** to S19 and
    write the reason here.

## Step log

### S09 — WP3: `superseded` and the atomic redirect (done)

Planned test labels (WP3 of the plan): `tdd.supersede.failed-to-superseded`,
`tdd.supersede.redirects-pending-dependents`, `tdd.supersede.retargets-review`,
`tdd.supersede.delivery-ignores-superseded`,
`tdd.delivery.failed-paths-not-double-reported`, a supersede in the middle of a
running DAG in `stress-verify.mjs`, and a backwards-compatible read of a
`team.json` without `supersededBy` in `verify.mjs`.

- **Rule (`src/state.ts`, `src/types.ts`):** new terminal status `superseded` and
  the field `TeamTask.supersededBy`. `TASK_TRANSITIONS` gains the transitions
  into it from every non-completed status and keeps `superseded` itself terminal.
  `unsatisfiedDependencies` resolves a supersession chain recursively (with cycle
  protection): a dependency on a replaced task is satisfied by the replacement's
  fate, so history that was never rewritten cannot fence a lane forever.
  `applySupersession(team, oldId, newId)` is the pure operation: it marks the old
  task `superseded`, drops its capability and `changedPaths` (keeping `output`),
  redirects every non-terminal dependent's `dependencies`, retargets every
  non-terminal `reviewedTaskId`/`sourceTaskId`, and refuses a replacement that
  transitively depends on the task it replaces (that would build a cycle).
- **Shared status sets (`src/types.ts`):** `DEAD_TASK_STATUSES`
  (`cancelled`/`superseded`), `OPEN_TASK_STATUSES`, `SETTLED_TASK_STATUSES`, so the
  server and the panel stop spelling out their own `completed || failed ||
  cancelled` chains.
- **Delivery (`src/quality-gates.ts`):** `superseded` is excluded from blockers
  exactly like `cancelled` (the non-quality loop, the "all work was cancelled"
  rule, the quality loop) and `unconfirmedWaivers` skips dead work — a replaced or
  cancelled task keeps its waivers as history without blocking delivery forever.
- **Tool (`src/tools.ts`):** new captain-only `agent_teams_supersede_task`
  (`task_id`, `reason`, `replacement`, plus the create_task fields for the inline
  path). One locked operation: create-or-resolve the replacement, apply
  `applySupersession`, write, revoke the previous owner's activation, emit
  `agent-teams/task-superseded`, kick the scheduler. `TEAM_TOOL_NAMES` grows to 15;
  `capabilities.test.mjs` pins the new count.
- **UI:** `VisualTaskState`/`taskTone` gain `superseded`, the panel draws it in its
  own faded-striped grey (not the error colour) with the `task.status.superseded`
  label in both locales, the progress summary reports it separately in the final
  line, and a client-side `settledTask()` replaces the literal status chains.
- **RED first:** the tdd group failed on the new matrix and on
  `tdd.supersede.delivery-ignores-superseded` (`w1 (work) is not completed`);
  lifecycle and stress had no scenario yet.
- **GREEN:** `quality-gates-tdd` 115 PASS / 0 FAIL; `verify.mjs` 232 PASS / 0 FAIL
  (two new checks: the captain-only tool with its atomic redirect, and the reader
  accepting a superseded task with or without `supersededBy`); lifecycle
  `all lifecycle checks passed` with six new supersede checks (replace in place,
  same team/lane, dependents + reviews follow, the old capability is refused, the
  dependent still waits, completing the replacement unblocks it); stress
  `all complex stress checks passed` with three new mid-graph checks.
- **Deviation from the plan, recorded:** the plan asks for the supersede scenario
  in the middle of the **31-node** graph. That graph ends with every task completed
  and the suite asserts the exact final counts (38 tasks, all completed), and a
  completed task is immutable by design, so the scenario runs on its own
  three-node chain inside `stress-verify.mjs` instead (`Supersede Matrix`). It
  proves the same scheduler property — a supersede mid-graph rewires the leaf and
  the scheduler drives it once the replacement completes — without weakening the
  existing assertions.
- **Honest test adaptations:** the earlier `sweeper`/`kappa` variants failed
  because a member whose only task is blocked is never spawned (no session to
  claim with) and because the scheduler may claim the replacement before the test
  looks at it; the checks now wait for the real spawn and assert "not terminal"
  instead of a status that races the scheduler.

### S08 — WP2: the whole contract is amendable, and a failed lane retries (done)

Planned test labels (WP2 of the plan): amend `deliverables`, `reviewedTaskId`
(valid / nonexistent / not an implementation), amend a `work` task, amend a
`failed` task followed by `reassign` and a successful completion, `force`
invalidates the review; the lifecycle scenario "captain undercounted inScope →
amend → member completes without recreate".

- **Rule (`src/quality-gates.ts`, `src/state.ts`, `src/types.ts`):**
  `ContractAmendmentInput` gained `deliverables`, `nonGoals`, `reviewedTaskId`,
  `subject`, `description`; `amendTaskContract` takes a sixth `force` parameter and
  returns `invalidatedReviews`. The field sets are split: a quality task amends the
  whole contract, a `work` task amends `subject`/`description`/`deliverables`/
  `nonGoals` and is rejected by name when a quality field is attempted.
  `reviewedTaskId` must exist, must not be the task itself, and must point at an
  `implementation`/`repair`/`verification`/`integration` task. `completed` and
  `cancelled` stay immutable; `failed` became amendable. `force` overrides the
  post-review freeze and marks the passing verdict `stale` (new durable
  `ReviewVerdict`), so the changed contract must be reviewed again.
  `TASK_TRANSITIONS.failed` is now `['pending']` — the retry `reassign_task`
  already performed through `invalidateTaskAttempt`.
- **Tools (`src/tools.ts`):** `agent_teams_amend_task` exposes the new payload plus
  `force`, applies the staled verdicts inside the same team lock, returns
  `staled_reviews`, and its description says what is amendable. A running team's
  `update_task` now accepts `dependencies`/`assignee` edits for `pending` (any
  attempt) and `failed` tasks; `claimed`/`in_progress` still refuse, because that
  edit belongs to the S10 replan with attempt invalidation. `agent_teams_status`
  prints `revised ×N` for an amended contract.
- **RED first:** the amend suite showed 5 new failures out of 15 (no
  `invalidatedReviews`, no new fields, work tasks rejected),
  `tdd.state.transition-table-covers-every-status` and
  `tdd.state.failed-retry-transition-is-legal` failed, and the lifecycle scenario
  died at `task t1 is failed; terminal contracts are immutable`.
- **GREEN:** amend suite 15/15; `quality-gates-tdd` 108 PASS / 0 FAIL; lifecycle
  `all lifecycle checks passed` including the three new ones (`a failed contract is
  amendable and the revision is recorded`, `the retry keeps the same task in the
  same lane instead of recreating it`, `the amended contract completes without
  cancelling or recreating the task`); `verify.mjs` 230 PASS / 0 FAIL with four new
  source-level checks (the extended amend payload, the stale verdict kept out of the
  member-facing enum, the `revised ×N` status line, the running-team edit rule).
- **Two honest test adaptations:** the retry assertion first demanded
  `status === 'pending'`, but `reassign_task` returns after it has already kicked
  the member, so the task may be dispatched again — the check now asserts identity,
  lane, amendment and a live generation instead of a status that races the
  scheduler. The new lifecycle block also read the shared `task()` helper, which is
  bound to the `lifecycle` team, and now reads its own team.
- **Split of `stale` from WP3:** the plan lists `verdict: stale` under both WP2 and
  WP3. It ships here with the force path, which is the only producer; WP3/S09 reuses
  the value for `superseded`. `superseded` itself is deliberately **not** in the
  transition table yet — the status does not exist until S09.
- **Deferred to S10 (planned, not scope creep):** editing `dependencies`/`assignee`
  of a `claimed`/`in_progress` task needs the replan operation with explicit
  `invalidate: true`, which is WP4.

### S07 — docs + release 0.1.21 (done, `74fc749`)

Scope: WP1 + WP2-free docs, WP5, WP6.1, WP6.2, WP9-a, WP10, plus the scheduler
fix found by the t5 replay. Two extra commits belong to this step:
`0108c81` (scheduler) is recorded here because the t5 replay — which is part of
the S07 release checklist — is what found it.

- Release mechanics: `package.json` 0.1.20 → 0.1.21; `release-notes/v0.1.21.md`
  (style of `v0.1.19.md`); `README.md` / `README_ZH.md` version references and
  the new features in both capability tables; `readme-version.mjs` reports
  "match 0.1.21"; `compatibility.json` deliberately unchanged (the supported
  host matrix did not move). Decision D5 is mentioned in the release note as
  **upcoming in 0.1.23**, with no tool-signature change in 0.1.21.
- Docs: `docs/quality-gates.md` gained §1.3 (waived / no_regression, with the
  incident reference), the new statuses and criterion/confirmation shapes in
  §5.2, the completion rules and the waiver confirmation path in §6.2, and the
  completed-work-only path audit plus the unconfirmed-waiver blocker in §6.7.
  `agent_teams_update_task` / `agent_teams_create_task` descriptions now explain
  `waived`, `no_regression` and `waiverConfirmation`; `qualityPlanningPrompt`
  gained the "write the criterion for the measurement you want", "a waiver is
  not a way to close work", and "overlap serialization follows the closure"
  rules. Locale keys shipped with S06 (zh first, then en).
- **Traps found and written down (see `.local/TRAPS.md`):**
  1. **PowerShell round-trips destroy UTF-8.** Twice
     (`scripts/lifecycle-verify.mjs`, `.local/t5-replay.mjs`):
     `(Get-Content -Raw) -replace ... | Set-Content -Encoding utf8` mangled
     Cyrillic, em dashes and box-drawing into `â€"` / `Â§`. Both times the file
     had to be restored from git and the edits re-applied through the file
     tools. Root cause: Windows PowerShell 5.1 reads without an explicit
     encoding as ANSI. Rule now: edit sources only with `read`/`edit`/`write`;
     after any bulk replace, grep for `â€|Â` and expect zero.
  2. **A member's own fresh attempt is not a lost owner** (`0108c81`). The
     scheduler re-claimed the task under the member, so `in_progress` dropped
     back to `claimed`, the attempt counter grew, and the member's next
     `update_task` failed as stale or as an illegal transition. Fixed by
     `noteClaimedAttempt` (the plugin declares the capabilities it mints) plus
     the rule that recovery is a *fallback*: fresh `nextReadyTask` work wins.
  3. **Background kicks make team state non-deterministic.** `update_task`
     writes and then kicks the scheduler without awaiting it, so a later step
     can read a state an earlier step never produced. A signal aborted right
     after the call keeps the write and makes the kick a no-op — that is the
     `settle()` helper in the replay.
- **Deliberately changed test expectations** (documented, not silently
  weakened):
  - `unobserved missing owner recovers once and repeated kicks do not rotate it
    again` → `a member-minted capability is never recast as an unobserved owner`.
    The old assertion *demanded* the buggy behaviour (a disposed handle on a
    member-minted attempt had to rotate the attempt). The recovery throttle it
    was really about is still asserted by the `tRecoverFail` case above it, and
    the new worker-level regression is at the end of the file.
  - `reassignment quiesces recovered owner and creates a new attempt` — its
    old precondition (`disposedParkedAlpha`) is no longer reachable; the same
    claim (reassignment revokes the capability and mints a new attempt) is now
    asserted against the task's own before/after state.
  - `previously interrupted member is reused in a later round` — added polling,
    because `create_task` kicks the scheduler without awaiting it and the old
    synchronous read only passed by accident.
  - `tdd.complete.ordered-evidence-tolerates-model-paraphrase` →
    `tdd.complete.whitespace-and-punctuation-differences-tolerated` (S03): the
    old label asserted the length-parity fallback that WP1 removes on purpose.
- **Left out:** the t5 replay drives the real compiled tools through a fake host
  rather than a live LLM session: the real-host matrix is sandbox-blocked, so
  the transcript under `.local/logs/t5-replay-<version>.log` is tool-level
  evidence, not model-level. `sharedInScope` / `accept_paths` docs are waiting
  for S10, `supersede` for S09. `.local/TRAPS.md` and `.local/FOLLOWUPS.md`
  were created in this step (the latter was missing although the branch rules
  require it).

### S06 — WP10: phases, agents and queues views

Planned test labels (`scripts/verify.mjs`, new group `6b/8`):

- `phase columns on an empty plan are empty`
- `phase columns follow the DAG levels`
- `manual phases take precedence over the DAG levels`
- `manual phases keep the DAG levels inside the unphased column`
- `agent swimlanes keep one row per member plus an unassigned row`
- `swimlane buckets split completed, running, queued and blocked work`
- `swimlane marks finished work as completed`
- `unassigned tasks get their own lane`
- `queue reports a member whose only task failed as all-done`
- `queue reports all-done for a member whose work is terminal`
- `queue reports the blocking dependency by id`
- `the same blocking id reaches the agent view`
- `queue reports waiting-review-of while the reviewed task is still open`
- `queue reports no-tasks for a member without work`
- `idle reason formatting covers every variant`
- `queue overview counts idle members and groups the reasons`
- `idle reasons name the blocking task from the feedback run`
- `agent colours are stable per name, shared by all three views and distinct across the roster`
- `phase board keeps one fixed X per phase column`
- `phase board draws an edge per dependency that landed on the board`
- `phase board height follows the busiest column`
- `persisted view choice falls back to the dependency tree`

- **Changed:** `activity-model.ts` gained the WP10 pure projections —
  `phaseColumns`, `phaseBoardLayout`, `agentSwimlanes`, `agentQueue`,
  `queueOverview`, `idleReasonSummary`, `agentColor`, `parseActivityView` and
  the `PhaseTask`/`ProjectionMember`/`ManualPhase` shapes. `ActivityPanel.tsx`
  grew a `ViewSwitcher` (`Tree | Phases | Agents | Queues`, choice persisted in
  `localStorage` under `ACTIVITY_VIEW_STORAGE_KEY`), a `PhaseBoard` with fixed
  X per phase, `AgentSwimlanes` and `QueueView`; the tree's node button was
  extracted into a shared `TaskNode` that paints the agent dot with
  `agentColor`. `snapshot.ts` / `activity-monitor.ts` forward `attempt` and
  `reviewedTaskId` (fields only, no logic). 30 locale keys were added to `zh`
  first and then `en`; the module CSS gained the view/phase/swimlane/queue
  blocks.
- **Tests prove:** DAG levels, manual-phase precedence, the unphased fallback,
  swimlane bucketing, the `blocked-by` / `all-done` / `waiting-review-of` /
  `no-tasks` idle reasons, grouping arithmetic, stable agent colours, the phase
  board geometry (fixed column X, edge per landed dependency, busiest-column
  height) and the view persistence fallback. verify 188 → 210 PASS / 0 FAIL;
  qg-tdd unchanged at 106/0; all 18 suites exit 0; `lib/client.js` contains the
  new views.
- **Left out:** two things are deliberately *not* done here. (1) The plan's WP10
  text says `agentQueue` may derive `waiting-review-of` from `reviewedTaskId`
  "if the field is forwarded" — I forwarded it and implemented the reason
  properly, including the correction that a `review` task is not claimable
  before the task it judges finishes; without that, the reason could never fire
  because a review with no dependencies always looked claimable. (2) The
  queue-overview count is *not* the plan's illustrative "idle 8 / 9": idle is
  defined mechanically as "no claimable task right now", so the three members
  whose only work already completed are excluded and the four holding a pending
  task count as busy-but-waiting. The test asserts that rule and that the groups
  account for every idle member, rather than a number copied from the plan.
  `phaseBoardLayout` is exported and unit-tested but the plan's
  `compactDagLayout` remains the tree's layout; I did not fold the two together
  because the tree must keep depth columns while the board must keep phase
  columns. Panel rendering itself was not exercised in a browser: the sandbox
  blocks the real-host matrix, and `.local/SETUP.md`'s scratch profile serves
  only the built bundle. `planProgress` (WP8) is intentionally absent — it is
  S16.
- **Note for S17 (decision D4, no rework owed here):** S06 ships the part of
  the phase model that does not need `plan.phases` — manual phases win, and
  without any declaration the columns come from topological depth. The two
  remaining rules of D4 are additive and land with `plan.phases` in S17:
  (a) a task no manual phase lists is fitted into the phase of its **nearest
  DAG ancestor** instead of the `unphased` column, and (b) a task whose manual
  phase sits **lower** than a dependency's phase is **lifted** to that
  dependency's phase and flagged. Both change `phaseColumns` /
  `phaseBoardLayout` only; the panel already renders whatever columns they
  return.

### S05 — WP6.1: profile lint and `doctor.mjs --profiles`

Planned test labels (in `scripts/quality-gates-tdd.mjs`, group M):

- `tdd.profiles.misplaced-key-names-its-parent-scope`
- `tdd.profiles.valid-profile-passes-the-lint`
- `tdd.profiles.near-miss-key-still-suggests-the-close-name`
- `tdd.profiles.nested-scopes-are-checked-too`
- `tdd.profiles.doctor-lint-accepts-a-valid-config`
- `tdd.profiles.doctor-lint-reports-the-exact-fix`

- **Changed:** `profiles.ts` grew a key-scope table (`PROFILE_KEY_SCOPE`,
  `REVIEW_POLICY_SCOPE`, `MEMBER_KEY_SCOPE`, `TASK_KEY_SCOPE`,
  `FALLBACK_SCOPE`), a `suggestNestedProfileKey` second-level hint inside
  `assertAllowedKeys`, an exported `lintProfileKeys` (key structure of every
  profile, its members, tasks, fallbacks and reviewPolicy) and
  `findProfilesInConfig` (locate the profile map inside a bare, `plugins`-nested
  or composed `cordis.patch.yml`-shaped document). `doctor.mjs` gained
  `--profiles <file>` / `inspectConfiguredProfiles`. `allowWaivers` was added to
  `REVIEW_POLICY_KEYS` and to the plugin config schema in `index.ts` — without
  the schema entry the host would strip it before WP1's rule could read it.
- **Tests prove:** `requiredReviewers` at the top level now reports
  `is unknown at this level; requiredReviewers belongs under reviewPolicy
  (profiles.material.reviewPolicy.requiredReviewers)`; a well-formed profile
  passes; a near-miss key still gets its Levenshtein suggestion; the nested
  scopes (member `fallback`) are checked too; and the doctor script accepts a
  valid config and reports the exact fix for a bad one, BOM included. CLI run
  verified by hand against a fixture. verify 188 PASS / 0 FAIL, qg-tdd 101 → 106
  PASS, all suites exit 0.
- **Left out:** the flag reads the *provider config as JSON*, not composed YAML.
  `cordis.patch.yml` is a patch list in YAML and the plugin declares no YAML
  parser, so adding one would mean touching `pnpm-lock.yaml`, which the branch
  rules forbid. The doc comment and the error message say so explicitly, and
  `findProfilesInConfig` still accepts the shapes a JSON export produces
  (`{profiles}`, `{plugins:{'agent-teams':{config:{profiles}}}}`).
  `lintProfileKeys` validates the key structure only: `resolveTeamProfile`
  needs `maxMembers`, resolves model routes through the host and normalizes seed
  tasks, so it cannot run in a config-only lint; the doctor's `limits` line
  states that boundary.

### S04 — WP6.2: Delivery ignores dead tasks; the path audit follows completed work

Planned test labels (in `scripts/quality-gates-tdd.mjs`, group L):

- `tdd.delivery.cancelled-task-paths-are-not-blockers`
- `tdd.delivery.path-audit-follows-completed-work-only`
- `tdd.delivery.completed-task-unaudited-path-still-blocks`

Must stay green: `tdd.delivery.ok-only-when-all-gates-pass`,
`tdd.delivery.failed-review-without-repair-blocks`,
`tdd.delivery.unconfirmed-waivers-block`.

- **Changed:** the unaudited-path loop in `canDeclareDelivery` is now gated on
  `item.status === 'completed'`, so a `cancelled` task's leftover `changedPaths`
  can no longer block Delivery. `cancelled` tasks were already excluded from the
  quality-task blocker loop, so the two policies now agree.
- **Tests prove:** a cancelled implementation with out-of-scope `changedPaths`
  produces zero blockers and no path line at all; the audit still fires for a
  completed task with an undeclared path (`t2 has unaudited path
  src/unlisted.ts`), so the filter cannot be mistaken for switching the gate
  off. verify stayed 188 PASS / 0 FAIL, qg-tdd 97 → 101 PASS, all 18 suites
  exit 0.
- **Left out:** the `superseded` half of WP6.2 belongs to S09/WP3, where that
  status is introduced — the loop's status filter is the hook it will use. I did
  not touch `cancelUnfinishedTask` to clear `changedPaths`: the feedback asked
  for the report to ignore dead work, and clearing audit data on cancel would
  destroy the record the archive is kept for.

### S03 — WP1: `waived` acceptance and `no_regression` criteria

Open-question decision Q1 applied: a member may submit `status=waived` with a
non-empty `evidence`; the task records `hasWaivers`, and the reviewer has to
confirm the waivers in its own verdict data, otherwise Delivery is blocked with
`<id> has unconfirmed waivers`. `reviewPolicy.allowWaivers: false` disables the
mechanism (a `waived` result is then just an invalid result).

Planned test labels (in `scripts/quality-gates-tdd.mjs`, group K):

- `tdd.complete.waived-requires-evidence`
- `tdd.complete.waived-counts-as-covered`
- `tdd.complete.no-regression-needs-baseline`
- `tdd.complete.waived-rejected-when-policy-forbids`
- `tdd.complete.paraphrased-criterion-rejected`
- `tdd.complete.normalized-criterion-text-accepted`
- `tdd.complete.missing-criterion-names-the-criterion`
- `tdd.delivery.unconfirmed-waivers-block`
- `tdd.delivery.confirmed-waivers-do-not-block`
- `tdd.state.waived-result-round-trips`
- `tdd.state.criterion-object-accepted`
- `tdd.state.waived-without-evidence-rejected`

`scripts/verify.mjs` round-trip additions (group 4, on-disk flow):

- `waived acceptanceResults and commandsRun survive a team.json round trip`
- `a criterion object in acceptance survives a team.json round trip`
- `legacy string criteria still read`

Labels that change intent on purpose (plan §2 WP1: "remove the length-parity
fallback"): `tdd.complete.ordered-evidence-tolerates-model-paraphrase` is
renamed and re-pointed at the normalization rule rather than at list-length
parity — the old assertion *is* the bug being removed.

- **Changed.** `AcceptanceResult.status` / `CommandResult.status` gained
  `waived` (evidence mandatory); `acceptance` entries may now be
  `{text, mode, baseline}`; `reviewPolicy.allowWaivers` (default true) can
  disable the mechanism. New pure rules in `quality-gates.ts`:
  `acceptanceCriterionText`, `uncoveredAcceptance`, `uncoveredCommands`,
  `normalizeCriterionText`, `resultCovered`, `reportsWaiver`, `taskHasWaivers`,
  `waiversConfirmed`, `unconfirmedWaivers`. The length-parity fallback in
  `acceptanceCovered` / `verifyCovered` is gone, replaced by normalized-text
  matching that names every uncovered criterion in the error.
  `evaluateQualityCompletion` takes `allowWaivers` as an optional third
  argument (default true — the pure rule stays pure; `update_task` passes the
  team policy in). `update_task` gained a review-only `waiverConfirmation`
  parameter and persists `hasWaivers`. `status` per task now reports
  `waived` and `waivers_unconfirmed`, and `renderStatus` prints them.
- **Tests prove:** a waiver without evidence is refused; a waiver counts as
  covered only when the policy allows it; `no_regression` needs a baseline in
  the evidence; an unrelated criterion can no longer satisfy the contract (the
  exact regression the length-parity fallback caused); whitespace/punctuation
  differences are still tolerated; the error names the missing criterion;
  delivery is blocked with `t1 has unconfirmed waivers` and unblocked by an
  explicit `waiverConfirmation`, while a merely passing review does not
  confirm; the new statuses and shapes round-trip through `team.json` while an
  old file still loads. verify 183 → 188 PASS / 0 FAIL, qg-tdd 84 → 97 PASS.
- **Left out.** `waived` matching is by normalized text, deliberately not
  semantic — the plan asks for a *removed* fallback, not a fuzzy one, so a
  genuinely paraphrased criterion is still rejected on purpose. The
  alternative waiver-confirmation designs (a free-text mention in `output`, a
  magic `confirm_waivers: true` flag) were dropped for an explicit structured
  `waiverConfirmation` object: it is machine-checkable, it names the task, and
  it cannot be produced by accident. `team.json` keeps `acceptance` as strings
  in the schema but now also persists criterion objects; `hasValidQualityTaskFields`
  validates both. Tool descriptions, `qualityPlanningPrompt` and
  `docs/quality-gates.md` §6.2 are still untouched on purpose — the linear
  order puts them in S07.

### S02 — WP5: overlap-skip by transitive dependency closure

Planned test labels (in `scripts/quality-gates-tdd.mjs`, group J):

- `tdd.scope.overlap-skipped-for-transitive-dependency`
- `tdd.scope.overlap-still-rejected-for-shared-ancestor-only`
- `tdd.scope.overlap-skipped-when-existing-task-depends-on-the-new-id`
- `tdd.scope.overlap-still-rejected-without-path`
- `tdd.scope.no-dead-pending-new-condition`

Must stay green: `tdd.create.overlapping-inscope-rejects-parallel-ready-tasks`,
`tdd.create.overlapping-inscope-allowed-when-serialized`.

- **Changed:** the overlap gate in `validateCreateTask` no longer tests
  `dependencies.includes(other.id)`. It calls a new `serializedAgainst` helper
  that asks two upstream questions: is `other` in the transitive closure of the
  candidate's dependencies (the old direct test was its one-hop case), and is
  the candidate's future id inside `other`'s own dependency closure. The dead
  `other.dependencies.includes('pending-new')` term is gone. `CreateTaskInput`
  gained an optional `nextTaskId`, which `agent_teams_create_task` now supplies
  as `t${taskSeq + 1}` — the pure validator does not allocate ids.
- **Tests prove:** a two-hop serialization is accepted
  (`candidate → t1 → t2`); a merely shared ancestor is still refused (the naive
  fix — treating any shared dependency as serialization — would have waved a
  real conflict through); the mirror direction is exercised with a control call
  that uses a different next id, so the pass cannot come from anything else;
  and a task carrying the phantom `pending-new` dependency no longer bypasses
  the check. verify stayed at 183 PASS / 0 FAIL, qg-tdd went 79 → 84 PASS.
- **Left out:** I first wrote the helper with the closure direction inverted
  (`dependencyClosureContains(tasks, candidateDeps, other.id)` asks *"is other
  upstream of the candidate"*, not *"is the candidate fenced behind other"*),
  and the RED run caught it — that is why the negative
  `…-shared-ancestor-only` case exists. The reverse lookup for the `edit_plan
  update_task` / replan path (WP5's second half, plan §2 WP5) is deferred to
  S17/WP7: `validateCreateTask` cannot see the task being replaced, because
  `updatePlanBatch` deliberately filters it out of `team.tasks` before calling
  it. The `nextTaskId` plumbing is already in place for that caller.
  Tool descriptions and docs for the changed gate are deliberately left to the
  S07 docs step, as the linear order requires.

### Deployment — 0.1.21 live in the `web` profile (verified 2026-09-20, no code change)

Owner installed `dsh-agent-teams-0.1.21.tgz` into `C:\Users\whitl\.dsh\profiles\web`
and restarted the `web` server (PID 158768, started 00:40:30). Verification, all
evidence-based, nothing inferred from the fact that the server answers:

- **Installed bytes are ours.** `lib/{client,index,scheduler,quality-gates,harness-compat}.js`
  SHA256 in the profile equals the local `lib/` build one-to-one.
- **The host loaded the plugin.** Both post-restart session logs
  (`~/.dsh/sessions/--D-OwlCats-AI_Tools--/session-6d7bc1d2…` and
  `--D-OwlCats-DCB--/session-58b6ae05…`) contain all 14 `agent_teams_*` tool names,
  the captain-protocol section, and the 0.1.21-only vocabulary
  (`waiverConfirmation`, `allowWaivers`, `has unconfirmed waivers`, `no_regression`).
  Reproduce with `node .local/verify-deployed-session.mjs <session.v3.jsonl.zstd>`;
  the logs are **multi-frame** zstd, `node:zlib` decodes only the first frame, so
  the script splits on the frame magic (2664 frames decoded, 0 unreadable).
- **Client panel composes.** `dsh.client.platform = "web"` and
  `exports["./client"].default = "./lib/client.js"` exist (237 192 bytes, written by
  the install); all seven `dsh.client.inject` targets resolve at `0.1.5-rc.2` in the
  host tree. Composition failure throws at registry construction, so a served
  `dsh web` is itself the proof that composition passed.
- **Do not read 404 on `/plugins/…` as "not registered".** Bundles are served only
  for the exact advertised revision URL (`/plugins/??<id>/client.js&rev=<opaque nonce>`);
  a bare `/plugins/<id>/client.js` 404s for host plugins too. Our plugin's own routes
  do answer: `/plugins/dsh-agent-teams/state` → `401 {"error":"unauthorized"}` while an
  unknown plugin id → empty `404`.
- **Host version.** The global CLI reports `0.1.5-rc.1`, but every
  `@deepseek-ai/dsh-*` runtime in that tree is `0.1.5-rc.2` (installed 2026-09-14,
  unchanged by the restart) — the plugin runs under rc.2 in practice.

### F4 — artwork cache revision, release 0.1.22 (owner report: "не вижу наших иконок")

Reported while verifying the 0.1.21 deploy: the panel rendered the whale captain
and whale members, while the installed package held the amber pack. Established
facts, in this order:

- the deployed `lib/{client,index,scheduler,quality-gates,harness-compat}.js` and
  all 30 `assets/agent-teams/*.png` are byte-identical to this checkout, and the
  running server is 0.1.21 (`allowWaivers`/`waiverConfirmation`/`no_regression`
  are absent from the 0.1.18 copy in `martty`, present in my own tool schema);
- the whale art the panel showed is `47183d8`'s pack — the *same file names*
  (`member-engineer-v2.png`, `team-lead-v2.png`) as the amber pack;
- the route served them with `cache-control: public, max-age=86400`, so the
  browser never asked again after the upgrade.

So this is a browser-side staleness with a server-side cause: stable URLs plus a
day-long cache plus changing bytes. Fixed by revisioning the URL, not by asking
the owner to clear a cache.

- **Changed:** `src/client/artwork.ts` builds every URL through one `artUrl()`
  helper that appends `?v=<ART_REVISION>`; the new generated module
  `src/client/art-revision.ts` holds the revision; `scripts/art-revision.mjs`
  derives it from the sorted, length-framed pack bytes and regenerates the module
  with `--write`; the art route moved out of `src/index.ts` into `src/artwork.ts`
  (`serveArtwork` + `ART_ALLOWLIST`) so the request shape is testable, and it
  still reads the URL *path* only (the query is never part of the file name).
- **Gates:** `pnpm build` now starts with `node scripts/art-revision.mjs --check`,
  and `scripts/verify.mjs` re-derives the same value, so a swapped icon without
  `pnpm art:revision` fails the build with
  `artwork revision is stale: committed …, pack …`.
- **Tests (RED first):** `lib/client/art-revision.js` was missing → the suite
  died with `ERR_MODULE_NOT_FOUND`, then the five new checks went green:
  `the committed artwork revision describes the packaged images`,
  `a redrawn artwork file changes the revision` (temp copy, one byte flipped),
  `every artwork URL carries the pack revision`,
  `the artwork route ignores the cache-busting query` (byte-compared against the
  packaged file, headers unchanged), `the artwork route serves allowlisted names
  only` (unknown name, `../package.json`, `%2e%2e%2fpackage.json`, bare prefix).
  Two existing checks were adapted, not weakened: they now read the path without
  the query before asserting `-symbol.png`, and the allowlist-or-client-mapping
  check reads `src/artwork.ts` instead of `src/index.ts`.
- **Mutation test:** replacing the name extraction with a raw `req.url` split
  rebuilt green but failed the suite (`the artwork route ignores the
  cache-busting query — status=404`), which is what proves the check is not
  vacuous. Reverted, rebuilt, 219 PASS / 0 FAIL.
- **Release:** version 0.1.22, `release-notes/v0.1.22.md`, README release entry +
  version table + roadmap renumbering, `docs/maintenance-workflow.md` gained
  "Changing the activity-panel artwork", `docs/usage.md` lost its stale "whale
  artwork" bullet. The plan's later releases shift by one (S13 → 0.1.23,
  S15 → 0.1.24), recorded in the step table above.
- **Local suite (all exit 0, logs in `.local/logs/release-0.1.22/`):**
  typecheck; build (`artwork revision: 5a90736f927c`); `verify.mjs` 219 PASS /
  0 FAIL; `quality-gates-tdd` 106 PASS / 0 FAIL; `fallback-tdd`,
  `member-failure-tdd`, `lifecycle-verify`, `stress-verify`, `web-routes-verify`,
  `harness-compat-tdd`, `stability-tdd`, `compatibility`, `readme-version`
  ("match 0.1.22"), `verify-package`, and the eight `*.test.mjs` files;
  `sync-skill --check` (10 skills / 121 files) and `lang-check` (policy clean).
  Left for CI: the whole `pnpm verify` chain, `compatibility.test.mjs`, and the
  real-host matrix.
- **Owner UI follow-up (same release, before the first restart):** the member
  portrait carries one corner mark instead of two — the role symbol is gone from
  the avatar (the row names the role in words) and the captain avatar lost its
  role mark too. The role pack then became the **compact** mark (owner's answer to
  "where should they go"): 12 px in the DAG node head (both the full map node and
  the phase-board `TaskNode`), the task-detail assignment line and the Queues rows,
  resolved by the new pure `ownerSymbolUrl(assignee, members)` in
  `src/client/artwork.ts` (captain → lead mark, unknown/unclaimed → null, caller
  keeps its coloured dot). The collapsed pill now draws the action symbol
  (`working`/`idle`) instead of the plain dot.
  `ActivityPanel.tsx` dropped `memberSymbolUrl` from the avatar, the
  `.memberSymbol`/`.leadSymbol` rules left `ActivityPanel.module.css`, and
  `.compactSymbol` (12 px) plus `.badgeSymbol` (13 px) were added. The old check
  `the small corner badge draws both marks from the symbol packs` was replaced by
  four: `the corner badge draws the activity mark only, from the symbol pack` (the
  avatar must render *no* role mark), `the role symbol pack stays resolvable for
  the compact slots`, `compact surfaces resolve an owner through the role symbol
  pack` (unit: captain / member / empty / unknown) and `the compact surfaces draw
  the symbol packs and keep a fallback`. `verify.mjs` 222 PASS / 0 FAIL.
- **Legibility check before shipping the sizes:** rendered all nine role and six
  action symbols at 12/13/18 px next to mock DAG-node, queue-row and pill markup
  with the real `256` pack files (`Chrome --headless=new`, 3× scale,
  `.local/tmp/preview/compact.{html,png}`) — every mark stays distinguishable at
  12 px, so the sizes are measured rather than guessed.
- **Owner UI round 2 (same release, still before the first restart):** four
  changes from the deployment screenshot review.
  1. **Phases scrolled twice** — the phase titles had their own `overflow-x`
     scroller (`.phaseColumns`) while the canvas had `.dagViewport`, so a scrolled
     header row drifted away from its columns. One scroller now
     (`.phaseBoardScroll`) holds a `.phaseHeaderRow` (each header at the very `x`
     the layout gave its column) plus the canvas. Check: `phase headers and the
     board share one scroller`.
  2. **DAG node heads lost the symbol** (owner: unreadable next to a 9.5px id) —
     both heads are text + the small dot again, and the role mark survives only in
     the assignment line and the Queues rows. Check: `the dependency boards keep
     their node heads text-only` (asserts exactly two `compactSymbol` uses).
  3. **Agents view removed** (owner: the member tree above already carries it) —
     `ActivityViewMode` is `tree | phases | queues`, `parseActivityView('agents')`
     falls back to `tree`, the `AgentSwimlanes` component and the whole
     `.swimlane*` CSS block are gone (the queue row's dot became `.queueDot`), and
     the seven now-unused locale keys were dropped from both dictionaries. The
     model projection `agentSwimlanes` stays and is logged as FOLLOWUPS F5, so
     nobody has to guess whether it is dead or pending.
     Check: `the panel offers the tree and the two surviving cuts only`.
  4. **The members-tree portrait spans the whole block** (owner: half a column was
     empty beside `Captain assigned`) — the assignment line moved inside the
     member row (a `span`, since a `div` is invalid in a `button`) and the avatar
     spans both grid rows, capped at 76px; the name keeps its width and the role
     text yields first. Check: `the member portrait spans the whole block in the
     members tree`. Rendered from the built stylesheet with real artwork before
     shipping (`.local/logs/release-0.1.22/preview/members-tree.png`).
  `verify.mjs` **226 PASS / 0 FAIL**, all 20 suites and both policy checks green.
- **Artifact (rebuilt after the UI round):**
  `.local/dist/nanmicoder-dsh-agent-teams-0.1.22.tgz`, 2 238 424 bytes, SHA256
  `ED94A24A…E7B3`; the three superseded builds (`6A6524EB…381F`, `4DF0EC6E…33C3`,
  `5AB07C2E…38EE`) never reached a restart. The reinstall note from the previous
  round still applies: remove before re-adding the same `file:` spec, then restore
  the `dsh.profile.bundles` order.
- **Artifact (rebuilt after the compact marks):**
  `.local/dist/nanmicoder-dsh-agent-teams-0.1.22.tgz`, 2 240 640 bytes, SHA256
  `5AB07C2E…38EE`; the two superseded builds (`6A6524EB…381F` at 2 238 040 bytes,
  `4DF0EC6E…33C3` at 2 237 711 bytes) never reached a restart. Note for the next
  install: re-adding the *same* `file:` spec makes pnpm skip resolution, so the
  package must be removed first (the `dsh.profile.bundles` order was restored to
  `dsh-base, dsh-web-app, @nanmicoder/dsh-agent-teams, dsh-agent-status-bar` after
  each re-add).
- **Deployed** into `C:\Users\whitl\.dsh\profiles\web`
  (`dsh plugin --profile web add --save-exact file:…0.1.22.tgz`): profile
  dependency points at the 0.1.22 tarball, installed version 0.1.22,
  `lib/client.js`, `lib/index.js`, `lib/artwork.js`, `lib/client/artwork.js` and
  `lib/client/art-revision.js` byte-identical to this checkout,
  `ART_REVISION = 5a90736f927c`, `member-engineer-v2.png` 39 838 bytes, the panel
  bundle carries `compactSymbol`/`ownerSymbolUrl` and no `css.badgeDot`, and
  `dsh --profile web --dump-config` still resolves `id: agent-teams`. The host
  picks it up on the next restart; the browser then asks for revisioned URLs, so no
  cache clearing is needed. Pre-install backups: `*.bak-2026-09-20-pre-0.1.22`
  (package.json, pnpm-lock.yaml, pnpm-workspace.yaml; plus
  `package.json.bak-2026-09-20-pre-reinstall`); rollback target is the 0.1.21
  tarball, which stays in place.

### S01 — WP9-a: one TASK_TRANSITIONS table

Planned test labels (all in `scripts/quality-gates-tdd.mjs`, group I):

- `tdd.state.single-transition-table-is-shared`
- `tdd.state.transition-table-covers-every-status`
- `tdd.state.completion-gate-uses-the-shared-transition-table`

Existing labels from the same step that must stay green: `tdd.complete.*`,
`tdd.state.invalid-verdict-rejected-at-durable-boundary`,
`tdd.resume.create-task-does-not-unhalt`.

- **Changed:** `STATUS_TRANSITIONS` (a byte-identical second copy of the state
  machine in `quality-gates.ts`) is gone; `quality-gates.ts` now imports and
  re-exports `TASK_TRANSITIONS` from `state.ts` and reads it inside
  `evaluateQualityCompletion`. `src/state.ts` is byte-identical to upstream —
  the first attempt added a re-export there and typecheck rejected it as a
  redeclaration (TS2323), because `state.ts` already defines and exports it.
- **Tests prove:** the object identity of `quality-gates.TASK_TRANSITIONS` and
  `state.TASK_TRANSITIONS` is the same reference; the six-status matrix matches
  the normative expectation in both directions (every listed transition is
  allowed, every unlisted one is rejected by `transitionError`); the completion
  gate rejects `pending → in_progress`, which is a table lookup, not a special
  case. Everything else stayed green: verify 183/0, qg-tdd 79/0, and all 18
  sandbox-safe suites exit 0.
- **Left out:** no status was added here (that is S09/WP3), so no persisted
  field changed and `verify.mjs` needed no round-trip case. A module-scope
  `const STATUS_TRANSITIONS = TASK_TRANSITIONS` had to be dropped in favour of
  reading the binding inside the function: at module-evaluation time the
  `state.ts` binding is still in its temporal dead zone
  (`ReferenceError: Cannot access 'TASK_TRANSITIONS' before initialization`),
  while an older-owner layout cannot work either because `quality-gates.ts`
  re-exports the pure-state helpers that `state.ts` must import.
