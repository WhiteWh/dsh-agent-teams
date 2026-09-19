# Building a DeepSeek Harness (DSH) plugin from scratch

> Distilled from the full development of the dsh-agent-teams plugin (host tools + browser activity panel + conversation card).
> Covers a bundle plugin end to end — skeleton, host side, client side, build/install, and the pitfalls — so a coding agent can follow it directly.
> Reference implementations: `dsh-agent-teams` (finished), DSH `packages/workflow/tool-workflow` (tool plugin template),
> `packages/client/tsdown.client.ts` (client bundle protocol), `packages/bundle/base|cordis.patch.yml` (host composition),
> `packages/client/modules/src/index.ts` (browser roster scan), `packages/client/ui-workflow-run` (conversation-flow UI template).

## 0. Overview: what a DSH bundle plugin is

An installable plugin is one npm package playing two roles:

- **host side** (Node): the package root's `lib/index.js`, mounted as one plugin row in the composition tree, registering tools, services, HTTP routes and session events.
- **client side** (browser): the subpath `./client` (`lib/client.js`), scanned by `dsh-client-modules` into the `window.__DSH_BOOT__` roster, running as a cordis plugin that calls `apply(ctx)` and renders UI.

Install = `dsh plugin --profile <profile> add <package path or name>`: pnpm installs into the profile and adds the package to the profile manifest's `dsh.profile.bundles` layer list; the bundle's `cordis.patch.yml` inserts the plugin row into the composition tree as a patch layer. **Restart the profile after plugin add**, because the package manifest/bundle layers and client package metadata are cached in-process. A user's `cordis.patch.yml` edited after boot is re-read transactionally by boot HMR, so config updates and patch-row mount/removal work without a restart.

## 1. Plugin shape and project skeleton

```
dsh-my-plugin/
├── package.json          # dsh.bundle + dsh.client + exports
├── cordis.patch.yml      # inserts the plugin row into the host composition
├── tsconfig.json         # host compile (excludes src/client)
├── tsconfig.client.json  # client compile (jsx: react-jsx)
├── tsdown.config.ts      # client bundle build (mirrors the tsdown.client.ts protocol)
├── src/
│   ├── index.ts          # host entry: name/inject/Config/apply
│   ├── tools.ts          # tool registration (optional; split files in a large plugin)
│   ├── events.ts         # session event writes (optional)
│   ├── event-types.ts    # event types + SessionEventMap merge (ZERO imports!)
│   ├── snapshot.ts       # host-side data assembly (optional)
│   ├── state.ts          # file persistence (optional)
│   └── client/
│       ├── index.tsx     # browser entry (must be .tsx to hold JSX!)
│       ├── XxxPanel.tsx  # UI components
│       ├── *.module.css
│       └── artwork.ts    # shared pure logic (optional)
├── assets/               # static assets shipped with the package (served by an allowlisted route)
└── scripts/verify.mjs    # offline smoke verification
```

### 1.1 package.json essentials (why each field exists)

```jsonc
{
  "name": "dsh-my-plugin",
  "type": "module",                          // ESM everywhere
  "main": "lib/index.js",                    // host entry (tsc output)
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "assets", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // bundle declaration: the patch mounts the host row
    "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit"
  }
}
```

- `exports["./client"]` is a hard requirement of the roster scan: `client-modules` reads `exports["./client"]` to find the browser bundle (a string, or a one-level conditional object with a string `default`; `types` takes no part in runtime resolution). Missing it rejects the package outright.
- `dsh.bundle.patch` makes `dsh plugin add`'s reconcile recognise this as a bundle and add it to the bundles layer.
- `dsh.client` is the authoritative client manifest in the current source; `platform` must be `"web"`. Package metadata and negative conclusions are cached by name, so adding/removing a client declaration or fixing an export requires a host restart. If an older deployment differs, check its source before declaring compatibility.
- `peerDependencies`: every host-side dependency (`@deepseek-ai/dsh-tools`, `dsh-session`, `dsh-subagent`, …) plus the browser side (`dsh-client-runtime`, `dsh-client-ui-slots`, `react`) is a peer, resolved at runtime from the profile's `node_modules` (the flattened `healProfilesModuleFallback` directory) instead of being installed twice.
- `files` must include `lib` and `cordis.patch.yml`; add `assets/...` when there are static assets.

