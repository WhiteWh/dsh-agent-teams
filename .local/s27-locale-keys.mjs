/**
 * S27: the three progress legend labels plus the tooltip template, one dictionary
 * each. Inserted after `'progress.percent'` in both halves (zh first, en second).
 * Placeholders must match across dictionaries — the tooltip carries all four.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const text = await readFile(file, 'utf8')
const lines = text.split(/(?<=\n)/)
const anchors = []
lines.forEach((line, index) => {
  if (/^\s*'progress\.percent':/.test(line)) anchors.push(index)
})
if (anchors.length !== 2) throw new Error(`expected two 'progress.percent' anchors, found ${anchors.length}`)

const zhKeys = [
  "  'progress.segment.plan': '原始计划',",
  "  'progress.segment.added': '过程中追加',",
  "  'progress.segment.followup': '计划完成后追加',",
  "  'progress.segment.title': '{label} · {percent}% · {completed}/{total}',",
]
const enKeys = [
  "  'progress.segment.plan': 'Original plan',",
  "  'progress.segment.added': 'Added while running',",
  "  'progress.segment.followup': 'Added after the plan',",
  "  'progress.segment.title': '{label} · {percent}% · {completed}/{total}',",
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
for (const key of ['plan', 'added', 'followup', 'title']) {
  const found = (next.match(new RegExp(`'progress\\.segment\\.${key}':`, 'g')) ?? []).length
  if (found !== 2) throw new Error(`progress.segment.${key} appears ${String(found)} times, expected 2`)
}
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: added 4 progress.segment keys x 2 dictionaries (${lines.length} -> ${out.length} lines)`)
