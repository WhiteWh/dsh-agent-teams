# Usage guide (detailed)

This document holds the detailed usage material for `dsh-agent-teams`: how it works, Web UI behaviour, the tool inventory, configuration and known limits. The README keeps only the introduction and quick start.

## How it works

`dsh-agent-teams` reuses DSH capability seams and does not depend on a workflow engine:

| DSH capability | How AgentTeams uses it |
|---|---|
| `ctx.tools` registry | registers the 19 business tools; restricts which tools a model can see by session identity |
| `ctx.subagents.startContinuable()` | creates a member: a durable, continuable subagent carrying a member persona |
| `ctx.subagents.followup()` | wakes the recipient member (the message joins its next turn) |
| the durable team member table + `ctx.agents` | the former stores durable member identity, the latter provides real `running / idle / ready` activity (no reliance on a volatile subagent directory projection) |
| `agent/status` | once a member goes idle, triggers automatic claiming from the shared task pool and wakes the next round |
| `ctx.systemPrompt.section()` | provides a compact fixed core policy per initial captain/member identity; the template directory is always retained |
| Web server route registration | the activity-panel data route `/plugins/dsh-agent-teams/state` plus the static mascot/symbol artwork under `/plugins/dsh-agent-teams/assets/` (dual-key compatibility for `webServer`/`httpServer`, see below) |
| filesystem | team state is persisted under `<workspace>/.agent-teams/<teamId>/` |

Data path: tool execution → on-disk state (the source of truth) → host snapshot route → overlay rendering on a 1s poll; the session log additionally receives `agent-teams/*` events (audit / replay / retrospective).

> **Beta-version compatibility**: the npm `latest` (`0.0.1-rc.1`) service keys are still `ctx.httpServer` / `ctx.workspace`, while the later `next` (`rc.2`) renamed them to `ctx.webServer` / `ctx.workspaceRegistry`. The plugin probes both key sets (new key first, old key as a fallback, and it listens on both for the `internal/service` event), so routes register on either version.

### Web UI

