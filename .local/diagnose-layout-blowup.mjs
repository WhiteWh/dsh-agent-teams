/**
 * Read-only diagnosis #5: does the round-2 phase layout blow up on a dense DAG?
 *
 * `depthOf` walks same-phase dependency paths with a fresh `seen` set per branch and
 * no memoisation, so the work is proportional to the number of *paths*, not to the
 * number of edges. A real quality-mode plan (layers of lanes, each layer depending on
 * the whole previous layer) has astronomically many paths — which would freeze the
 * panel's render loop, and with it the whole web client.
 *
 * The fixture below is a layered DAG: `layerWidth` tasks per layer, every task of a
 * layer depending on every task of the previous one.
 */
import { phaseBoardLayout, phaseColumns } from '../lib/client/activity-model.js'

function layered(layers, layerWidth) {
  const tasks = []
  let id = 0
  let previous = []
  for (let layer = 0; layer < layers; layer += 1) {
    const current = []
    for (let index = 0; index < layerWidth; index += 1) {
      id += 1
      const taskId = `t${String(id)}`
      current.push(taskId)
      tasks.push({
        id: taskId,
        subject: `lane ${taskId}`,
        status: 'pending',
        state: 'open',
        assignee: 'worker',
        dependencies: [...previous],
        depth: layer,
      })
    }
    previous = current
  }
  return tasks
}

for (const [layers, width] of [[2, 3], [3, 3], [4, 3], [5, 3], [3, 4], [4, 4], [5, 4]]) {
  const tasks = layered(layers, width)
  const phases = [{ id: 'E0', title: 'All in one phase', taskIds: tasks.map((task) => task.id) }]
  const started = process.hrtime.bigint()
  let ok = 'ok'
  try {
    const layout = phaseBoardLayout(tasks, phases)
    ok = `nodes=${String(layout.nodes.length)} width=${String(layout.width)}`
  } catch (error) {
    ok = `threw: ${String(error.message)}`
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`${String(layers)} layers x ${String(width)} = ${String(tasks.length).padStart(3)} tasks   ${ms.toFixed(1).padStart(9)} ms   ${ok}`)
  if (ms > 20000) {
    console.log('  → stopping: the blowup is proven, larger cases would hang forever')
    break
  }
}

console.log('\nphaseColumns on the same fixture (no chain walk, for contrast):')
const small = layered(5, 4)
const started = process.hrtime.bigint()
console.log('columns:', phaseColumns(small, [{ id: 'E0', taskIds: small.map((task) => task.id) }]).length,
  'in', (Number(process.hrtime.bigint() - started) / 1e6).toFixed(2), 'ms')
