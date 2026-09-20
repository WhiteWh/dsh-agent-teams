/**
 * S26: one locale key for a closed phase — the board marks its column and the
 * running-plan editor disables it as a target. Inserted after `'phase.count'` in
 * each dictionary (zh first, en second), preserving the file's line endings.
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

const zhKey = "  'phase.closed': '已关闭',"
const enKey = "  'phase.closed': 'Closed',"
const endingOf = (line) => line.endsWith('\r\n') ? '\r\n' : '\n'
const out = []
lines.forEach((line, index) => {
  out.push(line)
  const position = anchors.indexOf(index)
  if (position !== -1) out.push(`${position === 0 ? zhKey : enKey}${endingOf(line)}`)
})

const next = out.join('')
if ((next.match(/'phase\.closed':/g) ?? []).length !== 2) throw new Error('phase.closed is not two per dictionary')
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: added phase.closed (${lines.length} -> ${out.length} lines)`)
