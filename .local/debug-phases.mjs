import { phaseColumns, phaseBoardLayout } from '../lib/client/activity-model.js'

const tasks = [
  { id: 't1', subject: 'Requirements', status: 'completed', state: 'completed', assignee: 'analyst', dependencies: [], depth: 0 },
  { id: 't2', subject: 'Implementation', status: 'in_progress', state: 'running', assignee: 'impl-c1', dependencies: ['t1'], depth: 1 },
]
const phases = [{ id: 'p1', title: 'Phase 1', taskIds: ['t1', 't2'] }]

console.log('tasks.length', tasks.length, 'Array.isArray', Array.isArray(tasks))
console.log('no phases  :', JSON.stringify(phaseColumns(tasks, [])))
console.log('phases arg :', JSON.stringify(phaseColumns(tasks, phases)))
console.log('undefined  :', JSON.stringify(phaseColumns(tasks, undefined)))
console.log('layout     :', JSON.stringify(phaseBoardLayout(tasks, phases)))
