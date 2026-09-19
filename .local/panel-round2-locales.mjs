// Local one-shot: drop the locale keys whose components are gone — the view
// switcher (`view.*`), the queues view (`queue.*`), the tree's dependency hints
// (`dependency.*`) and the assignment label the compact member row no longer
// renders. Both dictionaries are edited together so a key can never exist in one
// language only.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/locales.ts'
const lines = readFileSync(file, 'utf8').split('\n')
const prefixes = ['view.', 'queue.', 'dependency.', 'assignment.']
const kept = []
const removed = []
for (const line of lines) {
  const key = /^\s*'([^']+)':/u.exec(line)?.[1]
  if (key !== undefined && prefixes.some(prefix => key.startsWith(prefix))) {
    removed.push(key)
    continue
  }
  kept.push(line)
}
console.log('removed', removed.length, 'keys:', [...new Set(removed.map(key => key.split('.')[0]))].join(', '))
writeFileSync(file, kept.join('\n'), 'utf8')