- **Follows the host language**: the plugin registers its own `agentTeams` locale namespace and obtains the translate function through the Slot's official `locale` seat; the conversation card, activity panel, dynamic status summaries, history markers and accessibility text all switch between Simplified Chinese and English live with Harness. English is the official fallback language for a missing entry; the plugin never guesses the language from the DOM and never patches host source.
- **Top-right activity panel** (a non-modal `shell.overlay` floater): it auto-expands once a team exists; by default it docks to the right of the conversation, grows in height with its content, and only scrolls internally after reaching the viewport safety ceiling instead of filling the screen with blank space. The panel can be switched to a floating window and dragged; the docked mode supports left-edge resizing, the floating mode also supports the bottom edge and the bottom-right corner. The floating height is locked only after the user resizes it vertically. Position, manual size and dock mode are restored after a refresh; the collapse control in the title bar folds the panel into a small top-right badge (team count plus an activity pulse). Each team shows the captain, segmented overall progress, status counts, a collapsible member list and the phase board. The board gives every phase a column and draws a real SVG curve per dependency: work that runs in sequence inside a phase reads as one line, parallel work takes its own row, and the column stretches to the width of its longest chain. Clicking a node pins it and opens the task detail under the board — its owner, unsatisfied prerequisites, the model it uses and the work it unlocks; clicking the same node again clears the pin. Running task nodes and assignment chips show the short model name directly, while a member row keeps the full `provider/model`. A member node is **large by default**: the portrait spans both of its lines and carries the live action in its corner, the head line names the member, the role, the model and the state, the line beneath is the sentence behind that state (`Working on t39 · deepseek-v4-flash`, `Waiting for t14 · impl-c1`), and the task chips sit on their own row behind their label. The chevron at the node's right edge folds **that one** member into a compact tray line — portrait, role symbol, name, model badge, action symbol with its state word and the chips — and leaves its neighbours alone; the folded node keeps the chevron to unfold itself again. Clicking the row (never the chevron) opens the member's child session.
- **Mascot artwork**: captain/member avatars are the amber terminal mascots (`assets/agent-teams/`, 8 roles + 6 actions) matched by role keyword. The large node's portrait spans the block (capped at 76 px) and carries the live action as a corner ring, and its head line names the role in words next to the member's name; the folded tray keeps a 24 px portrait with the action symbol inline beside the state word and the role reduced to a 12 px symbol whose tooltip holds the words. **Work is the node's own height**: a plaque three dots wide runs down the right edge of the row and its dots pulse in a top-to-bottom wave while the member works (a faint slot column when it does not), so the state is read from the shape of the node rather than from an icon inside its text; the text label next to it stays the accessible answer. The role symbol is the **compact** mark: 12 px in the slots where neither the mascot nor a label fits — the tray row and the task-detail assignment line — with the coloured dot kept as the fallback for an unclaimed task or an unmatched role, and a captain owner resolving to the lead mark. The collapsed panel pill draws the action symbol rather than a plain dot, and the phase board keeps its node heads text-only (a 12 px role mark next to a 9.5 px id was the least readable spot in the panel). The action glyph follows the member state with an animation (working float / idle breathe / unknown thinking), an unread message adds a halo around the avatar; `prefers-reduced-motion` is respected. Every artwork URL carries the pack revision as `?v=<revision>` (`node scripts/art-revision.mjs` derives it from the packaged bytes, and `pnpm build` plus `scripts/verify.mjs` fail when the committed value is stale), so redrawing a pack reaches an open browser instead of sitting behind the day-long `cache-control`.
- **Session scoping**: the panel shows only the **current session's** teams (matched by captainSessionId); a new session collapses the panel automatically and switching back to the team's conversation restores it.
- **Conversation card**: creating a team adds a lightweight card to the conversation stream (member overview, click-through to a member session, and an "activity panel" button that re-activates a dismissed floater).
- **Historic review**: `agent_teams_delete` **archives** a team rather than dropping it (`<stateRoot>/archive/<teamId>/`, retaining members, tasks, the dependency graph and the mailbox in full); when a team ends, its members are marked removed but stay in Harness's subagent catalog so historic sessions can still address them, while later wake-ups keep being refused. A historic snapshot keeps the whole roster and renders it in an idle/delivered state. Even when an old conversation has no card, selecting that captain session after a restart performs one lightweight cold discovery and restores the member tree and DAG; clicking a member opens its persisted session transcript.

### Team state files

```
<workspace>/.agent-teams/<teamId>/
├── team.json            # team record: members, tasks (with dependencies), task sequence
└── inbox/
    ├── captain.jsonl    # captain mailbox (members → captain)
    └── <member>.jsonl   # one mailbox per member (JSONL)
```

Task state machine: `pending → claimed → in_progress → completed | failed | cancelled`. Every execution carries a monotonic `attempt` plus a unique `attemptId`; a transfer first invalidates the old attempt and then interrupts and waits for the previous member to go quiet, so a late update cannot overwrite the new result. Dependencies are checked before claiming, and a member may not hold two unfinished tasks at once.

Old `kind=work` tasks can still be completed with free text. Quality kinds (`requirements` / `implementation` / `verification` / `review` / `repair` / `integration`) go through a structured contract: creation requires an objective and acceptance items, and implementation/repair additionally require `inScope` and `verify`. `review` / `requirements` can only `completed` with `verdict=pass`; `needs_revision` / `reject` must `failed` with at least one finding. After a failed review the system automatically creates a repair plus the next review round that does not depend on the failed review. First-version scope control is a completion-time audit (against the caller-submitted `changedPaths`), not host write interception. A halted team cannot be silently resumed by an ordinary `create_task`; it needs `agent_teams_resume` or `create_task({ resume, resumeReason })`. In quality mode a human provides only the goal and constraints; the default task order is requirements → implementation → verification → review → integration, and the review contract judges whether the implementation passes, so do not write "please submit needs_revision" into a task. `halted` means a human stopped the team; `escalated` only means the automatic loop hit its ceiling — the two are not the same thing. Details are in `docs/quality-gates.md`.

