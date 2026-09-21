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
| S08 | WP2 amend_task extensions + retry from failed | done | d79296b | verify 230 PASS/0 FAIL; qg-tdd 108 PASS/0 FAIL; amend suite 15/15; lifecycle scenario amend→retry→complete |
| S09 | WP3 superseded + atomic dependency redirect | done | 481e89b | verify 232 PASS/0 FAIL; qg-tdd 115 PASS/0 FAIL; lifecycle +6 checks; stress +3 checks |
| S10 | WP4 accept_paths + sharedInScope + awaiting_scope_review | done | d80470f | verify 235 PASS/0 FAIL; qg-tdd 121 PASS/0 FAIL; lifecycle +3 checks (S08 check adapted to the new hold) |
| S11 | WP6.3 known-delta registry | done | 6d22d8b | verify 237 PASS/0 FAIL; qg-tdd 126 PASS/0 FAIL; lifecycle +5 checks |
| S12 | WP6.4 requiredReviewers enforced | done | 8bdea2d | verify 237 PASS/0 FAIL; qg-tdd 132 PASS/0 FAIL; fixture default list removed (see log) |
| S13 | docs + release 0.1.23 | done | fc0ba2c | version 0.1.23; notes + release record; tag v0.1.23 with the branch marker; artifact packed and installed into the web profile |
| S14 | WP11 phase 1 team_id addressing | done | | verify 240 PASS/0 FAIL; qg-tdd 132 PASS/0 FAIL; lifecycle 145 PASS/0 FAIL (+16 multi-team checks); all 21 suites exit 0; D5 schema-optional id with a listing error, D6 guard |
| S15 | docs + release 0.1.24 | done | | version 0.1.24; notes + release record; tag v0.1.24 with the branch marker; artifact 2 263 430 B / SHA256 `77423C11…4CBD` installed into the web profile; 0.1.23 was taken by the F4 hotfix |
| S16 | WP8 plan progress + task checklist | done | | verify 261 PASS/0 FAIL (+21); qg-tdd 134 PASS/0 FAIL (+2); lifecycle 147 PASS/0 FAIL (+2); all 21 suites exit 0; D3 both modes server-side |
| S17 | WP7 replan live team | done | | verify 288 PASS/0 FAIL (+27); qg-tdd 134 PASS/0 FAIL; lifecycle 152 PASS/0 FAIL (+5); stress 25 PASS/0 FAIL (+4); all 21 suites exit 0; tool count 18 → 19; D4 phases declared + DAG-level fallback |
| S18 | WP11 phase 2 N teams in UI + scheduler | done | | verify 288 PASS/0 FAIL; multi-team 14 PASS/0 FAIL (new suite, in the chain); lifecycle 152; stress 30 PASS/0 FAIL (+5); all 22 suites exit 0; liveCaptainTeam removed |
| S19 | WP11 phase 3 team limits | done | | verify 291 PASS/0 FAIL (+2); lifecycle 155 PASS/0 FAIL (+3); all 22 suites exit 0; four configured keys + slot summary in status |
| S20 | docs + release 0.2.0 | done | | version 0.2.0; notes + release record; artifact 2 317 040 B / SHA256 `FBBA6EBA…12EE` installed into the web profile; tag v0.2.0 with the branch marker; all 22 suites exit 0 |
| S21 | owner UI round + release 0.2.1 | done | | work plaque (full-node height, 3 dots wide) in the members tree; `cfe9338` UI commit + `09ac60e` release; verify 293 PASS/0 FAIL; artifact 2 318 783 B / SHA256 `2F73FAF8…D411` installed; tag v0.2.1 |
| S22 | owner UI round 2 + release 0.2.2 | done | | compact one-line member node, phase columns as chains, hatched cancelled nodes, tree/queues views and their model projections deleted; declared-phase regression fixed; progress block reduced to one bar; verify 271 PASS/0 FAIL; full `pnpm verify` exit 0; artifact 2 301 430 B / SHA256 `A8B2FF78…C48B` installed; tag v0.2.2 |
| S23 | round 3.1: three-row work plaque | done | | `WorkBar` rows 5 → 3; new check `the work plaque is three dot rows tall` (RED first: `rows=0, 1, 2, 3, 4`); verify 272 PASS/0 FAIL; full `pnpm verify` exit 0 |
| S24 | round 3.2: collapsible phases section | done | | `phase.toggle`/`phase.expand`/`phase.collapse` header with the column count and `data-phases-toggle`, board body rendered only while open; new check `the phases section collapses like the members list and the checklist` (RED first: `toggle=-1`); verify green |
| S25 | round 3.3: large member node by default, per-member fold to the tray | done | | 0.2.1 large node restored as the default, chevron folds one member into the compact tray; `memberStatusText` + 13 `member.status.*` + 4 `assignment.*` keys + `.memberRole`/`.memberStatusLine`/`.assignmentLabel` restored; tray action symbol un-stuck from the block corner; two RED-first checks |
| S26 | round 3.4: a phase can be closed | done | | captain-only `close_phase` replan op (allowed only when every task of the phase is terminal), closed phases refuse `create_task`/`add_task`/`move_phase` and point at a new phase, snapshot publishes `closed`/`closedAt`, board marks the column with a `Closed` chip and the plan editor disables it; five new checks; verify 285 PASS/0 FAIL |
| S27 | round 3.5: one progress bar in three colours | done | | `origin` (`plan`/`added`/`followup`) stamped at creation from `planHasSettled`, `progress.segments` on the host payload, three-zoned bar + named legend in the panel, four locale keys; four new checks; verify 285 PASS/0 FAIL; preview `.local/logs/ui-round3/progress-closed-phase.png` |
| S28 | hotfix + release 0.3.0 | done | | memoised chain walk (48 tasks/12 layers: 7 477 ms → 0.4 ms; 56/14: 130 230 ms → 0.4 ms) + `PanelErrorBoundary`; verify 287 PASS/0 FAIL; full `pnpm verify` exit 0; artifact 2 319 106 B / SHA256 `F8C2BA3E…F43F` installed and the bundle re-enabled in the web profile; tag v0.3.0 |
| S29 | Φ1/F1: replaced session no longer disables replan | done | | validation skips terminal tasks (settled = history, `failed` included) + the retry path demands an owner; four RED-first checks; verify 291 PASS/0 FAIL; `fc8a6b9` |
| S30 | Φ1/F3: a removal requeues only live work | done | | `requeueMemberTasks` + `requeueableOnRemoval` (pending/claimed/in_progress/awaiting_scope_review); RED showed the old filter requeueing `t1,t2,t3,t4,t6,t7,t8` (failed, cancelled, superseded); verify 293 PASS/0 FAIL; `a49e306` |
| S31 | Φ1/F6: bounded status report | done | | pure `src/status.ts` (`selectStatusTasks`): default view = 13 of 183 tasks, settled history counted but not printed, history outputs dropped; tool gained `live`/`task_id`/`since`/`include_output`; rendered text 64 432 → 1 518 chars on the run's shape; verify 297 PASS/0 FAIL; `8e4a337` |
| S32 | material-layers item 2: the dispatch cap counted a recorded status | done | | `workingMemberNames` counts the work a member holds (claimed/in_progress) instead of `member.status`, which is written from the host's `agent/status` stream; a new lifecycle scenario (`maxWorkersPerTeam: 1`, stale `working` record, no member holding work) is RED `spawns=0 status=pending` and GREEN `spawns=1 status=claimed`; verify 298 PASS/0 FAIL, lifecycle 160 PASS/0 FAIL |

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
- **D7 — the replan tool is the captain's, not the user's (owner note,
  2026-09-20, before round 3).** `agent_teams_replan` belongs to the captain's
  tool set like every other `agent_teams_*` tool; a human never calls it. What the
  user "adds" therefore arrives as work the captain creates. Consequences for
  round 3:
  - the **three progress segments** cannot be classified by "who called which
    tool". They are classified by the creation path: the approved plan
    (`agent_teams_create`), captain maintenance (an `agent_teams_replan`
    `add_task`), and captain `create_task` work added after the plan first
    completed — which is what a user's later request turns into;
  - **closing a phase** is likewise a captain action on a captain tool (an
    operation of the replan batch, next to `move_phase`), and the panel's
    running-plan editor only composes that same captain request;
  - "нельзя добавлять задачи в закрытую фазу" is enforced where the captain can
    add them: `agent_teams_replan` (`add_task`, `move_phase`) and
    `agent_teams_create_task`.
- **Owner confirmations (2026-09-20, after 0.3.0 was installed).**
  - **No "close phase" control in the panel.** Closing is the captain's action, and
    asking the panel for a button was my misreading — the caption-side note is
    recorded here so it is not offered again. The panel keeps only what it is for:
    marking a closed column and refusing to target it in the running-plan editor.
  - **The three-segment attribution is accepted as implemented**: "the plan has
    settled" means every plan-origin task is terminal at the moment of creation, and a
    task created then is `followup`. No stricter definition is wanted.

## Φ1 feedback batch (owner file `DCB/docs/AGENT_TEAMS_FEEDBACK_PHI1.md`, 2026-09-21)

The dx9 run: 183 tasks, 11 members, one captain session, phases Φ0 and Φ1 closed. The
page reports seven items with the tool's own words; the owner's priority order is
F1 → F3 → F6 → F2 → F4 → F5, and F7 is the list of behaviours that must not break while
the rest is fixed. One step per item, RED-first checks, the affected suites per step and
the whole `pnpm verify` once in the release window (asking the owner first).

- **S29 — F1: a replaced session's name on history disabled the batch tools.** A member
  that had to be replaced leaves its name on the tasks it completed; the whole-plan
  validation then refused every `replan` batch, and since a terminal task cannot be
  reassigned and a removed name cannot be re-added, `cancel_task`, `move_phase`,
  `close_phase` and multi-task repair were lost permanently. Fix: the "assignee is an
  active member" rule applies only to tasks that can still be dispatched (`completed`,
  `cancelled` and `superseded` are history); `failed` stays checked because `retry` can
  revive it, and the retry path itself now refuses to revive a lane whose owner is gone
  unless the batch names one.
