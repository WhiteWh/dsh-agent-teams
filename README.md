<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-agent-teams turns one DeepSeek Harness session into a coordinated multi-agent team">
</p>

<p align="center">
  <a href="https://dshfind.com/en/plugins/NanmiCoder/dsh-agent-teams?ref=badge"><img src="https://img.shields.io/badge/recommended%20by-dshfind-FFD700?style=flat-square" alt="Recommended by dshfind"></a>
  <a href="https://dshfind.com/en/plugins/NanmiCoder/dsh-agent-teams?ref=badge"><img src="https://dshfind.com/api/badge/NanmiCoder/dsh-agent-teams?lang=en" alt="dshfind score"></a>
  <a href="https://dshfind.com/en/plugins/NanmiCoder/dsh-agent-teams?ref=badge"><img src="https://dshfind.com/api/badge/NanmiCoder/dsh-agent-teams?metric=downloads&amp;lang=en" alt="dshfind downloads"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams"><img src="https://img.shields.io/npm/v/@nanmicoder/dsh-agent-teams?style=flat-square&amp;color=5B4CF0" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT license"></a>
  <a href="./cordis.patch.yml"><img src="https://img.shields.io/badge/DSH-Web%20%2B%20Headless-5B4CF0?style=flat-square" alt="DSH Web and Headless"></a>
</p>

## One prompt. A working team.

`dsh-agent-teams` turns the current DeepSeek Harness session into a captain that can assemble durable sub-agents, split a goal into dependency-aware tasks, and coordinate work through direct messages.

Ask in natural language. The plugin provides the team protocol, 14 coordination tools, persistent state, an automatic shared-task scheduler, and a live Web UI—without requiring a separate workflow engine.

<p align="center">
  <img src="./assets/ui.png" width="100%" alt="DeepSeek Harness conversation with the AgentTeams live activity panel, members, tasks, dependencies, and reports">
</p>

## Releases

[v0.1.22](./release-notes/v0.1.22.md) is a packaging fix for the activity panel artwork. The panel addresses its images by file name, and those names survived the redraw from the whale pack to the amber terminal pack — so a browser that had cached `member-engineer-v2.png` kept drawing the old whale for the whole `cache-control` lifetime, and a freshly deployed panel looked unchanged. Every artwork URL now carries a content revision (`?v=<pack revision>`) derived from the packaged bytes, and both `pnpm build` and `scripts/verify.mjs` fail when the committed revision goes stale. No state, tool signature or quality-gate rule changed.

[v0.1.21](./release-notes/v0.1.21.md) makes acceptance criteria waivable: a member can report a check that is red on the baseline as `waived` with evidence instead of forcing the task to fail, and Delivery stays blocked until a review confirms the waiver. It also removes the list-length fallback that let an unrelated all-pass report satisfy a contract, makes scope-overlap serialization transitive, drops cancelled tasks from the Delivery path audit, turns a misplaced profile key into a fix ("`requiredReviewers` belongs under `reviewPolicy`"), adds `node scripts/doctor.mjs --profiles`, and gives the activity panel three read-only views over the same state: **Phases**, **Agents** and **Queues**. Recommended host: DeepSeek Harness `0.1.5-rc.1`; the three older supported host targets are retained.

### What this branch changes

This fork is the [upstream `main` checkout](./release-notes/v0.1.20.md) plus a plan-driven hardening pass. Every
change below is covered by a test written first, and the whole branch keeps the
upstream contract: existing `team.json` files still load, tool signatures are
unchanged, and no existing assertion was weakened.

| Work package | Change | Where |
| --- | --- | --- |
| **Acceptance waivers** | `waived` as a third result status, with mandatory evidence; the reviewer confirms it through `waiverConfirmation` and otherwise Delivery reports `<id> has unconfirmed waivers`. `reviewPolicy.allowWaivers: false` turns the mechanism off. `no_regression` criteria (`{text, mode, baseline}`) pass on "identical to the named baseline". The old length-parity fallback is gone, so criteria are matched by normalized text rather than by array position. | `src/quality-gates.ts`, `src/tools.ts` |
| **Transitive scope serialization** | The `inScope` overlap check walks the dependency closure instead of only direct edges, so a replacement task can be created while its downstream subtree still points at the task it replaces. A shared ancestor alone is still a real conflict. | `src/quality-gates.ts` |
| **Clean delivery reports** | The path audit follows completed work only; `changedPaths` left behind by a cancelled task no longer reddens Delivery. | `src/quality-gates.ts` |
| **Actionable profile errors** | A misplaced key now names its nesting, and `node scripts/doctor.mjs --profiles <config.json>` lints every configured profile without booting a host. | `src/profiles.ts`, `scripts/doctor.mjs` |
| **Two read-only panel views** | **Phases** (columns by declared phase, otherwise dependency level, with edges between columns) and **Queues** (who holds what, what is next, and the grouped idle reason). The choice is remembered per browser; a preference stored for the removed Agents view falls back to the tree. | `src/client/activity-model.ts`, `src/client/ActivityPanel.tsx` |
| **One task-status table** | The transition table lives once, in `src/state.ts`; the completion gate reads it instead of keeping a copy that can drift. | `src/state.ts`, `src/quality-gates.ts` |
| **Scheduler attempt integrity** | A member's own fresh attempt is no longer mistaken for a lost owner and re-claimed underneath it (which used to drop `in_progress` back to `claimed` and make the member's next `update_task` fail as stale), and fresh ready work now outranks re-claiming an attempt the member already holds. | `src/scheduler.ts` |
| **Revisioned panel artwork** | Artwork URLs carry a revision derived from the packaged bytes, so redrawing a pack changes the URL instead of leaving browsers on the previously cached image; the host route reads the path only, and a stale revision fails the build. | `src/client/artwork.ts`, `src/artwork.ts`, `scripts/art-revision.mjs` |

