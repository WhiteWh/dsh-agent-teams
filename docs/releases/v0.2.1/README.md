# v0.2.1 release record — work is the node's own height

A client-only follow-up to 0.2.0, requested by the owner after living with the members tree.
One change: the compact six-dot "working" mark inside a member row became a full-node
plaque.

## What shipped

| Change | Where |
| --- | --- |
| `WorkBar`: a plaque three dots wide spanning the row's full height at its right edge, its dots pulsing in a top-to-bottom wave while that member works (a faint slot column when it does not) | `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css` |
| The compact `WorkGlyph` is gone from a member row; the text state (`Working`, `Ready to continue`, `Delivered`, …) stays as the accessible label | `src/client/ActivityPanel.tsx` |
| The member row's grid gained a fourth column for the plaque (`grid-area: 1 / 4 / span 2 / auto`), so it spans both the head line and the assignment line | `src/client/ActivityPanel.module.css` |

No state, tool, schema, profile key or gate changed.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **293 PASS / 0 FAIL** (+2: the plaque checks) |
| lifecycle behaviour | `node scripts/lifecycle-verify.mjs` | **155 PASS / 0 FAIL** |
| multi-team panel | `node scripts/multi-team-panel-tdd.mjs` | **14 PASS / 0 FAIL** |
| quality-gate rules | `node scripts/quality-gates-tdd.mjs` | **134 PASS / 0 FAIL** |
| stress | `node scripts/stress-verify.mjs` | **30 PASS / 0 FAIL** |
| the remaining suites (`fallback`, `member-failure`, `stability`, `harness-compat`, `web-routes`, `compatibility`, `capabilities`, `spawn-recovery`, `command-source`, `http-body`, `verify-events`, `verify-package`, …) | as in `pnpm verify` | all exit 0 |
| packaging | `verify-package.mjs`, `readme-version.mjs`, `release-metadata.test.mjs` | pass, "match 0.2.1" |
| language policy | `node .local/lang-check.mjs` | pass |
| visual check | `node .local/preview-work-bar.mjs` → `.local/logs/ui-workbar/members-tree.png` | plaque rendered with the real CSS module sheet and artwork (Chrome headless, 2× scale) |

## Not verified here (left for CI)

- the whole `pnpm verify` chain (it spawns piped child processes, which this machine's
  sandbox denies);
- `scripts/compatibility.test.mjs` and the real-host matrix `scripts/harness-runtime-verify.mjs`;
- the live animation itself: the preview is a still frame, so the wave motion was reviewed
  in the source and in the rendered column, not frame by frame in a browser.

## Deployment record

| Item | Value |
| --- | --- |
| Artifact | `dsh-agent-teams-0.2.1.tgz`, 2 318 783 bytes (`.local/dist/nanmicoder-dsh-agent-teams-0.2.1.tgz`) |
| SHA-256 | `2F73FAF83A86A4A8D0E4944D9448208C98FEF7F948F89B7A691219745243D411` |
| Profile | `web` (`dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.2.1.tgz`) |
| Installed check | version 0.2.1; `lib/client.js` and the host files byte-identical to the source build; `TEAM_TOOL_NAMES` = 19; `dsh --profile web --dump-config` resolves `id: agent-teams` |
| Reinstall note | a different `file:` spec resolves normally; the `dsh.profile.bundles` order stays `dsh-base, dsh-web-app, @nanmicoder/dsh-agent-teams, dsh-agent-status-bar` |
| Restart | the host loads the plugin on restart, and the browser reloads the client bundle with the page |
| Rollback | `dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.2.0.tgz` |