## Tool inventory

| Tool | Purpose |
|---|---|
| `agent_teams_create` | create a team; the caller becomes the captain. One workspace may hold several teams and a captain may lead more than one: a second team needs the explicit `new_team: true`, and every later team-scoped call names its team through `team_id` |
| `agent_teams_add_member` | bring a member onto the roster (spawns a continuable subagent plus a member persona) |
| `agent_teams_remove_member` | remove a member safely: revoke its attempt, reclaim its unfinished tasks, wait for the interruption to settle, then reschedule |
| `agent_teams_create_task` | create a task with contract fields, `dependencies` and `assignee`; rejected by default while halted unless `resume` is explicit |
| `agent_teams_reassign_task` | atomically retry/transfer a task; `assignee=captain` means a safe captain takeover |
| `agent_teams_claim_task` | claim a task (dependency-checked; a captain may claim on behalf of a member, a member may only claim its own or an unassigned task) |
| `agent_teams_update_task` | advance a task while presenting the current `attempt_id`; for quality kinds an illegal completed is rejected by verdict / acceptanceResults / commandsRun / changedPaths |
| `agent_teams_amend_task` | captain-only: rewrite the whole contract (objective/acceptance/verify/inScope/outOfScope/deliverables/nonGoals/reviewedTaskId) of a task that is pending, claimed, in_progress or failed — or the subject/description/deliverables of a `work` task — when the contract itself makes honest completion impossible; writes a revisions ledger, freezes after a passing review, and `force` overrides that freeze by marking the passing verdict `stale`. Not available to members |
| `agent_teams_supersede_task` | captain-only: replace a task that will not finish (failed or abandoned) with an existing task or one created in the same call; the replaced task becomes `superseded`, non-terminal dependents are redirected to the replacement, non-terminal reviews/repairs are retargeted, and its capability is revoked. A completed task cannot be superseded |
| `agent_teams_accept_paths` | captain-only: ADD workspace-relative paths to a task's `inScope` (additive, unlike the full replacement in `amend_task`); completes a task held in `awaiting_scope_review`, works post-hoc on a completed task until a review verdict freezes the contract (`force` overrides), and records a revision |
| `agent_teams_pin_delta` | captain-only: register a check that is red here for a reason outside the lane (`check`, `expected`, `reason`); afterwards a `waived` result for that check gets its evidence filled in automatically as `pinned delta <id>: <reason>`. One entry per check; a duplicate names the existing id |
| `agent_teams_unpin_delta` | captain-only: remove one registry entry by id (the error lists the pinned ids when the id is unknown) |
| `agent_teams_replan` | captain-only: repair a RUNNING plan in one atomic batch — `add_task`, `update_task` (with `retry` and `invalidate`), `supersede_task`, `cancel_task`, `accept_paths`, `amend_task`, `move_phase` — under one `reason`; every operation is validated against the result of the previous one, and any error leaves the team untouched. The alternative to a cancel-and-recreate cascade |
| `agent_teams_send_message` | any member → any member/captain: the message lands directly in the recipient's mailbox and wakes it (no captain relay; an impersonated `from` is rejected) |
| `agent_teams_status` | one team in detail (kind/round/verdict, coverage matrix, escalated, halt/resume state); without a `team_id` it lists every team the caller leads or belongs to |
| `agent_teams_resume` | explicitly resume a halted team; a non-empty reason is required; cancelled tasks are not recreated |
| `agent_teams_delete` | end a team: interrupt its members and **archive** the team directory (tasks, dependency graph and mailboxes retained in full) |

