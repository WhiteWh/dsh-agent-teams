/**
 * The per-phase progress bar (owner request, 2026-09-21): one bar split into the plan's
 * phases, each with its own percentage, and the overall number on its own line.
 * Two keys per dictionary, inserted after `'progress.segment.title'`.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const text = await readFile(file, 'utf8')
const lines = text.split(/(?<=\n)/)
const anchors = []
lines.forEach((line, index) => {
  if (/^\s*'progress\.segment\.title':/.test(line)) anchors.push(index)
})
if (anchors.length !== 2) throw new Error(`expected two 'progress.segment.title' anchors, found ${anchors.length}`)

const zhKeys = [
  "  'progress.phase.title': '{label} · {percent}% · {completed}/{total}',",
  "  'progress.phase.legend': '{label} {percent}% · {completed}/{total}',",
]
const enKeys = [
  "  'progress.phase.title': '{label} · {percent}% · {completed}/{total}',",
  "  'progress.phase.legend': '{label} {percent}% · {completed}/{total}',",
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
for (const key of ['progress.phase.title', 'progress.phase.legend']) {
  const found = (next.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) ?? []).length
  if (found !== 2) throw new Error(`${key} appears ${String(found)} times, expected 2`)
}
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: added 2 keys x 2 dictionaries (${lines.length} -> ${out.length} lines)`)
