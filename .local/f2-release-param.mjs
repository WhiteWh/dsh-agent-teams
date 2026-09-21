// Local one-shot: the replan tool's `release` parameter (Φ1/F2).
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/tools.ts'
let source = readFileSync(file, 'utf8')
if (source.includes('release: { type:')) {
  console.log('already present')
} else {
  const anchor = "            force: { type: 'boolean', description: 'amend_task / accept_paths:"
  if (!source.includes(anchor)) throw new Error('force anchor not found')
  const added = "            release: { type: 'boolean', description: 'update_task: clear a stale handoff marker (reassigning) on a task nobody holds, so a pooled lane the captain invalidated can be claimed or reassigned again. Refused while a member holds a live attempt — revoke that with invalidate=true.' },\n"
  source = source.replace(anchor, added + anchor)
  writeFileSync(file, source)
  console.log('replan release parameter added')
}
