# Usage guide (detailed)

This document holds the detailed usage material for `dsh-agent-teams`: how it works, Web UI behaviour, the tool inventory, configuration and known limits. The README keeps only the introduction and quick start.

## How it works

`dsh-agent-teams` reuses DSH capability seams and does not depend on a workflow engine:

| DSH capability | How AgentTeams uses it |
|---|---|
| `ctx.tools` registry | registers the 14 business tools; restricts which tools a model can see by session identity |
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
- **Top-right activity panel** (a non-modal `shell.overlay` floater): it auto-expands once a team exists; by default it docks to the right of the conversation, grows in height with its content, and only scrolls internally after reaching the viewport safety ceiling instead of filling the screen with blank space. The panel can be switched to a floating window and dragged; the docked mode supports left-edge resizing, the floating mode also supports the bottom edge and the bottom-right corner. The floating height is locked only after the user resizes it vertically. Position, manual size and dock mode are restored after a refresh; the collapse control in the title bar folds the panel into a small top-right badge (team count plus an activity pulse). Each team shows the captain, segmented overall progress, status counts, a collapsible member tree and a compact task DAG. The DAG connects dependencies with real SVG curves; hovering or focusing with the keyboard previews the complete upstream/downstream chain, a click pins it and `Esc` clears it; the selected node shows its owner, unsatisfied prerequisites, the downstream work it unlocks, and the model that task uses. Running task nodes and assignment chips show the short model name directly, while a member row keeps the full `provider/model`. A member row shows an occupational avatar, role, live state and task chips, and clicking it opens the member's child session.
- **Mascot artwork**: captain/member avatars are the amber terminal mascots (`assets/agent-teams/`, 8 roles + 6 actions) matched by role keyword, and the small corner badge draws the separate symbol packs, which stay readable at badge size where a scaled mascot does not; the state action glyph follows the member state with an animation (working float / idle breathe / unknown thinking), an unread message adds a halo around the avatar; `prefers-reduced-motion` is respected. Every artwork URL carries the pack revision as `?v=<revision>` (`node scripts/art-revision.mjs` derives it from the packaged bytes, and `pnpm build` plus `scripts/verify.mjs` fail when the committed value is stale), so redrawing a pack reaches an open browser instead of sitting behind the day-long `cache-control`.
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
| `agent_teams_create` | create a team; the caller becomes the captain (a captain leads one team at a time) |
| `agent_teams_add_member` | bring a member onto the roster (spawns a continuable subagent plus a member persona) |
| `agent_teams_remove_member` | remove a member safely: revoke its attempt, reclaim its unfinished tasks, wait for the interruption to settle, then reschedule |
| `agent_teams_create_task` | create a task with contract fields, `dependencies` and `assignee`; rejected by default while halted unless `resume` is explicit |
| `agent_teams_reassign_task` | atomically retry/transfer a task; `assignee=captain` means a safe captain takeover |
| `agent_teams_claim_task` | claim a task (dependency-checked; a captain may claim on behalf of a member, a member may only claim its own or an unassigned task) |
| `agent_teams_update_task` | advance a task while presenting the current `attempt_id`; for quality kinds an illegal completed is rejected by verdict / acceptanceResults / commandsRun / changedPaths |
| `agent_teams_amend_task` | captain-only: rewrite objective/acceptance/verify/inScope/outOfScope of a non-terminal quality task (when the contract itself makes honest completion impossible); writes a revisions ledger and freezes after a passing review. Not available to members |
| `agent_teams_send_message` | any member → any member/captain: the message lands directly in the recipient's mailbox and wakes it (no captain relay; an impersonated `from` is rejected) |
| `agent_teams_status` | the whole team: kind/round/verdict, coverage matrix, escalated, halt/resume state |
| `agent_teams_resume` | explicitly resume a halted team; a non-empty reason is required; cancelled tasks are not recreated |
| `agent_teams_delete` | end a team: interrupt its members and **archive** the team directory (tasks, dependency graph and mailboxes retained in full) |

`agent_teams_add_member` needs no model parameters by default: when a member follows the captain's current LLM provider/model, the captain's current reasoning effort is snapshotted with it. When the user explicitly asks for a different model for a role, the optional `provider` + `model` may be passed together; overriding only `model` keeps the captain's current LLM provider. Whenever either provider or model changes, the reasoning effort automatically uses the target model's default tier; when the user explicitly asks for a specific effort for a member, the optional `reasoning_effort` may be passed (a tier id the target model supports, or `"default"` to force the model's own default). The plugin never opens a second selection round or a dialog per member.

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

The pre-execution plan review reads Harness's model catalog directly: member models and reasoning levels use the same Provider/model metadata as the main input area, so hand-written routes are no longer required. "Return to chat and revise" marks the staged draft as awaiting feedback, cancels the still-running planning turn, and asks the Captain through plugin context to ask once about the direction of the change; after the user answers, the Captain must update that same draft atomically through one `agent_teams_edit_plan` call and must not create another team. "Discard this plan" needs a second confirmation, then archives the draft, cancels the current turn and preserves model context that forbids automatic recreation; only "Confirm and run the team" creates members and schedules tasks, without an extra meaningless start confirmation.

While a long task runs, a stop button appears to the right of the specific team title. Clicking it and confirming again in the dialog cancels the Captain's current turn, interrupts every member, cancels unfinished tasks and stops further scheduling; the entry point no longer occupies the chat input area. Stopping does not delete the team, and a later user message may explicitly request `agent_teams_resume`. Cancelled/failed tasks keep their terminal state in the archive.

## Known limitations

- Scheduling is event-driven rather than permanently polling; a member cannot be cold-resumed while the captain is offline, and tasks and messages stay on disk until the captain resumes or calls the status tool.
- A captain leads one team at a time (matching Claude Code AgentTeams).
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