### 1.2 cordis.patch.yml: one row into the composition

```yaml
# bundle patch: a top-level YAML array; insert appends composition rows
- insert:
    - id: my-plugin            # row id (globally unique)
      name: dsh-my-plugin      # package name (client-modules resolves package.json by it)
      config:                  # optional: the plugin's Config
        someOption: value
```

Key points: `name` must equal the package name (the roster scan does `require.resolve('<name>/package.json')`); the row mounts into the host composition and tools register into the global `tools` registry, so every session under that profile can use them with no realm.

### 1.3 tsconfig: host and client must be two programs

```jsonc
// tsconfig.json -- host
{
  "compilerOptions": {
    "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["ES2022"], "strict": true, "noUncheckedIndexedAccess": true,
    "declaration": true, "declarationDir": "lib/types", "outDir": "lib", "rootDir": "src",
    "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true,  // TS 5.7+, rewrites .ts imports to .js
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/client"]     // the host program must never compile the client
}
```

```jsonc
// tsconfig.client.json -- client (extends host, overrides)
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",          // required
    "types": []                  // no node types in a browser environment
  },
  "include": ["src/client", "src/event-types.ts", "src/css-modules.d.ts"],
  "exclude": []
}
```

Why the split is mandatory (see 3.1): the host side's `dsh-session` index declares `Context.sessions: SessionStore` while the browser side's `dsh-client-runtime` declares `Context.sessions: ISessions` — same-name member types that conflict, so one program can only hold one of them (`skipLibCheck` swallows the conflict and keeps whichever is declared first). Split, the host program sees only host declarations and the client program only browser declarations, with no cross-contamination.

## 2. Host-side development

### 2.1 The four parts of a function plugin

A DSH function plugin is the named exports `name/inject/Config/apply` (no default export):

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// declaration-merge only: makes ctx.subagents / ctx.systemPrompt etc. visible (see 2.3)
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'my-plugin'
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

export interface Config { stateDir?: string }
export const Config: z<Config> = z.object({ stateDir: z.string().default('.agent-teams') })

export function apply(ctx: Context, config: Config): void {
  // register tools, prompt sections, HTTP routes... all inside apply
}
```

> **Beta version compatibility (webServer/httpServer)**: the Web service key on npm `latest` (`0.0.1-rc.1`) is `ctx.httpServer` (`HttpServerService`); the later `next` (`rc.2`) renamed it to `ctx.webServer` (`WebServer`), and the workspace key likewise from `workspace` to `workspaceRegistry`. During the transition do not hard-bind one key name: `ctx.get('webServer') ?? ctx.get('httpServer')` (new key first, old as fallback) and listen on both key sets through the `internal/service` event before re-registering. The route-registration shape (`register({kind, path, handler})` returning a disposer) is identical on both.

- `inject` declares the services depended on; `ctx.<name>` is only available for a service declared in `inject`.
- `Config` is described with `@deepseek-ai/schemastery`'s `z.object`; the Loader supplies defaults.
- `import type {} from '<package>'` is a **declaration-merge trigger**: DSH packages extend `Context` through `declare module '@deepseek-ai/cordis'`, and that package must be loaded into the program for the corresponding members to be visible.

### 2.2 Tool registration (defineTool, template: tool-workflow)

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'my_tool',
  description: '...the full contract the model sees...',
  parameters: {
    arg: { type: 'string', required: true, description: '...' },
    status: { type: 'string', enum: ['a', 'b'], description: '...' },  // enum makes inference exact
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const caller = exec.agent            // the calling Agent (parent session ownership, cwd, session)
    if (!caller) throw new Error('requires a calling agent')
    // ...business logic, returning a JSON value matching output.schema...
    return { ok: true }
  },
}))
```

Key lessons:
- `parameters` is a DSL property-description object (one schema per key); `output.schema` is ordinary JSON Schema.
- `exec.agent` is the calling Agent: `agent.session.header.cwd` is the workspace (where team state lands on disk), `agent.session` is an appendable session, `agent.id` is the session id. Subagent orchestration (`subagents.startContinuable` and friends) always requires `parent: exec.agent`.
- A tool's `description` is the model contract: state clearly when and how to use it. Pair it with a usage policy registered through `ctx.systemPrompt.section()` (tool-workflow does this around `order: 115`).

