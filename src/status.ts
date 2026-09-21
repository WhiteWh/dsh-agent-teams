/**
 * Bounded task selection for `agent_teams_status` (Φ1 feedback F6).
 *
 * The dx9 run reached 183 tasks, and the status call echoed **every** one of them with
 * its output — 20–30 KB per call. The session crashed on it twice, and the captain
 * stopped asking the plugin questions altogether, grepping the harness spill file
 * instead. A team that has been running for two phases must stay readable.
 *
 * The rule this module owns: a report shows the work that still needs attention, says
 * how much history it left out, and can still reach everything on request. Selection
 * lives here — pure and tested — so the structured payload and the text report cannot
 * disagree about what was shown.
 *
 * @module dsh-agent-teams/status
 */

import type { TaskStatus, TeamTask } from './types.ts'

/** How one status call narrows the task list. */
export interface StatusTaskFilter {
  /**
   * Only work that still needs attention. This is the default; pass `false` to list
   * every task, including the settled history.
   */
  readonly live?: boolean
  /** Report exactly one task, by id. Its output is always included. */
  readonly task_id?: string
  /** Only tasks updated at or after this epoch-millisecond timestamp. */
  readonly since?: number
  /** Include the output of settled tasks (completed/cancelled/superseded) too. */
  readonly include_output?: boolean
}

/** What the filter decided, so the report can state it instead of hiding it. */
export interface StatusTaskSelection {
  /** The tasks to report, with `output` removed where the filter drops history. */
  readonly tasks: readonly TeamTask[]
  /** How many tasks the filter left out. */
  readonly hidden: number
  /** How many reported tasks had their output dropped as settled history. */
  readonly outputs_dropped: number
}

/**
 * Statuses a captain no longer has to act on. `failed` is deliberately **not** here:
 * a red lane is exactly what a captain opens a status report to find, and its output
 * is the evidence of what went wrong.
 */
const SETTLED_HISTORY: readonly TaskStatus[] = ['completed', 'cancelled', 'superseded']

/**
 * Select the tasks one status report should show.
 *
 * @param tasks - every task of the team.
 * @param filter - the caller's narrowing options; the defaults are the bounded view.
 * @returns the tasks to report plus the counts that explain what was left out.
 */
export function selectStatusTasks(
  tasks: readonly TeamTask[],
  filter: StatusTaskFilter = {},
): StatusTaskSelection {
  const requestedId = filter.task_id?.trim() ?? ''
  const includeOutput = filter.include_output === true

  if (requestedId !== '') {
    const one = tasks.filter((task) => task.id === requestedId)
    return {
      tasks: one,
      hidden: tasks.length - one.length,
      outputs_dropped: 0,
    }
  }

  const liveOnly = filter.live !== false
  let selected = liveOnly
    ? tasks.filter((task) => !SETTLED_HISTORY.includes(task.status))
    : [...tasks]
  if (filter.since !== undefined) {
    selected = selected.filter((task) => (task.updatedAt ?? 0) >= (filter.since ?? 0))
  }

  let outputsDropped = 0
  const visible = selected.map((task) => {
    if (includeOutput || task.output === undefined) return task
    if (!SETTLED_HISTORY.includes(task.status)) return task
    outputsDropped += 1
    const { output: _dropped, ...rest } = task
    return rest as TeamTask
  })

  return {
    tasks: visible,
    hidden: tasks.length - visible.length,
    outputs_dropped: outputsDropped,
  }
}
