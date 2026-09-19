# Project maintenance skills

Before using a DSH plugin lifecycle skill in this repository, read `skills/README.md` for its source, version, and project-specific applicability. Prefer the project copy when a global skill has the same name.

Vendored skills are community guidance. Historical version examples are not the current support policy; verify exact Harness tags, npm artifacts, the resolved dependency graph, and AgentTeams behavior. Preserve upstream skill files; record local integration rules separately.

User instructions and authorization take precedence over skill defaults. Do not repeat confirmation for work the user has already authorized.

# Browser automation

For interactive browser automation, use the `ego-browser` skill from Ego Lite. Do not use `agent-browser` or another browser-control skill unless the user explicitly requests it or Ego Lite is unavailable.

# Local working copy

This checkout is patched locally and its environment facts are not upstream's. Read `.local/SETUP.md` before running a build, a verification layer, or an install: it lists the pinned pnpm invocation, the SocratiCode project name, which suites run under this machine's sandbox and which are blocked by it, and the scratch DSH profile used to exercise source changes. Keep local notes, logs and scripts under `.local/`; leave upstream files byte-identical.

# Documentation language policy

All documentation in this repository is written in English. Chinese is a legacy
state, frozen and not maintained.

- **Do not read Chinese documents.** The dated audits under `docs/*-audit-*`,
  `docs/maintenance-*`, `docs/releases/`, `docs/session-latency-audit-*`,
  `docs/theme-support-*`, `docs/upgrade-skill-study-*`, `README_ZH.md`, the
  release notes older than the current one, and the vendored skill files are
  excluded from the code index as well as from the working set. When work needs
  a fact from one of them, ask the owner for it or re-derive it from the code,
  the tests, or a fresh run — do not quote or re-translate the old prose.
- **Do not maintain Chinese text.** Never update, extend, reformat or re-sync it:
  no new Chinese sections, no Chinese copies of new documents, no keeping a
  translation in step with its English source.
- **English only for anything new.** New documents, sections, comments, help
  text and release notes are written in English. The plugin's own UI strings are
  product behavior, not documentation: the `zh` dictionary in
  `src/client/locales.ts` keeps following the host locale, and the CJK matchers
  in `src/client/artwork.ts` and `src/quality-gates.ts` are functional code.
- **The old files stay on disk.** They are excluded from the index and left
  untouched so their bytes, hashes and evidence links stay valid; deleting them
  requires an explicit owner instruction.
