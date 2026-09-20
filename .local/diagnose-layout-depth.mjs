/**
 * Read-only diagnosis #5b: how deep does a same-phase layered DAG have to be before
 * the path-walking `depthOf` becomes unaffordable? Paths multiply by the layer width
 * per layer, so this finds the threshold with real measurements instead of guesses.
 */
import { phaseBoardLayout } from '../lib/client/activity-model.js'

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
      tasks.push({ id: taskId, subject: taskId, status: 'pending', state: 'open', assignee: 'w', dependencies: [...previous], depth: layer })
    }
    previous = current
  }
  return tasks
}

for (const width of [3, 4, 5]) {
  for (let layers = 6; layers <= 14; layers += 2) {
    const tasks = layered(layers, width)
    const phases = [{ id: 'E0', taskIds: tasks.map((task) => task.id) }]
    const started = process.hrtime.bigint()
    phaseBoardLayout(tasks, phases)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    console.log(`width ${String(width)}  layers ${String(layers).padStart(2)}  tasks ${String(tasks.length).padStart(3)}   ${ms.toFixed(1).padStart(10)} ms`)
    if (ms > 15000) {
      console.log('  → unaffordable from here on; larger plans would freeze the panel')
      break
    }
  }
}
