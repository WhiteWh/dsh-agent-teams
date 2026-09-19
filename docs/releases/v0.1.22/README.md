# v0.1.22 release record — revisioned activity-panel artwork

A packaging fix for the live activity panel, shipped as its own release so the
plan's later releases keep one version = one shipped content (they shift by one:
0.1.23 for the contract work, 0.1.24 for `team_id`, 0.2.0 for the plan UI).

## What was wrong

The panel addresses its artwork by file name under
`/plugins/dsh-agent-teams/assets/`, and those names survived the redraw from the
whale pack to the amber terminal pack — `member-engineer-v2.png` was the whale
and is now the terminal. The host route served them with
`cache-control: public, max-age=86400`, so a browser that had already loaded the
pack kept drawing the cached whale for a day after the upgrade. Observed on a
real deployment: a profile that had just been moved to 0.1.21 still rendered the
whale captain and whale members, while the installed package held the amber
bytes.

Evidence that the server was not at fault (recorded before the fix): the
installed `lib/{client,index,scheduler,quality-gates,harness-compat}.js` and all
thirty `assets/agent-teams/*.png` were byte-identical to the source build, the
running server was 0.1.21 (the waiver vocabulary is absent from the 0.1.18 copy
installed in `martty`), and the whale art the panel drew is the pack from
`47183d8`, which used the same file names.

## What shipped

- `src/client/artwork.ts` builds every URL through one `artUrl()` helper that
  appends `?v=<ART_REVISION>`.
- `src/client/art-revision.ts` holds the revision; `scripts/art-revision.mjs`
  derives it from the sorted, length-framed pack bytes and regenerates the module
  with `--write` (npm script `art:revision`).
- `scripts/art-revision.mjs --check` runs first in `pnpm build`, and
  `scripts/verify.mjs` re-derives the same value, so a swapped icon without a
  regenerated revision fails with `artwork revision is stale: committed …, pack …`.
- The art route moved from `src/index.ts` into `src/artwork.ts`
  (`serveArtwork` + `ART_ALLOWLIST`) so the served request shape is testable. It
  reads the URL path only — the query is never part of the file name — and still
  serves allowlisted names exclusively.
- The member portrait carries **one** corner mark instead of two. The role symbol
  was redundant beside a row that already names the role in words, so the avatar
  keeps the live action mark only and the captain avatar drops its role mark too.
- The role symbol became the **compact** mark: 12 px in the slots where neither
  the mascot nor a label fits — a DAG node head, the task-detail assignment line
  and a Queues row — resolved through one `ownerSymbolUrl()` helper (a captain
  owner gets the lead mark; an unclaimed task or an unmatched role keeps the
  coloured dot). The collapsed panel pill shows the action symbol instead of a
  plain dot, which is the same busy/idle meaning with a readable mark.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 (both programs) |
| build + revision gate | `pnpm build` | exit 0, `artwork revision: 5a90736f927c` |
| offline suite | `node scripts/verify.mjs` | **222 PASS / 0 FAIL** (was 214; eight net new checks) |
| quality gates | `node scripts/quality-gates-tdd.mjs` | 106 PASS / 0 FAIL |
| behaviour suites | `fallback-tdd`, `member-failure-tdd`, `lifecycle-verify`, `stress-verify`, `harness-compat-tdd`, `stability-tdd` | all exit 0 |
| host auth + routes | `node scripts/web-routes-verify.mjs` | exit 0 |
| node test files | `release-metadata`, `readme-version`, `http-body`, `capabilities`, `member-spawn-recovery`, `command-source`, `quality-gates-repair-scope`, `quality-gates-amend` | all exit 0 |
| packaging | `node scripts/verify-package.mjs`, `readme-version.mjs` | pass, “match 0.1.22” |
| language policy | `node .local/lang-check.mjs` | pass |

New checks: `the committed artwork revision describes the packaged images`,
`a redrawn artwork file changes the revision`, `every artwork URL carries the
pack revision`, `the artwork route ignores the cache-busting query`,
`the artwork route serves allowlisted names only`, `the corner badge draws the
activity mark only, from the symbol pack`, `the role symbol pack stays resolvable
for the compact slots`, `compact surfaces resolve an owner through the role
symbol pack`, `the compact surfaces draw the symbol packs and keep a fallback`.

The compact marks were also rendered outside the host, at 3× device scale, with
the real `256` pack files (`Chrome --headless=new`, 12/13/18 px side by side and
a mock DAG node, queue row and collapsed pill): every role and action symbol stays
distinguishable at 12 px, so the sizes shipped are the sizes measured.

Two existing checks were adapted rather than weakened: the badge assertions read
the URL path without the query before matching `-symbol.png`, the
allowlist/client-mapping check reads `src/artwork.ts` (where the allowlist now
lives) instead of `src/index.ts`, and the check that asserted *both* corner marks
was replaced by the pair above — the avatar assertion is now stricter (no role
mark at all), and the role pack keeps its own assertion instead of losing
coverage with the UI.

**Mutation evidence.** Reading the file name from the raw request URL — the naive
implementation this fix replaces — rebuilds green but fails the suite with
`the artwork route ignores the cache-busting query — status=404`. The mutation was
reverted, the package rebuilt, and the suite re-run green (222 PASS / 0 FAIL).

## Not verified here (left for CI)

- the whole `pnpm verify` chain (it spawns piped child processes, which this
  machine's sandbox denies);
- `scripts/compatibility.test.mjs` (same limitation) and the real-host matrix
  `scripts/harness-runtime-verify.mjs` (needs a host cohort and credentials).

## Deployment record

| Item | Value |
| --- | --- |
| Artifact | `dsh-agent-teams-0.1.22.tgz`, 2 240 640 bytes |
| SHA-256 | `5AB07C2E3DEBF0C9946479434955CCEE21AF9C82203C8461FA33304D4D0838EE` |
| Profile | `web` (`dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.22.tgz`) |
| Installed check | version 0.1.22, `lib/client.js`, `lib/index.js`, `lib/artwork.js`, `lib/client/artwork.js`, `lib/client/art-revision.js` byte-identical to the source build, `ART_REVISION = 5a90736f927c`, `member-engineer-v2.png` 39 838 bytes (amber pack), panel bundle carries `compactSymbol`/`ownerSymbolUrl` and no `badgeDot`, `dsh --profile web --dump-config` resolves `id: agent-teams` |
| Reinstall note | re-adding the *same* `file:` spec makes pnpm skip resolution (`Lockfile is up to date`), so the package is removed first; the `dsh.profile.bundles` order is restored afterwards to `dsh-base, dsh-web-app, @nanmicoder/dsh-agent-teams, dsh-agent-status-bar` |
| Restart | the host loads the plugin only on restart; the browser then requests the revisioned URLs, so no cache clearing is needed |
| Rollback | `dsh plugin --profile web add --save-exact file:D:/OwlCats/AI_Tools/dsh-agent-teams-0.1.21.tgz`, and restore `pnpm-workspace.yaml.bak-2026-09-20-pre-0.1.22` / `package.json.bak-2026-09-20-pre-0.1.22` / `pnpm-lock.yaml.bak-2026-09-20-pre-0.1.22` in the profile |

The artifact was rebuilt twice before the first restart — the earlier digests
(`6A6524EB…381F`, then `4DF0EC6E…33C3`) never ran in a host.

Publication to the registry is a separate, maintainer-approved step; this record
covers the artifact and the profile installation only.
