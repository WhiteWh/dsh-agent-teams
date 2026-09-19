# AgentTeams quality gates and multi-round review

> Status: implemented (this document is the single execution spec)
> Audience: an implementation agent starting in a fresh window. Implement only what this document says — do not invent requirements, and do not write code before writing the test.
> Repository: the workspace root. Do not infer the workspace from machine-absolute paths.
> Baseline: Captain dynamic planning, DAG scheduling, `attempt_id`, failure blocking and whole-team stop on `feat/captain-planning-team-stop`.
> This document upgrades "multi-round requirement/code review until it passes" from a prompt protocol into a machine-decidable state.

## 0. One-sentence goal

Upgrade AgentTeams from "a reliable multi-agent task-scheduling base" into "a delivery system with structured task contracts, review verdicts, an automatic repair chain, enforced TDD and scope gates".

In this repository, "until consensus" does **not** mean "several agents said it looks fine". It means:

```text
every required gate passes
+ every acceptance item passes
+ no blocker / high finding is open
+ the latest implementation generation was reviewed by an independent reviewer
+ the declared verification commands pass
+ the change scope is legal
```

## 1. Current baseline: what exists, what is missing

### 1.1 Already present, must be reused

| Capability | Location | Must keep |
|---|---|---|
| Task state machine `pending → claimed → in_progress → completed\|failed\|cancelled`, plus the legalized retry `failed → pending` (v0.1.22) | `src/types.ts`, `src/state.ts` | `completed` and `cancelled` are read-only; a failed task is amendable and retryable; `claimed` cannot jump to `completed` |
| Dependencies only accept an upstream `completed` | `unsatisfiedDependencies()` | `failed` / `cancelled` never unlock downstream work |
| `attempt` + `attemptId` | `beginTaskAttempt()` / `update_task` | late writes must keep being rejected |
| Captain dynamic planning | `taskPlanning: captain` | do not revert to requiring a fixed seed DAG |
| Parallel ready tasks | `src/scheduler.ts` | tasks with no real dependency relationship may still run in parallel |
| Whole-team stop | `haltTeamWork()`, `POST /plugins/dsh-agent-teams/halt` | stop still does not delete the team |
| Existing verification entry points | `pnpm typecheck`, `pnpm build`, `pnpm verify` | new checks must be wired into `pnpm verify` |

### 1.2 Current gaps (must be fixed)

1. `TeamTask` has only `subject` + optional `description`; no contract, scope, acceptance or verification.
2. Review is just a `role` string; the scheduler does not know it is a review.
3. `completed` is passed unconditionally. A reviewer can write "major disagreement remains" and still mark `completed`.
4. A failed review does not automatically produce `repair-N` / `review-N+1`.
5. There is no `round`, no `maxReviewRounds`, no finding lifecycle.
6. There is no `changed_paths`, so out-of-scope edits cannot be audited.
7. `create_task` silently clears `halted`, which risks an accidental resume.
8. Existing tests cover scheduling, not quality gates. This requirement must start with failing tests.

### 1.3 Added in v0.1.21: acceptance waivers (`waived`)

Field evidence is in `D:/OwlCats/AI_Tools/Docs/AGENT_TEAMS_FEEDBACK.md` section 2: two
acceptance criteria of `t5` pointed at checks that were **already red on HEAD** for an
external reason. The honest implementer refused to write `passed` for such a
measurement, so the task was forced `failed` even though the lane's work was fully
correct.

v0.1.21 therefore adds a third acceptance status:

```ts
type AcceptanceResultStatus = 'passed' | 'failed' | 'waived'
```

Rules (machine-enforced):

- `waived` **must** carry a non-empty `evidence` naming the reason and the baseline it
  was compared against. A waiver without a reason is rejected both by the tool-argument
  parser and at the `team.json` boundary.
- `waived` counts as "this item is covered", exactly like `passed`, so it does not block
  `completed`.
- The task is flagged with `hasWaivers`, and **delivery stays blocked**:
  `canDeclareDelivery` reports `<id> has unconfirmed waivers` until a task with
  `kind=review` and `verdict=pass`, whose `reviewedTaskId` points at it, supplies an
  explicit `waiverConfirmation`. Writing "I confirm the waiver" in `output` does **not**
  count — that path cannot be machine-decided.
- `reviewPolicy.allowWaivers: false` disables the whole mechanism: `waived` is then
  treated as an ordinary gate failure. It is enabled by default.

The second way out is a **no-regression criterion**: an acceptance item may be an object

```ts
{ text: string, mode?: 'pass' | 'no_regression', baseline?: string }
```

A bare string is equivalent to `mode: 'pass'`. A `passed` result for a `no_regression`
criterion must name the baseline (commit or artifact) in `evidence`; a `passed` without a
baseline is rejected.

At the same time the **length-parity fallback was removed**: the old implementation
accepted "the result array has the same length and everything passed" as contract
satisfaction, so an all-pass report about entirely different items also passed the gate.
Matching is now by **normalized text** (trim, collapse internal whitespace, drop trailing
punctuation), and a failure lists every uncovered criterion by name. Contract text
remains human-readable prose rather than an opaque id, but it must not degrade into a
wildcard.

### 1.4 Added in v0.1.22: the whole contract is amendable, and a failed task retries

Field evidence is in `D:/OwlCats/AI_Tools/Docs/AGENT_TEAMS_IMPROVEMENT_PLAN.md` WP2 and
`AGENT_TEAMS_FEEDBACK.md` section 1: the amendment covered five contract fields, rejected
every `kind=work` task, and treated `failed` as immutable. A captain who had undercounted
`inScope`, or written a brief for the wrong lane, therefore still had to cancel and
recreate the task — and a red lane had no way back at all.

