// Local one-shot: version 0.4.1 — package.json, the README's live references and the
// context-artifact pointer (the release-notes file already exists).
import { readFileSync, writeFileSync } from 'node:fs'

const pkgText = readFileSync('package.json', 'utf8')
if (!pkgText.includes('"version": "0.4.0"')) throw new Error('package.json is not at 0.4.0')
writeFileSync('package.json', pkgText.replace('"version": "0.4.0"', '"version": "0.4.1"'))

let readme = readFileSync('README.md', 'utf8')
const pairs = [
  ['AgentTeams `0.4.0`', 'AgentTeams `0.4.1`'],
  ['| **`0.1.5-rc.1`** | **`0.4.0`** |', '| **`0.1.5-rc.1`** | **`0.4.1`** |'],
  ['| `0.1.2-rc.1` | `0.4.0` |', '| `0.1.2-rc.1` | `0.4.1` |'],
  ['| `0.1.2-alpha.5` | `0.4.0` |', '| `0.1.2-alpha.5` | `0.4.1` |'],
  ['| `0.1.2-alpha.2` | `0.4.0` |', '| `0.1.2-alpha.2` | `0.4.1` |'],
  ['@nanmicoder/dsh-agent-teams@0.4.0', '@nanmicoder/dsh-agent-teams@0.4.1'],
  ['`latest` tag points to `0.4.0`', '`latest` tag points to `0.4.1`'],
  ['./docs/releases/v0.4.0/README.md', './docs/releases/v0.4.1/README.md'],
]
let applied = 0
for (const [from, to] of pairs) {
  if (!readme.includes(from)) {
    console.log('MISS', from)
    continue
  }
  readme = readme.split(from).join(to)
  applied += 1
}
writeFileSync('README.md', readme)

const artifacts = readFileSync('.socraticodecontextartifacts.json', 'utf8')
if (!artifacts.includes('./release-notes/v0.4.1.md')) {
  const moved = artifacts.replace('"./release-notes/v0.4.0.md"', '"./release-notes/v0.4.1.md"')
  if (moved === artifacts) throw new Error('the 0.4.0 pointer was not found')
  writeFileSync('.socraticodecontextartifacts.json', moved)
}
console.log(`package.json 0.4.1; README references updated: ${String(applied)} of ${String(pairs.length)}; artifact pointer moved`)
