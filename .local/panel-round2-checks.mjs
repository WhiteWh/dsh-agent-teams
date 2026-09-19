// Local one-shot: drop the verify checks whose projections the owner removed
// (task stages, relationship chain, compact DAG layout, the queues view and the
// swimlanes) plus the parseActivityView check.
//
// A check block is delimited by paren balance starting at its `check(` line, never
// by "the next line that is a bare `)`" — an indented closer would otherwise send
// the scan to EOF and delete the rest of the file (learned the hard way).
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'scripts/verify.mjs'
const lines = readFileSync(file, 'utf8').split('\n')
const dropLabels = new Set([
  'task stages sort by depth',
  'task stages sort ids naturally',
  'non-finite depth falls back to stage 0',
  'relationship chain includes upstream dependency',
  'relationship chain includes focused task',
  'relationship chain includes downstream dependent',
  'relationship chain excludes sibling branch',
  'pinned dependency chain wins over keyboard and hover previews',
  'keyboard dependency chain wins over delayed hover preview',
  'hover dependency chain is used without a pinned or keyboard task',
  'relationship traversal is cycle-safe',
  'edge-free tasks switch to the fill-width parallel grid',
  'a real dependency keeps the layered DAG layout',
  'compact DAG lays dependency depths out left-to-right',
  'compact DAG keeps stable rows and reference node geometry',
  'compact DAG emits one curved SVG edge per valid dependency',
  'persisted view choice falls back to the dependency tree',
])

/** End line index (inclusive) of a parenthesised block that starts at `start`. */
function blockEnd(start) {
  let depth = 0
  for (let at = start; at < lines.length; at += 1) {
    const text = lines[at]
    for (const char of text) {
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0 && at > start) return at
        if (depth === 0) return at
      }
    }
  }
  throw new Error(`unbalanced block at line ${String(start + 1)}`)
}

const kept = []
const removed = []
let index = 0
while (index < lines.length) {
  const line = lines[index]
  const inlineLabel = /^check\(\s*'([^']+)'/u.exec(line)?.[1]
  const nextLabel = line.trimEnd() === 'check(' ? /^\s*'([^']+)',/u.exec(lines[index + 1] ?? '')?.[1] : undefined
  const label = inlineLabel ?? nextLabel
  if (label !== undefined && dropLabels.has(label)) {
    while (kept.length > 0 && kept[kept.length - 1].trimStart().startsWith('//')) kept.pop()
    const end = blockEnd(index)
    removed.push(`${label} (${String(index + 1)}-${String(end + 1)})`)
    index = end + 1
    continue
  }
  kept.push(line)
  index += 1
}
console.log('removed', removed.length, 'checks:')
for (const entry of removed) console.log('  -', entry)
writeFileSync(file, kept.join('\n'), 'utf8')
console.log('lines', lines.length, '->', kept.length)
