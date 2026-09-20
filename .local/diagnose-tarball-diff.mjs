/**
 * Read-only diagnosis #3: file-by-file diff between the artifact that ran (0.2.0)
 * and the one that took the web profile down (0.2.2). Whatever differs here is the
 * whole candidate set for the crash.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const listing = (tarball) => execFileSync('tar', ['-tzf', tarball], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split(/\r?\n/u)
  .filter((line) => line !== '' && !line.endsWith('/'))
  .sort()

const read = (tarball, entry) => execFileSync('tar', ['-xzOf', tarball, entry], { maxBuffer: 256 * 1024 * 1024 })

const older = '.local/dist/nanmicoder-dsh-agent-teams-0.2.0.tgz'
const newer = '.local/dist/nanmicoder-dsh-agent-teams-0.2.2.tgz'
const olderFiles = listing(older)
const newerFiles = listing(newer)

console.log('=== files only in 0.2.0 ===')
console.log(olderFiles.filter((file) => !newerFiles.includes(file)).join('\n') || '(none)')
console.log('=== files only in 0.2.2 ===')
console.log(newerFiles.filter((file) => !olderFiles.includes(file)).join('\n') || '(none)')

console.log('\n=== files whose bytes changed (0.2.0 -> 0.2.2) ===')
const changed = []
for (const file of olderFiles.filter((entry) => newerFiles.includes(entry))) {
  // The two package.json files differ by the version line only; compare everything else by hash.
  const a = sha256(read(older, file))
  const b = sha256(read(newer, file))
  if (a !== b) changed.push(file)
}
console.log(changed.join('\n') || '(none)')

console.log('\n=== the two files that matter for loading ===')
for (const file of ['package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml']) {
  const a = read(older, file)
  const b = read(newer, file)
  console.log(`${file}\n  0.2.0 ${String(a.length)} bytes ${sha256(a).slice(0, 16)}…\n  0.2.2 ${String(b.length)} bytes ${sha256(b).slice(0, 16)}…\n  identical: ${sha256(a) === sha256(b) ? 'YES' : 'NO'}`)
}
