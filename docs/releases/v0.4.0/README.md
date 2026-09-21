# v0.4.0 release record — the plan's own vocabulary, and the Φ1 defects

Nine defects from the dx9 `Φ1` run (183 tasks, 11 members) and the material-layers report
before it, plus the plan-vocabulary work the owner asked for. **Built and packed, not yet
rolled out**: the artifact waits for the owner's go-ahead to be installed.

## What shipped

| Change | Where |
| --- | --- |
| `create_task` declares an undeclared phase on a running team (`phase_title`), and reports `phase`/`phase_created`; a staged plan stays strict | `src/tools.ts`, `src/state.ts` |
| `label` — the plan's own human id — on `TeamTask`, accepted by `create_task` and a replan `add_task`, shown beside `tN` in the board, the checklist and the report | `src/types.ts`, `src/state.ts`, `src/tools.ts`, `src/replan.ts`, `src/snapshot.ts`, `src/client/*` |
| `verifiedTaskIds()` — a passing review/verification marks its lane; published in the snapshot and the status payload, counted per phase | `src/quality-gates.ts`, `src/snapshot.ts`, `src/tools.ts`, `src/client/*` |
| Per-phase roll-up (`running`/`blocked`/`failed`/`cancelled`/`superseded`/`waived`/`verified`/`closed`) in the report's `Phases (…)` section and the board's column header | `src/progress.ts`, `src/tools.ts`, `src/client/*` |
| F1: the whole-plan validation skips settled tasks; `retry` refuses without an active owner | `src/state.ts`, `src/replan.ts` |
| F3: `requeueMemberTasks` returns only live work, driven by `requeueableOnRemoval` | `src/state.ts`, `src/types.ts`, `src/tools.ts` |
| item 2: the dispatch cap counts held work (`workingMemberNames`), not the recorded member status | `src/scheduler.ts` |
| F6: bounded status report (`live`/`task_id`/`since`/`include_output`), selection in a pure module | `src/status.ts`, `src/tools.ts` |
| F2: `update_task {release:true}` clears a stale handoff marker; the invalidate branch no longer sets one when the owner is gone | `src/replan.ts`, `src/tools.ts` |
| F4: the replaced task counts as serialized for the duration of a `supersede_task` call; the refusal names retryability when a failed lane holds paths | `src/quality-gates.ts` |
| F4b: `pathMatchesScope` expands `**`, `*` and `?` | `src/quality-gates.ts` |
| F5: `REVIEWABLE_TASK_KINDS` includes `work` | `src/quality-gates.ts` |
| F4c: `taskPlanning.sharedInScope` documented as the answer to the shared-page convention | `docs/quality-gates.md` |

## Checks added (all RED-first)

F1 (4), F3 (2), dispatch cap (3: two lifecycle checks + a unit check), F6 (4), F7.1 (2 + a
lifecycle check), F7.2–F7.4 (5), F2 (3), F5 (2), F4 (3), F4b (2). Suite totals at the last
run: `verify.mjs` **315 PASS / 0 FAIL**, `lifecycle-verify` **161 PASS / 0 FAIL**.

## Verification on the release machine (Windows, Node 24.15.0, pnpm 10.33.0)

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | exit 0 |
| build + revision gate | `pnpm build` | exit 0 |
| offline suite | `node scripts/verify.mjs` | **315 PASS / 0 FAIL** |
| lifecycle behaviour | `node scripts/lifecycle-verify.mjs` | **161 PASS / 0 FAIL** |
| full chain | `pnpm verify` | **exit 0** (every suite, including `quality-gates-tdd` with `quality-gates-amend.test.mjs` re-pointed for F5: a review may judge a `work` lane, a `requirements` target is still refused by name) |
| field measurements | `.local/diagnose-layout-depth.mjs`, the cap-fence scenario | 48-task layered phase 7 477 ms → 0.4 ms; stale-cap dispatch `spawns=0 status=pending` → `spawns=1 status=claimed`; status report 64 432 → 1 518 chars |

## Artifact and deployment

| Item | Value |
| --- | --- |
| Artifact | `.local/dist/nanmicoder-dsh-agent-teams-0.4.0.tgz` — 2 335 026 bytes |
| SHA-256 | `0d5e04b369a0c3cc76b235e5c6c34d49d6771eea08695b559167d7d7a76e546c` |
| Staged copy | `D:\OwlCats\AI_Tools\dsh-agent-teams-0.4.0.tgz` for the profile install |
| Rollout | **not installed** — the owner rolls it out later; the live profile still carries 0.3.0 and was not touched |
| Rollback target | the 0.3.0 tarball, still on disk |
| Owner action at rollout | install with `--save-exact file:…0.4.0.tgz`, restart Harness, open the fresh `?token=` URL it prints |

## Not done (declared, with reasons)

- **F6b** — a member turn can die on its own session event ("`turn/end` carries
  non-JSON-serializable data"). The failing pipeline is the host's session events; my own
  payloads have not yet been audited for serialisability, which is the next step I would take.
- **`compatibility.test.mjs` in isolation and the real-host matrix** — left for CI, as before.
