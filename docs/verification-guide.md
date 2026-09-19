## Verifying that a DSH plugin really works (a field method)

> This document is distilled from the complete verification history of the dsh-agent-teams plugin (multi-agent team collaboration plus a Web UI activity panel).
> Every command was actually executed; every layer had its pitfalls, and they are marked at the corresponding step. Principle: **never touch a running instance — verify on a separate profile, a separate port and a temporary directory, and clean up afterwards**.

### The verification pyramid at a glance

Four layers, bottom to top; pass one before moving to the next, and fix any layer that fails before continuing:

1. **Offline**: both typecheck programs + build + smoke script (pure logic, temporary directory, self-cleaning)
2. **Composition**: `dsh --profile <scratch> --dump-config` proves the bundle patch composes into the config tree (no boot, no instance touched)
3. **Real end to end**: a separate headless profile + a real LLM task + on-disk/event checks
4. **GUI**: a separate web instance + ego-browser driving a real browser (roster → routes → DOM probe → screenshot)

---

### 1. Offline verification

#### 1.1 Two typecheck programs

A DSH plugin usually has both a **host side** (Node: tools, routes) and a **browser side** (React components, Conversation Node). The two pull in conflicting type declarations (typically: the host side's `dsh-session` index declares `Context.sessions: SessionStore`, which collides by name with the browser runtime's `ISessions`), so **they must be split into two independent tsc programs**:

```jsonc
// tsconfig.json (host): include src, exclude ["src/client"]
// tsconfig.client.json: extends ./tsconfig.json + jsx react-jsx + lib DOM + types []
//     include ["src/client", "src/event-types.ts", "src/css-modules.d.ts"]
```

```sh
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit   # both must report 0 errors
```

Pitfalls (all actually hit):
- **A `.ts` file does not parse JSX**: a client entry point containing JSX must be named `index.tsx` (`index.ts` reads `<Component` as a less-than sign and reports `TS1005 '>' expected`, regardless of the jsx configuration).
- **`declare module` merging needs the target module to be loaded first**: before `declare module '@deepseek-ai/dsh-session/types'` can extend `SessionEventMap`, that module must already exist as a module in the program — add `import type {} from '...'` at the top of the file (a type-only import loads the module declarations and is erased from the output).
- **Narrowing is lost inside a closure**: when `match.event.data.x` is used inside a `.map((m) => ...)` callback, the discriminated-union narrowing is not preserved — extract `const x = match.event.data.x` after the guard and use that.
- **Type link targets**: the links under `profiles/node_modules/@deepseek-ai/*` point at unstable targets (a staging snapshot may be an old build whose declarations say `module 'cordis'` rather than the rescoped `'@deepseek-ai/cordis'`). While developing, link `node_modules/@deepseek-ai/<pkg>` directly to the **source package directory of the checkout** (whose `lib/types` are the correctly declared build); if a client package's `lib` is stale (missing the `Context` declaration merging), prefer linking to the staging build of the same version as the running instance, or map it straight to the source.

#### 1.2 Build (tsc + the tsdown client bundle)

```jsonc
// package.json scripts
"build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown",
"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit",
"verify": "node scripts/verify.mjs"
```

- tsc emits `lib/` (host executable ESM) and `lib/types/` (declarations).
- `tsdown` bundles `lib/client/index.js` into the browser bundle `lib/client.js` (protocol: a CJS closure-factory, `window.__ModuleLoader__.load({ id, factory })`; platform modules react / `@deepseek-ai/dsh-client-*` are externalised; CSS Modules are inlined through lightningcss and injected as `<style data-plugin>`).
- Post-build smoke test: `node -e "import('./lib/index.js').then(m => console.log(Object.keys(m)))"` should show `name/inject/Config/apply`.

Pitfall: the current DSH preset rebases from `lib/types/...` to `src/...`; an external plugin must follow its own emitted layout instead of hard-coding an arbitrary `/lib/`. tsdown 0.22 has deprecated `external/noExternal`, while the current checkout preset still uses them; before migrating to `deps.neverBundle/alwaysBundle`, verify the function-matching semantics instead of treating the warning as permanently ignorable.

#### 1.3 The smoke script (scripts/verify.mjs)

Zero dependencies, a self-cleaning temporary directory, pure logic that can be tested. Template (copy the skeleton directly):

