// Local one-shot: bump the README's live version references from 0.2.0 to 0.2.1.
// Release-note links keep their own versions, so those lines are matched exactly.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'README.md'
let text = readFileSync(file, 'utf8')
const pairs = [
  ['AgentTeams `0.2.0`', 'AgentTeams `0.2.1`'],
  ['| **`0.1.5-rc.1`** | **`0.2.0`** |', '| **`0.1.5-rc.1`** | **`0.2.1`** |'],
  ['| `0.1.2-rc.1` | `0.2.0` |', '| `0.1.2-rc.1` | `0.2.1` |'],
  ['| `0.1.2-alpha.5` | `0.2.0` |', '| `0.1.2-alpha.5` | `0.2.1` |'],
  ['| `0.1.2-alpha.2` | `0.2.0` |', '| `0.1.2-alpha.2` | `0.2.1` |'],
  ['@nanmicoder/dsh-agent-teams@0.2.0', '@nanmicoder/dsh-agent-teams@0.2.1'],
  ['`latest` tag points to `0.2.0`', '`latest` tag points to `0.2.1`'],
  ['./docs/releases/v0.2.0/README.md', './docs/releases/v0.2.1/README.md'],
]
let applied = 0
for (const [from, to] of pairs) {
  if (!text.includes(from)) {
    console.log('MISS', from)
    continue
  }
  text = text.split(from).join(to)
  applied += 1
}
writeFileSync(file, text, 'utf8')
console.log('applied', applied, 'of', pairs.length)