**Amendable fields.** `agent_teams_amend_task` replaces whole fields (lists are full
replacements, never deltas) and now covers:

| Task shape | Amendable |
| --- | --- |
| quality (`requirements`, `implementation`, `verification`, `review`, `repair`, `integration`) | `objective`, `acceptance`, `verify`, `inScope`, `outOfScope`, `deliverables`, `nonGoals`, `reviewedTaskId`, `subject`, `description` |
| `work` | `subject`, `description`, `deliverables`, `nonGoals` — a work task has no quality contract, and an attempt to amend `objective`/`acceptance`/`verify`/`inScope`/`outOfScope`/`reviewedTaskId` on it is rejected with that field list |

`reviewedTaskId` must name an existing task whose kind is one of `implementation`,
`repair`, `verification`, `integration`; pointing a review at itself, at a missing id or
at a `work` task is rejected by name.

**Statuses.** A `failed` task is amendable — that is the first step of the retry, not a
rewrite of history — and `agent_teams_reassign_task` returns it to the pool. The shared
transition table in `src/state.ts` now says so (`failed: ['pending']`), because
`reassign_task` always produced that move through `invalidateTaskAttempt` while the table
claimed the status was terminal; `transitionError` and `evaluateQualityCompletion` read
the same object. `completed` and `cancelled` remain immutable.

**Freeze and the forced override.** Once a `review`/`requirements` task has passed
judgment (`verdict=pass`, `reviewedTaskId` pointing at the task) the contract is frozen.
`force: true` with the same mandatory non-empty `reason` overrides that freeze and marks
the judge's verdict `stale`, so delivery can no longer treat the changed contract as
reviewed; the amendment also lands in the revisions ledger. `stale` is a durable verdict
value but deliberately **not** in the `agent_teams_update_task` parameter enum: only the
captain's forced amendment produces it.

**Running teams.** `agent_teams_edit_plan` (`update_task`) may retarget `dependencies`
and `assignee` for a task that has not started (`pending`, any attempt) and for a `failed`
task. A task a member currently holds (`claimed`/`in_progress`) is still refused there:
that edit belongs to the replan operation with explicit attempt invalidation.

**Visibility.** Every amendment is appended to the task's `revisions` ledger (previous
values + reason + field list), and `agent_teams_status` prints `revised ×N` on a task whose
contract was amended.

### 1.5 Added in v0.1.22: `superseded` — replacing a lane that will not finish

Feedback §3: a red lane could only be removed by takeover plus cancel. The `failed` row
stayed in the graph, descendants waited forever on a task nobody would complete, and a
review kept pointing at the dead id.

`agent_teams_supersede_task({ task_id, reason, replacement? , <create_task fields>? })` is
captain-only and does the whole replacement in one locked operation:

1. the replaced task becomes `superseded`, gains `supersededBy`, loses its capability
   (`attemptId`/`handoffId`) and its `changedPaths`; its `output` stays as history;
2. every **non-terminal** task that depended on it now depends on the replacement;
3. every **non-terminal** `review`/`repair` contract that pointed at it
   (`reviewedTaskId` / `sourceTaskId`) is retargeted to the replacement;
4. the replacement is either an existing task id (`replacement`) or a task created inside
   the same call, inheriting `kind`, `round`, `sourceTaskId`, `coverageOf` and, by default,
   the replaced task's `dependencies`.

Refused: superseding a `completed` task (immutable), superseding a task that is already
`superseded`, and a replacement that (transitively) depends on the task it replaces —
that would build a dependency cycle the redirect cannot represent.

A dependency on a superseded task counts as satisfied once **its replacement** is
satisfied, recursively (`unsatisfiedDependencies`): the redirect keeps the live graph
readable, and the rule covers the history that was never rewritten. A superseded task with
no recorded replacement never satisfies anything.

Delivery treats `superseded` exactly like `cancelled` (`DEAD_TASK_STATUSES` in
`src/types.ts`): it is not a blocker, it cannot be confirmed by a review, and its paths are
never audited (the path loop follows `completed` work only). The scheduler never dispatches
it, and the panel draws it in its own grey tone with the `task.status.superseded` label
instead of the error colour — a replaced lane is dealt with, not failed.

## 2. Allowed / not allowed

### 2.1 Allowed

- Add a structured contract, `kind`, `round`, `verdict`, `findings`, `changedPaths`, `verify` to a task.
- Make `create_task` / `update_task` reject illegal completion according to the contract and verdict.
- Automatically create a repair task and the next independent review round after a failed review.
- Add review-policy configuration to the profile: minimum rounds, maximum rounds, required reviewers.
- Record `changed_paths`, `acceptance_results`, `commands_run` at completion.
- Use a git/workspace diff for completion-time scope audit.
- Change `create_task`'s automatic unhalt into an explicit `resume`.
- Add a Captain coverage matrix / stage summary.
- Add a mandatory TDD script and make `pnpm verify` run it.
- Update the parts of `docs/usage.md` and `README.md` that relate directly to this feature. `README_ZH.md` is frozen legacy and is not maintained (see the documentation language policy in `AGENTS.md`).
- Reuse the existing DAG, attempt, mailbox, halt and scheduler machinery.

### 2.2 Not allowed

