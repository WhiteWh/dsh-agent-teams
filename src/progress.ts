/**
 * Plan progress (WP8).
 *
 * One percentage for a whole team, computed on the server so the text status,
 * the conversation card and the activity panel cannot disagree. Two modes are
 * returned together — a kind-weighted one and an equal one — because the panel
 * switches between them without a second round trip; the profile only picks
 * which of the two is the default.
 *
 * Percent rule: `Σ weight(completed) / Σ weight(total − cancelled − superseded)`.
 * Tasks that were cancelled or replaced by a supersede are not work the team
 * still owes, so they leave the denominator instead of counting as failure.
 * A plan with nothing left in the denominator reports 0 percent rather than
 * inventing 100.
 */
import type { TaskOrigin, TeamTask } from './types.ts'
import { hasFollowUpRepair, verifiedTaskIds } from './quality-gates.ts'
import { taskDepthsById, unsatisfiedDependencies } from './state.ts'

/** The default weight of every task kind (`taskPlanning.weights` overrides it). */
export const PROGRESS_KIND_WEIGHTS: Readonly<Record<string, number>> = {
  implementation: 3,
  repair: 2,
  requirements: 1,
  verification: 1,
  review: 1,
  integration: 1,
  work: 1,
}

/** The weight of a task whose kind is unknown or absent. */
export const PROGRESS_DEFAULT_WEIGHT = 1

/** How the headline percentage is computed. */
export type ProgressMode = 'byKind' | 'equal'

/** A resolved weight table: the mode the profile asked for plus the kind table. */
export interface ProgressWeightTable {
  readonly mode: ProgressMode
  /** The kind table; still filled in `equal` mode so a later switch is honest. */
  readonly byKind: Readonly<Record<string, number>>
}

/** A declared phase, e.g. `plan.phases` or `taskPlanning.phases`. */
export interface ProgressPhaseGroup {
  readonly id: string
  readonly title?: string
  /** Tasks of this phase; tasks missing from every group fall into `unphased`. */
  readonly taskIds: readonly string[]
  /** Set once the captain closed the phase (round 3); it takes no new work. */
  readonly closed?: boolean
}

/**
 * Progress and status of one phase row.
 *
 * Φ1 feedback F7.3: the owner asked to see «Φ2: 12 lanes, 4 verified, 1 failed, 2 pins»
 * without asking the captain in chat. The counts below are that answer for one phase;
 * `verified` is the brief's word for work a passing review or verification judged, and
 * `pinned` counts the known deltas (pins) registered for the team.
 */
export interface PlanProgressPhase {
  readonly phaseId: string
  readonly title?: string
  readonly completed: number
  readonly total: number
  readonly percentByKind: number
  readonly percentEqual: number
  readonly running: number
  readonly blocked: number
  readonly failed: number
  readonly cancelled: number
  readonly superseded: number
  readonly waived: number
  /** Completed lanes a passing review/verification judged. */
  readonly verified: number
  readonly closed?: boolean
}

/** The plan progress of one team. */
export interface PlanProgress {
  /** The mode the team's profile prefers (`byKind` unless it asked for `equal`). */
  readonly mode: ProgressMode
  /** `percentByKind` or `percentEqual`, whichever `mode` selects. */
  readonly percent: number
  readonly percentByKind: number
  readonly percentEqual: number
  /** Every task of the team, including the cancelled and superseded ones. */
  readonly total: number
  readonly completed: number
  readonly running: number
  readonly blocked: number
  readonly failed: number
  /** Failed quality lanes that already have their follow-up repair (WP7). */
  readonly repaired: number
  /** Completed tasks that carry waivers. */
  readonly waived: number
  readonly superseded: number
  readonly cancelled: number
  /** One row per phase (declared phases, otherwise the DAG levels). */
  readonly byPhase: readonly PlanProgressPhase[]
  /**
   * Round 3: how much of the work is the original plan, how much the captain added
   * while it ran, and how much arrived after the plan had settled. One bar, three
   * colours — see the owner decision in `.local/PROGRESS.md` (D7).
   */
  readonly segments: readonly PlanProgressSegment[]
}

/** One stretch of a plan's life, as the progress bar colours it. */
export interface PlanProgressSegment {
  readonly origin: TaskOrigin
  readonly completed: number
  readonly total: number
  readonly percent: number
}

/** The three stretches, in the order the bar draws them. */
export const TASK_ORIGINS: readonly TaskOrigin[] = ['plan', 'added', 'followup']