```js
#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { /* the pure functions under test */ } from '../lib/state.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

// 1) Pure rules: state transitions, dependency gates, sanitize — assert inputs and outputs
// 2) File persistence: mkdtemp root -> createTeamDir/readTeam/mailbox round trip ->
//    archive/delete -> finally { rm(stateRoot, { recursive: true, force: true }) }
// 3) State functions: import from lib/ (e.g. taskVisualState/taskDepthsById) and assert against fixtures
// 4) Browser folds: import('../lib/client/xxx.js') and run the pure fold logic (no React dependency)

if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1) }
console.log('\nall checks passed')
```

Requirements: an assertion label must match its input and condition; cover a missing dependency, an empty directory and a terminal state that refuses a transition, and clean the temporary directory in `finally`. Pure projections behind the relationship UI must additionally assert stage order, natural id sorting, the non-finite depth fallback, upstream/downstream inclusion, sibling exclusion and cycle safety. Run `pnpm verify` in CI and before committing.

#### 1.4 Composition check: dump-config (no boot, no instance touched)

Use a **separate scratch profile** to prove the bundle patch composes into the config tree:

```sh
# Build the scratch profile by hand (pnpm is not required):
mkdir -p ~/.dsh/profiles/agent-teams-check/node_modules
ln -sfn /absolute/path/to/plugin ~/.dsh/profiles/agent-teams-check/node_modules/<pkg>
cat > ~/.dsh/profiles/agent-teams-check/package.json <<'EOF'
{ "name": "dsh-profile-check", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "<pkg>"] } } }
EOF
printf '[]\n' > ~/.dsh/profiles/agent-teams-check/cordis.patch.yml   # must be a top-level array!

dsh --profile agent-teams-check --dump-config | grep -A 4 "id: agent-teams"
```

- `--dump-config` is an **offline composition** (`composeEntries` applies the patch layers); it does not boot services and does not touch a running instance.
- The output should contain `- id: <plugin entry>` and its config.
- Pitfall: a `cordis.patch.yml` that is not a top-level array reports "must be a top-level YAML array". A custom profile that composed the web-app can take app-level `--host/--port` directly; `--patch` is an auditable way to pin it, but not the only entry point.

---

### 2. Real end-to-end verification (separate profile + real LLM)

#### 2.1 Installing into a separate profile

```sh
# The headless template initialises itself; pnpm link semantics plus automatic reconcile into dsh.profile.bundles
dsh plugin --profile headless add /absolute/path/to/plugin
dsh --profile headless --dump-config   # confirm the composition tree contains the plugin entry
```

A first real run usually exposes a **mount-ordering bug** immediately: under the Loader's concurrent activation, a sibling plugin (for example the provider registration of `subagent-spawn`) may not have finished when this plugin's apply runs — **a fail-loud check at mount time must move to the point of first use** (for example validating `ctx.subagents.getProvider(name)` when the first member is spawned), and the error message must be actionable.

#### 2.2 Designing the real LLM task

```sh
mkdir -p /tmp/agent-teams-e2e && cd /tmp/agent-teams-e2e
dsh --profile headless "Use AgentTeams to complete a small task: create the team 'Title plan', add 2 members (alice researches, bob writes), create 2 tasks (t2 depends on t1) assigned to them, wake them to finish, and finally summarise the output. Keep the tasks small; each member does one simple task."
```

Design points (to control tokens and decidability):
- **Keep the task small**: state explicitly "keep the tasks small / each member does one simple task" (spawning a member plus several tool-call rounds takes 1–3 minutes).
- **Require the plugin flow explicitly**: name the tools to call and their order (create team → add members → create dependent tasks → wake → summarise), otherwise the model may skip them.
- Run in a **dedicated working directory** (`/tmp/...`) so the on-disk artifacts are predictable; run in the background (`run_in_background`) and collect with `task_output --wait`.
- Decide success by: the task output narrates the complete flow (team created / members / tasks / output / team deleted) **and** the event stream landed on disk (see 2.3).

#### 2.3 On-disk checks (the data truth)

