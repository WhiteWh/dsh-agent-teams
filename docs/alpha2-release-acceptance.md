# Alpha.2 release acceptance record

> Release policy updated: the same Alpha.2 adapter code shipped as **0.1.15** on **latest**, while users of older hosts pin a compatible older version.
> That change did not touch runtime code. The record below keeps the originally tested version, the real API/UI process and its evidence; the historical test version is not rewritten as the new one.

0.1.15 supplementary verification: the frozen-lockfile install, typecheck, build, the full `pnpm verify` and packaging were repeated, and the package was really installed with the Alpha.2 CLI. The new package's 67 runtime and asset files are byte-identical to the previously tested local Alpha package; the release metadata is `dist_tag=latest`, `prerelease=false`. The full real-API business run was not repeated this time.

Date: 2026-08-31. Target plugin: **0.1.15-alpha.1**; host: `@deepseek-ai/dsh@0.1.2-alpha.2`; macOS arm64, Node.js 26.7.0, pnpm 10.33.0. Compatibility-fix commit: `bf50b49`. The business acceptance first used a local tarball built from that commit; the final release package was built, installed and cold-started separately, and release preparation did not change the plugin's runtime code.

## Environment and method

- A temporary DSH_HOME and a separate Web profile were used, with the host working directory `/tmp` and no other workspace selected.
- The model was the real `deepseek-official/deepseek-v4-flash` API with thinking disabled and `maxTokens=8192` for the business tests; no model stub replaced the business run.
- Test credentials were consumed only by the host credential service and never entered the repository, a screenshot, a report or the release package.
- The input was 10 synthetic orders covering paid, cancelled, refunded and partially_refunded — not customer production data.
- Every interactive UI check was performed by the acceptance operator through Ego Browser on a real Chromium page, including clicks, chat, edits, screenshots and DOM layout measurement.
- JSON expectations were computed independently by the operator before the model was called; afterwards the files, team state and input SHA-256 were checked directly, so a model's self-reported success was never the basis.

## Real business delivery

Team `release-business-0831`: analyst → builder → reviewer, three `work` tasks with ordered dependencies. Before human review every member id was empty and every task pending; the three real child sessions were created only after the approval click.

| Artifact | Actual result |
| --- | --- |
| `/tmp/dsh-agent-teams-release-0831-summary.json` | the 8 specified top-level keys, three channels, amounts as integer cents — equal to the independent expectations item by item. |
| `/tmp/dsh-agent-teams-release-0831-report.html` | an offline Chinese HTML report with a net-revenue card, per-channel order counts and a totals row, plus the refund and cancellation rules; no external links or scripts. |
| `/tmp/dsh-agent-teams-release-0831-review.md` | the reviewer re-read the specified files and recomputed, recording the problems, the fixes and the re-check conclusion. |

Of the 10 orders, 1 cancelled order was excluded and 9 counted: gross=93490, discount=6990, refund=21500, net=65000 cents (**¥650.00**). Per-channel net revenue was web=23000, app=22000, partner=20000 cents, with 4, 3 and 2 counted orders respectively. All three tasks ended completed, all three members went idle, and the input CSV was not modified.

Independent SHA-256 re-checks:

| File | SHA-256 |
| --- | --- |
| input CSV | `c7bd433930f94309695d58aa8f42586a447b561f3fff945f4a0059478f262441` |
| summary JSON | `06bc56310a2331993969fedfef234de84d6e83920f0e4d1fb604294166630b4b` |
| corrected HTML | `401d4cdec13543a5a173edec336f5077b80bae933126b17f8376e820fa5142ac` |

### Model deviations and human corrections

This was not an unattended fully automatic success:

1. The analyst's first draft went to `/tmp/summary.json` with a field structure that did not match the agreement. The operator raised it with the captain through normal chat; the captain woke the analyst with a team message, which corrected the path and the schema. The operator did not write the final artifact.
2. The reviewer repeatedly tried to start a browser inside its restricted environment and install dependencies, without success, and produced an auxiliary script for it. The operator clicked "stop generating", then added the constraint to stop the browser attempts and complete the data re-check honestly. The real UI acceptance was performed separately by the operator through Ego Browser; the reviewer's static analysis was never treated as a browser test.
3. The HTML prose still carried the old field name `net_income_cents`. After a human flagged it, the reviewer contacted the builder, which changed it to `net_cents`, and the reviewer re-ran and confirmed zero remaining occurrences with unchanged amounts.

