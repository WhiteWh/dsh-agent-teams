# Harness compatibility and release-lifecycle remediation plan

Audit date: 2026-09-05. This is an investigation result and an implementation plan, **not an announcement that a compatibility fix has landed or that an npm channel has changed**.

Reviewed: the last 30 real issues (PRs excluded), the 25 open PRs, current remote main, the local Harness source, official npm metadata, the release scripts and the related published packages.

Attachments: [the 30-issue itemised list](./issues.md) · [the 25-PR disposition table](./pull-requests.md) · [Harness release and API investigation](./harness-releases.md) · [PR #130 reproduction record](./pr-130-reproduction.md) · [official plugin npm snapshot](./plugin-npm-snapshot.json).
Supporting evidence: [official Harness npm snapshot](./harness-npm-snapshot.json) · [dependency-resolution experiment for an exact CLI](./dependency-resolution-evidence.json).

2026-09-06 addendum: [community upgrade-skill study](../upgrade-skill-study-2026-09-06/README.md). Nine maintenance skills were adopted; the audit, migration-scan and tarball-acceptance methods are reused first. That toolkit does not cover the core subagent API behind #130, so this plan's project regressions and release-channel gates are still required.

## 1. Recommended decisions

1. **Ordinary users get a host+plugin pair we have accepted.** The plugin's `latest` channel means "recommended for ordinary users" and must not be entered merely because the plugin itself dropped an `-alpha` suffix.
2. **The next main support line targets released Harness `0.1.2-rc.1`.** It is currently the default npm CLI version; the compatible plugin is promoted to our `latest` only after the full acceptance passes. No rc.1 plugin release package has passed this acceptance yet, so availability must not be announced early.
3. **An Alpha development preview must be opted into.** New previews use the plugin's `next` channel with an explicit pre-release version; documentation names exact host and plugin versions and the accepted dependency lock. The historical `alpha` tag is kept but not followed by default installs.
4. **Maintain release lines per host compatibility generation.** Do not patch the old `conversationEvents` and the new `uiConversation` back and forth over one default build; old hosts keep their historical companion version while the new mainline adapts to rc.1.
5. **The acceptance unit is the full dependency closure and the actual profile.** The global CLI, the Desktop embedded core, local source, profile dependencies and frontend packages must be identified separately. `dsh --version` alone does not prove compatibility.
6. **Merge one centralised adapter, handle business defects separately.** The overlapping parts of #119/#124/#130 are reviewed together; task scheduling, Windows timing, memory and authentication each keep their own acceptance item.

Upstream is in a fast-moving pre-release phase, so no promise can be made that the plugin works after an arbitrary future API removal. What can be institutionalised away: development versions reaching the default channel, unintentional mixing, verifying only against mocks, repeatedly patching the same problem in opposite directions, and treating "merged" as "users have the fix".

## 2. Current facts and "what to use now"

### 2.1 Four version dimensions must not be conflated

| Dimension | Real example | Meaning |
| --- | --- | --- |
| Harness core | `@deepseek-ai/dsh@0.1.2-rc.1` | upstream CLI/core release version |
| AgentTeams plugin | `@nanmicoder/dsh-agent-teams@0.1.15` | this repository's own release version, unrelated to the host number |
| npm channel | `latest`, `next`, `alpha` | movable pointers, not proof of compatibility |
| Desktop or source | Desktop product version, Git commit/tag | Desktop has an embedded core; a local checkout may be ahead of or behind npm |

For example `0.1.2-alpha.5` means the 5th Alpha of Harness and must not be abbreviated to plugin `0.1.5`; `rc.1` is still a candidate, not an unsuffixed GA.

### 2.2 Official npm snapshot

| Package/source | Observation | Effect on a default install |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `latest = next = 0.1.2-rc.1`; `alpha = 0.1.2-alpha.5` | an ordinary CLI install currently gets rc.1 |
| `@nanmicoder/dsh-agent-teams` | `latest = 0.1.15`; `alpha = 0.1.15-alpha.1` | the current default plugin package is only explicitly accepted on Alpha.2 |
| local Harness checkout | `d347e70390`, already merged into the `0.1.3-alpha.1` release branch | cannot replace acceptance of the published npm version |
| upstream `0.1.3-alpha.1` | a GitHub release exists; this query found no matching npm version | not a default support target yet |

**Today "host latest + plugin latest" yields rc.1 + 0.1.15, a known-incompatible combination.** #127/#132 report a missing `registerContinuableSetup` at startup and #131 concerns the later message-delivery API. No rc.1 plugin release package has passed this project's acceptance, which is not an exhaustive proof that every historical version is unusable.

Official sub-package tags are inconsistent: as of this query the `latest` of `dsh-base`, `dsh-subagent`, `dsh-session` and `dsh-client-ui-conversation` still points at `0.0.1-rc.1`, while `dsh-client-ui-chat`'s `latest` is `0.1.2-alpha.2`; their `next` points at rc.1. Installing every sub-package `@latest` is not a way to "align" them. Full metadata and source evidence are in the Harness investigation attachment.

### 2.3 Practical guidance today

| User's situation | What to do now | Evidence boundary |
| --- | --- | --- |
| an existing working combination | keep the actual host, the profile lockfile and the exact plugin version; upgrade neither side on its own | prioritise keeping a reproducible environment |
| on `0.1.2-rc.1` | wait for the centrally adapted candidate to be accepted; if the host must be recovered after a startup failure, disable only the incompatible plugin in that profile | must not claim the old plugin `0.1.14` is rc.1-compatible |
| an accepted `0.1.2-alpha.2` environment | may explicitly pin plugin `0.1.15` while keeping the full dependency lock | this repository has historical macOS Web/API acceptance; cross-platform acceptance was not redone |
| Harness `0.1.0-rc.8` | historical documentation pairs it with plugin `0.1.14`; pin exactly | not generalised to "all old RCs" |
| Harness `0.1.1-rc.2` | the maintainer-verified historical pair in #107 is plugin `0.1.10`, installed with `--save-exact` | a historical maintainer verification on macOS, not a full re-test here |
| Desktop or an unknown source version | diagnose the embedded core, the actual loaded path and the profile first | updating the global CLI does not update the Desktop embedded core |

Redirecting every ordinary user to Alpha.2 is not recommended, and pointing the plugin `latest` back at `0.1.14` is not either, because it still does not work with the current default rc.1: an rc.1 companion package must be produced and verified first.

Historical pin command (valid only for the rc.2 combination in the table):

```sh
dsh plugin --profile web add --save-exact @nanmicoder/dsh-agent-teams@0.1.10
```

An exact version string is not a floating range; only `^0.1.10` would allow a higher compatible version. A marketplace or installer rewriting the declaration needs its own investigation and must not be attributed to "a bare version upgrades automatically".

## 3. Root-cause consolidation

| Root cause | Representative issues | Unified handling |
| --- | --- | --- |
| a new plugin needs a new UI service while an old host still provides the old one | #113, #128, part of #107 | old hosts use the historical companion release; identify the actual core before installing and do not revert main to the old API |
| an old plugin needs `conversationEvents` after the host migrated | #104, #100, part of #107 | use the matching new-generation UI build; renaming the awaited service alone does not handle imports, types and bundling |
| the subagent refactor removed the old setup, message delivery and session-prefix APIs | #115, #120, #123, #127, #131, #132; #122 was linked by its author to #131 | migrate the rc.1 lifecycle, delivery, model selection, ownEvents and retirement boundaries centrally |
| release channels and version choices drop users into unsupported combinations | #126, #107, #128 | companion-version list, release gates, exact pinning, pre-install diagnostics |
| business/platform defects | #125, #103, #117, #106, #108 and others | reproduce and fix independently inside the same acceptance matrix; version adaptation is not treated as an automatic fix |

Of the last 30 issues, 21 are open and 9 closed; 14 are mainly version/channel related, 2 report startup symptoms with insufficient evidence, and the rest are 6 business/security/scheduling items, 1 Windows verification question, 5 feature suggestions and 2 under-specified reports. They are not 30 independent version failures. The full itemised table keeps duplicates, closed items, missing environments and genuine business problems; do not batch-mark them "just upgrade" to clean up the count.

The removal of the old subagent setup/message APIs happened in **Alpha.4**, not at rc.1; Alpha.5 and rc.1 continue that refactor. One adapter can therefore be designed centrally, but each host claimed as supported must be verified separately.

## 4. Release-governance gaps

### 4.1 The release channel changed policy within one day

On 2026-08-31 `0865d88` released the Alpha.2 adapter as `0.1.15-alpha.1@alpha`; about half an hour later `da2e2e4` changed it to `0.1.15@latest`, with release notes stating explicitly that the runtime code did not change. The README also states that the default channel follows the adapted developer preview.

The current `scripts/release-metadata.mjs` derives the tag from the **plugin's own** version alone: an `alpha/beta/rc` suffix diverts it, otherwise it uses `latest`. It does not consult the host support list or the actual acceptance, so removing a plugin suffix is enough to promote an Alpha-only build to the default channel.

### 4.2 Declaring installability is not runtime compatibility

The current peer range is `^0.1.2-alpha.2`, marked optional, and the repository sets `strict-peer-dependencies=false`. Measured with node-semver:

| Version | Satisfies `^0.1.2-alpha.2` |
| --- | --- |
| `0.1.2-alpha.2` | yes |
| `0.1.2-alpha.5` | yes |
| `0.1.2-rc.1` | yes |
| `0.1.2` / `0.1.3` | yes |
| `0.1.3-alpha.1` | no |

So a satisfied semver range is not an API guarantee, and the range must not be described as matching every pre-release. Changing the peer to `>=0.1.0` is not a fix either: node-semver does not by default treat `0.1.2-rc.1` as satisfying that range. More importantly, the upstream Alpha.2 CLI and bundles carry similar ranges themselves, so pinning only the CLI package name can still produce a changed dependency closure on re-resolution.

Two `npm install --package-lock-only --ignore-scripts` experiments were run in an isolated directory against the official registry: requesting CLI `0.1.2-alpha.2` exactly produced a lockfile with **208 rc.1 dsh packages and 7 Alpha.2 dsh packages**, with base/agent/subagent/session/web-app already resolved to rc.1; requesting CLI rc.1 exactly produced **214 rc.1 dsh packages**. Re-resolution can therefore mix generations today. This is dependency-resolution evidence only — no install script ran, no host booted, no plugin executed. Other package managers, old lockfiles and overrides need separate checks.

### 4.3 The fix is in main but not yet on npm

The official npm `0.1.15` was published at `2026-08-31T05:23:05Z`. main=`232a338` has 8 commits after the release commit `da2e2e4`, including the empty-field handling of #109 and the failure-reporting improvements of #110. Merging a PR does not justify telling a user that the current `latest` certainly contains the fix.

### 4.4 CI runs only at the release stage

The current `.github/workflows/publish.yml` uses Ubuntu + Node 24 + a single Alpha.2 lockfile and builds/verifies on a tag or a manual publish. As of this query the GitHub checks of all 25 open PRs were empty. The same gate must move to every PR, plus a real host matrix, Windows and packaged-install acceptance.

## 5. Target architecture: a narrow adapter that explicitly rejects unknown combinations

### 5.1 One compatibility list

Add a project-owned `compatibility.json` consumed by the release scripts, the diagnostics tool, the README generator and CI. This is a proposed project protocol, **not** a claim that Harness natively supports such a package.json field.

Each supported combination records at least:

- host source: npm / Desktop embedded / source; the exact core version or commit;
- the actual versions of the key runtime, bundle and browser packages, the necessary integrity information and the lockfile digest;
- plugin version, candidate artifact digest, channel;
- capability contracts for transport, member initialisation, event history, model selection, UI registration and authentication;
- platform/Node version, automation result, real-model and Web acceptance date, known limitations;
- status `verified` / `preview` / `legacy` / `unsupported`, plus the maintenance deadline.

Only explicitly verified combinations are listed. When an older-generation UI cannot safely coexist with a newer artifact, it needs a separate release line/build; an `if` after a failed load cannot repair a static import.

### 5.2 Concentrate version differences in `src/host-compat/`

The business layer uses only project-owned interfaces; the adapter maps versions and capabilities instead of duplicating probes across tools/scheduler/UI:

| Seam | Behaviour that must be preserved |
| --- | --- |
| member creation and cold resume | one model-selection install, fallback and final-failure handling; never a silent no-op when a hook is missing |
| message delivery | distinguish a standalone queue turn from a step-boundary injection while running; preserve the sender/plugin source and the AbortSignal |
| session history | use the member-owned events specified by the target version; never mix in the parent session's inherited prefix |
| model route | provider, model, reasoningEffort and the post-fallback active route are all persisted and restored |
| retirement/stop | cover every message entry point we use and the native follow-up entries; prevent a retired member from reviving while keeping history readable |
| Web mounting | service declaration, static imports, module loader, event registration and UI data shapes as one unit |
| access control | use the actual host authentication service; never let a sensitive route through when that capability is missing |

rc.1's public `sendMessage` and the internal `queueHostSubagentPrompt` have different delivery semantics and must not be treated as a rename of `followup`. If the internal entry point must be used, confine it to a specific adapter with an exact release baseline and real package contract tests; proposing a stable plugin seam upstream is later collaboration and cannot assume control over the upstream API.

### 5.3 Compatibility diagnostics and a safe exit

Add a doctor/preflight entry point that does not depend on the business plugin activating successfully, reporting: install source, actual service process/core, the CLI versus profile distinction, actual module paths/versions, plugin version, key API probes, the matching supported combination and an actionable fix.

Two moments must be covered:

1. **before import and dependency injection**: a missing package, a removed export or a mismatched required service generation; a try/catch inside `apply()` cannot fix an import error or a client injection that stays pending forever.
2. **before activation and business calls**: probe the key capabilities, install every required bridge when compatible, and when incompatible stop the AgentTeams creation/scheduling entry points with a clear diagnostic while keeping user state. When working with the host loader, a third-party plugin failure must not take down the whole Desktop.

Combine version strings with capability checks: a string is not complete proof, and a function merely existing does not prove its signature and semantics are unchanged. The diagnostics package collects only the necessary environment and versions, never credentials or full conversation content.

A standalone doctor does not automatically intercept installs from a marketplace, Desktop or `dsh plugin add`. Preventing mixing before installation requires those entry points to call the preflight, or a controlled install entry point tested by this project; host/marketplace integration is a separate collaboration item. Until then only the diagnostic capability can be guaranteed, and no claim can be made that every default install is protected.

## 6. Default, preview and historical version policy

| Channel/line | Audience | Entry condition | Update principle |
| --- | --- | --- | --- |
| `latest` | ordinary users | targets the explicitly chosen non-Alpha/Canary upstream baseline of the moment; the actual package passed full acceptance; no known critical feature regression | upstream changes enter a candidate first; never automatically follow upstream master |
| `next` | developers trying a new host deliberately | the exact host, pre-release plugin version and defects are stated; basic automation passes | explicit install, may iterate frequently, does not affect default users |
| historical exact version | users constrained by an old Desktop/host | a corresponding historical pair record exists | no automatic upgrade; backports of critical fixes only within the maintenance window |

rc.1 may become the recommended baseline for ordinary users after sufficient acceptance, while the documentation still states that it is an upstream release candidate. "There is no GA" must not be interpreted as "stay on an old version forever", and the name of an ordinary-user channel must not disguise actual maturity.

To bound maintenance cost: maintain one current recommended host generation long-term; after switching generations keep the previous supported line for a **30-day migration window** with backports limited to run-blocking, data-integrity and critical security fixes; a preview verifies only the named snapshot. The 30 days is a proposed policy, not yet a public commitment, and does not promise support for every historical Alpha.

To avoid adding four or five more near-synonymous channels, future previews use `next` uniformly; the plugin may still carry `-alpha.N`/`-rc.N` to express maturity, and the release script decides from an explicit channel plus the compatibility list instead of hard-binding suffix to npm tag. The historical `alpha` tag is neither deleted nor silently reinterpreted.

When the host minimum baseline or a core API breaks compatibility, use a new plugin minor line during 0.x. A candidate can be planned as `0.2.0-rc.1@next` and, after acceptance, `0.2.0@latest`; these are version examples to implement, **not yet released**. Changing from a pre-release number to a final one regenerates the tarball, so the final `0.2.0` package must be re-verified; an old candidate's digest cannot vouch for the final package. The release flow should upload the already-accepted tarball directly and check the registry integrity. Alternatively the final unsuffixed package can enter `next` for the last acceptance and then be promoted to `latest` on the same artifact, with no repack.

The release gate must reject at least:

- a plugin supporting only Alpha/Canary requesting `latest`;
- an acceptance record whose digest does not match the actual artifact;
- the compatibility list disagreeing with package peers, the README or the packaged artifact declarations;
- a critical lifecycle capability degraded to a no-op while full compatibility is claimed;
- a release pointer for the current `latest` line being unexpectedly overwritten by an older line's workflow.

Existing packages are not deleted, the same version is not republished, and no user profile is force-changed. Moving an npm tag cannot change an already installed version or lockfile, so a channel correction needs migration documentation and candidate acceptance.

## 7. Verification and merge standards

### 7.1 Three test layers

1. **business unit/integration layer**: task capability, attempt, concurrent claim, staged approval, terminal-state immutability, mailbox lease/ack, scheduling limits and interruption recovery.
2. **real release-package contract layer**: load the real Cordis/SubagentRuntime/Session/Connection and verify the received objects, arguments, event ordering and cold resume; a mock may replace only the LLM or external IO, never the host interfaces under test.
3. **artifact acceptance in a clean profile**: install the produced tarball with the specified host dependency closure and complete Web/headless startup, two members, a message round trip, a dependent task, failure reporting, fallback, stop, retirement and restart recovery. Verify the installed package, not just the source directory.

Planned requirements: the current main supported combination runs automation on Linux and Windows Node 24, with packaging and Web acceptance on macOS; Desktop is a separate surface, and only an actually accepted embedded core is listed as supported. Adding Node 22.19+ or more versions needs corresponding records and must not be inferred from the `engines` string. These are a matrix to implement, not a claim of completed tests.

Upgrade and downgrade are verified separately: old state is retained, unknown fields/schemas carry a version marker, and an unsupported downgrade is detected first so user team/session data is never overwritten. The illegal empty fields #105 already wrote to disk cannot be assumed fixed by new input validation; provide a targeted flow that inspects, backs up and previews changes before repairing, and verifies recoverability. A retired member must not be re-woken by a new native entry point while its historical transcript stays openable.

### 7.2 PR gates

- Every PR declares its target host line, the affected compatibility-list rows, whether it adds an internal API and whether it changes data or message semantics.
- Checks trigger on `pull_request`; the final merged code re-runs the affected matrix instead of reusing per-branch passes.
- A PR fixing a host difference first adds a contract case that fails on the original code, then verifies the compatible version; a version-independent business fix must not smuggle in a downgrade of every dependency.
- CI becomes a hard merge gate only after the maintainer configures required checks; adding a workflow does not enable branch protection.
- One manual success from editing a local `lib/` is not artifact acceptance for the whole PR.

## 8. Converging the current PRs

| PR group | Recommendation | Reason and what must be completed |
| --- | --- | --- |
| #119 / #124 / #130 | merge into one rc.1 migration PR with contributor provenance preserved | #124's synchronised session-start/ownEvents approach is the most complete; fix its internal static-import baseline, retirement message entries, install configuration and docs; #119/#130 each lose `this` on some path and #130 also has a no-op regression |
| #112 / #93 | do not merge the opposite UI API changes into main one after the other | #112 would revert to the old service; #93's main migration is already done by main, so take the remaining valuable docs/assertions |
| #90 | take it in first as an independent Windows verification | a small fix to the build-path check that helps establish a cross-platform baseline |
| #86 / #74 | put into the recovery/rate-limit regression work package | correct the description against the current diff and verify the parked attempt, cold resume, final error and bounded retry |
| #118 | split first, do not merge whole | the UI PR carries a postinstall whose target script is not in the npm `files` allowlist; auto-linking local host dependencies also breaks reproducibility |
| #48 | do not merge whole | it actually loosens a nonexistent dependency id, can stay pending forever, and conflicts with the current staged-approval semantics |
| #82 / #83 / #84 and similar display tweaks | normal iteration once the baseline is stable | they overlap the #118 panel refactor, so accept them together to avoid overwrites |
| avatars, history cleanup, sidebar, personas | separate product iterations | outside the minimal scope of this compatibility fix; state deletion and history migration need separate review |

Only key dispositions are summarised here. Baselines, current real diffs, risk and suggested order for all 25 PRs are in the [full PR table](./pull-requests.md). Deferred, superseded and partially adopted PRs must be communicated to their contributors according to the actual outcome and were not closed during this investigation.

## 9. Implementation order and completion conditions

| Order | Work package | Concrete output | Completion condition |
| --- | --- | --- | --- |
| P0-A | stop the bleeding in install and release | the main compatibility list, a README version-selection table, exact pinning, an explicit statement that rc.1 is currently unusable, and the known historical pairs | the default documentation no longer lures users into following any `latest` on its own; current state and target state are separated |
| P0-B | dependency closure and PR/release gates | a rebuildable host/profile lock, the CI matrix, failing contract cases, compatibility-list validation, artifact acceptance and the promotion flow; includes #90 | the same version choice yields the same dependency closure; the key breakpoints reproduce reliably before the fix; every PR and the final merge must pass |
| P0-C | unified rc.1 adapter | integrate the reusable parts of #124, the delivery-bridge experience of #130 and the necessary corrections, handling messages/lifecycle/ownEvents/UI/auth | the real rc.1 package passes the key business and cold-resume checks, and the reproduced #130 regression is covered by tests |
| P0-D | early diagnostics and install protection | doctor, an explicit exit on a version mismatch; a separate controlled install entry point plus host/marketplace integration | a mismatch carries locating information; interception is promised only for install entry points wired to the preflight; unknown combinations are never pretended to be supported |
| P1-A | candidate distribution and final promotion | the `next` candidate, per-platform evidence, the actual migration notes, the final ordinary-user release package | `latest` changes only after acceptance; registry/profile are re-checked after installing |
| P1-B | converging issues/PRs | fill the disposition table against the actual fixed version, record duplicate issue references, keep independent business defects | every bug closed as fixed points at an installable fixed version and its host; duplicates, withdrawals and upstream fixes are closed for their real reason |

Do not claim rc.1 compatibility publicly before the parts of P0-B to P0-D this project controls are done; entry points not yet wired to host/marketplace collaboration get their limitation stated separately. Finishing only the P0-A documentation revision is not enough. Split the work into a few clearly bounded PRs and integrate them in order, rather than one unreviewable patch.

GitHub communication and npm releases target a concrete accepted artifact. This investigation published no package, moved no dist-tag, merged/closed no PR, closed no issue and upgraded no user's host.

## 10. Issue completion states must be distinguished

Track `needs-environment` → `reproduced` → `fixed-in-main` → `verified-in-release`, recording reporter confirmation where useful. When an implementation is merged but unpublished, give the expected version instead of only replying "upgrade latest".

The bug template collects the actual host core, the Desktop version or source commit, how it runs, the profile, the resolved key package versions, the plugin version/source, OS/arch/Node, the full redacted error and minimal steps. A missing-service report for an old or new UI must record the exact service name; `conversationEvents` and `uiConversation` represent opposite directions.

Cross-source information uses these evidence levels: reproduced here, historical maintainer acceptance, user report, static source judgement, to be confirmed. Duplicate issues may be consolidated by root cause, but items verified in an independent environment stay separate. The itemised dispositions are in the attachments.

## 11. Verification boundary and sources for this audit

Completed here: the GitHub issue/PR and comment investigation, verification against official npm/published packages/upstream source, the audit of the existing release policy, two full dependency-resolution experiments for an exact CLI, and an isolated re-test of #130. #130's original Alpha.2 typecheck/build/verify all passed; a targeted test against the real Alpha.2 Service reproduced the lost `this`; switching to the rc.1 API shape made 3 of the original lifecycle test's teardown assertions fail. That is not a full rc.1 on-device acceptance.

Main sources:

- [default-channel request #126](https://github.com/NanmiCoder/dsh-agent-teams/issues/126)
- [bidirectional version mismatch and exact pinning #107](https://github.com/NanmiCoder/dsh-agent-teams/issues/107)
- [old-host UI service mismatch #113](https://github.com/NanmiCoder/dsh-agent-teams/issues/113)
- [Alpha.5 missing lifecycle API #120](https://github.com/NanmiCoder/dsh-agent-teams/issues/120)
- [detailed migration leads #123](https://github.com/NanmiCoder/dsh-agent-teams/issues/123)
- [rc.1 startup problem #127](https://github.com/NanmiCoder/dsh-agent-teams/issues/127)
- [rc.1 still failing to start with several plugin versions #132](https://github.com/NanmiCoder/dsh-agent-teams/issues/132)
- [release-policy change da2e2e4](https://github.com/NanmiCoder/dsh-agent-teams/commit/da2e2e49242c6ecd7e801a74dba0c8268a0a2f81)
- [upstream rc.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)
- [npm dist-tag mechanics](https://docs.npmjs.com/adding-dist-tags-to-packages/)
- [node-semver pre-release range rules](https://github.com/npm/node-semver#prerelease-tags)

The detailed issue list, PR disposition table, Harness release investigation and #130 reproduction record are in the attachments in this directory. The maintenance window, directory layout, channels and candidate version numbers here are a proposed plan and are not yet an effective product configuration.
