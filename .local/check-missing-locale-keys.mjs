// Local one-shot: does any client file still ask for a locale key that the
// dictionaries no longer define? A missing key is the one client-side failure the
// type system cannot see (the translate seat takes a string), so a crash after a
// locale cleanup would look like this.
import { readFileSync, readdirSync } from 'node:fs'
import { en, zh } from '../lib/client/locales.js'

const files = readdirSync('src/client').filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
const known = new Set([...Object.keys(en), ...Object.keys(zh)])
const missing = []
const dynamic = []
for (const name of files) {
  const source = readFileSync(`src/client/${name}`, 'utf8')
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'/gu)) {
    if (!known.has(match[1])) missing.push(`${name}: ${match[1]}`)
  }
  for (const match of source.matchAll(/\bt\(\s*`([^`]+)`/gu)) dynamic.push(`${name}: ${match[1]}`)
  for (const match of source.matchAll(/\bt\(\s*([A-Za-z_$][\w$]*)/gu)) dynamic.push(`${name}: ${match[1]}`)
}
console.log('dictionary keys:', known.size)
console.log('missing static keys:', missing.length === 0 ? '(none)' : '')
for (const line of missing) console.log('  ', line)
console.log('dynamic keys (checked by hand):')
for (const line of [...new Set(dynamic)]) console.log('  ', line)