/** Statuses that hold a slot without being finished work. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(['claimed', 'in_progress', 'awaiting_scope_review'])

/**
 * Validate and resolve the `taskPlanning.weights` value of a profile.
 * @param value - `'equal'`, a per-kind weight table, or `undefined` for defaults.
 * @returns the mode plus the kind table (never the caller's own object).
 */
export function resolveProgressWeights(
  value: string | Readonly<Record<string, unknown>> | undefined,
): ProgressWeightTable {
  if (value === undefined) return { mode: 'byKind', byKind: PROGRESS_KIND_WEIGHTS }
  if (typeof value === 'string') {
    if (value === 'equal') return { mode: 'equal', byKind: PROGRESS_KIND_WEIGHTS }
    throw new Error(`taskPlanning.weights must be "equal" or a table of positive numbers, not "${value}"`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('taskPlanning.weights must be "equal" or a table of positive numbers')
  }
  const byKind: Record<string, number> = { ...PROGRESS_KIND_WEIGHTS }
  for (const [kind, weight] of Object.entries(value)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(
        `taskPlanning.weights.${kind} must be a positive number; remove the key to keep the default`
        + ` (${String(PROGRESS_KIND_WEIGHTS[kind] ?? PROGRESS_DEFAULT_WEIGHT)})`,
      )
    }
    byKind[kind] = weight
  }
  return { mode: 'byKind', byKind }
}

/**
 * The kind weight of one task. The kind table is applied regardless of the
 * team's mode: both percentages are always reported, so an `equal` team still
 * shows what the weighted number would be (and the panel switch stays honest).
 */
function weightOf(task: { readonly kind?: string }, table: ProgressWeightTable): number {
  const kind = task.kind?.trim() ?? ''
  if (kind === '') return PROGRESS_DEFAULT_WEIGHT
  return table.byKind[kind] ?? PROGRESS_DEFAULT_WEIGHT
}

/** Round a weight ratio into a whole percent; an empty denominator is 0. */
function percentOf(completed: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((completed / total) * 100)
}

/** Buckets of one task group (the whole plan or a single phase). */
interface ProgressBuckets {
  readonly percentByKind: number
  readonly percentEqual: number
  readonly completed: number
  readonly total: number
}

/** Compute both percentages for one set of tasks. */
function bucketOf(
  tasks: readonly { id: string; status: string; kind?: string }[],
  table: ProgressWeightTable,
  retired: (task: { readonly id: string; readonly status: string; readonly kind?: string }) => boolean,
): ProgressBuckets {
  let weightTotal = 0
  let weightCompleted = 0
  let equalTotal = 0
  let equalCompleted = 0
  let completedCount = 0
  for (const task of tasks) {
    if (retired(task)) continue
    const weight = weightOf(task, table)
    weightTotal += weight
    equalTotal += 1
    if (task.status === 'completed') {
      weightCompleted += weight
      equalCompleted += 1
      completedCount += 1
    }
  }
  return {
    percentByKind: percentOf(weightCompleted, weightTotal),
    percentEqual: percentOf(equalCompleted, equalTotal),
    completed: completedCount,
    total: tasks.length,
  }
}

/**
 * Phase groups for the progress rows: declared phases first (in their order),
 * every task they do not mention appended as one `unphased` group. Without
 * declared phases the DAG levels are used, which is the same notion of a phase
 * the panel's Phases view draws.
 * @param tasks - the team's tasks.
 * @param phases - declared phases, when the team has any.
 * @returns the groups in display order.
 */
function phaseGroupsOf(
  tasks: readonly TeamTask[],
  phases: readonly ProgressPhaseGroup[],
): readonly ProgressPhaseGroup[] {
  if (phases.length === 0) {
    const depths = taskDepthsById(tasks)
    const byLevel = new Map<number, string[]>()
    for (const task of tasks) {
      const level = depths.get(task.id) ?? 0
      const bucket = byLevel.get(level) ?? []
      bucket.push(task.id)
      byLevel.set(level, bucket)
    }
    return [...byLevel.entries()]
      .sort(([left], [right]) => left - right)
      .map(([level, taskIds]) => ({ id: `level-${String(level)}`, taskIds }))
  }
  const known = new Set(tasks.map((task) => task.id))
  const assigned = new Set<string>()
  const groups: ProgressPhaseGroup[] = phases.map((phase) => {
    const taskIds = phase.taskIds.filter((taskId) => {
      if (!known.has(taskId) || assigned.has(taskId)) return false
      assigned.add(taskId)
      return true
    })
    return { id: phase.id, ...phase.title === undefined ? {} : { title: phase.title }, taskIds }
  })
  const rest = tasks.filter((task) => !assigned.has(task.id)).map((task) => task.id)
  if (rest.length > 0) groups.push({ id: 'unphased', taskIds: rest })
  return groups
}

