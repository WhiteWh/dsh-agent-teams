/**
 * The error boundary's one line. Inserted after `'activity.badgeAria'` in each
 * dictionary (zh first, en second), preserving the file's line endings.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const text = await readFile(file, 'utf8')
const lines = text.split(/(?<=\n)/)
const anchors = []
lines.forEach((line, index) => {
  if (/^\s*'activity\.badgeAria':/.test(line)) anchors.push(index)
})
if (anchors.length !== 2) throw new Error(`expected two 'activity.badgeAria' anchors, found ${anchors.length}`)

const zhKey = "  'panel.error': 'AgentTeams 面板出错：{error}',"
const enKey = "  'panel.error': 'AgentTeams panel failed: {error}',"
const endingOf = (line) => line.endsWith('\r\n') ? '\r\n' : '\n'
const out = []
lines.forEach((line, index) => {
  out.push(line)
  const position = anchors.indexOf(index)
  if (position !== -1) out.push(`${position === 0 ? zhKey : enKey}${endingOf(line)}`)
})

const next = out.join('')
if ((next.match(/'panel\.error':/g) ?? []).length !== 2) throw new Error('panel.error is not two per dictionary')
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: added panel.error (${lines.length} -> ${out.length} lines)`)