Remaining plan work is tracked locally and lands in later releases: contract
amendment extensions and `retry` from `failed` (0.1.23), `superseded` with an
atomic dependency redirect (0.1.23), post-hoc path acceptance and
`awaiting_scope_review` (0.1.23), the known-delta registry (0.1.23),
`requiredReviewers` enforcement (0.1.23), mandatory `team_id` addressing
(0.1.24), plan progress and the task checklist (0.2.0), and live-team replanning
(0.2.0).

### Verification

| Layer | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm build` | pass |
| `scripts/verify.mjs` | 219 PASS / 0 FAIL (upstream baseline on this machine: 181) |
| `scripts/quality-gates-tdd.mjs` | 106 PASS / 0 FAIL |
| the remaining suites (`lifecycle`, `stress`, `web-routes`, `capabilities`, `harness-compat`, …) | all exit 0 |
| `readme-version`, `release-metadata`, `verify-package`, `sync-skill --check` | pass |
| replay of the reported `t5` incident on the real compiled tools | 7/7 |

The real-host matrix (`scripts/harness-runtime-verify.mjs`) and the full
`pnpm verify` chain are left to CI: the local sandbox cannot spawn the child
processes they need.

### Documentation language

All documentation, release notes and comments are English. `README_ZH.md` and the
dated audit records under `docs/` are frozen legacy: they are excluded from the
code index, no longer synced with a version bump, and not maintained. The plugin's
own UI strings still follow the Harness locale, so the panel remains bilingual at
runtime; that dictionary is product behaviour, not documentation. New documents are
English-only.

## Why AgentTeams?

| Capability | What it changes |
| --- | --- |
| **Captain-led delegation** | The current session creates the team, assigns roles, and consolidates the final result. |
| **Durable members** | Members are continuable DSH sub-agents that can be woken for focused follow-up turns. |
| **Dependency-aware tasks** | Tasks move through explicit states and cannot be claimed before their dependencies finish. |
| **Automatic reuse and safe takeover** | Idle members claim the next ready task; reassignment revokes stale attempts before new work starts, and cold recovery retries stranded open attempts. |
| **Direct messaging** | Members send durable mailbox messages directly to teammates or the captain—no relay required. |
| **Live activity panel** | The Web UI combines segmented progress, a collapsible roster, and an interactive task DAG; running tasks show the member's model, and completed archives retain their full member and task history. Two read-only views sit next to the tree: **Phases** (dependency levels, or the plan's declared phases) and **Queues** (who holds what, what is next, and why an idle member is idle). |
| **Plan before execution** | Normal `/agent-teams` runs stage an unspawned roster and DAG first. The Web panel uses the host model catalog for member routes. Returning to chat stops the planning turn, asks what should change, and revises the same draft; discarding archives the draft, aborts the turn, and explicitly prevents automatic recreation. Only **Approve & Run** enables scheduling; each member starts with its first ready task. |
| **Quality gates** | Opt-in quality tasks support requirements → implementation → verification → review → integration contracts, automatic repair/re-review, and explicit resume. An acceptance criterion that cannot honestly be measured green can be `waived` with evidence, and a review has to confirm the waiver before delivery. Scope control is a completion-time audit, not host write interception. See [docs/quality-gates.md](./docs/quality-gates.md). |

The conversation card and activity panel use Harness's official locale service. They follow live language changes between English and Simplified Chinese—including status labels, dynamic summaries, controls, archive markers, and accessibility text—without a page reload or a separate plugin setting.

## Install and choose versions

**Recommended pair: DeepSeek Harness `0.1.5-rc.1` + AgentTeams `0.1.22`. Harness remains a prerelease.**

| Use case | DeepSeek Harness | AgentTeams plugin |
| --- | --- | --- |
| **Recommended installation** | **`0.1.5-rc.1`** | **`0.1.22`** |
| Retaining an older RC | `0.1.2-rc.1` | `0.1.22` |
| Developer Alpha testing | `0.1.2-alpha.5` | `0.1.22` |
| Retaining an older Alpha | `0.1.2-alpha.2` | `0.1.22` |

### 1. Install DeepSeek Harness

```sh
npm install --global @deepseek-ai/dsh@0.1.5-rc.1
dsh --version
```

Skip this if you already run this version. Alpha is opt-in: select an exact Alpha version from the table and lock all host dependencies as described in the [maintenance guide](./docs/maintenance-workflow.md).

### 2. Install the AgentTeams plugin

Install into the `web` profile. Replace the profile name if needed:

```sh
dsh plugin --profile web add --save-exact @nanmicoder/dsh-agent-teams@0.1.22
```

**After installation, stop and restart Harness for that profile, then refresh the browser.**

The default npm `latest` tag points to `0.1.22`, so `dsh plugin --profile web add @nanmicoder/dsh-agent-teams` installs this version on a fresh profile. Use the exact-version command above to pin it. The recommended Harness version is `0.1.5-rc.1`; installing the plugin does not upgrade the host. See the [source installation guide](./docs/maintenance-workflow.md) and [release verification](./docs/releases/v0.1.19/README.md).

> Desktop users must check the app's embedded Harness core; upgrading the global CLI does not upgrade it. For older `0.1.0-*` / `0.1.1-*` or unlisted hosts, keep a working pair and follow the [older-version and diagnostic guide](./docs/maintenance-workflow.md).

See the full [compatibility matrix](./compatibility.json), [source installation and Alpha testing guide](./docs/maintenance-workflow.md), and [verification coverage and platform limits](./docs/maintenance-2026-09-06/release/README.md).

Then ask for a team directly:

> Use AgentTeams to review the commits after v0.5.3 from performance, security, and product perspectives. Return one consolidated report.

## How it works

1. For a request to use AgentTeams, the captain follows the core protocol already in its system instructions. It continues an existing team and uses `agent_teams_status` when current state needs checking. When no team exists, the goal becomes a staged plan for review.
2. The captain adds role-specific members backed by continuable sub-agents.
3. The goal becomes tasks with owners and explicit dependencies.
4. The shared scheduler uses real `running / idle / ready` state to atomically claim one ready task per idle member and wake it. An interrupted resident attempt stays parked and can resume through a direct message without losing its capability; after a cold process restart, the scheduler retries stranded open work with a fresh attempt.
5. Members update with the current `attempt_id`; reassignment or captain takeover revokes the old attempt and waits for the old worker to quiesce before a new attempt starts.
6. The captain presents the combined result, then archives the complete team record.

Team state is stored under `<workspace>/.agent-teams/`; the Web panel reads that disk truth and combines it with live sub-agent activity.

Member creation is zero-interaction by default: a member on the captain's current LLM route snapshots that provider, model, and reasoning effort, while a member on a requested alternative route snapshots the target model's default effort; later continuations restore the resolved snapshot. Only an explicit heterogeneous-team request (for example, “backend on provider A/model X, frontend on provider B/model Y”) supplies a member-specific `provider` + `model`; there is no per-member model or reasoning prompt.

Captain sessions keep the concise core protocol and the original 14 native team tools from their first request. All business tools are directly available; no loading tool or extra activation call is needed. Configured profiles retain their bounded directory in the fixed system prompt. Creating, approving, continuing or ending a team does not rewrite the system prompt or tool schemas. Core rules remain available after history compaction or discarded code-mode tool results. Members receive four team tools, fixed member instructions, and their ordinary coding/research tools. Web approval wakes the captain with a control message; later member reports wake it again. See the [fixed protocol and benchmark contract](./docs/progressive-loading.md).

## Slash command

No “use AgentTeams” phrasing required. The plugin registers the
closed-namespace `/agent-teams` host command, so the Web GUI slash menu shows
an `agent-teams` placeholder with an input hint: pick it (or type the
command), describe the goal, and press Enter.

```
/agent-teams research the pricing pages of three competitors
```

The command pipeline claims the line, then preserves that exact input as an
ordinary user follow-up so it remains visible in the main chat. The gesture
boundary adds the deterministic activation directive at pre-step, so the
first model request follows the staged planning protocol without a mandatory helper call. The invocation is also durably
logged (`command/run` / `command/done`).

Surfaces without command adjudication (for example the headless CLI) get the
same deterministic activation through a gesture boundary: any genuine user
message starting with `/agent-teams` activates the protocol for the rest of
the text. Mid-sentence mentions stay ordinary prose.

Historical panels require saved team state or archives. Sessions from early versions that deleted teams without retaining archives do not yet support reconstructing the full panel from logs.

## Configuration

Defaults work without extra setup. A trusted profile can override member behavior:

```yaml
- id: agent-teams
  config:
    stateDir: .agent-teams
    memberProvider: spawn
    memberModel: deepseek-v4
    memberMaxDepth: 0
    maxMembers: 8
