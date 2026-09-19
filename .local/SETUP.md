# Local setup for this checkout

Everything in this directory is **local to this machine**. It is not upstream
material, it is not part of the published package, and `pnpm verify` does not
read it. Upstream files are kept byte-identical so `git fetch upstream` stays
clean; the local rules live here instead.

## What this checkout is

| Item | Value |
| --- | --- |
| Source | `https://github.com/NanmiCoder/dsh-agent-teams` (upstream `origin`) |
| Path | `D:\OwlCats\AI_Tools\dsh-agent-teams` |
| Commit at clone time | `87c95c94d7847e4a242cb589916adc519981175f` (2026-09-17) |
| Package version | `0.1.20` (`@nanmicoder/dsh-agent-teams`) |
| Node | `v24.15.0` (package requires `^22.19.0 \|\| >=24`) |
| Package manager | see "pnpm version" below |

Two profiles under `%USERPROFILE%\.dsh\profiles` have the **published** plugin
installed at **v0.1.18**: `web` and `martty`. The host CLI is
`@deepseek-ai/dsh@0.1.5-rc.1`. Nothing in this checkout is wired into those
profiles - the scratch profile below is how source changes get exercised.

## SocratiCode

Indexed as project `dsh-agent-teams` (collection `codebase_dsh-agent-teams`).

| Command | Purpose |
| --- | --- |
| `codebase_search` | semantic + BM25 search over `src/`, `scripts/`, root docs |
| `codebase_context_search` | the 13 artifacts listed in `.socraticodecontextartifacts.json` |
| `codebase_graph_query` / `_stats` / `_circular` | import graph over the same file set |
| `codebase_update` | incremental refresh; a file watcher is usually active too |

Excluded on purpose (`.socraticodeignore`): `lib/` build output, the 245-file
vendored skill mirror, the dated `docs/*-audit-*` evidence dumps, release
notes, and binary art. The nine curated `docs/*.md` guides *are* in the index
and are also registered as context artifacts.

Refresh the upstream issue work queue with:

```sh
node .local/fetch-upstream-issues.mjs   # writes .local/upstream-issues.{json,md}
```

## Verification: what runs here and what does not

Upstream CI (`.github/workflows/verify.yml`) runs `pnpm typecheck && pnpm build
&& pnpm verify` on Ubuntu **and** Windows Node 24, then a real-host matrix.
On this machine the first three layers run, the fourth layer is blocked by the
sandbox (see below).

Measured on this checkout:

| Layer | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | pass (both programs) |
| build | `pnpm build` | pass (`lib/` + `lib/client.js`) |
| offline verify | `node scripts/verify.mjs` | pass - **181 PASS, 0 FAIL**, all 8 groups |
| composition | scratch profile + `dsh --dump-config` | pass - `id: agent-teams` composes |
| TDD suites | see below | pass |
| real Harness (LLM) | `scripts/harness-runtime-verify.mjs` | needs a host cohort + artifact; not run here |

Suites that run without spawning a child process - all of these are green on
this checkout with the pinned pnpm:

```sh
node scripts/verify.mjs
node scripts/quality-gates-tdd.mjs
node scripts/fallback-tdd.mjs
node scripts/member-failure-tdd.mjs
node scripts/lifecycle-verify.mjs
node scripts/compatibility.mjs
node scripts/readme-version.mjs
node scripts/sync-skill.mjs --check
node scripts/quality-gates-repair-scope.test.mjs
node scripts/quality-gates-amend.test.mjs
node scripts/release-metadata.test.mjs
node scripts/readme-version.test.mjs
node scripts/http-body.test.mjs
node scripts/capabilities.test.mjs
node scripts/member-spawn-recovery.test.mjs
```

Last full run (`cmd /c ".local\pnpm.cmd exec node <file>"`): `verify.mjs`
**181 PASS / 0 FAIL** across all 8 groups, and every other suite above exited
`0`. Transcript: `.local/logs/baseline-pnpm10.log`.

Run a `*.test.mjs` file as `node <file>`, **not** `node --test <file>`: the test
runner spawns one child per file with a piped stdio, which the sandbox denies
before the test body runs (see below).

## Sandbox limits on this machine (measured, not assumed)

