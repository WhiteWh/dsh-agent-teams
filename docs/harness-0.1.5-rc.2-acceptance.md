# AgentTeams acceptance on DeepSeek Harness 0.1.5-rc.2

Date: 2026-09-18. Conclusion: **AgentTeams 0.1.20 works on Harness 0.1.5-rc.2 in a real run**; `0.1.5-rc.2` should join the support matrix (that PR adds it on the `preview` track).

## Host delta assessment

The official [dsh-v0.1.5-rc.2 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2) show only two UI-experience changes from rc.1 to rc.2 (the feedback-submission dialog and the layout of delivered-file cards), with no runtime contract change for subagents, sessions or tool registration. Full diff:
https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.5-rc.1...dsh-v0.1.5-rc.2

## Evidence (real runs, not static inference)

Environment: macOS (darwin-arm64), `@deepseek-ai/dsh@0.1.5-rc.2` (global npm install, `dsh web` mode), `@nanmicoder/dsh-agent-teams@0.1.20` (pnpm-installed into the web profile).

1. **Member spawn recovery**: on 0.1.18 every member failed to spawn on this host (`unspawned`, attempts spinning, the error only reaching `logger.warn` — issues #164/#166). After upgrading to 0.1.20, which contains the #167/#172 fixes, and restarting the host, all 3 members of the same team spawned and reached `working`.
2. **Task dispatch and claiming**: the full `pending → claimed → in_progress → completed` chain was exercised; two research tasks (kind `work`) were claimed and completed by members, and an `attempt_id` update was accepted correctly.
3. **Mailbox and wake-up**: a captain → member message was delivered in `wake` mode and started a new member turn; a member → captain report was delivered normally.
4. **Static checks**: `node scripts/doctor.mjs --host-root <dsh 0.1.5-rc.2 install dir>` passed (231 DSH package identities and dependency checks); `node scripts/compatibility.mjs && node --test scripts/compatibility.test.mjs` passed.

## Scope statement

- This acceptance covers team creation under the web profile (`approval=required`), member spawn, task dispatch/claim/completion and mailbox wake-up. It does **not** cover cold resume, shutdown recovery, HMR reload or several teams running at once.
- `0.1.5-rc.1` remains the recommended host (`recommendedHost` unchanged); rc.2 joins on the `preview` track, and promoting it to recommended is the maintainer's decision.
