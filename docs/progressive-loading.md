# AgentTeams fixed protocol and business tools

AgentTeams keeps its original 14 business tools and removes `agent_teams_open`. The trimmed core rules are fixed in the system prompt from the first request onward; creating, approving, continuing, pausing or archiving a team never swaps that prompt section or the tool definitions. Nothing has to be loaded, and there is no extra activation call.

This change addresses two problems:

- #146: when a team already exists, continue the current work and check state with `agent_teams_status` as needed, instead of recreating members and tasks. Even if the model calls create by mistake, the error guides it back to the existing team rather than telling it to end the old one first. The creation permission and the duplicate-team protection are both retained.
- #138: a trimmed fixed instruction, plus only the team tools the captain/member identity needs. No initial-request bytes were saved by adding tools mid-flight or replacing the system prompt.

| Session identity | Fixed team tools | Fixed system content |
|---|---|---|
| ordinary session, captain, cold-resumed captain | the original 14 business tools | trigger boundary, approval, collaboration, attempt, quality gates, pause/resume, wrap-up rules and the configured template directory |
| member | claim, update, send_message, status | member rules and the original persona |

Ordinary coding/research tools are kept as usual. Member identity comes from a durable member id, the retired-member index, or a trusted member-creation registration this plugin is performing — never from a freely writable label. The tool restriction applies to both the native schema and the PTC SDK, and it cannot lift a user or preset restriction.

A slash command, an explicit natural-language request and continuing an existing team all use the core protocol directly. Explaining, declining or quoting AgentTeams itself is not a request to start work. With no team, a staged plan is created and awaits approval; with an existing team, work continues. The template directory always contains the name, size, planning mode and a protocol/purpose summary of at most 240 characters, listing at most 16 templates. The full configuration is read when a team is created and frozen into the team state; the directory summary does not replace the full configuration.

The core rules do not depend on a tool result, so a legacy 13-tool allowlist can plan directly, and the rules remain readable after code mode discards a return value, a result is truncated, or session history is compacted. HMR cleans plugin resources and restores session identity; deploying a new version or changing configuration can itself change the prefix, so the stability guarantee applies to a business lifecycle under one version and configuration.

## Why progressive loading was withdrawn

An early implementation exposed `open` first, then added the business tools and replaced the system prompt. A user's long-session measurement showed cache reads dropping significantly after the switch, so it was withdrawn. Keeping `open` afterwards as a query helper was unnecessary too: state already has `status`, and templates already have a fixed directory. In the end `open` was deleted outright to avoid duplicate functionality and an extra model round trip.

This plugin guarantees that business state does not actively rewrite system/tools; that cannot guarantee every provider cache hit. Request byte counts are also not tokens, cache-hit rate or cost, so a lower tool count must not be claimed as a cost reduction.

## Web approval notification

After the Web **Approve & Run** submits the approval and starts scheduling, a control message with a plugin source is appended through `captain.steer`. An idle captain starts a turn; a running captain receives the message at a later step. The message states that approval has happened, that it must not be approved again or the work dispatched twice, and that after handling reports/user work it should end the turn when only waiting remains, because member reports wake the captain automatically. When the model calls approve itself, the existing tool result is returned and no second notification is sent.

A failed approval notification is logged, and an already-committed approval is never misreported as a failure; there is currently no cross-process durable retry guarantee.

## Verification criteria and evidence

`pnpm verify:capabilities` uses the real scoped registry, prompt assembly and WorkerThreadCodeRuntime, covering the fixed rules, direct business calls to the 14 tools, duplicate creation retaining the original team, a user restriction, cancel/failure, trusted member identity, pause, cold resume, HMR, PTC/both SDKs and actual result truncation.

`scripts/harness-runtime-verify.mjs` installs the packaged artifact into an isolated profile and boots it through the published CLI and the real Loader. Only the external LLM is a deterministic fixture; tools, sessions, persistence, scheduling and member creation all run the production implementation.

- `progressive-entry` keeps its historical scenario name and covers six paths: Chinese/English natural language, a raw slash command, the host command registry, a profile alias and `--profile`. The model request contains only the 14 team tools and directly creates a staged plan. The test continues an existing plan, approves explicitly, runs and reports member work, archives, resumes ordinary conversation, and checks status after archiving. The natural-language path first runs 30 ordinary conversation turns, then checks after each one that the system/tools hashes are unchanged.
- `protocol-compatibility` uses a 13-tool allowlist to use a template directly, resume the same session, and modify the original plan after calling the host's `compactNow`. Another path uses the real code runtime to discard a status return, truncate and compact, then modify and archive that same team. The core rules and the prefix are checked each time.
- `web-approval` approves through a real HTTP route and host authentication, checking the approval notification, the captain ending its waiting turn, a member report waking it again, and that a duplicate or failed approval produces no success notification.
- The lifecycle, fallback, failure, captain-idle-wakeup and two cold-resume scenarios are retained.

```sh
pnpm build
pnpm verify
pnpm pack --pack-destination /tmp/agentteams-artifacts
node scripts/harness-runtime-verify.mjs \
  --host-version 0.1.2-rc.1 \
  --artifact /tmp/agentteams-artifacts/nanmicoder-dsh-agent-teams-0.1.16-rc.3.tgz \
  --report-dir /tmp/agentteams-runtime-rc1
```

Verify the same artifact for every supported version in `compatibility.json`, each with its own runtime/report directory. A report keeps the request snapshot, request hash, artifact/fixture hashes and the business assertions. A deterministic fixture proves the chain and the request content, not real model comprehension or business quality.

The verification results after deleting `open` are in [no-open-verification.json](./no-open-verification.json). The real-model run used an isolated small application and externally checked three member reports, task state, the actual write sources, the captain's summary order and the source file bytes. A single real case cannot prove equality for arbitrary business, long-term cost or a statistical success rate.

The [legacy fixed-protocol report](./progressive-loading-verification.json) and the [earlier real-model comparison](./agent-teams-real-model-verification.json) are historical artifact evidence that still contains `open` and do not represent the current 13-tool version. The local verification record for the `open` deletion used the not-yet-bumped `0.1.16-rc.1` development package, distinguished by SHA-256, and must not be confused with the `rc.1` on npm. The released version for this change is `0.1.16-rc.3`; GitHub Actions repacks and verifies that same artifact for the released version.
