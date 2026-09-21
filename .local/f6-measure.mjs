// Local one-shot: the measured numbers behind the F6 fix, for the record.
import { renderStatus } from '../lib/tools.js'
import { selectStatusTasks } from '../lib/status.js'

const tasks = []
for (let index = 1; index <= 183; index += 1) {
  const settled = index <= 170
  tasks.push({
    id: `t${String(index)}`,
    subject: `lane ${String(index)}`,
    status: settled ? 'completed' : index <= 175 ? 'pending' : index <= 178 ? 'in_progress' : 'failed',
    assignee: 'worker',
    dependencies: [],
    attempt: settled ? 1 : 0,
    kind: 'work',
    output: settled ? `result of lane ${String(index)}: ${'x'.repeat(280)}` : `report of lane ${String(index)}`,
    createdAt: index,
    updatedAt: index,
  })
}
const base = {
  team_name: 'dx9',
  viewer: 'captain',
  members: [{ name: 'worker', role: 'implementer', provider: 'p', model: 'm', reasoning_effort: '', status: 'idle', activity: 'idle' }],
  progress: { percent: 93, mode: 'byKind', percent_by_kind: 93, percent_equal: 93, completed: 170, total: 183, running: 3, blocked: 0, failed: 5, waived: 0, superseded: 0, cancelled: 0 },
  captain_inbox: [],
  member_inboxes: {},
  mailbox_warnings: [],
  mailbox_warning_count: 0,
}
const selection = selectStatusTasks(tasks)
const bounded = renderStatus({ ...base, tasks: selection.tasks, tasks_total: tasks.length, tasks_hidden: selection.hidden, tasks_outputs_dropped: selection.outputs_dropped })
const unbounded = renderStatus({ ...base, tasks, tasks_total: tasks.length, tasks_hidden: 0, tasks_outputs_dropped: 0 })
console.log(`default view:  shown ${String(selection.tasks.length)} of ${String(tasks.length)} (hidden ${String(selection.hidden)})`)
console.log(`rendered text: ${String(unbounded.length)} chars before → ${String(bounded.length)} chars after`)
console.log(`all tasks on request: ${String(selectStatusTasks(tasks, { live: false }).tasks.length)}, with outputs: ${String(selectStatusTasks(tasks, { live: false, include_output: true }).tasks.filter((task) => task.output !== undefined).length)}`)
console.log(`one task: ${String(selectStatusTasks(tasks, { task_id: 't7' }).tasks.length)} (with output: ${String(selectStatusTasks(tasks, { task_id: 't7' }).tasks[0]?.output !== undefined)})`)
console.log(`since 180: ${String(selectStatusTasks(tasks, { since: 180 }).tasks.length)}`)
