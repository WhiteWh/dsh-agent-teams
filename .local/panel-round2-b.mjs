// Local one-shot: drop the queues view, the view switcher and the old TaskViews,
// then insert the board-only TaskViews before TeamSwitcher. The end of a dropped
// block is the start of the *next declaration in the file*, taken from the full
// ordered list, so a removal can never swallow a component it did not name.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/ActivityPanel.tsx'
const lines = readFileSync(file, 'utf8').split('\n')

/** First line of the doc comment (if any) directly above a declaration. */
function blockStart(index) {
  let at = index
  while (at > 0 && /^\s*\*/u.test(lines[at - 1])) at -= 1
  if (at > 0 && lines[at - 1].trim() === '/**') at -= 1
  return at
}
const declarations = []
lines.forEach((line, index) => {
  if (/^function /u.test(line)) declarations.push(index)
  if (/^const [A-Za-z]+ = /u.test(line) || /^export function /u.test(line)) declarations.push(index)
})
const nextDeclaration = index => declarations.find(at => at > index) ?? lines.length

const dropNames = ['QueueView', 'ViewSwitcher', 'TaskViews']
const drops = dropNames.map((name) => {
  const at = lines.findIndex(line => line.startsWith(`function ${name}(`))
  if (at === -1) throw new Error(`missing ${name}`)
  return { name, start: blockStart(at), end: nextDeclaration(at) }
})
console.log('dropping:', drops.map(drop => `${drop.name} ${drop.start + 1}..${drop.end}`).join(', '))

const replacement = `/**
 * The panel's only graph view: the phase board, its detail card and the checklist.
 *
 * The owner dropped the tree and the queues view (2026-09-20, round 2): inside a
 * phase the board already draws sequential work as a line and the column stretches
 * to fit it, so a second view of the same graph only split attention. The checklist
 * underneath stays the flat list, and a row click pins the node in the board.
 */
function TaskViews({ tasks, members, t, discarded = false, manualPhases = [] }: {
  readonly tasks: readonly ActivityTask[]
  readonly members: readonly ActivityMember[]
  readonly t: AgentTeamsTranslate
  readonly discarded?: boolean
  /** Declared phases from the plan (WP7); they drive the columns and the order. */
  readonly manualPhases?: readonly ManualPhase[]
}) {
  const [pinnedTaskId, setPinnedTaskId] = useState<string | null>(null)
  const pin = (id: string): void => { setPinnedTaskId((current) => current === id ? null : id) }
  const pinned = pinnedTaskId === null ? undefined : tasks.find((task) => task.id === pinnedTaskId)
  return (
    <>
      <section className={css.dependencySection} aria-label={t('phase.aria')} data-phase-section>
        <PhaseBoard
          tasks={tasks}
          members={members}
          t={t}
          discarded={discarded}
          pinnedTaskId={pinnedTaskId}
          onPin={pin}
          manualPhases={manualPhases}
        />
      </section>
      {pinned !== undefined && (
        <TaskDetail task={pinned} tasks={tasks} members={members} t={t} discarded={discarded} />
      )}
      <TaskChecklist tasks={tasks} t={t} onFocus={setPinnedTaskId} manualPhases={manualPhases} />
    </>
  )
}
`

const kept = []
let cursor = 0
for (const drop of drops.sort((left, right) => left.start - right.start)) {
  kept.push(...lines.slice(cursor, drop.start))
  cursor = drop.end
}
kept.push(...lines.slice(cursor))
const teamSwitcherAt = kept.findIndex(line => line.startsWith('function TeamSwitcher({'))
if (teamSwitcherAt === -1) throw new Error('TeamSwitcher anchor missing after removal')
const insertAt = blockStart(teamSwitcherAt)
const next = [
  ...kept.slice(0, insertAt),
  ...replacement.split('\n').slice(0, -1),
  ...kept.slice(insertAt),
]
writeFileSync(file, next.join('\n'), 'utf8')
console.log('written', file, 'lines', next.length)