- **S30 — F3: `remove_member` requeued superseded lanes into the pool.** Six of eight
  "requeued tasks" had been superseded long before, and idle members claimed them —
  one put a second writer on a file that a live lane was editing. Fix: a removal
  requeues only live unfinished work and the pool never lists a dead lane; `claim_task`
  refuses a superseded or cancelled task by name.
- **S31 — F6: the status payload is unbounded.** `agent_teams_status` echoes every task
  with its full output (20–30 KB at 183 tasks) and crashed the session twice. Fix:
  bounded by default — counts plus live tasks, terminal outputs only on request — with
  explicit filters (`live`, `task_id`, `since`, `include_output`).
- **S32 — F2: a stale `(reassigning)` marker no tool could clear.** A pooled task kept
  the handoff marker forever; the only exit was `supersede_task`. Fix: an explicit
  release in the replan batch plus self-healing when the recorded holder is gone.
- **S33 — F4, F4b, F4c: the `inScope` audit is too literal.** (a) the overlap predicate
  ignores terminal tasks and dependency relations, so a successor is not a race;
  (b) a `**` wildcard in `inScope` is not expanded by the audit, so four real files read
  as "outside the contract"; (c) the shared-page convention (`docs/PLANS.md` and friends
  kept out of `changedPaths`) is punished with `awaiting_scope_review`.
- **S34 — F5: a `work` lane's waiver can never be confirmed.** `kind=review` only
  accepts an implementation/repair/verification/integration target, so a `work` task that
  reported `waived` against a registered pin sits unconfirmed for the rest of the phase.
- **F7 is the regression list**: quality gates, pins, atomic plan validation,
  `supersede_task`'s retargeting, durable mailboxes and the one-unfinished-task rule all
  worked; each fix below keeps its check green.

Release: **0.4.0** after the batch (relaxed validation, new tool parameters, scope-audit
semantics). Tag with the branch marker as usual; the dangerous operations wait for the
owner's go-ahead.

## Round 3 scope (owner request, 2026-09-20, after 0.2.1 with the round-2 patch)

Four items, in the owner's order, one step at a time with RED-first checks, a full
`pnpm verify` per step and one release at the end of the UI pair and one for the
contract change.

- **S23 — the work plaque is three dot rows, not five.** The plaque kept five rows
  from the era of a two-line member row; a one-line row does not need that height.
  `WorkBar` goes to `[0, 1, 2]` rows, the stagger, dots and idle slot stay as they
  are, and the existing plaque checks are extended to assert the row count (five
  rows was the compaction the owner is reversing).
- **S24 — the phases section collapses like every other section.** Members and the
  checklist already have a chevron header (`aria-expanded`, `data-*-toggle`,
  one collapse/expand word); the board gets the same treatment — a
  `phase.toggle` header with the column count, `phase.expand`/`phase.collapse`,
  `data-phases-toggle`, default open, and the board body rendered only while open.
  No new storage key: sibling sections keep their state in component state.
- **S25 (unplanned, owner request after seeing 0.2.2) — the large member node is the
  default again, and one member folds into a tray.** "Участников я не просил делать
  по умолчанию сколлапсированными — верни их по дефолту крупными. Дай мне кнопку на
  мембере позволяющую его свернуть в такой трей." So the compact line introduced in
  S22 stays, but as the **folded** state: the 0.2.1 large node (portrait spanning both
  lines with the action ring, role in words, model badge, state word, status sentence,
  labelled chip row) is what a member looks like until the reader folds it, and a
  chevron on the node folds **that one** member. The fold control is a *sibling* of the
  row button (a button may not contain a button, and the row navigates).
  - Restored with it: `memberStatusText()`, the thirteen `member.status.*` keys, the
    four `assignment.*` keys, `.memberRole`, `.memberStatusLine`, `.assignmentLabel`
    (the key values are the 0.2.1 ones, taken from `09ac60e:src/client/locales.ts`).
  - Also fixed while there: the tray's action symbol was absolutely positioned in the
    block (the base `.stateArt` corner-ring rule leaked into the compact markup), so it
    floated at the row's right edge instead of sitting inline before the state word;
    `.memberStateIcon .stateArt` now resets it to a 12 px inline mark.
  - New checks: `a member node is large by default and folds into the compact tray on
    demand` and `the compact tray row is one icon line that ends in the work plaque`
    (both RED first); the round-2 badge check was re-pointed to the shared `modelBadge`
    value plus its position in each variant, because the badge is now built once.
- **S26 — a phase can be closed, and a closed phase accepts no new tasks.** The
  captain closes a phase **after accepting its tasks** (his obligation, stated in
  the captain prompt), through one more operation of the captain-only replan batch:
  `close_phase`. A phase may close only when every task in it is settled
  (completed, cancelled or superseded) — otherwise the operation is refused naming
  the phase and the tasks still open. Once closed:
  - `agent_teams_replan` refuses `add_task` with that `phase` and refuses
    `move_phase` into it, with a message that names the closed phase and points at
    declaring a new one (`move_phase` with a `title`);
  - `agent_teams_create_task` refuses the same `phase` argument;
  - the snapshot publishes `closed` per phase, the board marks a closed column, and
    the running-plan editor never offers a closed phase as a target.
  State shape: `plan.phases[].closed` (+ `closedAt`), validated by
  `isTeamPlanPhase`, so an older `team.json` keeps loading as open phases.
- **S27 — the overall progress bar is one line in three colours.** Segments:
  (1) the original plan, (2) work added while the team ran, (3) work added after the
  plan first completed — see D7 for how a task is attributed. The bar keeps its
  single width and the server-side percentage; the three slices are coloured and
  the legend names them, so "how much of this was the plan" is readable without
  reading the task list.

Releases: **0.2.3** after S23+S24 — and it also carries S25, which the owner asked
for while looking at 0.2.2 — then **0.3.0** after S26+S27 (state and tool behaviour
change, with an upgrade note for the new `closed` field).

## Step log

### S32 — the dispatch cap counted a recorded status, so idle members were never woken (done)

Owner report (the material-layers page, item 2): *"Диспетчер плагина не поднимает участника
на назначенную задачу. Это измерено сегодня семь раз (t185, t186, t194, t195, t202, t203,
t204): задача назначена и pending, участник idle — и ничего не происходит, пока я не отправлю
письмо."* — two captain actions per lane instead of one.

- **Two reproductions, and only the second one fires.** The obvious sequence (assign to a
  busy member, wait for it to go idle) already worked: a new lifecycle check
  (`a member picks up its assigned lane when it goes idle, without a message from the
  captain`) passes against the unfixed code as well, because the scheduler already kicks a
  member on its `agent/status` idle edge.
- **The real mechanism:** `kickTeam` and the create-time guards counted workers with
  `member.status === 'working'`, and that field is written from the host's status stream.
  One missed idle event leaves a member marked `working` forever, the per-team cap
  (`maxWorkersPerTeam`, 8 by default, lower in the field profiles) then looks full, and
  `kickTeam` returns before dispatching anybody — team-wide, not per lane. A manual message
  steers the member directly and bypasses the cap, which is exactly why the owner's
  workaround worked. Seven stalls in an eleven-member run fits a systematic cap, not luck.
- **Fix:** `workingMemberNames(team)` counts the work a member actually holds (a
  `claimed`/`in_progress` task) and `workingCount` uses it, so the cap is state-based
  exactly like the create-time guards of owner decision D6 and cannot drift from the graph
  the report shows.
- **New scenario** (`maxWorkersPerTeam: 1`, two members, one with a stale `working` record
  and no task): with the old counting it is **RED** — `spawns=0 status=pending`, the lane
  sits assigned and pending with nobody woken — and with the fix **GREEN** —
  `spawns=1 status=claimed`. The old counting was restored for one build to capture that
  RED evidence, then put back.
- **Checks:** the lifecycle scenario's two checks, the idle-edge check above, and a unit
  check in `verify.mjs` (`the dispatch cap counts the work a member holds, not a recorded
  status`, which also asserts the recorded-status counting is gone from the source).
- **Also in this step:** the F6 change had broken three `lifecycle-verify` assertions that
  read the full task list from a status call; they now ask for it explicitly
  (`agent_teams_status { live: false }`) and a new check asserts the bounded default
  (`shown=1 of 2`), so the bounded report is covered in both directions.
- **Verification:** `verify.mjs` 298 PASS / 0 FAIL; `lifecycle-verify` 160 PASS / 0 FAIL.

### S31 — Φ1/F6: the status report is bounded by default (done)

The dx9 run reached 183 tasks and `agent_teams_status` echoed **every** one with its
output text. The session crashed on it twice; the captain stopped asking the plugin
questions and grepped the harness spill file instead — "a poor substitute for asking the
plugin a question".

- **Measured on the run's shape** (183 tasks, 170 settled, 300-character outputs):
  the rendered report was **64 432 characters**; it is **1 518** now, and the omitted
  history is stated in the report rather than silently truncated.
- **Selection is a pure module** (`src/status.ts`, `selectStatusTasks`), so the
  structured payload and the text report cannot disagree about what was shown — the
  payload carries `tasks_total`, `tasks_hidden`, `tasks_outputs_dropped` and an echo of
  the filter. Default view: the work that still needs attention (`pending`, `claimed`,
  `in_progress`, `awaiting_scope_review`, **`failed`** — a red lane is exactly what a
  captain opens a report for), 13 of 183 on this fixture; settled history
  (`completed`/`cancelled`/`superseded`) is counted, not printed, and its output text is
  dropped.
- **Nothing became unreachable:** `live=false` lists all 183, `include_output=true`
  restores the history's outputs, `task_id` reports one task in full (its output
  included), and `since` answers "what changed since my last call" (4 tasks for
  `since: 180`). The four parameters are described on the tool and asserted by a check.