- Do not build a second workflow engine.
- Do not implement Issue #72 (Staging / Approve & Run / planning-time GUI approval).
- Do not make "several agents told each other OK" a termination condition.
- Do not let an implementer approve its own implementation or repair.
- Do not give review / test tasks write permission semantics by default. The first version must at least forbid it in the contract and the completion audit; do not pretend that all bash/fs access has been intercepted.
- Do not let a repair task depend on a `failed` review task.
- Do not rerun an old review with `reassign_task` instead of creating `review-N+1`. `beginTaskAttempt()` clears the previous output.
- Do not treat `send_message` as a formal next review round. Mail has no gate.
- Do not revive `failed` / `cancelled` tasks by hand. Since v0.1.22 a `failed` task may be **amended and retried** through `reassign_task` (the legal `failed → pending` transition), but `completed` and `cancelled` stay read-only; any other next round must create a new task.
- Do not modify `~/.dsh/profiles/web/cordis.patch.yml` unless the user explicitly asks for it in the current window.
- Do not commit or push `docs/multi-role-profiles.md`, `docs/personal-kb-delivery/`.
- Do not commit / push / open a PR unless the user explicitly asks.
- Do not start a server that replaces the Web GUI.
- Do not do a real deployment, and do not run a production release automatically.
- Do not advertise "do not touch other files" in a prompt as a hard security boundary. The first version only guarantees a completion-time audit and rejection of `completed`.
- Do not fake "a member's write tool fails immediately when it goes out of scope" while the host has no unified write-interception interface.
- Do not build independent git worktree isolation in one go. That is a follow-up PR, outside this requirement.
- Do not change the official DSH checkout for this feature.
- Do not expand into refactoring unrelated UI, panel animations or image assets.

## 3. Boundaries and responsibilities

### 3.1 System responsibility

The system must machine-enforce:

- An implementation/repair task without a contract cannot be created.
- A task without acceptance evidence cannot `completed`.
- `review` / `requirements` cannot `completed` without `verdict=pass`.
- `needs_revision` / `reject` cannot unlock downstream work.
- An out-of-scope `changed_paths` cannot `completed`.
- A failed verification command can only `failed`.
- A failed review automatically opens a repair + next review round until it passes or the ceiling is reached.
- After `maxReviewRounds` the automatic loop stops and escalates to the Captain / user.
- A halted team cannot be resumed by an ordinary `create_task`.

The system does **not** guarantee:

- that a member is completely unable to modify out-of-scope files with bash during execution;
- that the model writes high-quality code;
- that the user has pre-reviewed the DAG in the GUI.

### 3.2 Captain responsibility

- Draw the smallest task graph that satisfies the user goal.
- Create requirement/acceptance tasks first, then implementation tasks.
- Emit a coverage matrix: every user constraint maps to at least one task.
- Do not approve an implementation yourself unless the user explicitly asks the Captain to take over.
- Escalate to the user when rounds are exceeded or the contract is unclear, instead of reviewing each other indefinitely.
- When the user only wants a report and not further execution, do not `create_task`; answer from status / existing results.

### 3.3 Member responsibility

| Role | May do | May not do |
|---|---|---|
| requirements-analyst | produce goal, scope, acceptance, open questions | write implementation code; declare requirements converged on its own |
| requirements-challenger | find omissions, ambiguity, conflicts | rewrite the requirement contract as final; write implementation |
| implementer | change only files inside `inScope`; run `verify` | change `outOfScope`; approve its own implementation |
| test-engineer | add tests, run verification, report failures | treat a test failure as a pass; widen product scope |
| correctness-reviewer | read-only review of logical correctness | change code directly; review an implementation it just wrote |
| security-reviewer | read-only review of permissions/injection/leaks | change code directly |
| scope-reviewer | check out-of-scope edits against the contract and `changed_paths` | wave through an unaccounted change |
| integrator | final verification, collect evidence | declare delivery while review has not passed |
| fixer / repair | fix only the named findings | do `outOfScope` work on the side; mark a review pass itself |

### 3.4 User responsibility

- Provide the goal and the constraints.
- Confirm ambiguous open questions.
- Explicitly ask to stop or resume the team.
- A real deployment must be confirmed by the user.

## 4. Product flow

```text
user goal
  ↓
requirements-round-1
  ↓
requirements-challenge
  ↓
requirements converged?
  ├─ open questions not closed → implementation tasks cannot be created
  └─ verdict=pass
       ↓
coverage matrix complete
       ↓
implementation
       ↓
verification
       ↓
correctness / security / scope review in parallel
       ↓
everything passed?
  ├─ no → repair-round-N (does not depend on the failed review)
  │        ↓
  │      verification
  │        ↓
  │      review-round-N+1 (must target the latest attempt)
  │        ↓
  │      maxReviewRounds exceeded?
  │        ├─ yes → escalate to Captain / user, stop the automatic loop
  │        └─ no → continue
  └─ yes
       ↓
integration / final verification
       ↓
scope audit + coverage matrix
       ↓
delivery
```

The number of requirement rounds is configured by the profile; do not hard-code "every task must have 3 rounds". A small task may pass in 1 round; a high-risk task may require at least 2.

## 5. Data model

Extend the existing `TeamTask` / `TeamState` / `TeamProfileSnapshot`. Do not start a separate state file unless the existing `team.json` cannot hold the ledger; the first version may keep the ledger as a projection of task output + status.

### 5.1 Enums

```ts
type TaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work' // backwards compatible with old tasks; ordinary work with no quality gate

type ReviewVerdict =
  | 'pass'
  | 'needs_revision'
  | 'reject'
  | 'stale' // durable only: a forced amendment invalidated this verdict (v0.1.22)

type FindingSeverity =
  | 'low'
  | 'medium'
  | 'high'
  | 'blocker'
```

### 5.2 New task fields