```

`memberMaxDepth` defaults to `0`: team members cannot create nested subagents. Set `1` to explicitly permit one descendant level; the limit also covers runtime/code-tool calls. Default members report through team messages only, avoiding duplicate native parent reports. Idle roster members make no model requests. Task assignments start distinct turns; coordination joins the nearest model step. Acceptance and consumption are tracked separately. Removal/archive drains the selected branch and its pending input before reporting success.

`memberProvider` is the sub-agent runtime backend (`spawn` / `fork`), not an LLM provider. Cross-LLM-provider routing uses the optional `provider` + `model` fields of `agent_teams_add_member`; `memberModel` is only a model default for all members. A member on the captain's current provider/model inherits the captain's reasoning effort, while a changed provider or model automatically uses the target model's default. To request a particular effort, pass the optional `reasoning_effort` field — one of the target model's supported effort ids, or `"default"` to force the model's own default.

`slashCommand: false` disables the deterministic `/agent-teams` activation surfaces (slash command and gesture boundary), leaving the natural-language trigger as the only entry point.

## Boundaries

- One captain leads one active team at a time.
- Idle members with no open task are automatically reused for ready work. An idle member that still owns an open attempt is parked until messaged or explicitly reassigned; messages that cannot be delivered live remain durable and are retried at a later status boundary.
- State is file-backed and serialized within one DSH process; concurrent processes editing the same team are not coordinated.
- The activity panel reports persisted state as-is. Models may occasionally finish work without performing the expected task-state update.

See [docs/usage.md](./docs/usage.md) for the full tool reference, state model, Web UI behavior, configuration, and known limits.

## Plugin development Skill

Community upgrade, audit, benchmark, testing and release skills are vendored with a pinned source revision. See [skills/README.md](./skills/README.md) for local rules and [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

The repository also ships the open Agent Skills package [`dsh-plugin-development`](./skills/dsh-plugin-development/SKILL.md):

```sh
npx skills add NanmiCoder/dsh-agent-teams --skill dsh-plugin-development
```

## Documentation

| Guide | Covers |
| --- | --- |
| [Usage](./docs/usage.md) | Architecture, UI behavior, tools, configuration, limits, and validation |
| [Verification](./docs/verification-guide.md) | Offline, composition, real e2e, and GUI verification |
| [Plugin development](./docs/developing-dsh-plugins.md) | Human-readable guide built from this plugin |
| [README writing](./docs/readme-writing-guide.md) | Repository documentation conventions |

## Development

```sh
pnpm install
pnpm build
pnpm verify
```

## Named multi-role profiles

Configure one or more complete team profiles in `cordis.patch.yml`. A profile always supplies the roster (independent provider/model/role/reasoning effort). Set `taskPlanning: captain` when the Captain should derive the DAG from the user's goal; omit it or set `taskPlanning: seed` to keep a fixed template workflow:

```yaml
profiles:
  demo-delivery:
    description: Ship a small feature
    protocol: Discuss requirements, review, test, then prepare release; do not deploy automatically.
    members:
      - name: analyst
        model: gpt-5.6-sol
        role: Analyze requirements
      - name: implementer
        model: gpt-5.6-terra
        role: Implement the approved solution
    tasks:
      - id: requirements
        subject: Requirements discussion
        assignee: analyst
      - id: implementation
        subject: Implement solution
        assignee: implementer
        dependencies: [requirements]
```

Use an explicit profile flag: `/agent-teams --profile demo-delivery implement the feature`. The first ordinary token is never treated as an implicit profile. Normal command runs call `agent_teams_create({ profile, approval: "required" })`: the roster and seed/Captain-designed DAG remain staged, no child session is created, and no task is claimed. Edit the plan in the activity panel using the host model catalog, return to chat so the Captain asks what to revise and then atomically updates the same draft, discard it, or click **Approve & Run**. Return/discard actions cancel any planning turn still running; discard also parks model-facing context that forbids silently creating a replacement team. Approval resolves the final provider/model/reasoning choices, commits the roster, and creates each member session only when its first task is ready. A running team is stopped from its own panel header through a confirmation dialog rather than from the composer. Direct tool clients may pass `approval: "automatic"` for the legacy immediate path. Failed review/test tasks do not unlock downstream work; automatic repair/review tasks do not depend on the failed review.

## License

[MIT](./LICENSE)