- **Checks:** `the status report shows the work that needs attention, not the settled
  history`, `a status call can still reach every task, one task, or what changed`,
  `the rendered status stays bounded and says what it left out` (which measures both the
  bounded and the unbounded render of the same fixture, so the flood cannot come back
  unnoticed) and `the status tool exposes the filters that make a bounded report usable`.
- **Verification:** build exit 0; `verify.mjs` 297 PASS / 0 FAIL.

### S30 — Φ1/F3: a member removal requeues only the work that still needs an owner (done)

The dx9 run answered `remove_member frame` with
`requeued tasks: t89, t93, t102, t109, t112, t113, t114, t164`; six of the eight had been
superseded long before, and the pool made them look claimable. Four incidents followed in
one hour: two lanes were claimed by the wrong member, and `t102` put a **second writer** on
a file a live lane was editing (the holder noticed the tree change inside its own turn and
stopped — the plugin never told either lane).

- **Cause:** the removal loop skipped only `completed`, and `invalidateTaskAttempt` sets
  `status = 'pending'` while clearing the attempt — so `failed`, `cancelled` and
  `superseded` lanes were resurrected into the shared pool and reported as requeued work.
- **Fix:** the requeue is now an exported state helper, `requeueMemberTasks(team, name)`,
  driven by `requeueableOnRemoval` (`LIVE_TASK_STATUSES`: `pending`, `claimed`,
  `in_progress`, `awaiting_scope_review`). Every settled status is history and keeps both
  its status and the name of the member that did the work; the tool handler is three lines
  shorter and the rule is testable without a tool context.
- **Why the claim path needed no change:** `TASK_TRANSITIONS` already refuses
  `superseded/cancelled/completed → claimed`, and the scheduler's ready filter only ever
  offers a `pending` task — the pool listing them was the only way a dead lane could run.
  The new check asserts both halves, so a future edit cannot quietly reopen the door.
- **Interaction with F1:** because a removal now leaves a red (`failed`) lane untouched, a
  settled `failed` task keeps the replaced member's name — so F1's historical set had to
  cover **every** terminal status, `failed` included. The only path that can revive such a
  lane is `retry`, and that path refuses without a new owner (S29). A check asserts the
  batch still works with a red lane of the replaced session in the graph.
- **RED first:** `a member removal requeues only the work that still needs an owner` failed
  with `requeued t1,t2,t3,t4,t6,t7,t8` — the field's exact shape (failed, cancelled and
  superseded lanes coming back) — plus `a dead lane never becomes claimable work again`.
- **Verification:** build exit 0; `verify.mjs` 293 PASS / 0 FAIL.

### S29 — Φ1/F1: a replaced session's name on history no longer disables replan (done)

The dx9 run replaced a wedged member session (`remove_member` + `add_member`, the
plugin's own §8.4 route) and from that moment **every** `replan` batch was refused:

```
Error: task "t5" assignee "frame" is not an active member
```

Measured cost in the run: `cancel_task`, `move_phase`, `close_phase` and every
multi-task repair unavailable for the rest of the phase; four stale pool entries could
not be cancelled; a dependency correction had to be abandoned. It is permanent because a
terminal task cannot be reassigned and a removed name cannot be re-added.

- **Cause:** `validateTeamGraph` (shared by the staged editor and the live replan batch)
  required *every* task's assignee to be an active member, including the tasks that had
  already finished under that member's name.
- **Fix 1 — history is not a live constraint:** the rule now skips `completed`,
  `cancelled` and `superseded` (statuses that can never be dispatched again). `failed`
  deliberately stays checked: `retry` can revive it.
- **Fix 2 — the revive path names an owner:** `updateTask`'s `retry` branch validates
  the owner it is about to make dispatchable again and refuses with
  `task t2 has no active owner ("frame" is not a member) — pass assignee to name one when
  you retry this lane`. Without it the fix would have traded a loud refusal for a lane
  nobody could ever claim.
- **RED first:** four checks — `a completed task keeps its replaced owner without
  blocking a replan batch`, `the batch tools a healthy team needs still work with a
  replaced owner on history`, `a live lane whose owner is gone is still refused` and
  `retrying a lane whose owner was removed demands a new owner`. The first run failed
  exactly with the field's error, and the suite needed a new `attempt()` helper so an
  expected-success call fails a check instead of aborting the run.
- **Verification:** build exit 0; `verify.mjs` green (287 + 4 checks).

### S28 — hotfix + release 0.3.0: the phase board froze the web client (done)

Field incident, 2026-09-20: after 0.2.2 was installed into the live `web` profile the
owner could no longer open DSH in Chrome at all; the plugin had to be unmounted
(`dsh.profile.bundles` entry removed + `disabled: true` in the profile patch) to get
the app back. Owner's words: the harness fell, the app blocked its own launch, and the
operation should not have run without a warning.

- **What I ruled out, with evidence (read-only):** the artifact is intact (installed
  copy byte-identical to the tarball, sha256 `A8B2FF78…C48B`); `lib/index.js` and
  `cordis.patch.yml` are **byte-identical** between 0.2.0 (which ran) and 0.2.2, so the
  host half cannot be the cause; my install changed nothing in the profile except the
  plugin's own spec (the pre-0.2.2 lock backups differ only in that package — the host
  runtimes were not re-resolved); the bundle keeps the same loader registration and
  requires exactly one host module (`@deepseek-ai/dsh-client-ui-primitives`), which the
  shell provides to a dozen host packages, so the client graph shape is fine.
