// Local one-shot: temporarily restore the old, recorded-status worker count so the
// cap-fence scenario can be shown RED (nothing dispatched) before the fix.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'

const file = 'src/scheduler.ts'
const mode = process.argv[2]
const fixed = `function workingCount(team: TeamState): number {\r\n  return workingMemberNames(team).length\r\n}`
const broken = `function workingCount(team: TeamState): number {\r\n  return team.members.filter((member) => member.status === 'working').length\r\n}`

if (mode === 'break') {
  const source = readFileSync(file, 'utf8')
  if (!source.includes(fixed)) throw new Error('fixed form not found (line endings?)')
  writeFileSync(`${file}.fixbak`, source)
  writeFileSync(file, source.replace(fixed, broken))
  console.log('workingCount: OLD recorded-status counting restored (RED run)')
} else {
  if (!existsSync(`${file}.fixbak`)) throw new Error('no backup to restore')
  writeFileSync(file, readFileSync(`${file}.fixbak`, 'utf8'))
  unlinkSync(`${file}.fixbak`)
  console.log('workingCount: fix restored')
}
