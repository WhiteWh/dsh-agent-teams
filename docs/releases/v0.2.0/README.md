# v0.2.0 release record — repair a live plan, several teams at once

The final release of the hardening plan: steps S16–S19 (WP8, WP7, WP11 phases 2–3) on top
of the 0.1.21–0.1.24 line. One version = one shipped content, so the release carries exactly
those four work packages.

## What shipped

| Step | Work package | Change |
| --- | --- | --- |
| S16 | WP8 | `src/progress.ts` (one server-computed percentage, `byKind` + `equal`, per-phase rows), `taskPlanning.weights`, the `Progress:` line and checkbox glyphs in `agent_teams_status`, the panel's progress block with a mode switch, the task checklist, the card's mini bar |
| S17 | WP7 | `TeamState.plan` (revision, phases, `agent-teams/plan-revised` diff), `agent_teams_replan` (7 operations, atomic, `invalidate`/`retry`), the shared `replanLiveTeam` runtime for the tool and the Web route, the panel's running-mode editor, `hasFollowUpRepair` shared by Delivery and progress |
| S18 | WP11 phase 2 | the panel's team switcher (`liveCaptainTeam` removed), `TeamScheduler.sweepAll` across workspaces, the worker caps enforced on the dispatch primitive, `verify:multi-team` in the chain |
| S19 | WP11 phase 3 | `maxTeamsPerWorkspace` / `maxTeamsPerSession` as configured keys, one `resolveTeamLimits`, the slot summary (`Slots: …; N queued`) and the limits echo in `agent_teams_status` |

Tool set: 18 → 19 (`agent_teams_replan`). New statuses: none. New session event:
`agent-teams/plan-revised`. New profile keys: `maxTeamsPerWorkspace` (4),
`maxTeamsPerSession` (8), `maxWorkersPerTeam` (roster cap), `maxConcurrentWorkersGlobal` (8).

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 (both programs) |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **291 PASS / 0 FAIL** |
| quality-gate rules | `node scripts/quality-gates-tdd.mjs` | **134 PASS / 0 FAIL** |
| lifecycle behaviour | `node scripts/lifecycle-verify.mjs` | **155 PASS / 0 FAIL** |
| multi-team panel | `node scripts/multi-team-panel-tdd.mjs` | **14 PASS / 0 FAIL** |
| stress | `node scripts/stress-verify.mjs` | **30 PASS / 0 FAIL** |
| behaviour suites | `fallback-tdd`, `member-failure-tdd`, `harness-compat-tdd`, `stability-tdd`, `web-routes-verify`, `compatibility.mjs` | all exit 0 |
| node test files | `release-metadata`, `readme-version`, `http-body`, `capabilities` (19 tools), `member-spawn-recovery`, `command-source`, `quality-gates-repair-scope`, `quality-gates-amend` | all exit 0 |
| events write guard | `node scripts/verify-events.mjs` | exit 0 |
| packaging | `node scripts/verify-package.mjs`, `readme-version.mjs` | pass, "match 0.2.0" |
| skill mirror | `node scripts/sync-skill.mjs --check` | up to date |
| language policy | `node .local/lang-check.mjs` | pass |

Checks added across this release: +24 in `verify.mjs` (progress fixtures, weights, known
deltas of the replan applier, route parser, panel wiring, configured limits), +3 in
`quality-gates-tdd.mjs` (profile weights, nested `taskPlanning` scope), +8 in
`lifecycle-verify.mjs` (the replan repair scenario, the configured team limits, the slot
summary), +9 in `stress-verify.mjs` (replan under a live member, two teams and the caps) and
the new `multi-team-panel-tdd.mjs` suite (14 checks).

## Not verified here (left for CI)

- the whole `pnpm verify` chain (it spawns piped child processes, which this machine's
  sandbox denies);
- `scripts/compatibility.test.mjs` (same limitation) and the real-host matrix
  `scripts/harness-runtime-verify.mjs` (needs a host cohort and credentials);
- the manual scratch-profile look at the new panel surfaces (switcher, progress block,
  checklist, running-mode editor).

## Deployment record

| Item | Value |
| --- | --- |
| Artifact | `dsh-agent-teams-0.2.0.tgz`, 2 317 040 bytes (`.local/dist/nanmicoder-dsh-agent-teams-0.2.0.tgz`) |
| SHA-256 | `FBBA6EBA90F96A277C4B8E2865A83B3E018D98E529FE4D616E98EBD8148C12EE` |
| Profile | `web` (`dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.2.0.tgz`) |
| Installed check | version 0.2.0; `lib/client.js`, `lib/index.js`, `lib/tools.js`, `lib/state.js`, `lib/quality-gates.js`, `lib/replan.js`, `lib/progress.js`, `lib/snapshot.js` and `lib/scheduler.js` byte-identical to the source build; `TEAM_TOOL_NAMES` has 19 entries including `agent_teams_replan`; the installed prompt carries the replan rule; `dsh --profile web --dump-config` resolves `id: agent-teams` |
| Reinstall note | a different `file:` spec resolves normally; re-adding the *same* spec needs a remove first. The `dsh.profile.bundles` order stayed `dsh-base, dsh-web-app, @nanmicoder/dsh-agent-teams, dsh-agent-status-bar` |
| Restart | the host loads the plugin only on restart |
| Rollback | `dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.24.tgz`, and restore the `*.bak-2026-09-20-pre-0.2.0` files in the profile |

Publication to the registry is a separate, maintainer-approved step; this record covers the
artifact and the profile installation only.