```sh
# Team state files (headless cwd = the invoking directory; after deletion the team is archived/emptied)
ls -la /tmp/agent-teams-e2e/.agent-teams/

# Session logs: one directory per session; a member child session is its own uuid directory
ls -lt ~/.dsh/sessions/--private-tmp-agent-teams-e2e--/

# Event stream (zstd-compressed; decompress with zstdcat and count agent-teams/* events)
zstdcat ~/.dsh/sessions/<ws>/session-<id>/session.jsonl.zstd \
  | grep -o '"type":"agent-teams/[^"]*"' | sort | uniq -c
# Expected: team-created x1, member-added x2, task-created x2, task-updated xN,
#           message-sent xN, team-deleted x1 (counts match the flow one to one)
```

The event stream is the data source for the UI and for replay — **if the event counts do not match the flow steps, that is a bug** (for example a member that skipped the `update_task` ritual leaves events missing, which must be distinguished from the on-disk truth).

---

### 3. GUI verification (ego-browser + a separate web instance)

#### 3.1 Starting a separate web instance (without touching the user's running instance)

```sh
# Install from scratch (beta npm flow; peers resolve from the beta registry):
npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh plugin --profile agent-teams-beta add @deepseek-ai/dsh-base
npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh plugin --profile agent-teams-beta add @deepseek-ai/dsh-web-app
npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh plugin --profile agent-teams-beta add /abs/path/to/dsh-agent-teams
# Start it (managed background task, keep the task id; CLI and bundle on the same channel):
npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh --profile agent-teams-beta --host 127.0.0.1 --port 3081
# Only curl after seeing the exact URL
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3081/
```

- A custom profile that composed the web-app can take app-level `--host/--port` directly; `--patch` can also pin the webserver config.
- **Version-alignment pitfall**: the default npx CLI is rc.2 (the `next` channel) while `dsh plugin add` installs `latest` (rc.1) by default — when they are mixed, the rc.2-only `ui-plugin-config` waits for a `settingsScope` that only rc.2 provides and the page reports "Failed to load plugins". Pin the CLI to `@0.0.1-rc.1` (aligned with the `latest` bundle) or upgrade everything to `next`.
- The beta registry's `latest` (rc.1) and `next` (rc.2) use different service keys (`httpServer` vs `webServer`) — the plugin supports both, so sample both channels.
- Client HMR needs a watcher that keeps rebuilding `lib/client.js`; otherwise run `pnpm build` and reload the page. Only host/package manifest/profile bundle changes require a restart.
- The apps/web shell and ordinary packages do not go through client-plugin HMR; do not start a separate Vite server as a replacement for the DSH GUI.

#### 3.2 Roster and route liveness

```sh
# The browser roster must contain the plugin (client-modules scans the composition tree for packages declaring dsh.client)
curl -s http://127.0.0.1:3081/ | python3 -c "
import sys, json, re
html = sys.stdin.read()
m = re.search(r'window.__DSH_BOOT__ = (.*?)</script>', html, re.S)
g = json.loads(m.group(1))
print(any('agent-teams' in e['id'] for e in g.get('entries', [])))
"
# Client bundle and custom data routes
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3081/plugins/<pkg>/client.js
curl -s http://127.0.0.1:3081/plugins/<pkg>/state
curl -s "http://127.0.0.1:3081/plugins/<pkg>/state?archived=1"
```

Pitfall: the current source reads `dsh.client` from package.json and requires a valid `exports["./client"]` plus an actual bundle; a malformed declaration or a missing bundle fails loud. A negative conclusion about package metadata does not expire by itself — fix the manifest/export and restart the host.

#### 3.3 DOM probes (ego-browser)

```js
// Reuse the task space and open/reuse a tab at the start of every heredoc
const task = await useOrCreateTaskSpace('agent-teams webui test')
await openOrReuseTab('http://127.0.0.1:3081', { wait: true, timeout: 30 })

// Components must mount data-* probe attributes (data-agent-teams-activity / data-task-state / data-member-running ...)
const probe = await js(String.raw`(() => {
  const panel = document.querySelector('[data-agent-teams-activity]')
  if (!panel) return { panel: false }
  return {
    panel: true,
    teamName: panel.querySelector('[class*="teamName"]')?.textContent ?? '',
    delegationMap: !!panel.querySelector('[data-delegation-map]'),
    dependencyMap: !!panel.querySelector('[data-dependency-map]'),
    focusedTasks: [...panel.querySelectorAll('[data-task-id][data-focused="true"]')].map(n => n.getAttribute('data-task-id')),
    pinnedTasks: [...panel.querySelectorAll('[data-task-id][aria-pressed="true"]')].map(n => n.getAttribute('data-task-id')),
    artLoaded: [...panel.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0),
    mainShift: getComputedStyle(document.querySelector('[data-phase="active"]')).paddingRight,
  }
})()`)
cliLog(JSON.stringify(probe, null, 1))
```