/**
 * Compute the plan progress of one team.
 * @param tasks - the team's durable tasks.
 * @param options - `weights` (`'equal'` or a per-kind table) and declared `phases`.
 * @returns the counts, both percentages and the per-phase rows.
 */
export function planProgress(
  tasks: readonly TeamTask[],
  options: { readonly weights?: string | Readonly<Record<string, unknown>>; readonly phases?: readonly ProgressPhaseGroup[] } = {},
): PlanProgress {
  const table = resolveProgressWeights(options.weights)
  // A lane the team no longer owes leaves the denominator: cancelled and
  // superseded work, plus a failed quality lane that already has its follow-up
  // repair (the same rule Delivery uses — a repaired failure is history, and the
  // repair itself is the work that remains).
  const retired = (task: { readonly id: string; readonly status: string }): boolean => {
    if (task.status === 'cancelled' || task.status === 'superseded') return true
    if (task.status !== 'failed') return false
    const full = tasks.find((candidate) => candidate.id === task.id)
    return full !== undefined && hasFollowUpRepair(tasks, full)
  }
  const overall = bucketOf(tasks, table, retired)
  const verifiedIds = verifiedTaskIds(tasks)
  const byPhase = phaseGroupsOf(tasks, options.phases ?? []).map((group) => {
    const members = group.taskIds
      .map((taskId) => tasks.find((task) => task.id === taskId))
      .filter((task): task is TeamTask => task !== undefined)
    const bucket = bucketOf(members, table, retired)
    let phaseRunning = 0
    let phaseBlocked = 0
    let phaseFailed = 0
    let phaseCancelled = 0
    let phaseSuperseded = 0
    let phaseWaived = 0
    let phaseVerified = 0
    for (const task of members) {
      if (verifiedIds.has(task.id)) phaseVerified += 1
      if (task.hasWaivers === true) phaseWaived += 1
      if (task.status === 'completed') continue
      if (task.status === 'failed') phaseFailed += 1
      else if (task.status === 'cancelled') phaseCancelled += 1
      else if (task.status === 'superseded') phaseSuperseded += 1
      else if (RUNNING_STATUSES.has(task.status)) phaseRunning += 1
      else phaseBlocked += 1
    }
    return {
      phaseId: group.id,
      ...group.title === undefined ? {} : { title: group.title },
      completed: bucket.completed,
      total: bucket.total,
      percentByKind: bucket.percentByKind,
      percentEqual: bucket.percentEqual,
      running: phaseRunning,
      blocked: phaseBlocked,
      failed: phaseFailed,
      cancelled: phaseCancelled,
      superseded: phaseSuperseded,
      waived: phaseWaived,
      verified: phaseVerified,
      ...group.closed === true ? { closed: true } : {},
    }
  })
  let running = 0
  let blocked = 0
  let failed = 0
  let repaired = 0
  let waived = 0
  let completed = 0
  let superseded = 0
  let cancelled = 0
  for (const task of tasks) {
    if (task.status === 'completed') {
      completed += 1
      if (task.hasWaivers === true) waived += 1
    } else if (task.status === 'failed') {
      if (hasFollowUpRepair(tasks, task)) repaired += 1
      else failed += 1
    } else if (task.status === 'superseded') {
      superseded += 1
    } else if (task.status === 'cancelled') {
      cancelled += 1
    } else if (RUNNING_STATUSES.has(task.status)) {
      running += 1
    } else if (unsatisfiedDependencies([...tasks], [...task.dependencies]).length > 0) {
      blocked += 1
    }
  }
  const segments: PlanProgressSegment[] = TASK_ORIGINS.map((origin) => {
    const members = tasks.filter((task) => (task.origin ?? 'plan') === origin)
    let segmentCompleted = 0
    for (const task of members) {
      if (task.status === 'completed') segmentCompleted += 1
    }
    return {
      origin,
      completed: segmentCompleted,
      total: members.length,
      percent: percentOf(segmentCompleted, members.length),
    }
  })
  return {
    mode: table.mode,
    percent: table.mode === 'equal' ? overall.percentEqual : overall.percentByKind,
    percentByKind: overall.percentByKind,
    percentEqual: overall.percentEqual,
    total: tasks.length,
    completed,
    running,
    blocked,
    failed,
    repaired,
    waived,
    superseded,
    cancelled,
    byPhase,
    segments,
  }
}