```ts
interface ReviewFinding {
  id: string                 // stable id, e.g. SEC-001
  severity: FindingSeverity
  file?: string
  line?: number
  problem: string
  requiredFix: string
  resolved?: boolean
}

interface AcceptanceResult {
  criterion: string
  // v0.1.21: 'waived' requires non-empty evidence (see section 1.3)
  status: 'passed' | 'failed' | 'waived'
  evidence?: string
}

interface CommandResult {
  command: string
  status: 'passed' | 'failed' | 'waived'   // v0.1.21, same rules as acceptance
  exitCode?: number
  evidence?: string
}

// v0.1.21: an acceptance item is either a bare string or an object
interface AcceptanceCriterion {
  text: string
  mode?: 'pass' | 'no_regression'
  baseline?: string
}

// v0.1.21: how a review task confirms the waivers of the task it judged
interface WaiverConfirmation {
  taskId: string
  reason: string
  waived?: string[]
}

interface TeamTask {
  // existing fields stay unchanged
  kind?: TaskKind
  round?: number
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: (string | AcceptanceCriterion)[]   // v0.1.21
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
  hasWaivers?: boolean                             // v0.1.21: this report contains a waived item
  waiverConfirmation?: WaiverConfirmation          // v0.1.21: review only
  reviewedTaskId?: string
  reviewedAttempt?: number
  sourceTaskId?: string        // the implementation / previous artifact a repair targets
  sourceFindingIds?: string[]
  coverageOf?: string[]        // user constraints / goal items covered
}
```

When an old task lacks these fields:

- `kind` defaults to `'work'`.
- `'work'` keeps the old behaviour so existing teams and tests are not broken.
- Newly created `requirements` / `implementation` / `verification` / `review` / `repair` / `integration` must go through the new gates.
- Every field added in v0.1.21 is **optional on read**: `waived`, a `no_regression`
  object, `hasWaivers` and `waiverConfirmation` may all be missing and the state still
  cold-resumes, and a bare-string criterion keeps its meaning.

### 5.3 New team / profile fields

```ts
interface ReviewPolicy {
  requirementsMinRounds?: number // default 1
  requirementsMaxRounds?: number // default 4
  codeMaxRounds?: number         // default 3
  maxRepairAttempts?: number     // default 2
  requiredReviewers?: string[]   // e.g. ['correctness', 'security', 'scope']
}

interface TeamState {
  // existing fields
  reviewPolicy?: ReviewPolicy
}

interface TeamProfileConfig {
  // existing fields
  reviewPolicy?: ReviewPolicy
}
```

Configuration validation:

- Every round count must be a positive integer.
- `min <= max`.
- `requiredReviewers` may only contain known role aliases or member names.
- Unknown fields keep being rejected by the existing profile allowlist.

### 5.4 Persistence validation

`isTeamTask()` / `isTeamState()` must accept and validate the new optional fields:

- An illegal enum value rejects the whole `team.json`.
- An empty-string `objective` / an empty `inScope` entry is illegal.
- `round`, when present, must be a safe integer `>= 1`.
- `findings[].id` must be non-empty and unique within a task.

Files that lack the fields must still cold-resume.

## 6. Machine rules

These rules must be enforced by tools / the state machine, not merely written into a persona.

### 6.1 Creating a task

`agent_teams_create_task` gains optional parameters:

```ts
{
  subject: string
  description?: string
  dependencies?: string[]
  assignee?: string
  kind?: TaskKind
  round?: number
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  reviewedTaskId?: string
  sourceTaskId?: string
  sourceFindingIds?: string[]
  coverageOf?: string[]
  resume?: boolean
  resumeReason?: string
}
```

Creation rules:

1. `kind` defaults to `'work'`, keeping old calls compatible.
2. When `kind` is `implementation` / `repair` / `verification` / `review` / `requirements` / `integration`:
   - it must have a non-empty `objective`;
   - it must have a non-empty `acceptance` (at least 1 item).
3. `implementation` / `repair` additionally need a non-empty `inScope` and a non-empty `verify`.
4. `review` must have `reviewedTaskId`, and the target task must exist.
5. `repair` must have `sourceTaskId` and at least 1 `sourceFindingIds` entry.
6. The `dependencies` of a `repair` / next-round `review` must not contain a `failed` / `cancelled` task.
7. Within one team, if two `implementation|repair` tasks that are simultaneously `pending|claimed|in_progress` have intersecting `inScope` path sets, creation is rejected or a dependency is required. First version: reject parallel creation on intersection, and the error message must name the conflicting path and the other task id.
8. When the team is `halted=true`:
   - `create_task` is rejected by default;
   - only `resume=true` with a non-empty `resumeReason` clears `halted/haltedAt` and creates the task;
   - an ordinary creation must never resume silently.
9. While requirements have not converged, both the Captain protocol and the tool layer must block implementation:
   - if the team already has a `kind=requirements` task and none is `completed + verdict=pass`, reject creating an `implementation`;
   - if there is no requirements task at all, allow creation; this is the legacy usage without quality configuration. A quality profile must create requirements first.

### 6.2 Updating / completing a task

`agent_teams_update_task` gains optional structured parameters, or allows `output` to carry a JSON payload parsed on the side. Prefer explicit parameters; do not rely on free text alone:

```ts
{
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
}
```

**Undeclared paths become a decision, not a failure (v0.1.22, WP4).** A worker
reports what it really changed. When an `implementation`/`repair` completion lists a
path outside its declared `inScope`, the completion gate does **not** fail the lane and
does not accept the completion either: it refuses the `completed` transition with
`requiredStatus: 'awaiting_scope_review'` and reports **every** undeclared path at once,
and `update_task` moves the task into that intermediate status with the evidence
(`changedPaths`, `acceptanceResults`, `commandsRun`, `output`) already stored.

`awaiting_scope_review` is not terminal. It blocks descendants exactly like
`in_progress`, is never claimable, and blocks Delivery with
`<id> is awaiting a scope decision (accept_paths, or reassign/supersede it)`. The captain
then either

- **accepts the paths** — `agent_teams_accept_paths({ task_id, paths, reason, force? })`
  adds them to `inScope` **additively** (`amend_task` replaces whole lists, which is the
  wrong shape for "also allow these files"), records a revision, and completes the task in
  the same call as soon as the widened scope covers everything the worker reported;
