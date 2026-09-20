// Local one-shot: print the locale values of the toggle keys (ASCII-safe output,
// so the Chinese text is never round-tripped through a shell).
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('src/client/locales.ts', 'utf8')
const keys = ['members.toggle', 'members.collapse', 'members.expand', 'checklist.title', 'checklist.collapse',
  'checklist.expand', 'phase.aria', 'phase.count', 'phase.autoHint', 'phase.column', 'phase.unphased']
const out = []
for (const key of keys) {
  const pattern = new RegExp(`'${key.replace(/\./g, '\\.')}': ('[^']*'|"[^"]*")`, 'g')
  const values = [...src.matchAll(pattern)].map((match) => match[1])
  out.push(`${key}\n    ${values.join('\n    ')}`)
}
writeFileSync('.local/logs/locale-toggle-keys.txt', out.join('\n'), 'utf8')
console.log(out.join('\n'))
