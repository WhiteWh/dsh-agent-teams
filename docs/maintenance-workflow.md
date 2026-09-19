# AgentTeams maintenance and release workflow

This workflow applies community skills to real repository maintenance: record the problem and the exact version, review the contribution, implement and verify, then publish the very same accepted artifact. Read [skills/README.md](../skills/README.md) first; historical version examples in the upstream skills do not override this project's policy, and work the user has already authorised is not confirmed twice.

## One support list

[compatibility.json](../compatibility.json) is the only source for the host matrix. `scripts/compatibility.mjs` validates the exact development dependencies, the declared peer targets and the dependency-override policy, and emits the CI matrix through `--github-output`. Do not maintain a second version array in another script.

| Current candidate host | Role | Install and support boundary |
| --- | --- | --- |
| `0.1.5-rc.1` | recommended | the acceptance target for the default combination ordinary users have today; an RC is not GA and still has to be verified in practice |
| `0.1.2-rc.1` | legacy | retaining the older RC; use a profile and session copies isolated from the newer line |
| `0.1.2-alpha.5` | preview | an actively chosen preview host; plugin defaults must not move ordinary users onto Alpha |
| `0.1.2-alpha.2` | legacy | a compatibility target; the whole dependency closure must be checked, because pinning the CLI alone can still mix in rc.1 subpackages |

This is the matrix the current candidate code must pass; it does not mean the matching candidate npm version has been released. When a target is added or removed, adjust the list, the development/peer dependencies and any adapters together, review the resolved lockfile, and run the whole matrix. An unknown future version does not gain support merely because semver falls inside a wide range.

The old `0.1.0-*` and `0.1.1-*` hosts are not in this candidate matrix. Keep their exact working plugin version, or migrate both ends to an accepted host/plugin pair; never update only one end. Historically the exact install of `0.1.1-rc.2` with plugin `0.1.10` was verified by the maintainer and may be used on that old host:

```sh
dsh plugin --profile web add --save-exact @nanmicoder/dsh-agent-teams@0.1.10
```

That is a recovery reference for an old combination, not a support promise for every old RC or for the current Desktop. Desktop users must also check the embedded core and the actual profile; installing a new global CLI does not replace the desktop core, and changing an npm dist-tag neither revokes a wide dependency range in an existing profile nor uninstalls a package.

## From report to implementation

1. Record the chosen maintenance stage with `plugin-workflow`; establish the actually loaded path, profile and failing service with `plugin-runtime-debug`. Keep the unmodified error and a minimal reproduction.
2. For a version migration, use the `plugin-upgrade` scan and the exact official source/artifact comparison from `dsh-upgrade-audit`. Check the lifecycle, messages, events and sessions, models, client, auth and release dependencies; a version-pin miss count of zero does not mean there is no risk.
3. Review against the current PR head; do not substitute titles, old test records or GitHub's conflict-free status for evidence. Verify independent contributions separately; unify overlapping lifecycle fixes at the adapter boundary and link the adopted code and cases back to the contributor's PR.
4. Use `plugin-test` to pick the relevant tests. A missing core capability must produce a clear diagnostic; failure reporting, model selection or delivery must never be silently turned into a no-op. Input validation, staged approval and permission restrictions that were fixed must stay fixed.
5. Preserve each author's attribution; when rewriting or synthesising a patch, record the original PR and the corresponding contribution, and use `Co-authored-by` where applicable. Explain specifically why a part was not adopted and what comes next, instead of closing it as a blanket "incompatible".

A read-only installation diagnostic can run from source or from a published package:

```sh
node scripts/doctor.mjs \
  --host-root "/actual/path/to/the/running/dsh/package" \
  --profile-root "/actual/path/to/the/profile" \
  --json
```

The doctor checks the package versions, mixing and duplicate identities resolved from the given paths; it does not execute the plugin, does not change configuration, and cannot prove by itself that those paths are the running process. A successful result is not proof of a model, UI or task outcome.

## Changing the activity-panel artwork

The panel's images live in `assets/agent-teams/`: thirty 256×256 8-bit RGBA PNGs — nine mascots (`*-v2.png`), nine role symbols and six action symbols (`*-symbol.png`), plus the action mascots. Replace a file with the 256 px export, never the 64 px one: `scripts/verify.mjs` asserts the header of every packaged image.