- **reassigns** the task (`reassign_task` → `pending`), or **replaces** it
  (`supersede_task`).

`accept_paths` also works on a **completed** task (post-hoc acceptance) as long as no
`review`/`requirements` verdict has passed judgment on it; after that the contract is
frozen and `force: true` with the same mandatory `reason` is required.

**Known deltas (`pin_delta` / `unpin_delta`).** A check that is red in this workspace for
a reason outside the lane — a repo-wide lint baseline, a flaky external service — forces
every lane to invent the same waiver reason by hand. The captain pins it once:

```
agent_teams_pin_delta({ id?, check, expected, reason })
agent_teams_unpin_delta({ id, reason? })
```

- `check` is the identity: the command or acceptance-criterion text as the lane will report
  it. A second pin for the same check is refused and names the existing entry, so the
  automatic evidence can never be ambiguous or hide a stale pin.
- The entry is `{ id, check, expected, reason, pinnedBy, at }` on `TeamState.knownDeltas`
  (optional: a team created before the registry simply has none).
- A `waived` command or criterion that carries **no** evidence is filled from the pinned
  entry as `pinned delta <id>: <reason> (expected: <expected>)` — matching is by exact text
  first, then by containment, so `pnpm run lint -- --quiet` still matches a pin on
  `pnpm run lint`. An unpinned waiver without its own evidence stays rejected.
- Delivery keeps the WP1 rule: the task is flagged `hasWaivers` and stays blocked until a
  `review` task confirms the waiver with `waiverConfirmation`.
- `agent_teams_status` prints a `Known deltas` section (id, check, expected, reason,
  author), and the status payload carries the same list.

A path that is listed in `inScope` **and** matches `outOfScope` stays a hard failure: that
is a contradictory contract, not a scope decision, and the rejection says so.

**Shared scope (`taskPlanning.sharedInScope`).** A profile may declare paths that every
`implementation`/`repair` task of the team inherits:

```yaml
taskPlanning:
  mode: captain
  sharedInScope: ['docs/CHANGELOG.md', 'tools/', 'TROUBLESHOOTING.md']
```

The string form (`taskPlanning: captain`) keeps working. Shared paths are merged into the
task's `inScope` at creation and are **excluded from the overlap comparison**, so two
sibling lanes may both touch the generated docs without being reported as a scope
conflict; the same key in a nested `taskPlanning` object is validated like every other
profile scope, and an unknown key inside it is reported with the fix.

Completion rules:

1. The existing state machine is unchanged: `claimed` cannot go directly to `completed`.
2. `kind=requirements|review`:
   - `completed` only with `verdict=pass`;
   - `verdict=needs_revision|reject` must `failed`, with at least 1 `findings` entry;
   - a missing `verdict` rejects `completed` and any "verbal pass";
   - `pass` must not leave an unresolved `blocker|high` finding.
3. `kind=implementation|repair|verification|integration`:
   - `completed` must carry `acceptanceResults`, and every acceptance item must have a
     matching `passed` or an evidenced `waived` (v0.1.21, see section 1.3);
   - it must carry `commandsRun` covering every entry of the task's `verify`, each either
     `passed` or an evidenced `waived`;
   - `implementation|repair` must carry `changedPaths`;
   - any `changedPaths` entry that falls in `outOfScope`, or that cannot be proven to be
     inside `inScope`, allows only `failed`;
   - a failed verification allows only `failed` (a command reported as `status: 'failed'`
     is not affected by waivers).
4. `output` is still stored for humans and downstream readers, but the structured fields are the gate's source of truth.
5. Members must still submit the current `attempt_id`.
6. An implementer cannot mark its own implementation task as a review pass. A review task must be completed by a review role / the assigned reviewer.
7. Waived items are matched with the same **normalized-text** rule: an extra full stop or an
   extra space is not an error, a different criterion is not coverage, and the error
   message names the uncovered item.
8. A `passed` result for a `no_regression` criterion must carry `evidence` naming the
   baseline; it is the only kind of `passed` that may be non-green.
9. `waiverConfirmation` may only appear on a task with `kind=review`, and its `taskId`
   must equal that task's `reviewedTaskId`; otherwise it is rejected.

**The waiver confirmation path (v0.1.21).** After a member submits `waived`:

```text
the task is flagged hasWaivers
  ↓
a review task must have kind=review and reviewedTaskId pointing at it
  ↓
that review completes with verdict=pass and carries waiverConfirmation
  ↓
canDeclareDelivery passes; otherwise "<id> has unconfirmed waivers"
```

With `reviewPolicy.allowWaivers: false` the whole path does not exist: `waived` is treated as a plain failure.

Path matching rules (first version, must be a pure function with unit tests):

```text
inScope / outOfScope use workspace-relative POSIX paths.
Exact files and directory prefixes are supported:
  src/foo.ts     matches that file only
  src/foo/       matches that directory and its subpaths
Matching outside the repository, absolute paths and `..` escapes are forbidden.
outOfScope wins over inScope.
An undeclared path counts as out of scope for implementation/repair.
```

Default hard exclusions, even when not written into `outOfScope`:

```text
~/.dsh/
.git/
**/.env
**/.env.*
**/secrets/**
**/id_rsa*
other git repository roots
```

The first version of the completion audit takes the caller-submitted `changedPaths` as input; a lifecycle test may add a pure function `collectChangedPaths(gitStatusText)` that parses `git status --short` / `git diff --name-only`. Do not depend on a real git repository in unit tests unless it lives in a temporary directory.

### 6.3 Automatic repair / re-review

When a `kind=review|requirements` task ends as `failed` with `verdict=needs_revision`, the system automatically creates:

```text
repair-round-(N+1)
  kind=repair
  assignee=the original implementer, or the assignee of the source task
  sourceTaskId=the task under review
  sourceFindingIds=the unresolved findings
  dependencies=[sourceTaskId]   // the successful artifact, not the failed review
  round=N+1
  inScope=narrowed from findings.file; inherits source.inScope when there is no file
  verify=inherits source.verify
  acceptance=the requiredFix of every finding

review-round-(N+1)
  kind=review
  assignee=the original reviewer; must not become the implementer
  reviewedTaskId=the new repair task
  reviewedAttempt=the attempt the repair completed with
  dependencies=[repair-round-(N+1)]
  round=N+1
```

When the original task was `requirements`, what gets created is the next requirements / challenge round, not a code repair. Keep the naming `requirements-round-N`.

Checks before the automatic creation:

- `round + 1 <= maxRounds`.
- The same `sourceTaskId + finding set + reviewer` has not exceeded `maxRepairAttempts`.
- Once the ceiling is exceeded:
  - no further tasks are created automatically;
  - a mailbox / steer message is sent to the Captain;
  - `escalated: true` (or an equivalent field) appears in status;
  - the team is not halted automatically unless the user stops it.

`verdict=reject`:

- no automatic repair;
- escalate to the Captain / user;
- downstream stays locked.

### 6.4 Scheduling

Keep the existing scheduler:

- dispatch only `pending` tasks whose dependencies are all `completed`;
- the mailbox still outranks a new task;
- a halted team still dispatches nothing;
- auto-created repair / review tasks are ordinary tasks; do not invent a new scheduler for them.

The assignment prompt / persona must additionally carry:

- the current `kind` / `round` / `objective` / `inScope` / `acceptance` / `verify`;
- that a review may only be `pass` / `needs_revision` / `reject`;
- that completion must go through the structured fields;
- that only this task's scope may change;
- that mail is not a formal next review round.

These prompts are assistance, not the gate itself.

### 6.5 Resume semantics

New tool:

```text
agent_teams_resume
```

Parameters:

```ts
{
  reason: string   // required, non-empty
}
```

Behaviour:

- Captain only.
- When the team is not halted, return `already_running` instead of a fatal error.
- When the team is halted, clear `halted/haltedAt` and then `kickTeam`.
- Do not automatically recreate cancelled tasks.
- After a resume only still-`pending` tasks are dispatched; tasks marked `cancelled` while halted stay cancelled.

`create_task` no longer unhalts implicitly. When the Captain needs "resume and create the next-stage task", it should `resume` first and then `create_task`, or use `create_task({ resume: true, resumeReason })` as a convenience entry point inside the same lock. Both entry points must have identical semantics, with tests.

### 6.6 Coverage matrix

The Captain or the system projects it in status:

```ts
{
  goal_item: string
  task_ids: string[]
  status: 'missing' | 'in_progress' | 'passed' | 'blocked'
  evidence?: string
}
```

Rules:

- In quality mode, every constraint extracted from the user goal should appear.
- While a `missing` row exists, status / finalize must not claim the project is complete.
- The first version lets the Captain declare coverage through a task's `coverageOf`; the system checks "does any task declare coverage" and does not parse natural-language goals.
- A pure function is required: goal items + task list in, matrix out.

### 6.7 Final delivery

Do not add a separate "publish" tool. The delivery condition is what the Captain must be able to read from status before reporting to the user:

- every required `requirements` / `implementation` / `verification` / `review` / `integration` task is `completed`;
- every review is `verdict=pass`;
- there is no unhandled `failed` without a corresponding repair;
- there is no `missing` coverage row;
- there is no unaccounted out-of-scope path. Since v0.1.21 this audits only `completed`
  implementation/repair tasks: `changedPaths` left behind by a `cancelled` task no longer
  reddens the delivery report (`superseded` joins the same filter in 0.1.22). This is
  field feedback section 6.2 — the captain had to clear `changedPaths` by hand to get a
  clean report.
- since v0.1.21 there is no unconfirmed waiver: any task with `hasWaivers` waits for a
  `verdict=pass` review that confirms it with `waiverConfirmation`.

A pure function `canDeclareDelivery(team): { ok: boolean; blockers: string[] }` may be provided. The Captain protocol requires: while `ok=false`, do not announce completion to the user.

## 7. Tools and events

### 7.1 Changes to existing tools

| Tool | Change |
|---|---|
| `agent_teams_create_task` | add contract fields; reject by default while halted; enforce the contract for quality kinds; reject scope conflicts |
| `agent_teams_update_task` | add verdict / findings / changedPaths / acceptanceResults / commandsRun; reject an illegal completed by kind |
| `agent_teams_status` | add kind, round, verdict, a findings summary, the coverage matrix, escalated, halt/resume state |
| `agent_teams_create` | a profile may carry `reviewPolicy`; snapshot it into `team.profile` / `team.reviewPolicy` |

### 7.2 New tools

| Tool | Purpose |
|---|---|
| `agent_teams_resume` | explicitly resume a halted team; a reason is required |

Do not add `submit_review` as a first-version must. Prefer folding the review conclusion into `update_task` to limit tool growth. If the parameters turn out to be overloaded during implementation, the structured submission may be extracted into an internal function instead of exposing a new tool first.

### 7.3 Events

Extend existing events; do not start a separate event map file:

- `agent-teams/task-created` gains `kind?`, `round?`.
- `agent-teams/task-updated` gains `verdict?`, `round?`.
- new `agent-teams/team-resumed`: `{ teamId, reason }`.
- automatically created repair/review tasks still go through `task-created`.

`event-types.ts` keeps having zero runtime imports.

## 8. Prompt / documentation sync

Must be updated:

- the usage protocol in `src/index.ts`: add the contract, verdict, the ban on depending on a failed task, explicit resume, and the ban on self-approval.
- personas in `src/members.ts`.
- `assignmentPrompt` in `src/scheduler.ts`.
- `docs/usage.md`.
- one short subsection in `README.md` stating that quality gates exist and pointing at this document for details.

Do not paste this whole document into the usage prompt. The prompt keeps only a summary of the machine rules.

## 9. Enforced TDD

This is a hard gate, not a suggestion.

### 9.1 Order

Every machine rule must:

```text
1. get a failing test first
2. run it and confirm it fails because the feature is missing or the old behaviour contradicts this document
3. then write the minimal implementation
4. run it again and confirm it turns green
5. only then add documentation and prompts
```

Forbidden:

- writing the implementation first and the test afterwards;
- skipping the gate with "we will test it later";
- testing only a prompt string instead of the tool's rejection;
- deleting or loosening an existing verify / lifecycle / stress assertion to make new functionality pass.

### 9.2 Test files

New:

```text
scripts/quality-gates-tdd.mjs
```

Copy the style of `scripts/fallback-tdd.mjs`:

- Node ESM;
- import compiled output from `../lib/...`;
- `check(label, value)` / `throws(label, fn)`;
- on failure `process.exitCode = 1`.

The `verify` script in `package.json` must become:

```text
node scripts/verify.mjs
&& node scripts/fallback-tdd.mjs
&& node scripts/quality-gates-tdd.mjs
&& node scripts/lifecycle-verify.mjs
&& node scripts/stress-verify.mjs
&& pnpm verify:skill
```

`scripts/verify.mjs` may gain a few pure-function assertions, but the main quality-gate checklist must stay in `quality-gates-tdd.mjs` so it can be compared against this document.

`scripts/lifecycle-verify.mjs` must gain the tool-level closed loop, covering at least:

- an illegal completed is rejected;
- review `needs_revision` automatically produces a repair + next review;
- the repair does not depend on the failed review;
- an ordinary `create_task` does not resume a halted team;
- dispatching continues only after `resume`;
- beyond `maxReviewRounds` no further tasks are created automatically.

### 9.3 The checklist that must be written first and must fail

These labels are stable test-name prefixes; do not change their meaning while implementing:

#### A. Contract and creation

1. `tdd.create.work-kind-remains-compatible`: an old `create_task({subject})` can still create `kind=work`.
2. `tdd.create.implementation-requires-objective`: a missing objective throws.
3. `tdd.create.implementation-requires-acceptance`: a missing acceptance throws.
4. `tdd.create.implementation-requires-inscope-and-verify`: a missing inScope or verify throws.
5. `tdd.create.review-requires-reviewed-task`: a missing reviewedTaskId throws.
6. `tdd.create.repair-requires-source-and-findings`: a missing sourceTaskId / sourceFindingIds throws.
7. `tdd.create.repair-must-not-depend-on-failed-review`: dependencies containing a failed review throw.
8. `tdd.create.overlapping-inscope-rejects-parallel-ready-tasks`: two dependency-free implementation tasks with intersecting inScope are rejected.
9. `tdd.create.overlapping-inscope-allowed-when-serialized`: an intersection is allowed when the later task depends on the earlier one.
10. `tdd.create.implementation-blocked-until-requirements-pass`: creating an implementation is rejected while a non-passing requirements task exists.

#### B. Completion gates

11. `tdd.complete.review-without-verdict-rejected`.
12. `tdd.complete.review-needs-revision-cannot-complete`.
13. `tdd.complete.review-pass-requires-no-open-high-findings`.
14. `tdd.complete.implementation-requires-acceptance-results`.
15. `tdd.complete.implementation-requires-all-verify-commands`.
16. `tdd.complete.out-of-scope-path-cannot-complete`.
17. `tdd.complete.undeclared-path-cannot-complete`.
18. `tdd.complete.verify-failure-must-fail-task`.
19. `tdd.complete.claimed-still-cannot-jump-to-completed`.
20. `tdd.complete.work-kind-keeps-legacy-output-only-complete`: an old work task can still be completed with free text.

#### C. Path rules

21. `tdd.scope.file-match`.
22. `tdd.scope.directory-prefix-match`.
23. `tdd.scope.out-of-scope-wins`.
24. `tdd.scope.rejects-parent-escape`.
25. `tdd.scope.rejects-absolute-path`.
26. `tdd.scope.default-excludes-env-and-git`.

#### D. Automatic loop

27. `tdd.loop.needs-revision-creates-repair-and-next-review`.
28. `tdd.loop.repair-depends-on-source-not-failed-review`.
29. `tdd.loop.next-review-assigned-to-original-reviewer`.
30. `tdd.loop.next-review-cannot-be-implementer`.
31. `tdd.loop.round-increments`.
32. `tdd.loop.stops-at-max-review-rounds`.
33. `tdd.loop.reject-does-not-autoresume`.
34. `tdd.loop.requirements-needs-revision-opens-next-requirements-round`.

#### E. halt / resume

35. `tdd.resume.create-task-does-not-unhalt`.
36. `tdd.resume.explicit-resume-clears-halt`.
37. `tdd.resume.create-with-resume-reason-unhalts`.
38. `tdd.resume.cancelled-tasks-stay-cancelled`.
39. `tdd.resume.missing-reason-rejected`.

#### F. coverage / delivery

40. `tdd.coverage.missing-item-blocks-delivery`.
41. `tdd.coverage.passed-item-requires-completed-task`.
42. `tdd.delivery.ok-only-when-all-gates-pass`.
43. `tdd.delivery.failed-review-without-repair-blocks`.

#### G. Compatibility and persistence

