/**
 * Round 2, part 4: drop the model projections behind the removed tree and
 * queues views, and re-word the comments that still speak of three cuts.
 *
 * Every cut is anchored on a unique marker pair, so a failed anchor aborts the
 * script instead of truncating the file. Idempotent: it errors loudly if a
 * marker is already gone, which is why it must run only once.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/activity-model.ts', import.meta.url)
let src = await readFile(file, 'utf8')
const before = src.length
const cuts = []

/** Index of one unique marker, tolerating CRLF line endings. */
function at(name, marker, from = 0) {
  const pattern = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'), 'g')
  pattern.lastIndex = from
  const first = pattern.exec(src)
  if (first === null) throw new Error(`${name}: marker not found`)
  pattern.lastIndex = first.index + 1
  const again = pattern.exec(src)
  if (again !== null && again.index >= from) throw new Error(`${name}: marker not unique`)
  return { start: first.index, end: first.index + first[0].length }
}

/** Delete [start marker, end marker) — the end marker itself is kept. */
function cut(name, start, end) {
  const from = at(`cut ${name} start`, start)
  const to = at(`cut ${name} end`, end, from.end)
  cuts.push(`${name}: ${src.slice(from.start, to.start).split('\n').length - 1} lines`)
  src = src.slice(0, from.start) + src.slice(to.start)
}

/** Replace one unique literal (comment rewording). */
function swap(name, from, to) {
  const found = at(`swap ${name}`, from)
  src = src.slice(0, found.start) + to + src.slice(found.end)
  cuts.push(`swap ${name}`)
}

// Dead types: the depth-stage and compact-DAG projections had no consumer left.
cut('relationship-stage + compact-dag types',
  '/** Minimum task shape needed to derive dependency relationships. */',
  '/** Reference-panel geometry: narrow nodes with enough room for curved edges. */')

// Dead projection: the fill-width grid belonged to the removed tree view.
cut('parallel-grid probe',
  '/** Use a fill-width grid when the task graph has no real dependency edges. */',
  '/**\n * Whether an expanded activity panel still belongs to the current session.')

// Dead projections: focus resolution, depth stages, compact DAG layout.
cut('focus + stages + compact dag',
  '/**\n * Resolve the task whose dependency chain should be highlighted.',
  '/**\n * Whether a task is settled: done, red, or dead')

cut('terminal helper',
  '/** Whether a task has already finished (either way). */',
  '/** Natural-id ordering used by every projection below. */')

cut('member projection',
  '/** One member row the three cuts need to see. */',
  '/** A manually declared phase')

// Dead projections: participant lanes and the whole queue overview.
cut('swimlanes + queues',
  '/** One participant lane of the agents view. */',
  '/** Palette shared by every view')

// Dead view-mode model: the board is the panel's only graph view now.
cut('view mode + storage key',
  '/** The two read-only cuts plus the original dependency tree. */',
  '/** One positioned node of the phase board. */')

// Dead projection: the tree's related-chain highlight is the file's last block.
{
  const marker = at('cut related chain', '/**\n * Return the complete upstream/downstream chain around one task.')
  cuts.push(`related chain: ${src.slice(marker.start).split('\n').length - 1} lines`)
  src = `${src.slice(0, marker.start).replace(/\s+$/, '')}\n`
}

// Comments that still describe the retired three-cut layout.
swap('wp10 banner',
  '// ── WP10: three read-only cuts of the same state (phases, agents, queues) ──',
  '// ── WP10: the phase board, the panel\'s only cut of the same state ──')
swap('phase task doc',
  '/** One task as the three cuts need to see it. */',
  '/** One task as the phase board needs to see it. */')
swap('review pointer doc',
  '/** Set on a review task: the task it judges, used for the waiting-review reason. */',
  '/** Set on a review task: the task it judges, so a blocked review stays visible. */')
swap('phase column doc',
  '/** One phase column of the phases view. */',
  '/** One phase column of the phase board. */')
swap('phase columns doc',
  ' * Phase columns for the phases view.',
  ' * Phase columns for the phase board.')
swap('agent colour doc',
  ' * Stable colour token for one agent name, identical in the tree, phase and\n * agent views.',
  ' * Stable colour token for one agent name, identical on the phase board and in\n * the member list.')

await writeFile(file, src)
console.log(`activity-model.ts: ${before} -> ${src.length} bytes`)
for (const line of cuts) console.log(`  ${line}`)
