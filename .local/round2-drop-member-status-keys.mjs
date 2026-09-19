/**
 * Round 2 follow-up: the compact member line replaced the long member status
 * sentence, so `member.status.*` lost its only renderer (`memberStatusText`).
 * Drop those keys from both dictionaries by ASCII key pattern — the Chinese
 * values are never decoded or rewritten.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const src = await readFile(file, 'utf8')
const lines = src.split('\n')
const kept = []
const dropped = []
for (const line of lines) {
  if (/^  'member\.status\.[a-zA-Z]+':/.test(line)) {
    dropped.push(line.slice(0, line.indexOf(':')))
    continue
  }
  kept.push(line)
}
if (dropped.length !== 26) throw new Error(`expected 26 keys (13 x 2 dictionaries), found ${dropped.length}`)
await writeFile(file, kept.join('\n'))
console.log(`locales.ts: dropped ${dropped.length} keys`)
for (const key of dropped) console.log(`  ${key}`)
