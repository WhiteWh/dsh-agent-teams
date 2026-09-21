/**
 * Φ1/F7.3 + F7.4: the keys the panel needs for the phase roll-up, the plan's own lane
 * id and the "verified" marker. Inserted after `'phase.count'` in both dictionaries.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const text = await readFile(file, 'utf8')
const lines = text.split(/(?<=\n)/)
const anchors = []
lines.forEach((line, index) => {
  if (/^\s*'phase\.count':/.test(line)) anchors.push(index)
})
if (anchors.length !== 2) throw new Error(`expected two 'phase.count' anchors, found ${anchors.length}`)

const zhKeys = [
  "  'phase.progress': '{done}/{total} 完成',",
  "  'phase.failedCount': '{count} 失败',",
  "  'phase.verifiedCount': '{count} 已验证',",
  "  'task.verified': '已通过评审/验证',",
]
const enKeys = [
  "  'phase.progress': '{done}/{total} done',",
  "  'phase.failedCount': '{count} failed',",
  "  'phase.verifiedCount': '{count} verified',",
  "  'task.verified': 'Judged by a passing review or verification',",
]

const endingOf = (line) => line.endsWith('\r\n') ? '\r\n' : '\n'
const out = []
lines.forEach((line, index) => {
  out.push(line)
  const position = anchors.indexOf(index)
  if (position === -1) return
  for (const key of (position === 0 ? zhKeys : enKeys)) out.push(`${key}${endingOf(line)}`)
})

const next = out.join('')
for (const key of ['phase.progress', 'phase.failedCount', 'phase.verifiedCount', 'task.verified']) {
  const found = (next.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) ?? []).length
  if (found !== 2) throw new Error(`${key} appears ${String(found)} times, expected 2`)
}
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: added 4 keys x 2 dictionaries (${lines.length} -> ${out.length} lines)`)
