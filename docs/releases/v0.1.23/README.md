# v0.1.23 release record — amend, supersede, honest scope, known deltas

The first feature release of the hardening branch after 0.1.21/0.1.22: plan steps
S08–S12 (WP2, WP3, WP4, WP6.3, WP6.4). One version = one shipped content, so the
release carries exactly those five work packages.

## What shipped

| Step | Work package | Change |
| --- | --- | --- |
| S08 | WP2 | `amend_task` covers the whole contract plus the brief of a `work` task, accepts a `failed` task, and `force` stales the passing verdict; `TASK_TRANSITIONS` legalizes `failed → pending` |
| S09 | WP3 | `superseded` status, `applySupersession`, `agent_teams_supersede_task` with an atomic redirect of dependents and reviews, recursive satisfaction through `supersededBy` |
| S10 | WP4 | `awaiting_scope_review`, `agent_teams_accept_paths` (additive, post-hoc), `taskPlanning.sharedInScope` excluded from the overlap check |
| S11 | WP6.3 | `knownDeltas` registry with `pin_delta`/`unpin_delta` and automatic waiver evidence for a pinned check |
| S12 | WP6.4 | `reviewPolicy.requiredReviewers` enforced by `canDeclareDelivery` |

Tool set: 14 → 18. New statuses: `awaiting_scope_review`, `superseded`. New session
event: `agent-teams/delta-pinned`, `agent-teams/task-superseded`.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 (both programs) |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **237 PASS / 0 FAIL** |
| quality-gate rules | `node scripts/quality-gates-tdd.mjs` | **132 PASS / 0 FAIL** |
| behaviour suites | `lifecycle-verify`, `stress-verify`, `fallback-tdd`, `member-failure-tdd`, `harness-compat-tdd`, `stability-tdd`, `web-routes-verify` | all exit 0 |
| node test files | `release-metadata`, `readme-version`, `http-body`, `capabilities`, `member-spawn-recovery`, `command-source`, `quality-gates-repair-scope`, `quality-gates-amend` | all exit 0 |
| events write guard | `node scripts/verify-events.mjs` | exit 0 |
| packaging | `node scripts/verify-package.mjs`, `readme-version.mjs` | pass, “match 0.1.23” |
| language policy | `node .local/lang-check.mjs` | pass |

New checks added by these steps: five tdd groups (supersede, scope acceptance,
known deltas, required reviewers) plus the amended matrix, six lifecycle checks for
the supersede flow, three for the scope-review flow and five for the known-delta
registry, three mid-graph supersede checks in the stress suite, and seven
source-level checks in `verify.mjs`.

## Not verified here (left for CI)

- the whole `pnpm verify` chain (it spawns piped child processes, which this
  machine's sandbox denies);
- `scripts/compatibility.test.mjs` (same limitation) and the real-host matrix
  `scripts/harness-runtime-verify.mjs` (needs a host cohort and credentials).

## Deployment record

| Item | Value |
| --- | --- |
| Artifact | `dsh-agent-teams-0.1.23.tgz`, 2 257 086 bytes |
| SHA-256 | `C2FD504D974049977D5DAC46A8D15E9F36D9F6A6A8FE7DF440A4F78A91EC68E8` |
| Profile | `web` (`dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.23.tgz`) |
| Installed check | version 0.1.23; `lib/client.js`, `lib/index.js`, `lib/tools.js`, `lib/quality-gates.js` and `lib/state.js` byte-identical to the source build; `TEAM_TOOL_NAMES` has 18 entries including the four new tools; `dsh --profile web --dump-config` resolves `id: agent-teams` |
| Reinstall note | re-adding the *same* `file:` spec makes pnpm skip resolution, so the package is removed first; the `dsh.profile.bundles` order is restored afterwards to `dsh-base, dsh-web-app, @nanmicoder/dsh-agent-teams, dsh-agent-status-bar` |
| Restart | the host loads the plugin only on restart |
| Rollback | `dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.22.tgz`, and restore `*.bak-2026-09-20-pre-0.1.23` in the profile |

Publication to the registry is a separate, maintainer-approved step; this record
covers the artifact and the profile installation only.
