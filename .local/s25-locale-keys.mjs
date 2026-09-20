/**
 * S25: the large member node is the default again, so the strings its second line,
 * its role words and its labelled chip row need come back — the thirteen
 * `member.status.*` keys and the four `assignment.*` keys that round 2 deleted with
 * the old layout (values taken from `09ac60e:src/client/locales.ts`), plus the two
 * new labels of the per-member collapse control.
 *
 * Line-based insertion after `'member.state.stopped'` in each dictionary half:
 * zh first, en second. It preserves the file's own line endings.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/locales.ts', import.meta.url)
const text = await readFile(file, 'utf8')
const lines = text.split(/(?<=\n)/)
const anchors = []
lines.forEach((line, index) => {
  if (/^\s*'member\.state\.stopped':/.test(line)) anchors.push(index)
})
if (anchors.length !== 2) throw new Error(`expected two 'member.state.stopped' anchors, found ${anchors.length}`)

const zhKeys = [
  "  'member.status.executing': '正在执行 {taskId}',",
  "  'member.status.executingModel': '正在执行 {taskId} · {model}',",
  "  'member.status.working': '正在处理已派任务',",
  "  'member.status.waitingOn': '等待 {taskId} · {assignee}',",
  "  'member.status.waitingPrerequisite': '等待前置任务',",
  "  'member.status.waitingAssignment': '等待队长派工',",
  "  'member.status.delivered': '任务已交付',",
  "  'member.status.idle': '待继续执行',",
  "  'member.status.unknown': '状态未知',",
  "  'member.status.staged': '确认后创建并启动',",
  "  'member.status.settled': '任务均已终结',",
  "  'member.status.discarded': '计划已放弃，未创建',",
  "  'member.status.stopped': '团队已停止，需显式恢复',",
  "  'member.collapseRow': '收起该成员',",
  "  'member.expandRow': '展开该成员',",
  "  'assignment.label': '队长派发',",
  "  'assignment.staged': '计划任务',",
  "  'assignment.discarded': '未执行的计划',",
  "  'assignment.empty': '暂无任务',",
]
const enKeys = [
  "  'member.status.executing': 'Working on {taskId}',",
  "  'member.status.executingModel': 'Working on {taskId} · {model}',",
  "  'member.status.working': 'Working on assigned tasks',",
  "  'member.status.waitingOn': 'Waiting for {taskId} · {assignee}',",
  "  'member.status.waitingPrerequisite': 'Waiting for prerequisites',",
  "  'member.status.waitingAssignment': 'Waiting for the captain to assign work',",
  "  'member.status.delivered': 'Tasks delivered',",
  "  'member.status.idle': 'Ready to continue',",
  "  'member.status.unknown': 'Status unknown',",
  "  'member.status.staged': 'Will be spawned after approval',",
  "  'member.status.settled': 'All assigned work is settled',",
  "  'member.status.discarded': 'Plan discarded; member was not created',",
  "  'member.status.stopped': 'Team stopped; explicit resume required',",
  "  'member.collapseRow': 'Collapse this member',",
  "  'member.expandRow': 'Expand this member',",
  "  'assignment.label': 'Captain assigned',",
  "  'assignment.staged': 'Planned task',",
  "  'assignment.discarded': 'Plan not run',",
  "  'assignment.empty': 'No tasks',",
]

const endingOf = (line) => line.endsWith('\r\n') ? '\r\n' : '\n'
const out = []
lines.forEach((line, index) => {
  out.push(line)
  const position = anchors.indexOf(index)
  if (position === -1) return
  for (const key of (position === 0 ? zhKeys : enKeys)) out.push(`${key}${endingOf(line)}`)
})

const next = out.join('')
const count = (needle) => (next.match(new RegExp(needle, 'g')) ?? []).length
if (count("'member\\.status\\.") !== 26) throw new Error(`member.status keys: ${String(count("'member\\.status\\."))}`)
if (count("'assignment\\.") !== 8) throw new Error(`assignment keys: ${String(count("'assignment\\."))}`)
if (count("'member\\.(collapse|expand)Row'") !== 4) throw new Error('collapse/expand labels are not two per dictionary')
if (!next.trimEnd().endsWith(') => string')) throw new Error('the file tail moved — aborting')
await writeFile(file, next)
console.log(`locales.ts: restored 13 member.status + 4 assignment keys and added 2 control labels (${lines.length} -> ${out.length} lines)`)