| Symptom | Cause | Consequence |
| --- | --- | --- |
| `Error: spawn EPERM` (errno -4048) | in the confined pwsh sandbox a process cannot open a named pipe, so Node `child_process` with `stdio: 'pipe'` cannot start | `pnpm verify` stops inside `scripts/verify.mjs` at the Windows cross-process file-lock check (line ~1649); `node --test` fails for every file; `scripts/compatibility.test.mjs` fails on its `spawnSync` doctor check; the harness runtime verifiers cannot run |
| `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | same sandbox: curl.exe and PowerShell `Invoke-WebRequest`/`Invoke-RestMethod` cannot do TLS | `curl`, `iwr` and `irm` are unusable for network work. **`git` and Node's built-in `fetch` work** - that is how the clone and `.local/fetch-upstream-issues.mjs` succeed |
| `npm error ... writing to the directory: C:\Users\...\npm-cache\_logs` | npm's cache/log directory is outside the writable workspace | `npm install --global ...` fails. Workaround used here: `$env:npm_config_cache = "D:\OwlCats\AI_Tools\.npm-cache"`, which is inside the workspace |

To get a full green `pnpm verify` (including the two EPERM-blocked checks),
re-run it from a shell with `danger-full-access`, or run it in CI.

## pnpm version

CI pins `pnpm@10.33.0` (`npm install --global pnpm@10.33.0` +
`pnpm install --frozen-lockfile`). The machine's global pnpm is newer, which
matters twice:

- a newer pnpm rewrites `pnpm-lock.yaml` during install (it did, and the
  pristine file was restored with `git checkout -- pnpm-lock.yaml`);
- pnpm 11+ treats skipped dependency build scripts as a hard error
  (`ERR_PNPM_IGNORED_BUILDS`) for `node-pty`, `koffi`, `protobufjs`,
  `@google/genai`, `@deepseek-ai/dsh-subprocess-local`.

`.local/pnpm.cmd` runs the pinned version and keeps npm's cache inside the
workspace, because `npm install --global` and npx both want
`C:\Users\<user>\AppData\Local\npm-cache`, which the sandbox cannot write:

```powershell
cmd /c ".local\pnpm.cmd --version"                  # 10.33.0
cmd /c ".local\pnpm.cmd install --frozen-lockfile"
cmd /c ".local\pnpm.cmd typecheck"
cmd /c ".local\pnpm.cmd build"
cmd /c ".local\pnpm.cmd exec node scripts/verify.mjs"
```

Note that `pwsh` is not installed on this machine (the harness runs Windows
PowerShell 5.1), so scripts here are invoked as `cmd /c ".local\pnpm.cmd ..."`
or from a plain terminal. `install --frozen-lockfile` with the pinned version
leaves `pnpm-lock.yaml` untouched - verified with `git status`.

## Exercising source changes without touching the real profiles

`D:\OwlCats\AI_Tools\.dsh-scratch` is a throwaway `DSH_HOME` containing the
profile `agent-teams-check`, whose `node_modules/@nanmicoder/dsh-agent-teams`
is a junction to this checkout. The composition check:

```powershell
$env:DSH_HOME = "D:\OwlCats\AI_Tools\.dsh-scratch"
dsh --profile agent-teams-check --dump-config | Select-String -Context 0,8 "id: agent-teams"
```

It does not boot a server and does not read `~/.dsh`. After a `pnpm build`, the
same profile can serve the built plugin for a real browser session:

```powershell
$env:DSH_HOME = "D:\OwlCats\AI_Tools\.dsh-scratch"
dsh --profile agent-teams-check web --port 3081
```

Delete `.dsh-scratch` at any time; recreate the profile by repeating the
`package.json` + `cordis.patch.yml` + junction steps described in
`docs/verification-guide.md` section 1.4.

## Known state to look at later

- `node scripts/doctor.mjs --host-root C:\Users\whitl\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
  reports `FAIL: 230 resolved DSH packages differ from host 0.1.5-rc.1`. The
  global CLI is 0.1.5-rc.1 but its resolved dependency tree is not uniformly
  that version. Unrelated to this checkout; it decides whether a *source*
  plugin install can pass the host identity check.
- The upstream work queue is `.local/upstream-issues.md` (62 open items). The
  defect-heavy ones already filed against quality gates are #183, #175, #174,
  #161, and #160. Read the body of one with:
  `node -e "fetch('https://api.github.com/repos/NanmiCoder/dsh-agent-teams/issues/183').then(r=>r.text()).then(console.log)"`

## Remotes: upstream (read-only) and fork (push target)

`origin` — upstream `NanmiCoder/dsh-agent-teams`. Push туда **невозможен** (чужой
репозиторий; `git push --dry-run origin` отвечает 403 — это ожидаемо, не поломка).
Рабочая копия опубликована в собственном публичном форке:

| Remote | URL | Назначение |
| --- | --- | --- |
| `origin` | `github.com/NanmiCoder/dsh-agent-teams` | только `fetch`; источник upstream-релиза и issue |
| `fork` | `github.com/WhiteWh/dsh-agent-teams` | push; `main` = upstream `87c95c9`, `toolkit-fix` = 9 коммитов поверх |

```powershell
git push fork toolkit-fix          # рабочая ветка
git fetch origin                   # подтянуть upstream перед синхронизацией
```

`main` в форке совпадает с upstream-базой, поэтому `Compare & pull request`
показывает ровно коммиты `toolkit-fix`. Заготовка описания PR (если решите
отправить наверх) — `.local/PULL_REQUEST.md`; в upstream **ничего не отправлялось**.

Лицензия MIT: форк, изменение и публикация разрешены при сохранении текста
`LICENSE` и копирайта. `LICENSE` и поле `author` в `package.json` не менялись.

## Layout of this directory

```
.local/
  SETUP.md                     this file
  PROGRESS.md                  step table (S01–S20) + per-step log + owner decisions D1–D6
  TRAPS.md                     pitfalls of this checkout: read before every step
  FOLLOWUPS.md                 out-of-scope bugs with file:line
  PULL_REQUEST.md              PR draft (not submitted)
  pnpm.cmd                     run the CI-pinned pnpm 10.33.0 from this checkout
  t5-replay.mjs                t5 incident replay on the real compiled tools
  create-fork.mjs              one-shot: create the GitHub fork via API (token from GCM)
  fetch-upstream-issues.mjs    refresh the work queue (node fetch)
  upstream-issues.json         last raw API response
  upstream-issues.md           last formatted table
  dist/                        release tarball + .sha256
  logs/                        install + typecheck/build + verify transcripts
```

Durable configuration for this checkout, outside `.local/`:

```
.socraticode.json                  projectId = dsh-agent-teams
.socraticodeignore                 what the indexer must not read
.socraticodecontextartifacts.json  13 curated docs as searchable artifacts
../.dsh-scratch/                   throwaway DSH_HOME for profile checks
../.npm-cache/                     npm cache redirected into the workspace
```