- **The cause (measured, not guessed):** `phaseBoardLayout`'s chain-depth walk visited
  every dependency **path** — a fresh `seen` per branch, no memoisation — so a layered
  plan multiplied paths by the layer width per layer:

  | fixture | 0.2.2 | after the fix |
  | --- | --- | --- |
  | 12 layers x 4 lanes = 48 tasks | **7 477 ms** | 0.4 ms |
  | 14 layers x 4 = 56 tasks | **130 230 ms** | 0.4 ms |
  | 12 layers x 5 = 60 tasks | **96 601 ms** | 0.4 ms |

  That runs inside the panel's render: the tab locks up while the panel loads, a reload
  locks it again, and the reader concludes the app is broken. It only bites when a
  **declared phase** holds a layered graph (auto-derived columns hold one task each,
  which is why every fixture in the suite stayed fast — my own "dense" fixture was only
  five layers deep, so it never crossed the threshold that the owner's real plan did).
- **Fix:** memoise the depth per task (`depthCache`), keeping a `stack` set so malformed
  cyclic state terminates instead of looping. One visit per task, linear.
- **Second fix (defence in depth):** `PanelErrorBoundary` now wraps the activity overlay
  and the conversation card. The shell's additive overlay does not isolate a plugin's
  render exception, so any future fault in this panel would unmount the host's tree
  again; the boundary renders one line naming the failure instead. It cannot help against
  a hang, which is exactly why the memoisation is the primary fix.
- **Checks:** `a dense declared phase lays out without walking every dependency path`
  (the 12x4 fixture with the layout it must produce and a 1 s budget the old recursion
  needs minutes for) and `a panel fault cannot take the shell down` (boundary, both
  registrations, style and locale key). `verify.mjs` 287 PASS / 0 FAIL.
- **Process change the owner asked for:** the dangerous operations (the whole `pnpm
  verify` chain, `pnpm pack`, anything that writes into the live `web` profile) are now
  gated on an explicit "можно" from the owner in the current turn. Recorded in
  `.local/SETUP.md` together with the reason: this machine serves the conversation from
  the very profile those operations touch.

### S26 — round 3.4: a phase can be closed, and a closed phase takes no new work (done)

Owner request (round 3, item 3): "если все задачи в фазе выполнены/отменены, а также
сам координатор после приемки задач этой фазы закрыл её (что он обязан сделать) —
фаза считается закрытой. Новые задачи в закрытую фазу добавлять нельзя, только
создать новую фазу."

- **One more operation of the captain's own tool** (never a user tool — owner note D7):
  `agent_teams_replan` gained `close_phase` with `phase_id`. `ReplanAction`, `ACTIONS`,
  the tool's action enum and its description list it; the tool result now prints a
  change without a task id (`close_phase: closed phase E0 (2 task(s))`), which is why
  `ReplanChange.taskId` became optional.
- **The gate:** a phase closes only when every task in it is terminal
  (`TERMINAL_TASK_STATUSES` — `failed` counts, because it is settled evidence and
  Delivery, not the phase, judges it). Otherwise the operation is refused with the open
  tasks named: `phase "E1" still has 1 open task(s): t2 (pending) — accept and settle
  them first`. Closing an unknown or already closed phase is refused too.
- **Enforcement at both doors work comes through:** `phaseFor()` in the replan module
  refuses a closed phase for `add_task`/`move_phase` (the message names the phase and
  says to declare a new one), and `agent_teams_create_task` refuses the same `phase`
  argument. A new phase declared with a `title` is open by construction.
- **State and panel:** `plan.phases[].closed` + `closedAt`, validated by
  `isTeamPlanPhase` (both optional, so an older `team.json` loads as open phases); the
  snapshot publishes them; the board draws the closed column's underline in the
  delivered tone with a `Closed` marker (the header row only grows when such a column
  exists — `:has()`); the running-plan editor lists a closed phase as a disabled option
  instead of hiding it.
- **Captain obligation:** protocol rule 7 now ends with the phase bookkeeping — close a
  phase once its tasks are accepted, and put later work in a **new** phase.
- **RED first:** five checks — `a phase closes once every task in it is settled`,
  `closing a phase with open work is refused and names the tasks`, `closing an unknown
  or already closed phase is refused`, `a closed phase refuses new work and points at a
  new phase`, `create_task refuses to place work in a closed phase` — plus the snapshot
  and panel contracts. Two fixture mistakes were fixed on the way: the snapshot call
  needed the real `assembleTeamSnapshot(ctx, root, workspace, team, options)` signature
  with `historic: true` (a live probe needs the host's agents registry), and the closed
  fixture had to be built once with `now: 500` so `closedAt` was assertable.
- **Verification:** typecheck exit 0, build exit 0, `verify.mjs` 285 PASS / 0 FAIL.

### S27 — round 3.5: the overall progress bar is one line in three colours (done)

Owner request (round 3, item 4): "overall progress надо разбить на 3 стейта —
1. оригинальный план, 2. то что добавилось в процессе - репланирование, 3. всё что
докидывает пользователь после завершения плана в первый раз. Всё в одной линейке,
просто размечаем разными цветами."

- **Attribution without guessing** (owner note D7: the replan tool is the captain's, so
  no tool call says "the user asked"): `TeamTask.origin` is stamped when a task is
  created — `plan` for the seeded/approved plan, `added` while the plan still owes work,
  `followup` once every plan task is terminal. `state.planHasSettled()` +
  `state.originForNewTask()` hold those two rules; a task with no `origin` counts as
  plan work, so a `team.json` written before the field keeps answering. A replacement
  inherits the lane it replaces (`replaced.origin ?? 'plan'`) and the review loop's
  repair tasks inherit the task they follow up, so history cannot be relabelled later.
- **Host payload:** `PlanProgress.segments` — always the three stretches in bar order
  with `completed`/`total`/`percent` — computed in `src/progress.ts` and published by
  the snapshot; the status text keeps its single percentage.
- **Panel:** the bar becomes a flex row of three zones (`data-origin`, `flex-grow` = the
  stretch's size) whose inner fill is that stretch's delivered share — blue for the plan,
  amber for what was added while running, green for what came after — with a named legend
  under it (`Original plan 14/16 · Added while running 3/5 · Added after the plan 1/3`)
  and a tooltip per zone. A host payload without segments degrades to one plan-only zone
  instead of inventing a split.
- **Checks:** `progress splits the plan into the three stretches of its life`,
  `a task added before the plan settles is "added", after it settles "followup"`,
  `the panel draws three coloured zones and names them` and
  `a replanned task records the stretch that created it`.
- **Visual check:** `.local/preview-s27.mjs` →
  `.local/logs/ui-round3/progress-closed-phase.png` shows the three zones and a closed
  phase column side by side.
- **Verification:** typecheck exit 0, build exit 0, `verify.mjs` 285 PASS / 0 FAIL.

### S25 — round 3.3: the large member node is the default, folded on demand (done)

Owner request while looking at 0.2.2 (verbatim): "Участников я не просил делать по
умолчанию сколлапсированными - верни их по дефолту крупными. Дай мне кнопку на
мембере позволяющую его свернуть в такой трей."

- **What changed:** S22's compact line stays, but as the *folded* state. A member is
  now the 0.2.1 large node — portrait spanning both grid rows with the action ring,
  head line (`name`, role in words, model badge, state word) and the status sentence
  under it, chips on their own row behind the `Captain assigned` label, plaque over
  the full height — until the reader folds **that one** member with the chevron at
  the node's right edge. `data-compact` on the block and the row selects the variant;
  `collapsedMembers` starts empty (`ReadonlySet<string>`), so the default is large.
- **Why the control is a sibling:** the row is itself a `<button>` that navigates to
  the member's session, and a button may not contain a button. The chevron therefore
  sits in a 20 px strip reserved by the row's right padding, next to the plaque.
- **Restored with the large node** (values from `09ac60e:src/client/locales.ts`):
  `memberStatusText()`, the thirteen `member.status.*` keys, the four `assignment.*`
  keys, and `.memberRole`, `.memberStatusLine`, `.assignmentLabel` in the stylesheet.
- **Bug fixed on the way:** the tray's action symbol was stuck at the row's right
  edge — the base `.stateArt` rule (absolute, 18 px, corner ring) still applied to the
  compact markup, which puts it inside `.memberStateIcon`. `.memberStateIcon .stateArt`
  now resets it to a 12 px inline mark, which is what the compact row was designed to
  show.
- **RED first:** `a member node is large by default and folds into the compact tray on
  demand` (failed with `collapse=-1 row=51735 compact=-1`) and `the compact tray row is
  one icon line that ends in the work plaque`. The round-2 badge check was re-pointed:
  the badge is now built once as `modelBadge`, so its attributes are asserted where it
  is defined and its position in **both** variants is asserted on the branches.
- **Visual check:** `.local/preview-round3.mjs` renders two large nodes and two folded
  trays from the built bundle with the real stylesheet
  (`.local/logs/ui-round3/member-nodes.png`).
- **Verification:** typecheck exit 0, build exit 0, `verify.mjs` green; the full chain
  is deferred to the release window (see the working rules in SETUP: no long
  background chains while other sessions run on this machine).

### S24 — round 3.2: the phases section collapses like every other section (done)

Owner request (round 3, item 2): "блок с 'фазами' должен быть сворачиваемым так же
как и все остальные".

- The board moved inside the same header the members list and the checklist use: a
  `phase.toggle` button with the column count (`phaseColumns(...).length`), the
  `phase.expand`/`phase.collapse` word, `aria-expanded={phasesOpen}`,
  `data-phases-toggle`, default open, and the board body rendered only while open.
  `.phasesToggle` joins `.membersToggle` in the stylesheet instead of duplicating the
  twenty-line rule, and it joins the focus-visible list.
- **RED first:** `the phases section collapses like the members list and the checklist`
  — failed with `toggle=-1 board=41511` before the header existed.
- **Locale keys:** `phase.toggle` (`阶段（{count}）` / `Phases ({count})`),
  `phase.collapse` (`收起` / `Collapse`), `phase.expand` (`展开` / `Expand`).
  The first insertion script split the dictionary on a key and rejoined only two of
  three parts, truncating the English half and breaking the parse; it was reverted with
  `git checkout -- src/client/locales.ts` and replaced by a line-based insert that
  cannot lose the tail (and asserts the closing signature of the file).
- **Verification:** typecheck exit 0, build exit 0, `verify.mjs` green (locale parity,
  the new toggle check, the board's scroller and single-view checks all pass).

### S23 — round 3.1: the work plaque is three dot rows tall (done)

Owner request (round 3, item 1): "сделай уплотнение анимированных точек … по
вертикали — x3 строчек должно быть примерно". The five rows dated from the retired
two-line member row.

- **RED first:** new check `the work plaque is three dot rows tall` in
  `verify.mjs` — it slices the `WorkBar` body and asserts three rows, three columns,
  and that the stylesheet still spreads them over the node (`justify-content:
  space-between`, `min-height: 22px`). It failed with the diagnostic
  `rows=0, 1, 2, 3, 4` before the change.
- **GREEN:** `WorkBar`'s row list is `[0, 1, 2]`. The dots (3 px, round), the
  0.12 s per-row stagger, the idle slot opacity and `align-self: stretch` are
  untouched, so the wave still reads top-to-bottom and the plaque still spans the
  node — it is simply shorter.
- **Local suite:** typecheck exit 0; build exit 0; `verify.mjs` green including the
  three plaque checks.
- **Visual check:** `.local/preview-round2.mjs` re-rendered after its own template
  was corrected to three rows (the first render still drew five and was misleading);
  `.local/logs/ui-round2/phase-board.png` shows three rows of three dots per plaque.

### S22 — owner UI round 2: compact member node, phases as chains, one graph view (done)

Owner request after living with 0.2.1, verbatim intent: compact a member row of
`members` into one small line (role icon, status icon, name, model, its task list)
with the work plaque at the end; make the `phases` section lay sequential work out
in a line while the phase column stretches, which removes the need for the `tree`
section; paint cancelled task nodes in a very pale scarlet hatch; and delete the
`queues` section.

- **Member node** (`ActivityPanel.tsx`, `.module.css`): one flex line —
  `.memberAvatar` (24 px, the old corner action mark dropped) → `.memberRoleIcon`
  (12 px, the role in words moved into its `title`) → `.memberInfo` (`.memberName`
  with the role tooltip, `.memberModel` badge, `.memberStateIcon` = action symbol +
  state label) → `.memberCount` → `.assignmentLine` (chips only) → `<WorkBar />`
  last, `align-self: stretch` via `.memberRow > .workBar`. `.memberStatusLine`,
  `.memberRole` and `.assignmentLabel` and their nine `member.status.*` locale keys
  are gone, so `memberStatusText()` went with them.
- **Phase board** (`activity-model.ts`): `phaseBoardLayout(tasks, manualPhases)`
  now gives a task its **intra-column chain depth** as `x` (the longest path of
  dependencies that stay inside the same phase) and keeps a predecessor's row when
  its predecessors agree, otherwise the first free row at that depth. A column's
  `width` is `(maxDepth + 1) * NODE_WIDTH + maxDepth * COLUMN_GAP`, and `columns[]`
  carries `taskIds`, so a reader (and the header count) never has to infer
  membership from `x`. Geometry: `COMPACT_DAG_NODE_WIDTH 92`,
  `COMPACT_DAG_COLUMN_GAP 26`, `COMPACT_DAG_ROW_GAP 8`.
- **Cancelled nodes**: `.dagNode[data-state='cancelled']` paints the card in
  `color-mix(#f2b8b5 14%, bg-layer-1)` and hatches it with a 45°, 32 %-pale-scarlet
  stripe, with dot, head and label tinted to match — settled history, not the error
  colour.
- **Deleted with the views** (owner decision — the board makes a second graph view
  redundant): `DependencyMap` (tree), `QueueView`, `ViewSwitcher`, the old
  `initialActivityView`/`ACTIVITY_VIEW_STORAGE_KEY`/`ActivityViewMode`, ~60
  `view.*`/`queue.*`/`dependency.*`/`assignment.*` locale keys, and the model
  projections that only served them (`taskStages`, `compactDagLayout`,
  `relatedTaskIds`, `usesParallelTaskGrid`, `dependencyFocusTaskId`,
  `agentSwimlanes`, `agentQueue`, `queueOverview`, `idleReasonSummary` and their
  types). The removed checks are named in `verify.mjs` as an owner-requested
  removal, not as a weakened assertion.
- **Regression found while previewing (pre-existing, shipped since 0.2.1):**
  `phaseColumns` returned the declared columns only when `rest.length > 0`, so a
  plan whose declared phases covered **every** task discarded them and fell through
  to the DAG levels, which then had nothing to lay out — the board rendered
  **empty**, exactly for the fully declared plans that use phases. Fixed by
  returning the declared columns whenever they exist and pushing `unphased` only
  for what the plan left out; two RED-first checks hold both halves.
- **New guards** (`verify.mjs`): every `css.<name>` a panel component renders must
  exist in its stylesheet (this caught `css.viewHint`, deleted with the switcher
  while the board still used it, and the never-defined `css.archivedWrap`);
  sequential work in one phase shares a row; parallel work takes its own row; a
  column stretches to its longest chain; a chain edge is a short forward curve in
  the row; a cancelled node is a pale hatched card; the phase board is the only
  graph view; the member row is one compact line ending in the plaque.
  verify 271 PASS / 0 FAIL; the full `pnpm verify` chain exit 0.
- **Visual check:** `.local/preview-round2.mjs` renders the member list and the
  board from the built bundle with the real CSS sheet, the real layout function and
  headless Chrome (`.local/logs/ui-round2/phase-board.png`).
- **Follow-up in the same round (owner screenshot):** the progress block drew one
  bar *row per phase* (`level-0 … level-7` for a team with no declared phases). The
  owner crossed all of them out — "перечеркнутую кучу говна убери" — so the panel
  now draws **one** bar: the per-phase render block, `ProgressPhaseView`,
  `PlanProgressView.phases`, the five `.progressPhase*` rules and the
  `progress.phase` locale key are gone. The snapshot keeps publishing `byPhase`
  (host roll-up, still asserted host-side by the snapshot checks), but no panel row
  renders it and the panel's own view no longer carries the field at all
  (`!('phases' in view)`); four checks were re-pointed RED-first.

### S21 — owner UI round: the full-node work plaque (done)

Owner request after living with 0.2.0: the compact animated six-dot mark should become a
plaque spanning the node's whole height, three to four dots wide, animated the same way.

- **`WorkBar`** (new component): a plaque three dots wide, the full height of a member
  row, at its right edge — a new fourth grid column (`grid-area: 1 / 4 / span 2 / auto`)
  so it spans the head line and the assignment line alike. Five rows of three dots with
  `justify-content: space-between` fill the node height; while the member works they run a
  top-to-bottom wave (`@keyframes agentTeamsBar`, `row * 0.12s` stagger), and when it does
  not the column stays as a faint slot marker (opacity 0.15), so the lit wave — not the
  column — reads as work.
- **The compact six-dot mark is gone from a member row** (the text state stays as the
  accessible label); `WorkGlyph` still marks the captain node and the collapsed pill, where
  no full-height node exists.
- **Tests first:** two new source-level checks in `verify.mjs` (the plaque is rendered
  inside the member row and the glyph is not; the dots are round and 3 px and the wave is
  keyed) — RED before the component existed, green after. `verify.mjs` 293 PASS / 0 FAIL.
- **Visual check:** `.local/preview-work-bar.mjs` renders the members tree with the real
  CSS module sheet, the real artwork and headless Chrome
  (`.local/logs/ui-workbar/members-tree.png`), which is how the plaque was reviewed before
  shipping (the still frame shows the lit wave on the working row and the faint column on
  the idle ones).
- **Release 0.2.1** (client-only): `09ac60e` — version bump, `release-notes/v0.2.1.md`,
  `docs/releases/v0.2.1/README.md`, README version references (a one-shot local script
  `.local/bump-readme-0.2.1.mjs` did the bump after shell escaping of backticks failed
  twice), artifact packed and installed into the `web` profile, tag `v0.2.1` with the branch
  marker. No state, tool, schema, profile key or gate changed.
- **Also done in this round:** the stale fork branch `toolkit-fix` (the pre-hardening line at
  `d11e0cb`) was deleted from the fork as the owner approved.
- **Owner action:** restart the harness (the running `dsh web` still has 0.2.0 loaded) and
  refresh the page.

### S20 — docs + release 0.2.0 (done)

- **Release mechanics:** `package.json` 0.1.24 → 0.2.0 (targeted edit — the file is never
  re-serialized, see the S18 language-check trap); `release-notes/v0.2.0.md` (the plan's
  close-out: replan, the plan entity, progress, several teams, configured limits, upgrade
  notes); README gained the v0.2.0 paragraph, the version table moved to 0.2.0, the install
  command and the "default `latest`" line follow, and the release-verification link points at
  `docs/releases/v0.2.0/README.md`; `compatibility.json` deliberately unchanged.
- **Release record:** `docs/releases/v0.2.0/README.md` — the per-step table (S16–S19), the
  verification matrix, the checks added across the release, the artifact digest and the
  deployment/rollback rows. `.socraticodecontextartifacts.json`'s `latest-release-notes`
  artifact moved to `v0.2.0.md`.
- **Local suite (logs in `.local/logs/s20b/`):** typecheck exit 0; build exit 0;
  `verify.mjs` **291 PASS / 0 FAIL**; `quality-gates-tdd` **134 PASS / 0 FAIL**;
  `lifecycle-verify` **155 PASS / 0 FAIL**; `multi-team-panel-tdd` **14 PASS / 0 FAIL**;
  `stress-verify` **30 PASS / 0 FAIL**; all 22 suites, `verify-package`, `sync-skill --check`
  and the language check exit 0; `readme-version` reports "match 0.2.0"; `release-metadata`
  passes.
- **Artifact:** `.local/dist/nanmicoder-dsh-agent-teams-0.2.0.tgz`, 2 317 040 bytes, SHA256
  `FBBA6EBA90F96A277C4B8E2865A83B3E018D98E529FE4D616E98EBD8148C12EE`; copied to
  `D:\OwlCats\AI_Tools\dsh-agent-teams-0.2.0.tgz` for the profile install.
- **Deployed** into `C:\Users\whitl\.dsh\profiles\web` (a different `file:` spec resolved
  normally; the `bundles` order was already correct): installed version 0.2.0, the nine
  runtime `lib/*.js` files byte-identical to this checkout, `TEAM_TOOL_NAMES` = 19 with
  `agent_teams_replan`, the installed prompt carries the replan rule,
  `dsh --profile web --dump-config` still resolves `id: agent-teams`. Backups:
  `*.bak-2026-09-20-pre-0.2.0`; rollback target is the 0.1.24 tarball.
- **Tag:** annotated `v0.2.0` with the branch marker and the artifact facts, pushed to the
  fork together with the branch (see the tag policy section above).
- **Owner action:** restart the harness so the running `dsh web` process loads 0.2.0; the
  browser needs a refresh (the panel gained the switcher, the progress block, the checklist
  and the running-mode editor; artwork URLs keep their revision).
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs`, the real-host
  matrix and the manual scratch-profile look at the new panel surfaces.

### S19 — WP11 phase 3: configurable limits and slot reporting (done)

Scope (plan §WP11 phase 3): the guards that phase 1 hard-coded become configured keys,
and `status` answers "how many are working, how much waits, who holds a slot".

- **Keys and one resolver:** `ToolsConfig` gained `maxTeamsPerWorkspace` (default
  `MAX_TEAMS_PER_WORKSPACE` = 4) and `maxTeamsPerSession` (default
  `MAX_TEAMS_PER_SESSION` = 8), joining the phase-2 `maxWorkersPerTeam` (default: the
  roster cap) and `maxConcurrentWorkersGlobal` (default 8). `resolveTeamLimits(config)` is
  the single place that turns config into numbers, so the create guard, the scheduler and
  the report cannot drift; `index.ts` exposes all four in the plugin `Config` (zod schema +
  `Config` interface + resolution into `ToolsConfig`).
- **Create guard:** the workspace fuse keeps its message shape (`this workspace already has
  N live teams (limit L)`) and a new session fuse refuses a captain session over its own
  limit (`you already lead N team(s), which is the limit L per captain session`). The
  session check runs first, so a workspace that is full because several captains filled it
  answers with the workspace message.
- **Observability:** `slotSummaryOf(team, limits)` reports who holds a slot (member + the
  task it holds) and how many tasks are queued. `agent_teams_status` now carries it in both
  modes — the multi-team list gained `slots`, `queued` and a top-level `limits`, the single
  team gained `slots` + `limits` — and the rendered text prints
  `Slots: 1/4 working (worker t2); 3 queued` plus a `Limits:` line and the limits in the
  list header.
- **Tests:** `lifecycle-verify.mjs` now mounts the tools with
  `maxTeamsPerWorkspace: 3, maxTeamsPerSession: 2`, so the guards are proven configured
  rather than assumed: the session fuse refuses a third team of one captain, two more
  captains fill the workspace (3 live) and the fourth create is refused with the live
  count, the list payload carries `limits` + `slots`/`queued` per team, and the rendered
  report matches `Slots: N/M working (…); Q queued` (+3 checks, the old fifth-team check
  replaced by the configured one). `verify.mjs` asserts the wiring: the exported
  `MAX_TEAMS_PER_SESSION`, the one resolver, the payload fields, both render lines and the
  four `Config` schema entries.
- **Green:** typecheck exit 0; build exit 0; `verify.mjs` **291 PASS / 0 FAIL**;
  `lifecycle-verify` **155 PASS / 0 FAIL**; `multi-team-panel-tdd` 14; `quality-gates-tdd`
  134; `stress-verify` 30; all 22 suites + `verify-package` + `sync-skill --check` + the
  language check exit 0 (logs in `.local/logs/s19b/`).
- **Note:** the phase-2 caps already lived in `ToolsConfig`, so phase 3 only had to expose
  the two team keys and add the summary — no scheduler change.
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs` and the real-host
  matrix.

### S18 — WP11 phase 2: several teams in the panel and in the scheduler (done)

Scope (plan §WP11 phase 2): with N teams the panel stacked every live team into one
column (two DAGs read as one graph) and the scheduler only ever moved the team a tool
call named.

- **Panel switcher:** `TeamSwitcher` (one tab per live team: name, `done/total`, an
  activity dot; a halted team keeps its tab with a warn dot) and a single rendered
  `TeamSection` — the selected team's DAG, members, progress and slices only. The
  choice lives in `dsh-agent-teams:activity-panel:team:v1`; a stale id falls back to
  the first live team. `liveCaptainTeam` (dead since the phase-1 addressing change, and
  the reason two teams could not be told apart) is **removed** together with its two old
  checks; the model now exposes `panelTeamTabs`, `panelSelectedTeamId` and
  `parsePanelTeamSelection`, and `verify.mjs` asserts the same invariants on them.
- **Scheduler sweep:** `TeamScheduler.sweepAll` walks every live team of every workspace
  the host reports (`ToolsConfig.workspaces`, injected from `workspaceRegistry` in
  `index.ts`; absent → the calling captain's workspace), skips staged/halted teams and
  returns `{ teams, dispatched }`. `agent_teams_status` for a captain who leads more than
  one team now triggers the sweep instead of a single-team kick, so a second team with
  ready work no longer waits for its own call.
- **Caps (upstream #144 mechanics):** `maxWorkersPerTeam` (default: the roster cap, so no
  existing team is silently throttled) and `maxConcurrentWorkersGlobal` (default 8), both
  host config today and profile keys in phase 3. The check sits on the **dispatch
  primitive** (`kickMember`), not on its callers, so the sweep, a team kick and the
  `agent/status` idle wake-up all obey the same numbers; `kickMember` now returns whether
  it dispatched.
- **Found by the step's own tests (in-step fix):** the first sweep implementation skipped
  members whose durable status was `working`, which broke the cold-restart recovery — after
  a restart that status is stale and its open attempt is exactly what the recovery path has
  to redeliver. The loop now iterates every non-removed member and lets `isMemberAvailable`
  decide; the caps are accounted from the actual dispatches.
- **Mail:** already per team (`<stateRoot>/<teamId>/inbox/`, addressed with the team id), so
  phase 2 needed no routing change — asserted as a documented property instead.
- **Tests:** new `scripts/multi-team-panel-tdd.mjs` (14 checks: per-team tabs and counters,
  identical task ids in two teams staying separate, a halted team keeping its tab,
  stored/stale/empty selection, defensive parsing, switcher rendering and styling,
  `liveCaptainTeam` gone, sweep + caps in the source) wired into `pnpm verify` as
  `verify:multi-team`; `stress-verify.mjs` +5 (two teams of five, the sweep dispatching the
  second team without a second call, the workspace-wide cap bounding both teams, no member
  with two open lanes, archiving one team freeing the cap) — this closes the F6 follow-up.
- **Also fixed:** `package.json` was re-serialized while adding the script and turned the
  upstream author's `\uXXXX` escapes into literal CJK, which the language check caught
  (`lang-check` exit 1). The escaped form is restored; only the two script lines differ from
  the previous revision.
- **Green:** typecheck exit 0; build exit 0; `verify.mjs` **288 PASS / 0 FAIL**;
  `multi-team-panel-tdd` **14 PASS / 0 FAIL**; `quality-gates-tdd` **134 PASS / 0 FAIL**;
  `lifecycle-verify` **152 PASS / 0 FAIL**; `stress-verify` **30 PASS / 0 FAIL**; all 22
  suites + `verify-package` + `sync-skill --check` + the language check exit 0 (logs in
  `.local/logs/s18b/`).
- **Documented deviation:** the plan's phase-2 wording ("a per-team cap") is implemented as
  a fuse whose default equals the roster cap — a smaller default would have silently
  throttled the existing 8-member scenario. The decisive, observable cap is the global one,
  and both become profile keys in phase 3. The plan's `multi-team-panel-tdd.mjs` carries the
  panel-model checks; the scheduler half stays in the stress suite, which already owns the
  real dispatch harness.
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs` and the real-host
  matrix.

### S17 — WP7: replanning a live team (done)

Scope (plan §WP7, owner decision D4): a running plan is repaired in one atomic batch
instead of a cancel-and-recreate cascade. Tool count 18 → 19.

- **`src/replan.ts` (new):** `replanTeam(team, operations, { reason })` is **pure** — it
  deep-copies the parts a batch can touch, validates and applies every operation in order on
  the copy and returns the next record plus the diff. "Any error — nothing written" is
  therefore structural, not a promise about statement order. Seven actions: `add_task`
  (full `create_task` contract, validated by the same `validateCreateTask`), `update_task`
  (`retry: true` for a failed/scope-held lane, `invalidate: true` for a live one),
  `supersede_task` (`replacement_task_id` or an inline replacement), `cancel_task`,
  `accept_paths` (re-runs the completion gate like the tool does), `amend_task` (persists
  the staled verdicts in the same batch) and `move_phase` (creates a phase when a title is
  given). Cycles and unknown references are caught by `validateTeamGraph`, moved from
  `tools.ts` to `state.ts` so the staged editor and the live batch share one rule.
  `MAX_REPLAN_OPERATIONS = 32`.
- **Plan entity:** `TeamState.plan` (`revision`, `updatedAt`, `goal?`, `phases?`), created
  with the team, validated at the durable boundary, bumped by `revisePlan` on every graph
  mutation (create/edit/supersede/accept/replan). New event
  `agent-teams/plan-revised` with the diff (`added`/`removed`/`rebound`/`invalidated`) —
  the runtime list `AGENT_TEAMS_EVENT_TYPES` is now the single source of the type union.
- **`agent_teams_replan` tool** (captain-only) plus one shared runtime method
  `replanLiveTeam` used by both the tool and the Web route, so validation, writing, the
  event, the member drain and the scheduler kick happen once. A revoked member is drained,
  goes `idle` (its session is kept) and receives `task tN replanned: <reason>` in its
  mailbox before the scheduler is kicked again.
- **Declared phases (D4):** `taskPlanning.phases` in a profile, `create_task phase`,
  `replan move_phase`; the snapshot carries `plan` (revision + phases) and feeds
  `planProgress` the declared phases (levels remain the fallback), the Phases view and the
  checklist order by them.
- **Found and fixed by the step's own test (recorded as an in-step fix, not a follow-up):**
  a member could still start work on a replanned lane by passing its revoked `attempt_id`
  while the task was `pending` again — the member branch only validated the capability when
  the task still had one. Now a capability the plan revoked is refused outright. The stress
  suite covers both directions (unrelated replan leaves the live attempt intact; replanning
  the held lane revokes exactly that attempt and the late write is refused).
- **Also aligned (WP8 ↔ Delivery):** `hasFollowUpRepair` is now one exported helper used by
  both `canDeclareDelivery` and `planProgress`, and a repaired failure leaves the progress
  denominator like `cancelled`/`superseded` (reported as `repaired`). Found by the lifecycle
  scenario: a plan repaired in one batch could otherwise never show 100%. The
  undefined-`reviewedTaskId`/`sourceTaskId` accident in the old inline rule is closed at the
  same time.
- **GUI:** `RunningPlanEditor` in the panel (running teams only, hidden for historic/
  discarded ones): per-row subject/dependencies/assignee/move-phase editing, `Retry`,
  `Supersede`, `Cancel`, `Accept paths` and the explicit "stop that member first" box, all
  posted as ONE `action: 'replan'` batch with one reason to `POST /plan`. Locale keys in both
  dictionaries.
- **Tests:** `verify.mjs` +27 (pure applier fixtures: atomicity, cycle, live-attempt guard,
  invalidate/member freed, supersede redirect, cancel, accept_paths, completed immutable,
  retry, phases, revision counter, event set, tool registration, route parser, panel editor,
  declared-phase wiring, repaired-denominator fixtures); `lifecycle-verify.mjs` +5 (the
  owner's t5 shape: a failed review opened a repair, one batch amended + retried + added,
  the graph finished through the same members and Delivery went `ok`); `stress-verify.mjs`
  +4 (replan next to a live member, revoked capability refused).
- **Green:** typecheck exit 0; build exit 0; `verify.mjs` **288 PASS / 0 FAIL**;
  `quality-gates-tdd` **134 PASS / 0 FAIL**; `lifecycle-verify` **152 PASS / 0 FAIL**;
  `stress-verify` **25 PASS / 0 FAIL**; all 21 suites + `verify-package` + `sync-skill --check`
  + the language check exit 0 after the tool-count bump in `capabilities.test.mjs`
  (18 → 19, five assertions) — logs in `.local/logs/s17b/`.
- **Documented deviation:** the plan's WP7 status table allows `amend_task force` on a
  *completed* task; the shipped WP2 rule (a completed contract is immutable, enforced by
  `quality-gates-amend.test.mjs`) wins, and the post-hoc repair for a finished lane stays
  `accept_paths`. The panel's running-mode editor is a purpose-built compact component
  rather than a `mode: 'running'` rewrite of the 783-line `StagingPlanEditor`: same batch,
  same route, far less surface to break.
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs` and the real-host
  matrix. The web-routes suite mounts a stub route by design, so the real `action: 'replan'`
  handler is covered by the unit test of its request parser plus the shared-runtime checks.

### S16 — WP8: plan progress and the task checklist (done)

Scope (plan §WP8, owner decision D3): one server-computed percentage per team plus a
flat list of every task, because the panel showed only an equal-share segment bar, a
`N/M` counter and a per-member percentage nobody rendered.

- **`src/progress.ts` (new):** `planProgress(tasks, { weights, phases })` returns both
  percentages (`percentByKind`, `percentEqual`), the mode the profile prefers, the
  counts the legend needs (completed/total/running/blocked/failed/waived/superseded/
  cancelled) and one row per phase. The rule is
  `Σ weight(completed) / Σ weight(total − cancelled − superseded)`; an empty
  denominator reports 0 instead of 100. Blocked reuses `unsatisfiedDependencies`, so a
  dependency on a superseded task is satisfied through its replacement exactly as the
  scheduler sees it. Phase rows follow declared phases when they exist (declared first,
  the rest as `unphased`), otherwise the DAG levels — the same notion of a phase the
  Phases view draws.
- **D3 weights:** `resolveProgressWeights` accepts `'equal'` or a per-kind table with
  the documented defaults (`implementation` 3, `repair` 2, everything else 1). The mode
  selects only the headline number: both are always computed, so the panel switch never
  needs a second round trip. A bad table is rejected with `taskPlanning.weights…`.
- **Profile and durable state:** `taskPlanning.weights` is validated by
  `normalizeTaskPlanning` (and now also key-checked by the lint, which previously
  skipped the nested `taskPlanning` scope entirely), resolved into
  `NormalizedTeamProfile.progressWeights`, frozen into `TeamProfileSnapshot` by
  `initializeProfileTeam` and validated at the durable boundary in `state.ts`.
- **Surfaces:** the snapshot carries `progress`; `agent_teams_status` carries the
  snake_case `progress` payload and prints
  `Progress: 62% (8/13; running 2, blocked 1, failed 0, waived 1)` before the task list,
  with `[x]`/`[~]`/`[ ]`/`[!]` per task; the panel draws the proportional bar, the phase
  rows and a mode switch (stored per browser), and a new collapsible `TaskChecklist`
  lists every task in phase-then-depth order (status glyph, id, subject, kind/round,
  assignee, status, waivers, `→ tN` for a superseded task); clicking a row pins that
  node in the dependency tree. The conversation card shows the same percentage under the
  team name. Locale keys added in both dictionaries.
- **Also fixed while here:** the client `ActivityTask.state` union was missing
  `superseded` (S09 shipped the state without the mirror type), `waivedResultCount` is
  now one helper used by both the status report and the snapshot, and the snapshot task
  payload gained `waived`/`supersededBy` for the checklist.
- **Green:** typecheck exit 0; build exit 0; `verify.mjs` **261 PASS / 0 FAIL** (240
  before, +21: weights, fixtures, phase rows, snapshot payload, client selector, stored
  mode, locales, panel/card structure); `quality-gates-tdd` **134 PASS / 0 FAIL** (+2
  profile checks); `lifecycle-verify` **147 PASS / 0 FAIL** (+2 on the rendered status
  text and its glyphs); all 21 suites, `verify-package`, `sync-skill --check` and the
  language check exit 0 (logs in `.local/logs/s16b/`).
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs` and the
  real-host matrix; the manual scratch-profile look at the new bar and checklist.
- **Not in this step:** declared phases from the plan entity (`plan.phases`, WP7/S17)
  and the multi-team switcher (S18). The progress payload already takes phases as an
  argument, so S17 only has to pass them in.

### S15 — docs + release 0.1.24 (done)

- **Release mechanics:** `package.json` 0.1.23 → 0.1.24; `release-notes/v0.1.24.md`
  (addressing rules, workspace fuses, the compatibility note that a call must now name
  its team, what stays for 0.2.0); README gained the v0.1.24 paragraph, the version
  table moved to 0.1.24, the install command and the "default `latest`" line follow,
  and the release-verification link points at `docs/releases/v0.1.24/README.md`;
  `compatibility.json` deliberately unchanged (the host matrix did not move).
- **Release record:** `docs/releases/v0.1.24/README.md` — before/after table for the
  addressing surface, the verification matrix, the new checks, the artifact digest and
  the deployment/rollback rows.
- **Docs corrected while shipping:** `docs/quality-gates.md` attributed the S08–S12
  features to `v0.1.22`, the version the plan reserved for them before the artwork
  hotfix took that number; those labels now read `v0.1.23`, and a new §1.6 documents
  the v0.1.24 addressing change. `.socraticodecontextartifacts.json`'s
  `latest-release-notes` artifact moved from `v0.1.22.md` to `v0.1.24.md`.
- **Local suite (logs in `.local/logs/s15/`):** typecheck exit 0; build exit 0;
  `verify.mjs` **240 PASS / 0 FAIL**; `quality-gates-tdd` **132 PASS / 0 FAIL**;
  `lifecycle-verify` **145 PASS / 0 FAIL**; all 21 suites, `verify-package`,
  `sync-skill --check` and the language check exit 0; `readme-version` reports
  "match 0.1.24".
- **Artifact:** `.local/dist/nanmicoder-dsh-agent-teams-0.1.24.tgz`, 2 263 430 bytes,
  SHA256 `77423C113E25F6FC6C81A09AA7FC5FF58EB53A77C1312D0FF81EA2D28C104CBD`; copied to
  `D:\OwlCats\AI_Tools\dsh-agent-teams-0.1.24.tgz` for the profile install.
- **Deployed** into `C:\Users\whitl\.dsh\profiles\web` (the spec changed, so a plain
  `add` resolved; the `bundles` order was already correct): installed version 0.1.24,
  `lib/{client,index,tools,state,quality-gates,artwork}.js` byte-identical to this
  checkout, `TEAM_TOOL_NAMES` = 18, the installed prompt carries the `team_id` rule and
  the installed tools carry the listing error, `dsh --profile web --dump-config` still
  resolves `id: agent-teams` with `stateDir: .agent-teams`. Backups:
  `*.bak-2026-09-20-pre-0.1.24`; rollback target is the 0.1.23 tarball.
- **Tag:** annotated `v0.1.24` with the branch marker and the artifact facts, pushed to
  the fork together with the branch.
- **Owner action:** restart the harness so the running `dsh web` process (PID 26400)
  loads 0.1.24; the browser needs no cache work (artwork URLs keep their revision).
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs`, and the
  real-host matrix.

### S14 — WP11 phase 1: `team_id` addressing (green)

Scope (plan §WP11 phase 1, owner decisions D5 + D6): team identity becomes an
argument instead of a property of the calling session, so one workspace can hold
several teams (requirement R2) and any folder works (R1/R3).

- **`src/state.ts`:** `findTeamByCaptain` / `findTeamByParticipant` (which threw
  `ambiguous` at two teams) are replaced by list-returning `listTeams`,
  `findTeamsByCaptain`, `findTeamsByParticipant` plus `describeTeamHandles` for
  human-readable id/name lists.
- **`src/tools.ts`:** every team-scoped tool gained a `team_id` parameter;
  `pickCallerTeam` is the single enforcement point — a missing id throws
  `team_id is required: you participate in N teams (<handles>)`, an unknown id
  names the caller's teams. The parameter is deliberately **optional in the
  argument schema**: the runtime validates arguments before the handler runs, so
  `required: true` would answer with a bare `missing required property` instead
  of the list, and D5 asks for one-step self-correction. Members of exactly one
  team keep omitting it (`capabilities.ts` context), so the member prompt is
  unchanged. `agent_teams_create` returns the id and needs `new_team: true` for
  a second team; the duplicate-team error keeps the historical
  "Use agent_teams_status and continue the existing team" guidance, adds the
  `new_team=true` rule and keeps refusing to end the old team first.
  `agent_teams_status` without an id lists the caller's teams (`team_id`, name,
  phase, halted, `tasks: {total, done}`, members, activeWorkers, role) when there
  are several and still answers a single team in detail. State-based guard (D6):
  a fifth live team and a ninth concurrently working member are refused, with the
  live count in the message; configurable keys stay in phase 3 (S19).
- **`src/index.ts`:** prompt rule 1 is the addressing rule (remember the id from
  `create`, `status` with no argument if unsure, second team needs an explicit
  request plus `new_team: true`); the web routes and the panel resolve the caller's
  team by id through the list API.
- **Tests (the plan's WP11 list, phase-1 part):** `scripts/lifecycle-verify.mjs`
  gained the multi-team scenario — two teams in one workspace, `new_team`
  guard, a missing `team_id` naming both ids, the `status` list shape versus the
  per-team detail, a cross-team `update_task` probe that uses a task id the
  addressed team does not own, archiving one team leaving the other live, and the
  fifth-team refusal. The harnesses in `lifecycle-verify.mjs`, `stress-verify.mjs`
  and `quality-gates-tdd.mjs` now remember the id their `create` returned and pass
  it like a model would (a `null` override omits it on purpose for the negative
  case); `capabilities.test.mjs` names its team on the archive call.
- **Docs:** README capability row, `docs/usage.md` (create row, status row, a new
  "Addressing a team" section, the rewritten limitation),
  `docs/progressive-loading.md` (the two core rules).
- **Green:** typecheck exit 0; build exit 0 (twice, after the S11/S12 trap);
  `verify.mjs` **240 PASS / 0 FAIL**; `quality-gates-tdd` **132 PASS / 0 FAIL**;
  `lifecycle-verify` **145 PASS / 0 FAIL** (was 129); `stress-verify` 21;
  `capabilities.test.mjs` 18/18; all 21 suites and `sync-skill --check` exit 0
  (logs in `.local/logs/s14/` and `.local/logs/s14b/`).
- **Deferred, with a FOLLOWUPS entry:** the plan's `stress-verify` line "two teams,
  one free member, no double assignment" needs the phase-2 cross-team scheduler;
  phase 1 keeps assignment inside one team, where a member cannot be double-booked
  by construction.

### S13 — docs + release 0.1.23 (done)

- **Release mechanics:** `package.json` 0.1.22 → 0.1.23; `release-notes/v0.1.23.md`;
  README gained the release paragraph, the version table and the install command, and
  dropped the shipped work packages from "remaining plan work" (only `team_id` and the
  0.2.0 items remain); `readme-version.mjs` reports "match 0.1.23";
  `compatibility.json` deliberately unchanged (the host matrix did not move).
- **Release record:** `docs/releases/v0.1.23/README.md` with the per-step table, the
  verification matrix, the new checks per suite, the artifact digest and the
  deployment/rollback rows.
- **Local suite (logs in `.local/logs/s13/`):** typecheck exit 0; build exit 0;
  `verify.mjs` **237 PASS / 0 FAIL**; `quality-gates-tdd` **132 PASS / 0 FAIL**; the
  other 19 suites and both policy checks exit 0; `readme-version`, `verify-package` and
  `release-metadata.test.mjs` pass.
- **Artifact:** `.local/dist/nanmicoder-dsh-agent-teams-0.1.23.tgz`, 2 257 086 bytes,
  SHA256 `C2FD504D…68E8`; copied to `D:\OwlCats\AI_Tools\dsh-agent-teams-0.1.23.tgz` for
  the profile install.
- **Deployed** into `C:\Users\whitl\.dsh\profiles\web` (remove → add, then the
  `bundles` order restored): installed version 0.1.23, `lib/{client,index,tools,
  quality-gates,state}.js` byte-identical to this checkout, `TEAM_TOOL_NAMES` = 18 with
  the four new tools, `dsh --profile web --dump-config` resolves `id: agent-teams`.
  Backups: `*.bak-2026-09-20-pre-0.1.23`.
- **Tag:** annotated `v0.1.23` with the branch marker, pushed to the fork together with
  the branch (see the Release tags section for the rule).
- **Left for CI:** the whole `pnpm verify` chain, `compatibility.test.mjs`, and the
  real-host matrix.

### S12 — WP6.4: `requiredReviewers` is enforced (done)

Scope (plan §6.4, the plan's recommendation: enforce rather than delete):
`canDeclareDelivery` requires a passing review from every entry of
`reviewPolicy.requiredReviewers`.

- **Rule:** for each entry, at least one `review` task that is `completed` with
  `verdict=pass` whose reviewer matches. Matching follows the spec sentence
  ("known role aliases or member names"): the member **name** equals the entry
  case-insensitively, or the reviewer member's **role** contains the entry as a
  substring (`correctness` matches `correctness-reviewer`). A review the captain
  owns satisfies nobody — the captain is not an independent role. The blocker is
  `no passing review from the required reviewer "<entry>" (reviewPolicy.requiredReviewers)`.
  An absent or empty list keeps Delivery open, so no existing team is retroactively
  blocked.
- **RED first:** two of the five new group-Q labels failed (`missing-role-blocks-delivery`
  returned no blockers at all; the captain-owned review counted as a role).
- **GREEN:** `quality-gates-tdd` 132 PASS / 0 FAIL; `verify.mjs` 238 PASS / 0 FAIL;
  all 21 suites exit 0.
- **Fixture change, recorded because it touches shared test setup:** the shared
  `team()` helper in the tdd suite carried an inert
  `reviewPolicy.requiredReviewers: ['correctness', 'security', 'scope']` while no
  fixture team staffs a security or scope reviewer. Once the field became live, every
  unrelated Delivery check (dead tasks, waivers, supersession) would have failed for
  a policy it never modelled. The default list was removed — the assertions were not
  touched — and group Q sets the policy explicitly for each case it makes a claim
  about. No existing assertion was weakened: nothing asserted that list's effect,
  because nothing enforced it.
- **Build trap (second occurrence of the S11 lesson):** the first build after the
  rule change failed on `reviewer.role` being optional (`TS18048`) while the old
  `lib/` was already deleted, and the tdd suite reported green against the
  partially-emitted tree. Fixed the type narrowing, rebuilt to exit 0, and only then
  trusted the suite.
- **Docs:** `docs/quality-gates.md` §5.3 documents the enforcement and the matching
  rule; `docs/usage.md` states it next to the profile example; README gained the
  capability row and dropped the field from "remaining plan work".

### S11 — WP6.3: the known-delta registry (done)

Scope (plan §6.3): `TeamState.knownDeltas: { id, check, expected, reason, pinnedBy, at }[]`,
captain-only `pin_delta`/`unpin_delta`, automatic waiver evidence for a pinned check,
and a `Known deltas` section in `agent_teams_status`.

- **Types/rules:** `KnownDelta` in `src/types.ts`, `TeamState.knownDeltas?` (optional, so
  every `team.json` written before this step still loads — the reader validates the array
  element-by-element when present). `src/quality-gates.ts` gains `isKnownDelta`,
  `pinnedDeltaFor`, `pinnedWaiverEvidence`, `pinKnownDelta`, `unpinKnownDelta`; `state.ts`
  re-exports them and uses `isKnownDelta` in the durable team validator.
- **Identity rule:** `check` is the key. A second pin for the same check is refused with
  the existing id, because two reasons for one red check would make the automatic evidence
  ambiguous and hide a stale pin. `unpin` names the pinned ids when the id is unknown.
- **Auto evidence:** `update_task` parses results in a deferred-evidence mode, fills a
  `waived` item with no evidence from the pinned entry (`pinned delta <id>: <reason>
  (expected: …)`, exact check text first, containment second so `pnpm run lint -- --quiet`
  still matches), and only then rejects a waiver that still has no reason — the rejection
  now points at `pin_delta`. The WP1 chain is untouched: the task is flagged `hasWaivers`
  and delivery stays blocked until a review confirms it.
- **Tools:** captain-only `agent_teams_pin_delta` / `agent_teams_unpin_delta` (tools are now
  18), new session event `agent-teams/delta-pinned` carrying the action, and the status
  payload/`renderStatus` gained the registry.
- **RED first:** the new `P. known deltas` group (5 labels) had no implementation; the
  capability suite still pinned 16 tools.
- **GREEN:** `quality-gates-tdd` 126 PASS / 0 FAIL; `verify.mjs` 237 PASS / 0 FAIL (two new
  checks: the captain-only registry that feeds the status report; the pin-supplied evidence
  path plus the durable delta shape); lifecycle `all lifecycle checks passed` with five new
  checks (pin once and see it in the payload, duplicate refused by name, a pinned check
  waives without written evidence, an unpinned check still demands it, the status report
  carries the registry).
- **Build trap hit:** the first `pnpm build` failed on a missing `isKnownDelta` import, and
  because `clean-build` had already deleted `lib/` while `tsc` emitted the host files despite
  the error, the tdd suite ran green against a partially rebuilt `lib/` (the client bundle
  was missing). Re-ran the build after the import fix and treated the suite result as
  invalid until the build exited 0 — worth remembering before trusting a suite right after a
  failed build.

### S10 — WP4: honest scope reports, `accept_paths`, `sharedInScope` (done)

Planned test labels (WP4 of the plan): `tdd.scope.shared-paths-not-in-overlap`,
`tdd.scope.accept-paths-additive`, `tdd.scope.undeclared-goes-to-scope-review`,
`tdd.scope.accept-completes-task`, plus `docs/quality-gates.md` §6.2.

- **State (`src/types.ts`, `src/state.ts`):** new intermediate status
  `awaiting_scope_review`, reachable from `in_progress` and leaving to `completed`
  (accepted), `pending` (retry), `failed`/`cancelled`/`superseded`. It is not
  terminal, never claimable, and blocks descendants exactly like `in_progress`
  (`taskVisualState` maps it to `running`, the reader accepts it).
- **Gate (`src/quality-gates.ts`):** an `implementation`/`repair` completion that
  lists a path outside `inScope` no longer fails. The gate refuses the `completed`
  transition with `requiredStatus: 'awaiting_scope_review'`, reports **every**
  undeclared path at once (`scopeReview`), and names `accept_paths` in the error.
  A path that is in `inScope` *and* matches `outOfScope` stays a hard failure — that
  is a contradictory contract, not a scope decision. Delivery blocks a held task
  with `<id> is awaiting a scope decision (accept_paths, or reassign/supersede it)`.
- **New rule:** `acceptTaskPaths(team, task, paths, by, reason, force)` — additive
  `inScope` widening, a `revisions` entry, and the same post-review freeze/`force`
  semantics as `amendTaskContract`. It also works on a `completed` task (post-hoc
  acceptance), which is the point of the feature.
- **New tool:** captain-only `agent_teams_accept_paths({ task_id, paths, reason,
  force? })`. It applies the rule and, when the task was held, re-evaluates the
  completion gate with the evidence already stored: the lane completes in the same
  call when the widened scope covers what the worker reported, otherwise the result
  names what is still outside. `update_task` consumes `gate.scopeReview` and stores
  `awaiting_scope_review`. Tools are now 16.
- **Profiles (`src/profiles.ts`, `src/types.ts`):** `taskPlanning` accepts the
  original string or `{ mode, sharedInScope }`; the new `TASK_PLANNING_KEYS` scope
  validates the nested keys and feeds the near-miss hint. `resolveProfileSharedInScope`
  exposes the paths, the team snapshot freezes them, `create_task` merges them into
  every implementation/repair `inScope`, and `validateCreateTask` subtracts them
  (`subtractScope`) from both sides of the overlap comparison — sibling lanes may
  both touch the generated docs without a false conflict.
- **UI:** `task.status.awaitingScopeReview` in both locales and the panel's status
  label map; the visual state stays `running` because the work exists and only the
  decision is missing.
- **RED first:** the new tdd group failed on 4 of 8 labels (`shared-paths…`,
  `undeclared-goes-to-scope-review`, `accept-paths-additive`, `accept-completes-task`),
  the transition matrix lost a status, and the S08 lifecycle check still expected the
  old refusal.
- **GREEN:** `quality-gates-tdd` 121 PASS / 0 FAIL; `verify.mjs` 235 PASS / 0 FAIL
  (three new checks: the captain-only additive tool that completes a held lane; the
  hold-instead-of-fail wiring end to end; the profile shared scope and its overlap
  exclusion); lifecycle `all lifecycle checks passed` with three new checks
  (undeclared path holds the task with its evidence; accepting completes it; the
  accepted lane no longer blocks the team record).
- **Honest test adaptation:** the S08 lifecycle check asserted the old hard refusal
  (`/scanner\.test\.ts is undeclared/`). It now asserts the new contract — the task
  is held in `awaiting_scope_review` with the path recorded — and that same lane
  still fails explicitly and is then amended and retried, so the S08 scenario keeps
  testing what it was written for.
- **Test-authoring traps hit (not product bugs):** my first WP4 group spread the
  contract object *after* the per-case overrides, so every case silently used the
  shared `implContract()` scope; and `{ ...candidate, inScope: [...] }` kept the
  candidate's `sharedInScope`, so the "still guards own paths" case could never
  overlap. Both fixed by explicit literals in the suite.

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
