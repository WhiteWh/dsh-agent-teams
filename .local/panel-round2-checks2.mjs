// Local one-shot (part 2): drop every verify check whose body calls a projection
// the owner removed — matched on the call, not on the label, so nothing that tests
// a surviving helper can be caught by accident.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'scripts/verify.mjs'
const lines = readFileSync(file, 'utf8').split('\n')
const removedCalls = [
  'agentSwimlanes(',
  'agentQueue(',
  'queueOverview(',
  'idleReasonSummary(',
  'taskStages(',
  'compactDagLayout(',
  'relatedTaskIds(',
  'dependencyFocusTaskId(',
  'usesParallelTaskGrid(',
  'parseActivityView(',
]

function blockEnd(start, opener) {
  let depth = 0
  for (let at = start; at < lines.length; at += 1) {
    for (const char of lines[at]) {
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
    }
    if (depth <= 0 && at >= start) return at
  }
  throw new Error(`unbalanced ${opener} at ${String(start + 1)}`)
}

const kept = []
const removed = []
let index = 0
while (index < lines.length) {
  const line = lines[index]
  const isCheck = /^(check|throws)\(/u.test(line)
  if (!isCheck) {
    kept.push(line)
    index += 1
    continue
  }
  // Resolve the label and the block extent first, then decide.
  const nextLabel = line.trimEnd().endsWith('(') ? /^\s*'([^']+)',/u.exec(lines[index + 1] ?? '')?.[1] : undefined
  const inlineLabel = /^(?:check|throws)\(\s*'([^']+)'/u.exec(line)?.[1]
  const label = inlineLabel ?? nextLabel
  const end = blockEnd(index, 'block')
  const body = lines.slice(index, end + 1).join('\n')
  const hit = removedCalls.find(call => body.includes(call))
  if (hit === undefined) {
    kept.push(...lines.slice(index, end + 1))
    index = end + 1
    continue
  }
  while (kept.length > 0 && kept[kept.length - 1].trimStart().startsWith('//')) kept.pop()
  removed.push(`${label ?? '(unlabelled)'} [${hit}] ${String(index + 1)}-${String(end + 1)}`)
  index = end + 1
}
console.log('removed', removed.length, 'checks:')
for (const entry of removed) console.log('  -', entry)
writeFileSync(file, kept.join('\n'), 'utf8')
console.log('lines', lines.length, '->', kept.length)
