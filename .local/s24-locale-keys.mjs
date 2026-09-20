/**
 * S24 (second attempt): the phases section gained the collapsible header the
 * members list and the checklist already had. Three keys are inserted after the
 * `'phase.aria'` line of each dictionary — zh first, en second — preserving the
 * file's own line endings (git checked this file out as CRLF).
 *
 * The first attempt split the file on the `'phase.autoHint'` key and rejoined only
 * two of the three parts, which truncated the English dictionary and broke the
 * parse; that version was reverted with `git checkout -- src/client/locales.ts`.
 * This one is line-based: it cannot lose the tail.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const text = await readFile(file, 'utf8')
const lines = text.split(/(?<=\n)/)
const anchors = []
lines.forEach((line, index) => {
  if (/^\s*'phase\.aria':/.test(line)) anchors.push(index)
})
if (anchors.length !== 2) throw new Error(`expected two 'phase.aria' anchors (zh, en), found ${anchors.length}`)

const zhKeys = [
  "  'phase.toggle': '阶段（{count}）',",
  "  'phase.collapse': '收起',",
  "  'phase.expand': '展开',",
]
const enKeys = [
  "  'phase.toggle': 'Phases ({count})',",
  "  'phase.collapse': 'Collapse',",
  "  'phase.expand': 'Expand',",
]

const endingOf = (line) => line.endsWith('\r\n') ? '\r\n' : '\n'
const withEnding = (key, line) => `${key}${endingOf(line)}`

const out = []
lines.forEach((line, index) => {
  out.push(line)
  const position = anchors.indexOf(index)
  if (position === -1) return
  const keys = position === 0 ? zhKeys : enKeys
  for (const key of keys) out.push(withEnding(key, line))
})

const next = out.join('')
const count = (needle) => (next.match(new RegExp(needle, 'g')) ?? []).length
if (count("'phase\\.toggle':") !== 2 || count("'phase\\.collapse':") !== 2 || count("'phase\\.expand':") !== 2) {
  throw new Error('inserted key count is not two per dictionary')
}
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: inserted 3 keys x 2 dictionaries (${lines.length} -> ${out.length} lines)`)
