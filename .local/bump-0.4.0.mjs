// Local one-shot: version 0.4.0 — package.json, the README's live references and the
// context-artifact pointer. The README script is derived from its 0.3.0 predecessor.
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = 'package.json'
const pkgText = readFileSync(pkg, 'utf8')
if (!pkgText.includes('"version": "0.3.0"')) throw new Error('package.json is not at 0.3.0')
writeFileSync(pkg, pkgText.replace('"version": "0.3.0"', '"version": "0.4.0"'))

const previous = readFileSync('.local/bump-readme-0.3.0.mjs', 'utf8')
const next = previous.replaceAll('0.3.0', '0.4.0').replaceAll('0.2.2', '0.3.0')
writeFileSync('.local/bump-readme-0.4.0.mjs', next)

let readme = readFileSync('README.md', 'utf8')
const pairs = [
  ['AgentTeams `0.3.0`', 'AgentTeams `0.4.0`'],
  ['| **`0.1.5-rc.1`** | **`0.3.0`** |', '| **`0.1.5-rc.1`** | **`0.4.0`** |'],
  ['| `0.1.2-rc.1` | `0.3.0` |', '| `0.1.2-rc.1` | `0.4.0` |'],
  ['| `0.1.2-alpha.5` | `0.3.0` |', '| `0.1.2-alpha.5` | `0.4.0` |'],
  ['| `0.1.2-alpha.2` | `0.3.0` |', '| `0.1.2-alpha.2` | `0.4.0` |'],
  ['@nanmicoder/dsh-agent-teams@0.3.0', '@nanmicoder/dsh-agent-teams@0.4.0'],
  ['`latest` tag points to `0.3.0`', '`latest` tag points to `0.4.0`'],
  ['./docs/releases/v0.3.0/README.md', './docs/releases/v0.4.0/README.md'],
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
console.log(`package.json 0.4.0; README references updated: ${String(applied)} of ${String(pairs.length)}`)
