// Local one-shot: replace the DependencyMap (tree) component with a standalone
// TaskDetail card, because the phase board is now the panel's only graph view.
// Pointer-based editing of a 2100-line component is exact only by line number, so
// this script slices by the two anchors and writes the file back as UTF-8.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/ActivityPanel.tsx'
const text = readFileSync(file, 'utf8')
const lines = text.split('\n')
const start = lines.findIndex(line => line.startsWith('function DependencyMap({'))
const taskNodeAt = lines.findIndex((line, index) => index > start && line.startsWith('function TaskNode({'))
const end = taskNodeAt - 1
if (start === -1 || taskNodeAt === -1 || end <= start) throw new Error(`anchors not found: start=${String(start)} end=${String(end)}`)
console.log('replacing lines', start + 1, '-', end + 1)
console.log('first:', lines[start].slice(0, 60))
console.log('last :', lines[end].slice(0, 60))

const detail = `/**
 * The detail card of one task: the board shows it under the columns when a node is
 * clicked (the tree view that used to own this card is gone — WP11 phase 2's
 * board lays sequential work out in a line, so a second graph view is redundant).
 */
function TaskDetail({ task, tasks, members, t, discarded = false }: {
  readonly task: ActivityTask
  readonly tasks: readonly ActivityTask[]
  readonly members: readonly ActivityMember[]
  readonly t: AgentTeamsTranslate
  readonly discarded?: boolean
}) {
  const model = taskModelLabel(task, members)
  const waitingOn = unsatisfiedDependenciesOf(task, tasks)
  const dependents = tasks.filter((candidate) => candidate.dependencies.includes(task.id))
  return (
    <section className={css.taskDetail} data-task-detail={task.id}>
      <span className={css.taskDetailHead}>
        <span className={css.taskDetailId}>{task.id}</span>
        <span className={css.taskDetailSubject} title={task.subject}>{task.subject.replace(/^开发\\s*/u, '')}</span>
        <span className={css.taskDetailBadge} data-state={discarded ? 'cancelled' : taskTone(task.state, task.status)}>
          {discarded ? t('task.status.notRun') : taskStatusLabel(task.status, t)}
        </span>
      </span>
      <span className={css.taskDetailLine}>
        {ownerSymbolUrl(task.assignee, members) !== null
          && (
            <img
              className={css.compactSymbol}
              src={ownerSymbolUrl(task.assignee, members) ?? ''}
              alt=""
              aria-hidden
            />
          )}
        {task.assignee || t('task.assignee.unclaimed')} · {discarded
          ? t('task.detail.notRun')
          : task.status === 'completed'
          ? t('task.detail.completed')
          : task.dependencies.length === 0
          ? t('task.detail.noPrerequisite')
          : waitingOn.length === 0
            ? t('task.detail.ready')
            : t('task.detail.waitingOn', { tasks: formatTaskIds(waitingOn, t) })}
      </span>
      {model !== '' && (
        <span className={css.taskDetailModel} data-task-model={model}>
          {t('task.model', { model })}
        </span>
      )}
      <span className={css.taskDetailMeta}>{dependents.length === 0
        ? t('task.detail.noDownstream')
        : t('task.detail.unlocks', { tasks: formatTaskIds(dependents.map((candidate) => candidate.id), t) })}</span>
    </section>
  )
}

/** The dependencies of one task that are not completed yet. */
function unsatisfiedDependenciesOf(task: ActivityTask, tasks: readonly ActivityTask[]): string[] {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  return task.dependencies.filter((id) => byId.get(id)?.status !== 'completed')
}
`

const next = [...lines.slice(0, start), ...detail.split('\n').slice(0, -1), ...lines.slice(end + 1)]
writeFileSync(file, next.join('\n'), 'utf8')
console.log('written', file)
