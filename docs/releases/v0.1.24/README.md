# v0.1.24 release record — team identity is an argument

Plan step S14 (WP11 phase 1). The release exists on its own because it changes a protocol
invariant ("one captain, one team") and the text of the system prompt, even though the tool
count and every state field stay the same. 0.1.23 was taken by the artwork-cache hotfix, so
this is the release the plan calls "0.1.23: WP11 phase 1".

## What shipped

| Step | Work package | Change |
| --- | --- | --- |
| S14 | WP11 phase 1 | `team_id` on every team-scoped tool, list-returning team finders, `new_team: true` for a second team, the team list in `status`, state-based workspace guards, prompt rule 1 rewritten |

Tool set: 18 (unchanged). New statuses: none. New session events: none.

| Surface | Before | After |
| --- | --- | --- |
| Team lookup | `findTeamByCaptain` / `findTeamByParticipant`, throwing `ambiguous` at two teams | `listTeams`, `findTeamsByCaptain`, `findTeamsByParticipant` — always a list |
| Addressing | derived from the calling session | `team_id` argument on every team-scoped tool |
| Missing id | resolved silently | `team_id is required: you participate in N teams (<id (Name)>, …)` |
| `create` | refused when the captain already had a team | refused unless `new_team: true`; the refusal keeps the existing-team guidance |
| `status` with no id | the captain's single team | the caller's teams when there are several, the team in detail when there is one |
| Workspace limits | none | 4 live teams, 8 members in `working` state, counted across the workspace |
| Member calls | `team_id` optional | unchanged — a member of exactly one team is substituted |

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 (both programs) |
| build + revision gate | `pnpm build` | exit 0 (twice, to rule out the stale-`lib` trap) |
| offline suite | `node scripts/verify.mjs` | **240 PASS / 0 FAIL** |
| quality-gate rules | `node scripts/quality-gates-tdd.mjs` | **132 PASS / 0 FAIL** |
| lifecycle behaviour | `node scripts/lifecycle-verify.mjs` | **145 PASS / 0 FAIL** (129 before this step) |
| stress | `node scripts/stress-verify.mjs` | exit 0 (21 checks) |
| behaviour suites | `fallback-tdd`, `member-failure-tdd`, `harness-compat-tdd`, `stability-tdd`, `web-routes-verify`, `compatibility.mjs` | all exit 0 |
| node test files | `release-metadata`, `readme-version`, `http-body`, `capabilities` (18/18), `member-spawn-recovery`, `command-source`, `quality-gates-repair-scope`, `quality-gates-amend` | all exit 0 |
| events write guard | `node scripts/verify-events.mjs` | exit 0 |
| packaging | `node scripts/verify-package.mjs`, `readme-version.mjs` | pass, "match 0.1.24" |
| skill mirror | `node scripts/sync-skill.mjs --check` | 10 skills, 121 files up to date |
| language policy | `node .local/lang-check.mjs` | pass |

New checks added by this step: the multi-team scenario in `lifecycle-verify.mjs` (16
checks — `new_team` guard, the missing-id listing, the `status` list shape and per-team
detail, cross-team `update_task` isolation, archiving one team of two, the fifth-team
refusal), three rewritten source-level finder checks in `verify.mjs`, and the harness
updates in `stress-verify.mjs` / `quality-gates-tdd.mjs` / `capabilities.test.mjs` that make
every captain call carry its remembered `team_id`.

Documentation corrected in the same release: the quality-gate spec attributed the
0.1.23 features to `v0.1.22` (the version the plan reserved for them before the artwork
hotfix took that number); `docs/quality-gates.md` now dates them correctly and gained
section 1.6 for the addressing change.

## Not verified here (left for CI)

- the whole `pnpm verify` chain (it spawns piped child processes, which this machine's
  sandbox denies);
- `scripts/compatibility.test.mjs` (same limitation) and the real-host matrix
  `scripts/harness-runtime-verify.mjs` (needs a host cohort and credentials);
- the plan's `stress-verify` line "two teams, one free member, no double assignment": with
  assignment still scoped to one team, a member cannot be double-booked by construction, so
  that scenario belongs to the phase-2 scheduler (S18, `.local/FOLLOWUPS.md` F6).

## Deployment record

| Item | Value |
| --- | --- |
| Artifact | `dsh-agent-teams-0.1.24.tgz`, 2 263 430 bytes (`.local/dist/nanmicoder-dsh-agent-teams-0.1.24.tgz`) |
| SHA-256 | `77423C113E25F6FC6C81A09AA7FC5FF58EB53A77C1312D0FF81EA2D28C104CBD` |
| Profile | `web` (`dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.24.tgz`) |
| Installed check | version 0.1.24; `lib/client.js`, `lib/index.js`, `lib/tools.js`, `lib/state.js`, `lib/quality-gates.js` and `lib/artwork.js` byte-identical to the source build; `TEAM_TOOL_NAMES` has 18 entries; the installed `lib/index.js` carries the `team_id` protocol rule and the installed `lib/tools.js` carries the listing error; `dsh --profile web --dump-config` resolves `id: agent-teams` with `stateDir: .agent-teams` |
| Reinstall note | a different `file:` spec resolves normally; re-adding the *same* spec would need a remove first. The `dsh.profile.bundles` order stayed `dsh-base, dsh-web-app, @nanmicoder/dsh-agent-teams, dsh-agent-status-bar` |
| Restart | the host loads the plugin only on restart |
| Rollback | `dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.23.tgz`, and restore the `*.bak-2026-09-20-pre-0.1.24` files in the profile |

Publication to the registry is a separate, maintainer-approved step; this record covers the
artifact and the profile installation only.
