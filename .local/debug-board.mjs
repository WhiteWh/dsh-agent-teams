// Local debug: print the phase board the lane fixture produces, so the new
// geometry checks can state real numbers instead of guessed ones.
import { phaseBoardLayout } from '../lib/client/activity-model.js'

const laneTask = (id, dependencies, assignee, status, extra = {}) => ({
  id, subject: `task ${id}`, dependencies, assignee, status, depth: 0, ...extra,
})
const laneTasks = [
  laneTask('t1', [], 'analyst', 'completed'),
  laneTask('t2', ['t1'], 'implementer', 'completed'),
  laneTask('t3', ['t1'], 'lane-a', 'completed'),
  laneTask('t4', ['t1'], 'lane-b', 'completed'),
  laneTask('t5', ['t1'], 'lane-c', 'failed'),
  laneTask('t6', ['t1'], 'lane-d', 'pending'),
  laneTask('t7', ['t1'], 'lane-e', 'pending'),
  laneTask('t8', ['t1'], 'lane-f', 'pending'),
  laneTask('t9', ['t1'], 'lane-g', 'pending'),
  laneTask('t10', ['t5'], 'migrator', 'pending'),
  laneTask('t11', ['t3', 't4', 't5'], 'migrator', 'pending'),
]
const board = phaseBoardLayout(laneTasks, [
  { id: 'E0', title: 'Recon', taskIds: ['t1', 't2'] },
  { id: 'E1', title: 'Lanes', taskIds: ['t3', 't4', 't5'] },
])
console.log('columns:', board.columns.map(column => ({ id: column.phaseId, x: column.x, width: column.width, tasks: column.taskIds.length })))
console.log('nodes:', board.nodes.map(node => `${node.task.id}@${node.x},${node.y}`).join(' '))
console.log('size:', board.width, 'x', board.height)