### 2.3 Service injection and "fail-loud timing"

```ts
// Be careful with mount-time validation: provider registration is the effect of a
// sibling plugin row (the Loader activates concurrently) and may happen after your
// apply. Do not validate the provider inside apply -- move it to first real use.
const provider = ctx.subagents.getProvider(config.memberProvider)   // <- at spawn time, not in apply
```

`inject` waits only for **services** (the service having been provided), not for **provider registration** (the effect of another row under the same service). Any validation that depends on a sibling plugin's behaviour must be deferred to first use (the earliest resolvable point), otherwise it fails randomly under concurrent activation (see pitfall 5.1).

### 2.4 HTTP routes (the activity panel's data channel)

```ts
import { readFile } from 'node:fs/promises'

// dual key during the transition: new key first, old as fallback (see the version note in 2.1)
const web = (ctx.get('webServer') ?? ctx.get('httpServer')) as WebRouteHost
ctx.effect(() => web.register({
  kind: 'exact',                       // or 'prefix'
  path: '/plugins/my-plugin/state',
  handler: async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ... }))
  },
}), 'my-plugin: state route')
```

- `register` returns a disposer and must be wrapped in `ctx.effect(..., 'label')` (HMR safety).
- The service may bind only after the plugin's apply: when the first registration fails, subscribe with `ctx.on('internal/service', name => ...)` and register again.
- A static-asset route **must allowlist** (path-traversal defence): wrap `decodeURIComponent` in try (a malformed encoding returns 404, not 400), strip the path with `split('/').pop()` before consulting a Set, then `join`.
- Client polling is the plain data channel available to an external plugin: use `cache: 'no-store'`, in-flight overlap protection, response-shape validation, unmount/cancelled guards, and keep the last successful snapshot while the host restarts or a request fails.

### 2.5 State persistence (files + an in-process lock)

```ts
// Team state = <workspace>/.agent-teams/<teamId>/team.json + inbox/*.jsonl
// Use node:fs/promises directly (the plugin's own bookkeeping, not the sandboxed fs
// service; that service has no delete API).
const locks = new Map<string, Promise<unknown>>()
export async function withTeamLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  locks.set(key, previous.then(() => gate))
  await previous
  try { return await fn() } finally { release() }
}
```

- Read-modify-write must be serialised: use a promise-chain mutex inside one process (make the key include the workspace so same-named teams in different workspaces do not serialise against each other).
- Events/models can bypass the tool "ritual" by writing files directly, so a panel-like UI must treat the disk as the source of truth (a host snapshot) rather than replaying events (events are for conversation-flow nodes and the audit trail).

### 2.6 Session event writes (the conversation-flow UI's data source)

```ts
// event-types.ts -- event types + SessionEventMap merge, and it must have ZERO imports!
export interface AgentTeamsTeamCreatedData { readonly teamId: string; readonly name: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'my-plugin/team-created': AgentTeamsTeamCreatedData }
}
```

```ts
// events.ts -- writes
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session/types'
session.append(type, data)   // type must already be merged into SessionEventMap
```

