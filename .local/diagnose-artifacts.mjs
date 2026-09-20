/**
 * Read-only diagnosis #2: is the artifact the profile installed intact, and how does
 * its client bundle differ from the 0.2.0 one that ran fine?
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const readTarEntry = (tarball, entry) => execFileSync('tar', ['-xzOf', tarball, entry], { maxBuffer: 64 * 1024 * 1024 })

const artifacts = {
  '0.2.0 (ran fine)': '.local/dist/nanmicoder-dsh-agent-teams-0.2.0.tgz',
  '0.2.1': '.local/dist/nanmicoder-dsh-agent-teams-0.2.1.tgz',
  '0.2.2 (installed)': '.local/dist/nanmicoder-dsh-agent-teams-0.2.2.tgz',
}
const installedBundle = 'C:/Users/whitl/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/client.js'
const installed = readFileSync(installedBundle)

for (const [label, tarball] of Object.entries(artifacts)) {
  if (!existsSync(tarball)) {
    console.log(`${label}: artifact missing at ${tarball}`)
    continue
  }
  const tarballBytes = readFileSync(tarball)
  const client = readTarEntry(tarball, 'package/lib/client.js')
  const host = readTarEntry(tarball, 'package/lib/index.js')
  console.log(`${label}`)
  console.log(`  tarball     ${String(tarballBytes.length)} bytes  sha256 ${sha256(tarballBytes).slice(0, 16)}…`)
  console.log(`  lib/client.js ${String(client.length)} bytes  sha256 ${sha256(client).slice(0, 16)}…`)
  console.log(`  lib/index.js  ${String(host.length)} bytes`)
  if (label.startsWith('0.2.2')) {
    console.log(`  installed copy identical: ${sha256(client) === sha256(installed) ? 'YES' : 'NO'}`)
  }
  const specifiers = [...new Set([...client.toString('utf8').matchAll(/['"](@deepseek-ai\/[^'"]+)['"]/gu)].map((m) => m[1]))].sort()
  console.log(`  host specifiers: ${specifiers.join(', ') || '(none)'}`)
  const firstLine = client.toString('utf8').slice(0, 120).replace(/\n/gu, '\\n')
  console.log(`  bundle head: ${firstLine}`)
  console.log('')
}

// Does the 0.2.2 bundle reference anything the 0.2.0 bundle did not?
const bundleOf = (tarball) => readTarEntry(tarball, 'package/lib/client.js').toString('utf8')
const older = bundleOf(artifacts['0.2.0 (ran fine)'])
const newer = bundleOf(artifacts['0.2.2 (installed)'])
const idsOf = (text) => new Set([...text.matchAll(/require\(\s*['"]([^'"]+)['"]/gu)].map((m) => m[1]))
const olderIds = idsOf(older)
const newerIds = idsOf(newer)
console.log('=== module ids required by 0.2.2 but not by 0.2.0 ===')
console.log([...newerIds].filter((id) => !olderIds.has(id)).join('\n') || '(none)')
console.log('=== module ids required by 0.2.0 but not by 0.2.2 ===')
console.log([...olderIds].filter((id) => !newerIds.has(id)).join('\n') || '(none)')
console.log('=== loader registration line of each ===')
for (const [label, text] of [['0.2.0', older], ['0.2.2', newer]]) {
  const match = /__ModuleLoader__\.load\([^\n]{0,160}/u.exec(text)
  console.log(`${label}: ${match === null ? 'NOT FOUND' : match[0]}`)
}
writeFileSync(join(mkdtempSync(join(tmpdir(), 'dsh-diag-')), 'note.txt'), 'diagnosis only\n')