Pitfalls:
- **`snapshotText`'s `@N` refs are invalidated by every snapshot**: call `snapshotText()` again to get a fresh ref before filling an input or clicking a button; when no exact ref is found, fall back to `aria-label` or the button text (`.match(/\[ref=(\d+), loc=[^\]]*Send[^\]]*\]/)`).
- **The composer selector changes**: the placeholder may change from "describe what you want to build" to "message the agent" — list every textbox first and then address one precisely.
- CSS-module substring selectors are easily too broad; probes should prefer stable `data-*`, role and aria attributes.
- Verify the hover preview, click pin, and a second click / `Escape` unpin; `aria-pressed` lands only on the pinned source task, and the focused chain excludes siblings.
- On a wide screen assert that the main padding is non-zero and that the panel/composer overlap is zero; at ≤960px the padding returns to 0 with no horizontal body overflow; when closing, sample intermediate frames to confirm it is not an instant jump.
- A card activation event can be simulated with a CustomEvent, but keep at least one real button path. Poll state with browser wait/re-probe, not with a busy-waiting shell sleep.

#### 3.4 Screenshot archive

```js
await captureScreenshot('/tmp/agent-teams-panel.png')   // returns the file path
```

Store one per key state (running / terminal / archive review) for human visual inspection; the DOM probe's textual evidence and the screenshot complement each other (the probe asserts, the screenshot is eyeballed).

---

### 4. Verification discipline

- **Do not touch the running instance the user named**: establish its profile/URL first; when the user says "leave that instance alone", do not curl it, restart it or check it sideways.
- **Re-run the whole chain**: typecheck → build → verify → diff check; decide between a hot swap and a page reload from the HMR conditions, and restart only for host/package manifest/profile bundle changes.
- **Background tasks stay traceable**: start them as managed background tasks and keep the task id; when the user did not ask to keep the process, stop it precisely by that id instead of a broad `pkill -f`.
- Reuse the ego-browser task space per goal and close it when done; delete only the exact temporary paths this task created.
- Commit/push follows user authorisation; when the user asks for a commit, report the hash, and do not push unless asked.

---

### 5. Verification checklist template (copy-paste)

```markdown
## Verification checklist: <plugin name>

### Build and offline
- [ ] pnpm typecheck        # both host and client programs report 0 errors
- [ ] pnpm build             # lib/ + lib/client.js (closure-factory) emitted
- [ ] node -e "import('./lib/index.js')..."  # exports name/inject/Config/apply
- [ ] pnpm verify            # smoke suite all PASS (pure rules/persistence/state functions/folds)
- [ ] dsh --profile agent-teams-check --dump-config | grep "id: <plugin>"   # composition tree contains the plugin entry

### Real end to end (separate headless profile)
- [ ] dsh plugin --profile headless add /abs/path/<pkg>
- [ ] dsh --profile headless "<a small task that explicitly requires the plugin flow>"
- [ ] the task output narrates the complete flow (team created/members/tasks/output/team deleted)
- [ ] on disk: .agent-teams state files exist (or are archived as expected)
- [ ] zstdcat the session log: the agent-teams/* event counts match the flow one to one

### GUI (separate web instance on 3081 + ego-browser)
- [ ] dsh --profile agent-teams-web --patch port.patch.yml starts and index returns 200
- [ ] window.__DSH_BOOT__ roster contains the plugin (otherwise check dsh.client + ./client export + bundle)
- [ ] /plugins/<pkg>/client.js returns 200; custom routes (state/assets) return 200 with correct content
- [ ] run a task in a new session -> panel/card appear (DOM probes assert on data-*)
- [ ] every key interaction closed loop (navigate-and-hide / session following / archive review) probed item by item
- [ ] screenshots archived (running/terminal/review)

### Cleanup and wrap-up
- [ ] stop the separate instance by the saved background task id (when the user did not ask to keep it)
- [ ] completeTaskSpace(keep: false); delete only the temporary paths this task created
- [ ] no other running instance the user named was touched
- [ ] commit as authorised; nothing was pushed unless asked
```