The file names are deliberately stable across packs, so a redraw does **not** change any URL. Without a revision, a browser that already holds the previous bytes keeps drawing them for the whole `cache-control` lifetime (a day) and a freshly deployed panel looks unchanged — that is exactly how the whale pack survived the move to the amber pack in a live profile. The client therefore appends `?v=<revision>` to every artwork URL, and the revision is a hash of the packaged bytes:

```sh
node scripts/art-revision.mjs            # print the pack and committed revisions
pnpm art:revision                        # regenerate src/client/art-revision.ts
```

Both `pnpm build` and `scripts/verify.mjs` re-derive that value and fail with `artwork revision is stale: committed …, pack …`, so swapping an icon without regenerating the revision cannot ship. The host route (`src/artwork.ts`) reads the URL *path* only — the `?v=` query is never part of the file name — and serves allowlisted names exclusively, which keeps an unknown name or a traversal attempt a plain 404.

## Install from source and test Alpha

Build the one artifact to be accepted inside the plugin checkout:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm verify
pnpm pack --out ./agent-teams-candidate.tgz
```

Prepare a separate test profile with a Web entry point configured (`agent-teams-preview` below), check the actual host and install:

```sh
node scripts/doctor.mjs --host-root "/actual/host/package/directory" --json
dsh plugin --profile agent-teams-preview add --save-exact /absolute/path/agent-teams-candidate.tgz
node scripts/doctor.mjs --host-root "/actual/host/package/directory" --profile-root "/actual/test/profile/directory" --json
dsh --profile agent-teams-preview --dump-config
dsh --profile agent-teams-preview
```

After a source change you must rebuild, repack and restart. A passing `doctor` does not replace acceptance of team creation, tasks and the UI.

Alpha testing must pin the whole host dependency group; `^0.1.2-alpha.2` does not mean only Alpha.2 is accepted, because transitive dependencies of an exact CLI version can still resolve to rc.1. This repository uses exact development dependencies, a full set of `pnpm.overrides`, and a frozen lockfile. The command below creates an isolated temporary install, profile and workspace, installs the same tgz and checks the resolved result:

```sh
node scripts/harness-runtime-verify.mjs \
  --host-version 0.1.2-alpha.2 \
  --artifact ./agent-teams-candidate.tgz \
  --report-dir /tmp/agent-teams-alpha2-check