The task descriptions contained the agreed paths; these were model execution deviations that a dependency upgrade alone cannot guarantee to remove. This round did verify message delivery, member continuation and a real correction once a deviation was found, and it also shows that real business work still needs artifact acceptance.
A text constraint in a `work` task is not a file-write sandbox and must not be treated as mandatory access control.

## Real UI acceptance

| Human action | Observation |
| --- | --- |
| Typed `/agent-teams` to create the business plan | the conversation card, the members, the three tasks and the two dependencies were visible; no child member executed before approval. |
| "Return to chat and revise", adding the card, the totals row and a mobile-width requirement | the same plan was edited, keeping three members and three tasks; no second team was created. |
| Opened the member model selection | it used the host's real model catalog, showing Flash / Pro / Flash Vision Exp and reasoning options. |
| Set t2's dependency to itself and saved | a self-dependency error appeared and the on-disk plan was not polluted; correcting it to t1 saved successfully. |
| Saved a task title, then "Confirm and run the team" | the edit persisted, members really started, and the dependencies advanced t1 → t2 → t3. |
| Float/dock, collapse/reopen the panel, select a DAG task | every control worked and the task detail and progress were readable. |
| Entered a child session from the member card, then returned to the captain | the member's actual tool calls and artifacts were inspectable; the captain session was not lost. |
| Member "stop generating" and the following chat | the running tool call was interrupted, and later captain messages and human instructions continued to be handled. |
| "Stop team" dialog, chose to keep running | the dialog closed, the task kept running, and nothing was cancelled by mistake. |
| Hard-refreshed the browser and reopened the activity panel | the team, members, DAG, edited title and completion progress all recovered. |
| Switched the host between Chinese and English and between light and dark | the plugin's status text, buttons and accessibility names followed; the screenshots stayed readable. |
| Panel at a 390px viewport | the panel sat at x=12..378 with a width of 366px, and the controls and member list stayed usable. |
| HTML report at desktop and at a 390px viewport | the amounts and tables were correct; on the phone `innerWidth=390` and `documentElement.scrollWidth=390`, and each table scrolled inside its container. |
| Created a second team `release-cancel-0831` and chose "discard this plan" | the archive view marked it as not created / not executed; on disk the archived member ids were empty and the tasks still pending, and the original business team was unaffected. |
| Anonymous requests to state / plan / halt | all returned 401; an authenticated state request from the same browser returned 200. |

No `Runtime.exceptionThrown` event was collected during the observation period. Screenshots and the raw check results live in a local temporary acceptance directory; a full session log containing conversation data was not published.

## Automated checks and boundaries

Before release, the frozen-lockfile install, typecheck, build, the full `pnpm verify`, pack and a real plugin install were run. The full check includes the authentication and lifecycle regression against a real Alpha.2 Connection + HTTP, plus the release-channel protection tests. GitHub Actions uses Node.js 24 to rebuild, check and publish on Linux.

The final local release package `nanmicoder-dsh-agent-teams-0.1.15-alpha.1.tgz` has 67 runtime and asset files byte-identical to the business-test package. The final package was installed into the Web profile with the Alpha.2 CLI, confirming version 0.1.15-alpha.1 and 50 post-install lib files matching the tarball. After a cold start, opening the historic business session restored the activity panel with 3 members, 3/3 completed and the DAG, and the authenticated state endpoint returned 200.

Local tarball SHA-256: `c892ec02e64cd0b4fabb9c4eba263eeca483cab19f75cfd555e464e7fa469971`. CI rebuilds and publishes on Linux, so this local tarball hash is not the npm package's registry integrity.

The Docker daemon was not running on this machine, so **no Docker runtime verification was performed**. The real business/UI results are limited to the macOS, Alpha.2 and DeepSeek Flash combination described above; no claim is made for Windows, other model providers, every older version or a future Alpha. A Linux CI build check is not equivalent to real API/UI acceptance on Linux.