- `SessionEventMap` is merge-extensible: `declare module '@deepseek-ai/dsh-session/types'` merges, and the browser-side Conversation Node replays those events deterministically by `seq`.
- **event-types.ts must have zero imports**: both the host and the client program load it, so importing a host-side package (such as `dsh-session`'s index) poisons the client program's declaration merging (see 3.1/5.3).
- Append target: write events into the **captain session** rather than the caller, including member operations, to keep a single monitoring surface; fall back to the caller session when the captain is unreachable. `session.append` throws, so wrap it in try/warn degradation.

## 3. Client-side development

### 3.1 Why two tsc programs are mandatory

`dsh-session` (host) declares `Context.sessions: SessionStore`; `dsh-client-runtime` (browser) declares `Context.sessions: ISessions`. Both are same-named members of `declare module '@deepseek-ai/cordis' { interface Context }`, so one program must conflict (after `skipLibCheck` swallows it, whichever is declared first wins, showing up as "Property 'open' does not exist on type 'SessionStore'" on `ctx.sessions.open`).

The rules after the split:

- host program: `include: ["src"]`, `exclude: ["src/client"]`; link only host package types.
- client program: `include: ["src/client", "src/event-types.ts", ...]`; it **must not compile any file that imports a host-side index** (that is why event-types has zero imports; client files import only browser-side packages and event-types' types).
- The merge for `declare module '@deepseek-ai/dsh-session/types'` only needs the `dsh-session/types` subpath to be loaded (the subpath file carries no host `Context` merge, so it is safe).

### 3.2 Extension pitfall: JSX needs `.tsx`

TS parses JSX only inside `.tsx` files. As soon as the plugin entry contains `root.render(<XxxPanel .../>)`, the file must be `src/client/index.tsx` (the output is still `lib/client/index.js`). Naming it `.ts` produces a stream of `TS1005 '>' expected` regardless of configuration — a pure extension problem (see pitfall 5.4).

### 3.3 The client bundle protocol (tsdown, mirroring tsdown.client.ts)

What the browser loads is not source but `/plugins/<id>/client.js` — a **CJS closure-factory**:

```js
window.__ModuleLoader__.load({
  id: "dsh-my-plugin",
  factory: (require) => { /* ... */ return module.exports }
})
```

Key `tsdown.config.ts` settings (aligned with `clientConfig` in the `0.1.0-rc.8` repository's `packages/client/tsdown.client.ts`):

```ts
export default {
  name: 'dsh-my-plugin/client',
  entry: { client: 'lib/client/index.js' },   // output of the tsc client program
  outDir: 'lib', format: 'cjs', platform: 'browser',
  dts: false, sourcemap: true, clean: false,
  deps: {
    neverBundle: (id) => CLIENT_EXTERNALS.includes(id),
    alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), /* same for import.meta.env */ },
  plugins: [
    // purity gate: a value import of a @deepseek-ai package that is neither
    // external nor inline-safe is a build error (cross-plugin value imports would
    // inline duplicate instances or need a specifier the module table cannot answer)
    { name: 'purity', resolveId(source) { /* @deepseek-ai check */ } },
    // CSS Modules inline: lightningcss compile + <style data-plugin> injection + class map
    { name: 'css-modules', resolveId(source, importer) { /* .module.css -> virtual id */ },
      async load(virtualId) { /* transform + injection, with the lib->src sourceAssetPath mapping (see 5.7) */ } },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-my-plugin", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
```

- `CLIENT_EXTERNALS` = `PLATFORM_MODULES` + `PRELOADED_CLIENT_EXTERNALS`; on rc.8 the latter contains `@deepseek-ai/dsh-client-runtime/client`. The platform list evolves, so copy it from the target checkout's `packages/client/web/src/platform.ts`/`tsdown.client.ts`.
- The browser side may import only platform modules, types and the inline-safe packages the current preset allows; cross-plugin value collaboration goes through a cordis service.
- `dsh.client.inject` is package graph/prefetch/HMR metadata and does not guarantee apply order; wait for a slot declaration with `ctx.slots.inject()` and for a service with the client plugin's `export const inject`.
- It needs `tsdown@0.22` + `lightningcss`; a plain pnpm install is enough.

### 3.4 Choosing the right UI seam: slots first, body portal as a fallback

Read the current `packages/client/ui-*/src/client/contract/slots.ts` first. Existing stable seams include `conversation.session.header.actions`, `conversation.input.dock`, `conversation.composer.dock`, `conversation.input.left/right` and `conversation.chat.node`. DeepSeek Harness `0.1.0-rc.8` also provides a frame-level `shell.overlay`; prefer registering into a semantically correct slot. Use a body portal with fixed positioning only when the target version genuinely has no seat for a global panel:

```tsx
// src/client/index.tsx (rc.8+)
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  const Panel = () => <ActivityPanel openSession={(id: SessionId) => { ctx.sessions.open(id) }} />
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'my-plugin-panel',
    order: 80,
  }, Panel))
}
```

- `ctx.sessions.list` is an `ObservableSnapshot<SessionListState>`; subscribe with `useSyncExternalStore` for a cross-session panel.
- `shell.overlay`'s lifecycle and stacking context are managed by AppFrame; window/document listeners and global attributes must still be effect-owned and cleaned up on HMR unmount.
- Model auto-expand/grace-collapse explicitly, and close synchronously on user navigation instead of relying on a polling delay.

#### 3.4.1 How the floater cooperates with the main workspace

When a docked wide-screen floater would cover the transcript/composer, let the conversation column yield space while the sidebar stays put. The panel broadcasts its open state through a global attribute, and the CSS depends only on stable host data attributes, never on hashed classes:

```tsx
useEffect(() => {
  const root = document.documentElement
  if (open) root.setAttribute('data-my-plugin-panel-open', '')
  else root.removeAttribute('data-my-plugin-panel-open')
  return () => { root.removeAttribute('data-my-plugin-panel-open') }
}, [open])
```

```css
:global(html) {
  --my-panel-width: 388px;
  --my-panel-shift: calc(var(--my-panel-width) + 18px + 14px);
}
:global(html[data-my-plugin-panel-open]) :global([data-phase='active']) {
  box-sizing: border-box;
  padding-right: var(--my-panel-shift);
}
:global([data-phase='active']) {
  transition: padding-right 360ms cubic-bezier(.22, 1, .36, 1);
}
@media (max-width: 960px) {
  :global(html[data-my-plugin-panel-open]) :global([data-phase='active']) { padding-right: 0; }
}
@media (prefers-reduced-motion: reduce) {
  :global([data-phase='active']) { transition: none; }
}
```

On a wide screen assert that the panel/composer overlap is 0; on a narrow screen degrade safely to an overlay.

#### 3.4.2 Relationship UI and accessibility

- Express captain→member assignment and task dependency stages through lines, text and state together, never colour alone.
- Extract stage grouping and the upstream/downstream chain into pure functions: natural id sorting, a non-finite depth falling back to 0, and cycle-safe traversal.
- Hover only previews; a click pins separately, `aria-pressed` lands only on the pinned source node, and a second click or `Escape` clears it; focus/blur and mouse enter/leave stay equivalent.
- An icon-only button has an `aria-label`, a section has a label, decorative images are `alt="" aria-hidden`, interactions have `:focus-visible`, and animations/transitions cover `prefers-reduced-motion`.

### 3.5 Conversation nodes (template: ui-workflow-run)

Embedded UI in the conversation flow = registering a Conversation Node (browser-side cordis):

```ts
// agent-teams-card-definition.ts
import type { ChatConversationViewNode, ConversationNodeContext,
  ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
// the two critical type-only imports for declaration merging (see 5.3):
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'   // loads the ChatNodeDataMap module
import type {} from '@deepseek-ai/dsh-session/types'                  // loads the SessionEventMap module

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap { 'my-plugin': MyCardData }               // the renderer's keyed data map
}

export const myDefinition: ConversationNodeDefinition<MyState> = {
  kind: 'my-plugin',
  target: 'chat',
  match: (event) => { /* extract a stable business id + start/update role from the event */ },
  start: (ctx, match) => { /* build state from the first event */ },
  update: (ctx, match) => { /* fold state by increasing seq; inside a nested closure extract data into a local first (see 5.5) */ },
  buildViewNode: (ctx) => ({ /* project the final data */ }),
}
```

```tsx
// index.tsx registration
ctx.uiConversation.events.register(myDefinition)
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node', key: 'my-plugin',
  inject: () => ({ openSession: (id) => ctx.sessions.open(id) }),
}, MyCardComponent))
```

- A Conversation Node is a **deterministic replay of the event stream**: `match` picks events, `start/update` fold by seq, `buildViewNode` projects — which is why a conversation-flow node supports historic review for free (replaying an old log restores the state).
- The component is an ordinary React component with the four-part props (`PropsRuntime<'conversation.chat.node','my-plugin'>` etc.).

## 4. Build and install

### 4.1 Build chain

```sh
pnpm build   # tsc host -> tsc client -> tsdown (client.js)
```

- tsc must be **5.7+**: `rewriteRelativeImportExtensions` rewrites a source `./x.ts` import to `.js` in the output (otherwise emit reports TS5096/TS5023, see pitfall 5.6).
- tsdown emits `lib/client.js` (CJS closure-factory) plus a sourcemap; the host-side tsc output (`lib/index.js` and friends) is usable as is.

### 4.2 Development-time type linking (developing outside a DSH checkout)

DSH packages are not published to the npm registry (pre-release), so during development symlink the dependencies into the project's node_modules:

```sh
mkdir -p node_modules/@deepseek-ai
ln -sfn /path/to/DSH/vendor/cordis           node_modules/@deepseek-ai/cordis
ln -sfn /path/to/DSH/packages/core/session   node_modules/@deepseek-ai/dsh-session
ln -sfn /path/to/DSH/packages/core/tools     node_modules/@deepseek-ai/dsh-tools
# ...and every dsh-* package you import (host side links packages/<group>/<pkg> of the checkout)
```

Two traps:

- **Link to the source checkout's build output** (`packages/<pkg>/lib/types`), not to a running instance's staging directory — a staging snapshot may be an old build (`declare module 'cordis'` rather than `'@deepseek-ai/cordis'`, so the declaration merge does not take effect).
- The checkout's `lib` may be stale (source updated but not rebuilt) — the symptom is missing types; add the link or switch to source `paths` mapping. The same applies to client-side packages.

### 4.3 Installing into a profile

```sh
pnpm build
# beta stage: dsh comes from the official npm package; install the plugin from a local path or git URL (before it is on npm)
npx -p @deepseek-ai/dsh dsh plugin --profile web add /absolute/path/to/dsh-agent-teams
# restart dsh (web or headless) for it to take effect
```

- `dsh plugin` runs pnpm in the profile directory and reconciles a dependency carrying a `dsh.bundle` declaration into the bundles layer.
- Beta registry: the `@deepseek-ai` scope needs the official read-only token (`.npmrc` scope auth); a peer range must be written against the rc channel (e.g. `^0.0.1-rc.1`), because a plain `^0.0.1` does not match `0.0.1-rc.x` and installation fails to resolve.
- **CLI and bundle must be on the same channel**: the default npx CLI may be `next` (rc.2) while `dsh plugin add` installs `latest` (rc.1) by default — mixed, an rc.2-only client entry (such as `ui-plugin-config`) waits for a service only rc.2 provides (`settingsScope`) and the page reports "Failed to load plugins … waiting for service: settingsScope". Pin `npx -p @deepseek-ai/dsh@0.0.1-rc.1` (aligned with `latest`) or upgrade everything to `next`.
- A separate test profile is a safe verification environment (it does not touch a running instance): the headless template initialises itself, and a custom profile can be built from scratch with `npx -p @deepseek-ai/dsh dsh plugin --profile <name> add ...`.

### 4.4 Offline verification (without starting a service)

```sh
node scripts/verify.mjs   # pure logic + file-persistence smoke (self-cleaning temp dir)
dsh --profile <scratch> --dump-config   # prove the plugin row appears in the composition tree (offline, no boot)
```

- Extract pure logic (state machine, dependency depth, folds, layout) into functions with no ctx dependency and have the verify script import `lib/*.js` and assert on them; run the write paths wrapped in `withTeamLock` against a real file round trip in a temporary directory.

## 5. Pitfall list (in development order; every one was hit in practice)

### 5.1 Provider registration happens after plugin mount

- **Symptom**: the first start randomly reports `no subagent provider "spawn" is registered`; it is guaranteed on headless.
- **Root cause**: the provider registration of the `subagent-spawn` row is a sibling plugin effect and, under the Loader's concurrent activation, may run after your `apply`; `inject` waits only for the service (the subagents service existing), not for the provider.
- **Fix**: do not validate the provider in apply; validate with `getProvider` at the first `spawnMember` and throw an actionable error ("fail loud at the earliest resolvable point").

### 5.2 The browser roster does not include the plugin (manifest / export / bundle)

- **Symptom**: no entry in `window.__DSH_BOOT__`, or a client bundle composition error at host start.
- **Current contract**: `client-modules` reads `package.json.dsh.client` and requires `platform: "web"`, a valid `exports["./client"]` and a bundle that actually exists; a malformed declaration or a missing bundle fails loud.
- **Cache boundary**: package metadata and negative conclusions do not expire; restart the host after fixing the manifest/export. Only a change to the contents of `lib/client.js` enters the client HMR rebuild chain.

### 5.3 `declare module` merging has no effect (TS2664 / the type union lacks your event)

- **Symptom**: after merging `declare module '@deepseek-ai/dsh-session/types'`, `event.type` in `match(event)` does not include your event; `declare module '@deepseek-ai/dsh-client-ui-conversation/client'` reports `TS2664: Invalid module name in augmentation`.
- **Root cause**: module augmentation only applies to a module **already loaded into the program**; a pure `declare module` file with zero imports never loads the target module.
- **Fix**: add `import type {} from '<target module>'` at the top of the merging file (it loads the module, is erased at compile time and never enters the bundle). This is also why event-types.ts must have zero imports while a definition file may carry type-only imports.

### 5.4 JSX reported as a stream of syntax errors

- **Symptom**: `root.render(<XxxPanel .../>)` reports a long stream of `TS1005 '>' expected`; changing the jsx config or the tsc version makes no difference.
- **Root cause**: the entry file is `index.ts` — TS parses JSX only in `.tsx`, so `<` is read as a less-than sign.
- **Fix**: every file containing JSX must be `.tsx` (`src/client/index.tsx`); the output name is unchanged (tsc emits `.js`).

### 5.5 Discriminated-union narrowing is lost inside a nested closure

- **Symptom**: `if (event.type === 'x') { ...arr.map(() => event.data.field) }` reports `Property 'field' does not exist`.
- **Root cause**: narrowing of a function parameter (`match`) is not preserved inside a nested arrow function (TS preserves narrowing inside a closure only for `const` variables).
- **Fix**: after the guard, extract `const field = match.event.data.field` first and use the local inside the closure.

### 5.6 tsc emit reports TS5096/TS5023

- **Symptom**: `typecheck` (`--noEmit`) passes while `tsc` emit reports `TS5096: allowImportingTsExtensions can only be used with noEmit` plus `TS5023: unknown option rewriteRelativeImportExtensions`.
- **Root cause**: TypeScript below 5.7 (`rewriteRelativeImportExtensions` was added in 5.7; in older versions `allowImportingTsExtensions` is only allowed with noEmit).
- **Fix**: `typescript@^5.9` (`pnpm add -D typescript@^5.9.0`). Also, `pnpm add` may replace a linked typescript with an older version, so confirm with `tsc --version` after installing.

### 5.7 tsdown CSS reports ENOENT (module.css not found)

- **Symptom**: `ENOENT: no such file or directory, open './Xxx.module.css'`.
- **Root cause**: copying tsdown.client.ts missed the lib→src fallback in `sourceAssetPath`: the tsc output is in `lib/client/` while the css source is in `src/client/`, and the repository implementation remaps the `lib/` prefix to `src/`.
- **Fix**: when resolveId cannot find the emitted path, replace the `/lib/` segment with `/src/` and look again.

### 5.8 Other field notes

- **Polling race**: a 1s setInterval plus fetch can overlap and arrive out of order — use an in-flight flag or a sequence number and apply only the newest.
- **Response-shape validation**: `body.teams ?? []` is not enough — `Array.isArray(body.teams)` prevents flicker on a 200 with an unexpected shape.
- **setState and listeners inside a closure**: window listeners read the latest `current` through a ref, synchronised in an effect; never write a ref during the render phase.
- **Navigation closes the panel**: call `setOpen(false)` synchronously when navigating to a child session instead of waiting for the auto-collapse grace period.
- **Deletion archives**: archive review data on delete, exclude it from the live scan, and expose it through a separate `?archived=1` query.
- **Session following**: filter by `SessionListState.current + captainSessionId`; show no team while `current === undefined`.
- **Composite identity for historic data**: a repeatable business id cannot be a historic/archived key on its own; use `${ownerSessionId}:${businessId}` and match the owner on restore/dedup too. When an old event lacks an owner, pin ownership to the current session when the card activates.
- **Async unmount guards**: polling, archive fetches, timeouts and event listeners all need a cancelled flag or disposer.

## 6. Verification pyramid (fastest to slowest)

1. `pnpm typecheck` (two programs) → 2. `pnpm build` → 3. `node scripts/verify.mjs` (pure logic / file round trips)
   → 4. `dsh --profile <scratch> --dump-config` (the composition tree contains the plugin row) → 5. a real headless task
   (`dsh --profile headless "..."`, needs `DEEPSEEK_API_KEY`) → 6. a separate web instance
   (`dsh --profile <web+plugin> --patch <port>` plus curl against the roster/routes) → 7. ego-browser driving a real browser
   for GUI end to end (run a task, assert the panel/card/animation through DOM probes).

Verification always uses a **separate profile and a separate port** and never touches a running instance.