```

That command downloads the host and uses fixed model responses with the real CLI, plugin, sessions, tools and subagents, without touching an existing user profile. Keep the verified lockfile across upgrades; do not handle a version mismatch by deleting credentials or `.agent-teams`.

The historical `0.1.0-rc.8` + plugin `0.1.14` combination requires pinning both ends. The historical [Alpha.2 compatibility record](./alpha2-compatibility.md) and [acceptance report](./alpha2-release-acceptance.md) describe only those versions and do not cover the current list.

## Checkable evidence from CI

[verify.yml](../.github/workflows/verify.yml) is a reusable workflow used for PRs, main and pre-release:

| Stage | What is actually checked | Evidence left behind |
| --- | --- | --- |
| Ubuntu / Windows static checks | Node 24, pnpm 10.33.0, frozen lockfile, typecheck, build, verify | each platform's job log |
| Ubuntu packaging | `pnpm pack --out` produces a real tgz, exactly one candidate | the `agent-teams-candidate` artifact and the file SHA-256 |
| Three-version real host | a matrix generated from the list; each exact host installs the same tgz, checks the closure and runs the product entry point | per-host `result.json`, closure manifest, fixture traces and stdout/stderr |
| Summary gate | every job succeeded; each report's host, plugin version, digest and candidate match | `Complete compatibility gate` |

The runner is `scripts/harness-runtime-verify.mjs --host-version <exact> --artifact <tgz> --report-dir <directory>`. The model adapter uses a repeatable fixture while the host CLI, profile, plugin, tools, subagents and sessions are real. By default it runs six segments: a normal lifecycle, lifecycle cold resume, fallback, fallback cold resume, a final failure, and a captain that actually ends its turn and goes idle before being woken by a member notification. The test also checks member execution, busy/idle messages, ordering and reasoning effort; changing those capabilities requires adding a scenario that turns red accurately.

CI uploads only reports, logs and fixture state, not the runtime's node_modules, caches, isolated HOME or the whole profile store. Reports are retained for 14 days; the release maintainer should archive the key versions, digests, results and limitations into the release record rather than leaving only a temporary directory that expires.

The runtime platform of the automatic matrix is Ubuntu. Windows currently covers the static checks; a real model API, the browser, Windows/Desktop product runs and user-data migration need additional evidence. UI changes are verified against the real host mount and interaction under the Ego Lite rules; provider verification with credentials records the result and never stores credentials in the repository. Skipped, not-applicable and failed must be recorded separately and never collapsed into "everything passed".

## Publishing the same accepted artifact

[publish.yml](../.github/workflows/publish.yml) must wait for the whole `verify` reusable workflow to succeed. The publish job downloads that run's candidate tgz, re-checks the SHA-256, the version and the full host list, and publishes that file through the existing npm OIDC trusted publishing; the publish job does not rebuild, and `pack --dry-run` is not a gate.

- A new pre-release plugin version (alpha / beta / rc) enters the project's `next` channel on first publish; an accepted RC artifact may be promoted to `latest` with `npm dist-tag add` by an explicit maintainer decision, on the same immutable version, without repacking.
- For the first publish of an unsuffixed plugin version, and when promoting an RC artifact to `latest`, the development baseline must be the recommended host from the list and every supported target must pass. The current recommended host is `0.1.5-rc.1`; a package that only passed on Alpha must not be promoted to the default version for ordinary users.
- The release tag must equal `v<package.version>`, and the GitHub prerelease flag must match the plugin version suffix; promoting an RC to npm `latest` does not change its GitHub pre-release identity. Query npm's current `latest` before a stable release and refuse a regression.
- Preparing a PR, a version or an artifact does not mean it has been published. After publishing, read the registry's version, integrity and dist-tag, reinstall the exact version from the registry as a consumer check, and record whether it matches the candidate.
- Roll back npm dist-tags, user profiles/lockfiles and data separately; keep immutable versions and Git history. Do not impersonate an npm rollback by deleting or repointing a Git tag.

The current GitHub workflow grants OIDC write permission only to the publish job; PR and acceptance jobs have repository read access and need no real model key. The added GitHub artifact actions are pinned to reviewed commits: upload `ea165f8d65b6e75b540449e92b4886f43607fa02`, download `d3f86a106a0bac45b974a628896c90dbdf5c8093`. The download action only warns on a digest mismatch, so this workflow additionally enforces a SHA-256 check on the candidate file.

## Release tags on this branch

Every release gets an **annotated** tag, pushed to the fork:

```sh
git tag -a v<package.version> -F <message-file>     # message starts with the branch marker
git push fork v<package.version>
```

- The tag name is exactly `v<package.version>` from `package.json`, as the release
  rules above require. Backfilled tags follow the same shape (`v0.1.21`, `v0.1.22`).
- The message must open with `AgentTeams <version> — branch agent-teams-hardening
  (fork release)`. Our tags are **not** upstream NanmiCoder tags — upstream stops
  at `v0.1.20` — and the marker is what keeps the two lines distinguishable in a
  clone that has both remotes.
- The tag points at the commit whose build produced the shipped artifact, and the
  message carries the artifact file name, size and SHA-256 plus the local
  verification result. A documentation or local-notes commit that lands after the
  artifact does not move the tag: rewriting a pushed tag would break the
  immutability rule above.
- Tags are created after the artifact is packed and installed, never before, so
  the digest in the message is the digest that actually ran.

## Closing conditions for issues and PRs

State each follow-up separately:

| State | The facts that must be linkable |
| --- | --- |
| Merged | the commit/PR on current main; do not imply npm has been updated |
| Released | the exact plugin version, the npm channel and the published artifact |
| Verified | the exact host/plugin/platform/profile, the run result and the uncovered scope |

A reproduced fault is closed once the matching fix and acceptance are complete; if it is waiting for a release, say so explicitly. A duplicate report may be closed pointing at the primary tracker, but keep the platform or reproduction steps unique to it. Feature proposals, insufficient evidence and external invitations are handled separately; do not batch-mark every "version-related" problem as resolved. The claim/dispatch behaviour in #125 and the request ceiling and resource/concurrency problems in #106 each have their own behavioural boundary and do not disappear merely because the host starts.
