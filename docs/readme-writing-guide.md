# README writing guide for DSH plugins

> Section template and writing rules for a coding agent writing a DeepSeek Harness plugin README.
> Distilled from several iterations of the finished `dsh-agent-teams` README (features, how it works, UI, tools, install, config, usage, verification, limits) and cross-checked against the in-repo package READMEs in the DSH repository (`packages/preset`, `packages/bundle`, `packages/client/ui-workflow-run`: terse and table-driven).

## 0. Language and length policy

- **All documentation in this repository is written in English.** Commands, tool names, identifiers and field names stay English too. (A Chinese README is not maintained; the plugin's own UI strings still follow the host locale, which is a product feature, not documentation.)
- **A standalone plugin project** (aimed at installing users, such as `dsh-agent-teams`): one-sentence value plus the full structure below.
- **An in-repo DSH package** (`packages/*/README.md`): mostly a paragraph of introduction plus sections and tables, a few paragraphs per section; an in-repo README serves maintainers and contributors and does not need an install/usage tutorial.
- The template below is isomorphic for both: the section order stays fixed, while length and depth follow the reader.
- **Length**: a standalone plugin README caps at 200–400 lines; past that, some section is piling up implementation detail (see the avoid list in section 2).

## 1. Structure template (order of the top-level headings)

| # | Section | Write | Do not write |
|---|---|---|---|
| 1 | Introduction (one paragraph under the title) | one-sentence value (what the user can do after installing) + 3–5 core features (bold keywords) | version history, roadmap, acknowledgements |
| 2 | `## How it works` | capability-seam table + one-sentence data flow + one-sentence state machine (see section 2) | architecture diagrams, pasted source, detail dumps |
| 3 | `## Web UI` (if any) | panel shape, mount position, interaction points, data path | every CSS class, every animation parameter |
| 4 | `## Tools` | table: tool name \| purpose (one sentence with the key semantics/boundaries) | the full parameter schema |
| 5 | `## Install` | command + when it takes effect (restart/HMR) + alternatives | internals of the build chain |
| 6 | `## Configuration` | field table + one YAML example | where each field is read in the source |
| 7 | `## Usage` | one paragraph + one copy-pasteable example instruction | a full conversation script |
| 8 | `## Verification` | three layers: 0 real evidence already gathered / 1 offline / 2 end-to-end (see section 4) | writing "not verified" as "verified" |
| 9 | `## Known limitations` | each item = symptom + cause/impact + mitigation (see section 5) | self-criticism, complaints without mitigation |
| 10 | `## License` | the licence name | — |

## 2. How to write "How it works"

**Open with the capability-seam table** (this is the architectural language of a DSH plugin — everything is a plugin, and capabilities are seams):

```markdown
`<plugin name>` reuses DSH's capability seams instead of reinventing them:

| DSH capability | How the plugin uses it |
|---|---|
| `ctx.tools` registry | registers N `xxx_*` tools (the same registration path as `tool-workflow`) |
| `ctx.subagents.startContinuable()` | creates a member: a durable, continuable subagent |
| `ctx.systemPrompt.section()` | registers the usage-policy prompt section |
| `ctx.httpServer.register()` | serves the panel data route `/plugins/xxx/state` |
| filesystem | state is persisted under `<workspace>/.xxx/<id>/` |
```

- List **the capabilities actually used**, one line "DSH capability → plugin purpose" each; this is the fastest way for a reader to judge how the plugin fits into DSH.
- Follow the table with **one sentence of data flow**: "tool execution → on-disk state (source of truth) → host snapshot route → overlay rendering on a poll. Session-log events keep being written (replay/audit)." (One directional chain; no big ASCII diagram.)
- **One sentence of state machine**: "Task state machine: `pending → claimed → in_progress → completed | failed | cancelled`, with transitions checked against an allowlist." (A state machine that fits one sentence never gets several paragraphs.)
- When referencing a file, give only the **entry path** (such as `src/snapshot.ts`); never paste code.
- **Avoid**: architecture diagrams (ASCII/plantuml), implementation-detail dumps (locks, queues, retry policy), and repeating mechanisms already explained in the repository's AGENTS.md.

## 3. Install and configuration

**The install command must be copy-pasteable** (absolute paths / an explicit cd):

````markdown
```sh
cd /path/to/<plugin>
pnpm build            # emits lib/
dsh plugin --profile web add /absolute/path/to/<plugin>
```
````

- State in one sentence what happens on install (`dsh plugin` installs into the profile and adds it to the `dsh.profile.bundles` layer list; the bundle patch mounts the host composition row).
- **Always state when it takes effect**: "> Note: `dsh plugin` modifies that profile's `package.json`/manifest; the plugin loads only **after restarting the dsh service**."
- The configuration section uses a **table plus one YAML example**:

```markdown
| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `.agent-teams` | state directory name (under the workspace) |
| `memberProvider` | `spawn` | the member subagent provider |
| `memberMaxDepth` | `1` | member re-delegation depth ceiling (`0` = forbidden) |
```

- **Put compatibility/deployment differences in a quoted note block** (reusable pattern 3), but ground it in the target deployment's source:

```markdown
> Compatibility note: the DSH checkout this plugin targets discovers the browser bundle through
> package.json `dsh.client` and `exports["./client"]`; if the deployed version differs, check its
> client-modules implementation first.
```

## 4. The verification section (three layers)

The verification section carries the README's credibility and must be **layered and honest about "verified / not yet verified"**:

| Layer | Heading | Content | Precondition |
|---|---|---|---|
| 0 | `### 0. Verified on a separate instance` | a checklist of runs that really happened (model name, command, artifact evidence); **every line is a fact that occurred** | actually executed |
| 1 | `### 1. Offline verification (no service needs to start)` | copy-pasteable build/smoke/composition commands | none |
| 2 | `### 2. End-to-end verification (needs a restart; schedule it yourself)` | the GUI/headless steps for the user | the user picks the moment |

- **Layer 0 record template** (record at this granularity):
  - headless profile end to end: `dsh --profile headless "..."` (a real LLM completing the whole flow);
  - on-disk/log verification: the session log contains the full event stream (list the event names and counts, e.g. `team-created x1, member-added x2...`);
  - UI load chain: the browser roster contains the plugin, `GET /plugins/xxx/client.js -> 200`, the data route's response shape;
  - GUI end to end: panel behaviour after driving a real browser (auto-expand, state updates, collapse) with the screenshot path.
- **Command rules**: all copy-pasteable (starting with `cd /path/...`, comments noting the expected output such as "you should see N lines"); a check that claims it "does not touch the running profile / does not boot a service" must say so.
- **Principle**: layer 0 records only what really happened, layer 1 is the developer's self-check entry point, layer 2 is left for the user to reproduce on their own instance — all three are required, and mixing them destroys trust.

## 5. How to write "Known limitations"

- Each limitation = **symptom + cause/impact + mitigation**, all inside one bullet. For example:
  - "A member acts only after receiving a message (being woken); there is no permanent polling. ... while the captain is offline a message stays in the mailbox and is delivered at the captain's next operation." (symptom → impact → mitigation path)
  - "A member (model) does not always follow the tool 'ritual' (for example it skips `update_task` on completion) — the panel reflects the persisted state faithfully, so the captain summarises from `agent_teams_status`/the files rather than from a member's claim."
- **Why it matters**: the limitations section is the negative space of the behaviour contract — it pre-answers what a user will inevitably hit ("why does the task still show as unfinished?"), stops a design trade-off from being misread as a bug, and becomes the TODO list for the next iteration.
- Write **real limits rather than platitudes**: design trade-offs (file-level persistence, one captain one team), environment dependencies (prefer `shell.overlay` and fall back to a self-managed portal only on an older version without the slot; yield space on a wide screen and overlay on a narrow one), model behaviour (skipping the ritual), boundaries (an old session has no historic events).
- Give every item a **mitigation or a pointer** ("treat status as authoritative", "delivered at the captain's next operation"); never leave an unsolvable complaint.

## 6. Five reusable patterns (distilled from `dsh-agent-teams`)

1. **Open with the capability-seam table**: always start the architecture explanation with a "DSH capability | plugin usage" table — it builds the "how does this fit into DSH" mental model faster than any prose.
2. **Every verification command is copy-pasteable**: `cd /path/to/...` + absolute paths + comments naming the expected output, so the user can paste and run instead of reading a picture.
3. **Put compatibility/deployment differences in a quoted note block** (`> Compatibility note: ...`): isolate one-off background such as "how the target version discovers the client bundle" and "which changes need a restart" from the body text, keeping the body clean.
4. **Compress the state machine and the data flow into one sentence each**: the transition list on one line, the data path as one arrow chain; a state machine that fits one sentence never gets several paragraphs, and detail that must be expanded goes into code/file references.
5. **Put "really verified" first in the verification section and grade it honestly**: layer 0 (verified, with evidence) → layer 1 (offline self-check) → layer 2 (you reproduce it) — trust comes from separating "I ran it" from "you run it".

## 7. Completion checklist

- [ ] the introduction answers in one sentence what a user can do after installing the plugin
- [ ] "How it works" opens with the capability-seam table, with the data flow and state machine one sentence each
- [ ] the install command is copy-pasteable and states when it takes effect (restart)
- [ ] the configuration has a field/default/meaning table
- [ ] verification has three layers, and layer 0 contains only runs that really happened (with commands and evidence)
- [ ] every known limitation includes a mitigation path
- [ ] no pasted source, no large architecture diagram, no implementation detail sold as a feature