44. `tdd.state.old-team-json-without-new-fields-still-loads`.
45. `tdd.state.invalid-verdict-rejected-at-durable-boundary`.
46. `tdd.prompt.assignment-includes-kind-scope-acceptance`.
47. `tdd.usage.mentions-explicit-resume-and-verdict`.

Those 47 are the minimum set. More may be written; fewer may not. Fewer counts as a missed requirement.

### 9.4 Test doubles

Lifecycle keeps using the existing fake ctx / fake agents; do not depend on a real LLM.

TDD scripts should prefer pure functions:

- path matching;
- completion validation;
- the pure planning function that expands the next round;
- coverage / delivery decisions;
- resume state changes.

Tool-level tests call the real compiled tools through `registerAgentTeamsTools`.

## 10. Suggested code locations

Do not move directories around for this feature. Prefer these files:

| File | Responsibility |
|---|---|
| `src/types.ts` | new fields and enums |
| `src/state.ts` | persistence validation, scope pure functions, completion validation, delivery/coverage pure functions |
| `src/tools.ts` | create/update/resume gates, automatic next-round expansion |
| `src/profiles.ts` | `reviewPolicy` parsing and allowlist |
| `src/members.ts` | persona additions |
| `src/scheduler.ts` | assignment contract summary |
| `src/event-types.ts` | event fields |
| `src/index.ts` | usage protocol, config schema, resume tool name |
| `src/snapshot.ts` / client status projection | when status/UI needs to show verdict/round |
| `scripts/quality-gates-tdd.mjs` | enforced TDD |
| `scripts/verify.mjs` | a few pure-function additions |
| `scripts/lifecycle-verify.mjs` | tool-level closed loop |
| `docs/usage.md`, `README.md` | user-visible explanation (`README_ZH.md` is frozen legacy, not maintained) |

Minimum client requirements:

- status / the activity panel can show `kind`, `round`, `verdict`;
- do not redo the panel layout for this;
- an old snapshot without those fields must keep rendering.

## 11. Implementation phases (one requirement, one PR allowed, but strictly in order)

A single implementation window may do all of it, but only in this order, each step red before green:

### Phase 0: TDD skeleton

- create `scripts/quality-gates-tdd.mjs`;
- write every assertion of section 9.3 as a failing test;
- wire it into `pnpm verify`;
- at this point `pnpm verify` must fail.

### Phase 1: types, persistence, pure functions

- extend the types and `isTeamTask`;
- implement the path matching, completion validation, coverage and delivery pure functions;
- the matching TDD checks turn green.

### Phase 2: create / update gates

- change both tools;
- the old `work` behaviour stays compatible;
- the matching TDD / lifecycle checks turn green.

### Phase 3: automatic loop + resume

- a failed review automatically creates the next round;
- `agent_teams_resume`;
- remove the implicit unhalt from `create_task`;
- the matching TDD / lifecycle checks turn green.

### Phase 4: prompt, status, documentation

- persona / assignment / usage;
- the status projection;
- user documentation;
- the full `pnpm typecheck && pnpm build && pnpm verify` turns green.

## 12. Acceptance criteria

Done if and only if:

1. All 47 tests of section 9.3 exist and pass.
2. `pnpm typecheck` passes.
3. `pnpm build` passes.
4. `pnpm verify` passes and includes `quality-gates-tdd.mjs`.
5. `git diff --check` reports no whitespace errors.
6. Old `work` tasks, old `team.json` files and old profile seed/captain planning still work.
7. A reviewer can no longer release downstream work with a free-text `completed`.
8. `create_task` no longer silently resumes a halted team.
9. The documentation states that first-version scope control is a completion-time audit, not host write interception.
10. No user-excluded file was changed, and no unauthorised commit/push/PR was made.

## 13. Explicitly outside this requirement

- Staging UI / pre-execution manual DAG edits / Approve & Run.
- Independent worktrees.
- Host-level bash/fs write interception.
- Human countersignature voting components.
- Automatic deployment.
- Several teams in parallel (one Captain still leads exactly one team).
- Modifying the official DeepSeek Harness.

## 14. New-window execution instruction

Copy the whole block below into a new window. Do not trim it.

```text
Implement the AgentTeams quality gates and multi-round review completely, following docs/quality-gates.md.

Hard constraints:
1. This document is the only requirement source. Do not invent extra functionality, and do not shrink the work to prompt-only changes.
2. Enforced TDD: write the failing tests in scripts/quality-gates-tdd.mjs first, then implement. All 47 items of section 9.3 are mandatory.
3. Wire that script into package.json's verify.
4. Reuse the existing DAG / attempt / halt / scheduler; do not build a new workflow engine.
5. Do not do Staging UI, worktrees, host write interception, deployment, commit, push or PR.
6. Do not modify ~/.dsh/profiles/web/cordis.patch.yml.
7. Do not commit docs/multi-role-profiles.md or docs/personal-kb-delivery/.
8. The old kind=work must stay compatible; only quality kinds go through the new gates.
9. A review may only complete with verdict=pass; needs_revision may only fail, and automatically creates a repair + next review that does not depend on the failed review.
10. create_task must not silently unhalt any more; use explicit resume or create_task({resume, resumeReason}).
11. When finished, run pnpm typecheck, pnpm build and pnpm verify, and report which files changed.

Follow the order in section 11 strictly: Phase 0 red -> Phases 1-3 green -> Phase 4 documentation.
```

## 15. Definition precedence during implementation

If a conflict appears while implementing, interpret it in this order:

1. section 2 "Not allowed" of this document;
2. section 6 machine rules of this document;
3. section 9 test checklist of this document;
4. the existing state machine, attempt handling, and the rule that a failed task does not unlock downstream work;
5. existing UI / documentation wording.

Record a conflict in the implementation notes; never change semantics silently.
