// Local one-shot: check the badge slice the verify check builds.
import { readFileSync } from 'node:fs'

const source = readFileSync('src/client/ActivityPanel.tsx', 'utf8')
const start = source.indexOf('team.members.map((member) => {')
const section = source.slice(start, source.indexOf('</div>}', start))
const badgeAt = section.indexOf('const modelBadge = ')
const badge = badgeAt === -1 ? '' : section.slice(badgeAt, section.indexOf('const portrait', badgeAt))
console.log('badge found:', badgeAt !== -1, 'length:', badge.length)
for (const probe of [
  'compactModelLabel(memberModel)',
  '<span className={css.memberModel}',
  'data-member-model={memberModel}',
  'title={memberModel}',
  'aria-label={memberModel}',
  'role="img"',
]) {
  console.log(probe.padEnd(38), badge.includes(probe))
}
console.log('{modelBadge} present:', section.includes('{modelBadge}'))
console.log('compact order:', JSON.stringify(['css.memberRoleIcon', '{modelBadge}', 'css.memberStateIcon'].map((m) => [m, section.indexOf(m)])))
console.log('large order:', JSON.stringify(['css.memberRole}', '{modelBadge}', '{stateWord}'].map((m) => [m, section.indexOf(m)])))
console.log('section end:', JSON.stringify(section.slice(-100)))