`agent_teams_add_member` needs no model parameters by default: when a member follows the captain's current LLM provider/model, the captain's current reasoning effort is snapshotted with it. When the user explicitly asks for a different model for a role, the optional `provider` + `model` may be passed together; overriding only `model` keeps the captain's current LLM provider. Whenever either provider or model changes, the reasoning effort automatically uses the target model's default tier; when the user explicitly asks for a specific effort for a member, the optional `reasoning_effort` may be passed (a tier id the target model supports, or `"default"` to force the model's own default). The plugin never opens a second selection round or a dialog per member.

## Addressing a team

Team identity is an **argument, not a property of the calling session**: `agent_teams_create` answers with the `team_id` (derived from the team name), and every team-scoped tool takes that id. The id is optional in the argument schema only so that a missing one can be answered with the list of teams the caller can address — `team_id is required: you participate in 2 teams (multi-a (Multi A), multi-b (Multi B))` — instead of a bare schema error, so one step is enough to correct the call. The system prompt tells the captain to remember the id from the `create` answer and to call `agent_teams_status` with no argument when it has forgotten it.

- `agent_teams_status` without a `team_id` lists the caller's teams (`team_id`, name, phase, halted, `tasks: {total, done}`, members, activeWorkers, role) when there are several, and keeps reporting a **single** team in detail — that is also how a member of exactly one team may omit the id, because the plugin substitutes the only team it takes part in. A member prompt therefore never has to carry an id.
- A second team in the same workspace needs `new_team: true`. That flag is the explicit "the user asked for a separate new team" signal: without it, `create` answers with the existing teams and tells the model to continue one of them instead of recreating anything.
- Teams are independent. Tasks, dependencies, mailboxes, capability attempts and archives are read and written per `team_id`; a task id that exists only in another team is not reachable (an `update_task` on it fails instead of touching a same-numbered task of the addressed team). Task ids restart per team (`t1`, `t2`, …).
- State-based workspace guards (configurable keys arrive with 0.2.0): a fifth live team is refused (`this workspace already has 4 live teams (limit 4)`), and so is a ninth active worker counted across all live teams. Archiving a team frees its slot immediately.
- The Web panel, the plan-review routes and the pre-execution planner still follow one team at a time in this release; the per-team switcher arrives with 0.2.0.

## Configuration

Override it in the profile's `cordis.patch.yml`:

```yaml
- id: agent-teams
  config:
    stateDir: .agent-teams        # team state directory name (under the workspace)
    memberProvider: spawn         # subagent runtime backend (spawn / fork), not an LLM provider
    memberModel: deepseek-v4      # optional: member model override
    memberMaxDepth: 1             # member re-delegation depth ceiling (0 = forbidden)
    maxMembers: 8                 # team size ceiling
    executionPrompt: |            # injected into the member persona and every assignment
      The document does not need to record the process; it should only record facts, unless I explicitly request the process to be recorded.
      The product interface should present the intended outcome, not reveal the reasoning process.
    fallback:                     # second choice when the primary model is unavailable
      provider: openai
      model: gpt-5.5
```

The effective precedence is: an explicit member `provider` + `model` / `model` → `memberModel` → the captain's current route. When a member follows the captain's current provider/model it inherits the captain's reasoning effort; whenever either provider or model changes, the target model's default tier is used automatically. An explicit `reasoning_effort` (a tier id the target model supports, or `"default"`) wins and is validated against the target provider/model before creation; an incompatible value makes member creation fail loudly. The provider/model/reasoning effort that actually took effect is written into `team.json` for status queries and member cold resume.

## Replanning a live team

A running plan is repaired, not rebuilt. `agent_teams_replan` takes one batch and one reason; the whole batch is validated against the result of the previous operation under the team lock, and **any** invalid step leaves the team exactly as it was (the applier works on a copy, so "nothing written" is structural rather than a promise about statement order).

| Operation | What it does | When the target status allows it |
| --- | --- | --- |
| `add_task` | create a lane with the full `create_task` contract | any status of the others |
| `update_task` | replace `subject`/`description`/`assignee`/`dependencies`; `retry: true` puts a failed (or scope-held) lane back in the queue | `pending` (any attempt), `failed`, `awaiting_scope_review` |
| `supersede_task` | replace a lane that will not finish, redirecting dependents and reviews (`replacement_task_id`, or a replacement created in the same operation) | `failed`, `cancelled`, `claimed`/`in_progress` with `invalidate: true` |
| `cancel_task` | drop a lane without deleting its history | `pending`; a held lane needs `invalidate: true` |
| `accept_paths` | settle a lane held in `awaiting_scope_review` (additive paths) | `awaiting_scope_review`, or post-hoc on `completed` |
| `amend_task` | rewrite a contract that makes honest completion impossible; `force` overrides a post-review freeze (the verdict becomes `stale`) | `pending`/`claimed`/`in_progress`/`failed` — a **completed** contract stays immutable |
| `move_phase` | put a task in a declared phase; pass a `title` to declare a new one, `phase_id: ''` to remove it | any |

`invalidate: true` is the explicit permission to touch a lane a member currently holds: the attempt is revoked, that member is drained, it goes `idle` (its session stays), and it receives a mailbox note — `task tN replanned: <reason>` — so it stops instead of finishing work the plan no longer wants. A revoked capability is refused afterwards even if the task is `pending` again, so a late update can never start a new attempt on a replanned lane. Members whose only remaining work disappeared go `idle`; nothing is retired (that stays exclusive to `remove_member`).

Each batch bumps the team's **plan revision** (`TeamState.plan.revision`, a monotone counter) and appends one `agent-teams/plan-revised` event carrying the diff: `added`, `removed` (superseded), `rebound` (dependencies or owner changed) and `invalidated`. The panel's running-mode editor posts the same batch to `POST /plugins/dsh-agent-teams/plan` with `action: 'replan'`, so the browser and the model share one validator, one writer and one wake-up.

Declared phases are part of the plan: a profile may list them (`taskPlanning.phases: [{id: E0, title: Recon}]`), a task joins one at creation (`create_task phase: 'E0'`) or later (`move_phase`), and the progress rows, the Phases view and the task checklist all order themselves by them — falling back to the DAG levels when nothing is declared.

## Several teams at once

A captain may lead several teams in one workspace (see "Addressing a team"), and phase 2 makes that a first-class view and schedule:

- **The panel switches teams.** When a session has more than one live team, the panel shows a tab strip (name, `done/total`, an activity dot) and renders **one** team at a time — its DAG, members, progress and slices. Stacking every team made two graphs read as one; the reader's choice is remembered per browser (`dsh-agent-teams:activity-panel:team:v1`), and a stored id that no longer exists falls back to the first live team. A halted team keeps its tab (a warn-coloured dot) instead of disappearing: stopped work is still work the reader asked for.
- **The scheduler sweeps every live team.** `agent_teams_status` for a captain who leads several teams triggers a workspace-wide sweep instead of a single-team kick, so a second team with ready work no longer waits for its own tool call. The sweep visits every live team of every workspace the host reports (`workspaceRegistry`), skipping staged and halted ones.
- **Two fuses on concurrent work.** `maxWorkersPerTeam` (default: the roster cap, `maxMembers`) and `maxConcurrentWorkersGlobal` (default 8) bound how many members may work at once; the check lives on the dispatch primitive, so the sweep, a single-team kick and the `agent/status` idle wake-up all obey the same numbers. Both keys are host config today (`cordis.patch.yml`) and move onto the profile in phase 3. A member is never given a second open lane: it belongs to exactly one team and the dispatch refuses a member that already holds work.
- **Mail is already per team.** Each team owns its mailbox directory (`<stateRoot>/<teamId>/inbox/`), and a message is addressed with its team id, so routing never has to guess which team a recipient belongs to.

### Limits and slots

Four fuses bound how much work exists and how much of it runs at once. They are host config in the profile's `cordis.patch.yml`, resolved in one place (`resolveTeamLimits`) so the create guard, the status report and the scheduler cannot disagree:

| Key | Default | What it stops |
| --- | --- | --- |
| `maxTeamsPerWorkspace` | 4 | a workspace filling up with live teams (`this workspace already has 3 live teams (limit 3)`) |
| `maxTeamsPerSession` | 8 | one captain session leading an unbounded number of teams (`… the limit 2 per captain session`) |
| `maxWorkersPerTeam` | the roster cap (`maxMembers`) | more members of one team working at once than the host allows |
| `maxConcurrentWorkersGlobal` | 8 | more members working across the workspace than the host allows |

```yaml
- id: agent-teams
  config:
    maxTeamsPerWorkspace: 4
    maxTeamsPerSession: 8
    maxWorkersPerTeam: 4
    maxConcurrentWorkersGlobal: 8
```

The team fuses are checked against live state (not against how many teams were ever created), and archiving a team frees its slot immediately. The worker fuses live on the dispatch primitive, so the scheduler sweep, a single-team kick and the `agent/status` idle wake-up all obey them.

`agent_teams_status` reports the same numbers and who is using them. With several teams it lists them with the slot summary and the limits in force:

```text
Your teams (2): [limits: 3/workspace, 2/session, 4 workers/team, 8 workers global]
  - multi-a "Multi A" [running] as captain: 1/2 tasks done, 1 members, 1 working (worker), 1 queued
```

and a single team's detail adds its own lines:

```text
Slots: 1/4 working (worker t2); 3 queued
Limits: 3 teams/workspace, 2 teams/session, 4 workers/team, 8 workers global
```

The payload carries the same information as data (`slots.working[]` with the member and the task it holds, `slots.queued`, `slots.team_workers`, `limits.*`), so a reader never has to infer a slot from a member status.

## Usage protocol

The plugin prompt section guides the model through a two-phase protocol: continue an existing team, confirming state through `agent_teams_status` as needed → when no team exists, create a staged team → write editable member placeholders → break the work into tasks and declare dependencies → wait for user review → after **Approve & Run**, atomically create members and start scheduling → the captain monitors/guides → report and then `agent_teams_delete`. A staged team has no child sessions and claims no tasks. Use `approval: automatic` only when the user explicitly asks to skip the review. Members may message each other directly with no captain relay. When a resident member is interrupted, or ends a turn normally while still holding a `claimed/in_progress` task, that attempt is parked; only an explicit retry/transfer/takeover revokes it. A parked attempt this process has already observed keeps its attempt even after Harness reclaims its AgentHandle, so a captain polling `agent_teams_status` will not re-mint it. Only a cold start, or an open task this process has never observed, is recovered automatically once; a failed recovery delivery returns to the original capability instead of becoming an endlessly redispatchable `pending` task.

## Named multi-role profiles

Configure `profiles` in the profile's `cordis.patch.yml`. Every template defines a roster; `taskPlanning: captain` supplies only the roster and the gates, leaving the Captain to build the task graph dynamically from the goal, while omitting the field or setting `seed` still expands the fixed task seeds. For example:

```yaml
profiles:
  demo-delivery:
    description: Deliver one small feature
    protocol: Discuss the requirements first, then implement, review, test and prepare the release; do not deploy without confirmation.
    members:
      - name: analyst
        model: gpt-5.6-sol
        role: Analyse the requirements
      - name: implementer
        model: gpt-5.6-terra
        role: Build the solution
    tasks:
      - id: requirements
        subject: Requirements discussion
        assignee: analyst
      - id: implementation
        subject: Build the solution
        assignee: implementer
        dependencies: [requirements]
```

Name a template explicitly with `/agent-teams --profile demo-delivery implement this feature`; do not use an implicit profile from the first token. Seed mode supplies template tasks; captain mode supplies only the roster and the constraints, leaving the Captain to design the DAG while staged. The panel allows editing a member's provider/model/reasoning/role prompt and a task's assignee/dependencies, and no member is created and no work is dispatched before approval. A dependency's output is passed downstream; a failed review/test does not unlock what follows, and the automatic repair/review does not depend on the failed review. `memberProvider` is the spawn/fork backend, not a model provider.

## Captain dynamic planning and whole-team stop

The recommended profile configuration supplies only the roster, the model routes and the delivery gates, and does not prescribe a complete DAG for the user goal:

```yaml
profiles:
  software-delivery:
    taskPlanning: captain
    protocol: |
      The user supplies only the goal and the constraints. The Captain decides whether to split the work, how to set dependencies, and which parts may run in parallel.
      Do not ask the user whether to split, merge, serialise or parallelise.
    members:
      - name: requirements-analyst
        provider: openai
        model: gpt-5.6-sol
        role: Analyse requirements and acceptance criteria
```

With `taskPlanning: captain` the profile no longer assumes a project directory, a package manager or a fixed quality graph; the Captain designs the DAG from the real goal and workspace. If the user explicitly asks for quality gates, it then creates requirements → implementation → verification → review → integration tasks with contracts, deriving `inScope` and `verify` from the real project. `taskPlanning: seed` keeps the fixed seed-task workflow.

`reviewPolicy.requiredReviewers` is enforced: Delivery stays blocked with `no passing review from the required reviewer "<entry>" (reviewPolicy.requiredReviewers)` until each listed entry has a completed `review` with `verdict=pass` from a member whose name equals the entry or whose role contains it (`correctness` matches a `correctness-reviewer`). A review the captain owns satisfies nobody. An absent list changes nothing.

### Plan progress and the task checklist

Every team snapshot, the `agent_teams_status` report and the conversation card carry the **same** percentage, computed on the server (`src/progress.ts`) so the three surfaces cannot disagree:

```
Progress: 62% (8/13; running 2, blocked 1, failed 0, waived 1)
```

The rule is `Σ weight(completed) / Σ weight(total − cancelled − superseded)`: a cancelled task and a task replaced by `agent_teams_supersede_task` are not work the team still owes, so they leave the denominator instead of counting as failure, and a plan with nothing left in the denominator reports 0 rather than inventing 100. A failed quality lane that already has its follow-up repair leaves the denominator the same way — its repair is the work that remains — which is exactly the rule Delivery uses to decide that a red lane is settled history, so a repaired plan reaches 100% and the payload counts those lanes as `repaired` rather than `failed`. Two weightings are computed together and both numbers travel in the payload:

| Mode | Weight of a task | Where |
| --- | --- | --- |
| `byKind` (default) | `implementation` 3, `repair` 2, `requirements`/`verification`/`review`/`integration`/`work` 1 | the built-in table |
| `equal` | every task 1 | `taskPlanning.weights: 'equal'` |

`taskPlanning.weights` accepts `'equal'` or a per-kind table (`{ implementation: 5, review: 0.5 }`), is frozen into the team when it is created, and only picks the **default**; the panel's progress block switches between the two modes for the reader and remembers that choice per browser. A bad table fails `agent_teams_create` with the key that owns it (`profiles.<name>.taskPlanning.weights.review must be a positive number`), and the nested `taskPlanning` scope is checked by `doctor.mjs --profiles` as well.

The panel draws the percentage as a single proportional bar above the equal-share segments — one bar for the whole team, with no row-per-phase breakdown — and the text report marks every task with a checkbox — `[x]` completed, `[~]` in flight, `[ ]` not started, `[!]` failed/cancelled/superseded. A collapsible **task checklist** under the phase board lists every task in phase-then-depth order (status glyph, id, subject, kind/round, assignee, status, waivers, `→ tN` for a superseded task); clicking a row pins that node in the board. The conversation card shows the same percentage as a mini bar under the team name.

The pre-execution plan review reads Harness's model catalog directly: member models and reasoning levels use the same Provider/model metadata as the main input area, so hand-written routes are no longer required. "Return to chat and revise" marks the staged draft as awaiting feedback, cancels the still-running planning turn, and asks the Captain through plugin context to ask once about the direction of the change; after the user answers, the Captain must update that same draft atomically through one `agent_teams_edit_plan` call and must not create another team. "Discard this plan" needs a second confirmation, then archives the draft, cancels the current turn and preserves model context that forbids automatic recreation; only "Confirm and run the team" creates members and schedules tasks, without an extra meaningless start confirmation.

While a long task runs, a stop button appears to the right of the specific team title. Clicking it and confirming again in the dialog cancels the Captain's current turn, interrupts every member, cancels unfinished tasks and stops further scheduling; the entry point no longer occupies the chat input area. Stopping does not delete the team, and a later user message may explicitly request `agent_teams_resume`. Cancelled/failed tasks keep their terminal state in the archive.

## Known limitations

- Scheduling is event-driven rather than permanently polling; a member cannot be cold-resumed while the captain is offline, and tasks and messages stay on disk until the captain resumes or calls the status tool.
- A captain may lead several teams in one workspace, but a call acts on exactly one of them: there is no combined report, no cross-team scheduler (a member is never double-booked because assignment stays inside one team) and the panel follows a single team per session until the 0.2.0 switcher.
- A member persona replaces the deployment's default persona; members still have the full tool set (bash/fs/web and so on).
- Team state is file-level persistence, so several processes operating on the same team at once are not guaranteed to be consistent (serialised by a lock inside one dsh process).
- The activity panel reads the on-disk truth and is independent of the session-log event stream: after a switch/restart it performs one cold discovery for the current session, and keeps a 1s poll only when an active team was found or a conversation card needs it, so an ordinary session does not scan permanently.
- The official Stop in the main chat window cancels only the captain's current turn; "Stop team" for a specific team in the activity panel cancels the Captain's current turn and every continuable member after a second confirmation, and freezes further scheduling. The input box can still send a new resume instruction once the stop has completed.
- The top-right overlay mounts into `shell.overlay` on DeepSeek Harness `0.1.0-rc.8`; on a wide screen the docked mode makes the main conversation column yield space according to the panel's actual width, the floating mode stays a non-modal overlay, and a narrow screen falls back to a safe inset overlay with dragging/resizing disabled while the left navigation stays put.
- The `/agent-teams` description and input hint in the slash menu come from the host `CommandDefinition`; the current official command protocol has no locale namespace field, so stable English metadata is kept. The plugin will not fake that layer of translation with DOM replacement; it will integrate once the host provides a proper interface.
- A member (model) does not always follow the tool "ritual" (for example calling `agent_teams_update_task` on completion) — the panel reflects the on-disk truth, and the captain summarises from `agent_teams_status`/the files.

## Verification

- Offline and lifecycle: `pnpm build && pnpm typecheck && pnpm verify`. Beyond the basic checks this includes a failure matrix over an 8-member, 31-node multi-layer DAG (extended to 38 tasks while running): concurrent takeover/removal, 50 late writes, a cold restart of 4 open tasks, a 7-way claim race, 40 terminal-state overwrites, a 42-message burst and final archival; composition is verified with `dsh --profile agent-teams-check --dump-config`.
- Real e2e: `dsh plugin --profile headless add <path>` followed by `dsh --profile headless "use AgentTeams to …"`, checking the `.agent-teams/` state files against the session-log event stream.
- GUI: a separate instance plus ego-browser (see `verification-guide.md`).
