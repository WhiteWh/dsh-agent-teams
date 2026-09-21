// Local one-shot: add the `label` parameter to create_task and to the replan operation,
// and carry it onto the created task.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/tools.ts'
let source = readFileSync(file, 'utf8')
const before = source

const createAnchor = "      phase: { type: 'string', description: 'Phase id to place this task in."
const createParam = "      label: { type: 'string', description: \"The plan's own human id for this lane (L.2, G.4, P4.3, …). It is shown next to the plugin's tN wherever the panel or the report names the task.\" },\n"
if (!source.includes(createAnchor)) throw new Error('create_task phase anchor not found')
if (source.includes("label: { type: 'string', description: \"The plan's own human id")) throw new Error('already applied')
source = source.replace(createAnchor, createParam + createAnchor)

const replanAnchor = "            subject: { type: 'string', description: 'add_task: the new task title."
const replanParam = "            label: { type: 'string', description: \"add_task: the plan's own human id for the lane (G.4, P4.3, …).\" },\n"
if (!source.includes(replanAnchor)) throw new Error('replan subject anchor not found')
source = source.replace(replanAnchor, replanParam + replanAnchor)

// create_task: put the label on the task it writes.
const taskAnchor = '          id: `t${fresh.taskSeq + 1}`,\r\n          subject: args.subject,\r\n'
if (source.includes(taskAnchor)) {
  source = source.replace(taskAnchor, '          id: `t${fresh.taskSeq + 1}`,\r\n          subject: args.subject,\r\n          ...args.label === undefined || args.label.trim() === \'\' ? {} : { label: args.label.trim() },\r\n')
} else {
  throw new Error('create_task task literal anchor not found')
}

if (source === before) throw new Error('nothing changed')
writeFileSync(file, source)
console.log('label: parameter on create_task and replan, and set on the created task')
