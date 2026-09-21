# v0.4.1 release record — the progress bar understands phases

A client-only follow-up to 0.4.0, requested by the owner on 2026-09-21. One change: the
overall progress block splits into the plan's phases.

## What shipped

| Change | Where |
| --- | --- |
| The bar is one zone per declared phase when the plan has phases: zone width from the phase's size, fill from **that phase's own percentage** (`percentByKind`/`percentEqual` by the reader's mode), a cycling colour per zone (`--agent-teams-phase`) | `src/client/ActivityPanel.tsx`, `src/client/ActivityPanel.module.css` |
| The team's percentage moved to its own line under the bar (`data-progress-overall`) | `src/client/ActivityPanel.tsx` |
| A phase legend naming every phase with its percentage and counts (`progress.phase.legend`, tooltip `progress.phase.title`) | `src/client/locales.ts`, `src/client/ActivityPanel.tsx` |
| A plan without declared phases keeps the three-colour origin split from 0.4.0 | `src/client/ActivityPanel.tsx` |

## Check

`the progress bar splits into one zone per declared phase, each with its own percent` — the
split attribute, the per-zone phase id, the width and fill expressions, the legend, the
overall line, the palette rule and both locale keys, plus the assertion that the percentage
comes from the host payload rather than a client estimate. The 0.4.0 origin checks stay
green, so both modes are pinned.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **316 PASS / 0 FAIL** |
| lifecycle behaviour | `node scripts/lifecycle-verify.mjs` | 161 PASS / 0 FAIL (unchanged by a client-only change) |
| full chain | `pnpm verify` | exit 0 |
| visual check | `.local/preview-phases-bar.mjs` | `.local/logs/ui-phases-bar/phases-bar.png` — four zones (100 %, 62 %, 33 %, empty), `58% · 18/36` on its own line, the phase legend under it |

## Artifact and deployment

| Item | Value |
| --- | --- |
| Artifact | `.local/dist/nanmicoder-dsh-agent-teams-0.4.1.tgz` — 2 337 862 bytes |
| SHA-256 | `72968dc7b089c4c9f0c00a69a8ce3c7c83894e24c928a903e113589da111257b` |
| Staged copy | `D:\OwlCats\AI_Tools\dsh-agent-teams-0.4.1.tgz` for the profile install |
| Rollout | pending the owner's go-ahead; the live profile carries 0.4.0, installed from the 0.4.0 tarball |
| Rollback target | the 0.4.0 tarball, still on disk |
| Owner action at rollout | install with `--save-exact file:…0.4.1.tgz`, then refresh the page (a client-only change needs no restart, but a restart is harmless) |
