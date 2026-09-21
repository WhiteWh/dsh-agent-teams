/**
 * Replanning a live team (WP7/S17).
 *
 * Before this module the only way to fix a running plan was a cascade of
 * cancels and re-creations, which threw away every member's context and every
 * dependency edge the team had already satisfied. A replan is one batch of
 * operations applied under the team lock, validated as a whole before anything
 * is written: a task that failed on a wrong contract can be amended and retried,
 * a lane that will never finish can be superseded, a scope decision can be
 * accepted and a phase can be moved — in the same call, with one reason, and
 * with nothing persisted when any single operation is invalid.
 *
 * The applier is **pure**: it returns a new team record instead of mutating the
 * one it was given, so "any error — nothing written" is a property of the code
 * rather than a promise about the order of statements.
 *
 * @module dsh-agent-teams/replan
 */
import { OPEN_TASK_STATUSES, TERMINAL_TASK_STATUSES, type TaskKind, type TeamPlanPhase, type TeamState, type TeamTask } from './types.ts'
import {
  CAPTAIN_KEY,
  applySupersession,
  invalidateTaskAttempt,
  originForNewTask,
  planOf,
  revisePlan,
  sanitizeReviewAcceptance,
  sanitizeReviewObjective,
  taskKindOf,
  transitionError,
  validateTeamGraph,
} from './state.ts'
import {
  acceptTaskPaths,
  amendTaskContract,
  evaluateQualityCompletion,
  normalizeBlankOptionalTaskFields,
  validateCreateTask,
  type ContractAmendmentInput,
  type CreateTaskInput,
} from './quality-gates.ts'

/** One operation of a replan batch. */
export type ReplanAction =
  | 'add_task'
  | 'update_task'
  | 'supersede_task'
  | 'cancel_task'
  | 'accept_paths'
  | 'amend_task'
  | 'move_phase'
  | 'close_phase'

/**
 * A replan operation, in the snake_case shape the tool and the Web route receive.
 *
 * One flat shape covers all eight actions on purpose: a batch arrives from a
 * model or from the browser editor, and a per-action union would only move the
 * same field names one level down.
 */
export interface ReplanOperation {
  readonly action: ReplanAction
  /** Target task for every action except `add_task` and `close_phase`. */
  readonly task_id?: string
  /** `add_task`: subject; `update_task`: replacement subject. */
  readonly subject?: string
  readonly description?: string
  readonly assignee?: string
  readonly dependencies?: readonly string[]
  // Contract fields, for `add_task` and for the amended fields of `amend_task`.
  readonly kind?: TaskKind
  readonly round?: number
  readonly objective?: string
  readonly inScope?: readonly string[]
  readonly outOfScope?: readonly string[]
  readonly acceptance?: readonly (string | { readonly text: string })[]
  readonly verify?: readonly string[]
  readonly deliverables?: readonly string[]
  readonly nonGoals?: readonly string[]
  readonly reviewedTaskId?: string
  readonly sourceTaskId?: string
  readonly sourceFindingIds?: readonly string[]
  readonly coverageOf?: readonly string[]
  /** `supersede_task`: an existing replacement task id. */
  readonly replacement_task_id?: string
  /** `accept_paths`: the paths to add to `inScope`. */
  readonly paths?: readonly string[]
  /** `move_phase`: the phase to move the task into (`''` removes it from every phase). */
  readonly phase_id?: string
  /** `move_phase`: title to give a phase that does not exist yet. */
  readonly title?: string
  /** Per-operation reason; the batch reason is the default. */
  readonly reason?: string
  /** `amend_task` / `accept_paths`: override the post-review contract freeze. */
  readonly force?: boolean
  /** Live attempts (`claimed`/`in_progress`) require this to be rewritten. */
  readonly invalidate?: boolean
  /**
   * `update_task`: put a `failed` (or scope-held) task back in the queue after its
   * contract was repaired, so the same lane runs again instead of being replaced.
   */
  readonly retry?: boolean
}

/** One member activation the batch has to drain after the write. */
export interface ReplanInvalidation {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly previousAssignee: string
}

/** One applied operation, as reported back to the captain. */
export interface ReplanChange {
  readonly action: ReplanAction
  /** The task the operation touched; absent for the phase-scoped `close_phase`. */
  readonly taskId?: string
  /** The task's subject, or the phase's id/title for `close_phase`. */
  readonly subject: string
  readonly detail: string
  /** Set when the batch revoked a running attempt for this task. */
  readonly invalidation?: ReplanInvalidation
}

/** What one replan batch did. */
export interface ReplanResult {
  /** Plan revision after the batch. */
  readonly revision: number
  readonly changes: readonly ReplanChange[]
  /** Task ids the batch created. */
  readonly added: readonly string[]
  /** Task ids the batch took out of the live graph by superseding them. */
  readonly removed: readonly string[]
  /** Task ids whose dependencies or owner the batch changed. */
  readonly rebound: readonly string[]
  /** Task ids whose running attempt the batch revoked. */
  readonly invalidated: readonly string[]
  /** Members whose only remaining work disappeared; the caller may drain them. */
  readonly invalidationDetails: readonly ReplanInvalidation[]
}

/** The outcome of one batch: the next team record plus the diff. */
export interface ReplanOutcome {
  readonly team: TeamState
  readonly result: ReplanResult
}

/** Batch ceiling: a replan is a repair, not a second planning session. */
export const MAX_REPLAN_OPERATIONS = 32

const ACTIONS: readonly ReplanAction[] = [
  'add_task', 'update_task', 'supersede_task', 'cancel_task', 'accept_paths', 'amend_task', 'move_phase',
  'close_phase',
]

/** Deep-copy the parts of a team a batch can touch, so the input stays intact. */
function draftOf(team: TeamState): TeamState {
  return {
    ...team,
    members: team.members.map((member) => ({ ...member })),
    tasks: team.tasks.map((task) => ({
      ...task,
      dependencies: [...task.dependencies],
      ...task.inScope === undefined ? {} : { inScope: [...task.inScope] },
      ...task.outOfScope === undefined ? {} : { outOfScope: [...task.outOfScope] },
      ...task.acceptance === undefined ? {} : { acceptance: [...task.acceptance] },
      ...task.verify === undefined ? {} : { verify: [...task.verify] },
      ...task.deliverables === undefined ? {} : { deliverables: [...task.deliverables] },
      ...task.nonGoals === undefined ? {} : { nonGoals: [...task.nonGoals] },
      ...task.sourceFindingIds === undefined ? {} : { sourceFindingIds: [...task.sourceFindingIds] },
      ...task.coverageOf === undefined ? {} : { coverageOf: [...task.coverageOf] },
      ...task.changedPaths === undefined ? {} : { changedPaths: [...task.changedPaths] },
      ...task.acceptanceResults === undefined ? {} : { acceptanceResults: task.acceptanceResults.map((item) => ({ ...item })) },
      ...task.commandsRun === undefined ? {} : { commandsRun: task.commandsRun.map((item) => ({ ...item })) },
      ...task.revisions === undefined ? {} : { revisions: task.revisions.map((revision) => ({ ...revision })) },
    })),
    plan: {
      ...planOf(team),
      ...team.plan?.phases === undefined ? {} : { phases: team.plan.phases.map((phase) => ({ ...phase, taskIds: [...phase.taskIds] })) },
    },
  }
}

/** Find a task of the draft or explain which id was wrong. */
function requireDraftTask(draft: TeamState, taskId: string, label: string): TeamTask {
  const task = draft.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) throw new Error(`${label}: task "${taskId}" does not exist in team "${draft.name}"`)
  return task
}

/** A task a member currently holds; rewriting it needs an explicit invalidate. */
function isLiveAttempt(task: TeamTask): boolean {
  return task.status === 'claimed' || task.status === 'in_progress' || task.status === 'awaiting_scope_review'
}

/** The member holding a task, when one is. */
function holderOf(draft: TeamState, task: TeamTask): { name: string; id: string } | undefined {
  if (task.assignee === undefined || task.assignee === CAPTAIN_KEY) return undefined
  const member = draft.members.find((candidate) => candidate.name === task.assignee && candidate.status !== 'removed')
  return member === undefined ? undefined : { name: member.name, id: member.id }
}

/** Members that keep a task in flight, for the "freed member" bookkeeping. */
function hasOtherOpenWork(draft: TeamState, memberName: string, exceptTaskId: string): boolean {
  return draft.tasks.some((task) => task.id !== exceptTaskId
    && task.assignee === memberName
    && OPEN_TASK_STATUSES.includes(task.status))
}

/**
 * Whether a task can still move.
 *
 * Closing a phase is only honest once every task in it reached a terminal status.
 * `failed` counts: it is settled evidence of a real attempt, and Delivery — not the
 * phase — is what judges it. `pending`/`claimed`/`in_progress` still expect the
 * scheduler or a member, so they hold the phase open.
 */
function isTaskSettled(task: TeamTask): boolean {
  return TERMINAL_TASK_STATUSES.includes(task.status)
}

/** Resolve a declared phase by id, or throw naming the declared ones. */
function declaredPhase(draft: TeamState, phaseId: string, label: string): TeamPlanPhase {  const phases = draft.plan?.phases ?? []
  const phase = phases.find((candidate) => candidate.id === phaseId)
  if (phase === undefined) {
    throw new Error(`${label}: unknown phase "${phaseId}"; declared phases: ${phases.map((candidate) => candidate.id).join(', ') || 'none'}`)
  }
  return phase
}

/**
 * Validate and resolve a declared phase for `move_phase` / `add_task`.
 *
 * Round 3: a phase the captain closed takes no new work. The refusal names the
 * phase and points at the only way forward — declaring a new one — because the
 * owner's rule is "новые задачи в закрытую фазу добавлять нельзя, только создать
 * новую фазу".
 */
function phaseFor(
  draft: TeamState,
  phaseId: string,
  title: string | undefined,
  create: boolean,
): TeamPlanPhase | undefined {
  const phases = draft.plan?.phases ?? []
  if (phaseId === '') return undefined
  const existing = phases.find((phase) => phase.id === phaseId)
  if (existing !== undefined) {
    if (existing.closed === true) {
      throw new Error(
        `phase "${existing.id}" is closed and takes no new work`
        + ' (declare a new phase: move_phase / add_task with a new phase_id and a title)',
      )
    }
    return existing
  }
  if (!create || title === undefined || title.trim() === '') {
    throw new Error(
      `unknown phase "${phaseId}"; declared phases: ${phases.map((phase) => phase.id).join(', ') || 'none'}`
      + ' (pass a title to declare a new one)',
    )
  }
  const phase: TeamPlanPhase = { id: phaseId, title: title.trim(), taskIds: [] }
  draft.plan = { ...planOf(draft), phases: [...phases, phase] }
  return phase
}

/** Remove a task id from every declared phase. */
function detachFromPhases(draft: TeamState, taskId: string): void {
  const phases = draft.plan?.phases
  if (phases === undefined) return
  for (const phase of phases) phase.taskIds = phase.taskIds.filter((id) => id !== taskId)
}

/** Attach a task id to one phase, removing it from the others. */
function attachToPhase(draft: TeamState, phase: TeamPlanPhase, taskId: string): void {
  detachFromPhases(draft, taskId)
  if (!phase.taskIds.includes(taskId)) phase.taskIds.push(taskId)
}

/** Build the `validateCreateTask` input of an `add_task` / inline-replacement operation. */
function createInputOf(operation: ReplanOperation, draft: TeamState): CreateTaskInput {
  // Some models materialize optional parameters as "" instead of omitting them
  // (issue #105); normalize before validation exactly like `create_task` does.
  const blank = normalizeBlankOptionalTaskFields({
    subject: operation.subject,
    description: operation.description,
    dependencies: operation.dependencies,
    assignee: operation.assignee,
    kind: operation.kind,
    round: operation.round,
    objective: operation.objective,
    inScope: operation.inScope,
    outOfScope: operation.outOfScope,
    acceptance: operation.acceptance,
    verify: operation.verify,
    deliverables: operation.deliverables,
    nonGoals: operation.nonGoals,
    reviewedTaskId: operation.reviewedTaskId,
    sourceTaskId: operation.sourceTaskId,
    sourceFindingIds: operation.sourceFindingIds,
    coverageOf: operation.coverageOf,
  })
  const kind: TaskKind = blank.kind ?? 'work'
  const shared = draft.profile?.sharedInScope
  const inScope: string[] | undefined = shared === undefined || (kind !== 'implementation' && kind !== 'repair')
    ? (blank.inScope === undefined ? undefined : [...blank.inScope])
    : [...new Set([...(blank.inScope ?? []), ...shared])]
  return {
    subject: (blank.subject ?? '').trim(),
    ...blank.description === undefined ? {} : { description: blank.description },
    ...blank.dependencies === undefined ? {} : { dependencies: [...blank.dependencies] },
    ...blank.assignee === undefined ? {} : { assignee: blank.assignee },
    kind,
    ...blank.round === undefined ? {} : { round: blank.round },
    ...blank.objective === undefined ? {} : { objective: blank.objective },
    ...inScope === undefined ? {} : { inScope },
    ...blank.outOfScope === undefined ? {} : { outOfScope: [...blank.outOfScope] },
    ...blank.acceptance === undefined ? {} : { acceptance: [...blank.acceptance] },
    ...blank.verify === undefined ? {} : { verify: [...blank.verify] },
    ...blank.deliverables === undefined ? {} : { deliverables: [...blank.deliverables] },
    ...blank.nonGoals === undefined ? {} : { nonGoals: [...blank.nonGoals] },
    ...blank.reviewedTaskId === undefined ? {} : { reviewedTaskId: blank.reviewedTaskId },
    ...blank.sourceTaskId === undefined ? {} : { sourceTaskId: blank.sourceTaskId },
    ...blank.sourceFindingIds === undefined ? {} : { sourceFindingIds: [...blank.sourceFindingIds] },
    ...blank.coverageOf === undefined ? {} : { coverageOf: [...blank.coverageOf] },
    nextTaskId: `t${String(draft.taskSeq + 1)}`,
    ...shared === undefined ? {} : { sharedInScope: [...shared] },
  }
}

/** Append one validated task to the draft. */
function appendTask(draft: TeamState, operation: ReplanOperation, now: number): TeamTask {
  const input = createInputOf(operation, draft)
  const gate = validateCreateTask(draft, input)
  if (!gate.ok) throw new Error(gate.error ?? 'the new task violates the quality contract')
  const dependencies = [...new Set((operation.dependencies ?? []).map((item) => item.trim()).filter(Boolean))]
  for (const dependency of dependencies) {
    if (!draft.tasks.some((task) => task.id === dependency)) {
      throw new Error(`dependency "${dependency}" does not exist in team "${draft.name}"`)
    }
  }
  const subject = (operation.subject ?? '').trim()
  if (subject === '') throw new Error('add_task requires a non-empty subject')
  if (operation.assignee !== undefined && operation.assignee !== CAPTAIN_KEY) {
    if (!draft.members.some((member) => member.name === operation.assignee && member.status !== 'removed')) {
      throw new Error(`assignee "${operation.assignee}" is not an active member`)
    }
  }
  const kind = gate.kind ?? 'work'
  const objective = kind === 'review' || kind === 'requirements'
    ? sanitizeReviewObjective(input.objective)
    : input.objective
  const acceptance = kind === 'review' || kind === 'requirements'
    ? sanitizeReviewAcceptance(input.acceptance)
    : input.acceptance
  draft.taskSeq += 1
  const task: TeamTask = {
    id: `t${String(draft.taskSeq)}`,
    subject,
    ...operation.description === undefined ? {} : { description: operation.description },
    status: 'pending',
    ...operation.assignee === undefined || operation.assignee === '' ? {} : { assignee: operation.assignee },
    dependencies,
    attempt: 0,
    kind,
    // Round 3: which stretch of the plan's life this task belongs to, decided once
    // at creation (a later reopen of the plan must not shuffle the segments).
    origin: originForNewTask(draft),
    createdAt: now,
    updatedAt: now,
    ...operation.round === undefined ? {} : { round: operation.round },
    ...objective === undefined ? {} : { objective },
    ...input.inScope === undefined ? {} : { inScope: input.inScope },
    ...input.outOfScope === undefined ? {} : { outOfScope: input.outOfScope },
    ...acceptance === undefined ? {} : { acceptance },
    ...input.verify === undefined ? {} : { verify: input.verify },
    ...input.deliverables === undefined ? {} : { deliverables: input.deliverables },
    ...input.nonGoals === undefined ? {} : { nonGoals: input.nonGoals },
    ...input.reviewedTaskId === undefined ? {} : { reviewedTaskId: input.reviewedTaskId },
    ...input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId },
    ...input.sourceFindingIds === undefined ? {} : { sourceFindingIds: input.sourceFindingIds },
    ...input.coverageOf === undefined ? {} : { coverageOf: input.coverageOf },
  }
  draft.tasks.push(task)
  return task
}

/** Apply `update_task` to one draft task. */
function updateTask(
  draft: TeamState,
  operation: ReplanOperation,
  label: string,
): { task: TeamTask; changed: boolean } {
  const taskId = (operation.task_id ?? '').trim()
  const task = requireDraftTask(draft, taskId, label)
  if (task.status === 'completed') {
    throw new Error(`${label}: task ${task.id} is completed; use amend_task (force) or accept_paths instead`)
  }
  if (task.status === 'cancelled' || task.status === 'superseded') {
    throw new Error(`${label}: task ${task.id} is ${task.status}; a dead task cannot be edited`)
  }
  const live = isLiveAttempt(task)
  if (live && operation.invalidate !== true) {
    throw new Error(
      `${label}: task ${task.id} is held by ${task.assignee ?? 'a member'} (${task.status});`
      + ' pass invalidate=true to revoke the attempt and stop that member',
    )
  }
  const subject = operation.subject?.trim()
  if (subject !== undefined && subject === '') throw new Error(`${label}: task subject must not be empty`)
  let changed = false
  if (subject !== undefined && subject !== task.subject) {
    task.subject = subject
    changed = true
  }
  if (operation.description !== undefined) {
    task.description = operation.description === '' ? undefined : operation.description
    changed = true
  }
  if (operation.assignee !== undefined) {
    const assignee = operation.assignee.trim()
    if (assignee !== '' && assignee !== CAPTAIN_KEY) {
      if (!draft.members.some((member) => member.name === assignee && member.status !== 'removed')) {
        throw new Error(`${label}: assignee "${assignee}" is not an active member`)
      }
    }
    const next = assignee === '' ? undefined : assignee
    if (next !== task.assignee) {
      task.assignee = next
      changed = true
    }
  }
  if (operation.dependencies !== undefined) {
    const dependencies = [...new Set(operation.dependencies.map((item) => item.trim()).filter(Boolean))]
    for (const dependency of dependencies) {
      if (dependency === task.id) throw new Error(`${label}: task ${task.id} cannot depend on itself`)
      if (!draft.tasks.some((candidate) => candidate.id === dependency)) {
        throw new Error(`${label}: dependency "${dependency}" does not exist in team "${draft.name}"`)
      }
    }
    if (dependencies.join(',') !== task.dependencies.join(',')) {
      task.dependencies = dependencies
      changed = true
    }
  }
  if (operation.retry === true) {
    // "Amend and retry" (WP7): the repaired contract runs again on the same
    // lane. The transition table owns the legality, so a completed or cancelled
    // task cannot be revived here either.
    const transition = transitionError(task.status, 'pending')
    if (transition !== undefined) throw new Error(`${label}: ${transition}`)
    // Φ1 feedback F1: a retry makes the task dispatchable again, so it needs an owner
    // that exists. Without this the batch would revive a lane assigned to a replaced
    // member — silently unclaimable instead of loudly refused.
    const owner = task.assignee
    if (owner !== undefined && owner !== '' && owner !== CAPTAIN_KEY
      && !draft.members.some((member) => member.name === owner && member.status !== 'removed')) {
      throw new Error(
        `${label}: task ${task.id} has no active owner ("${owner}" is not a member)`
        + ' — pass assignee to name one when you retry this lane',
      )
    }
    invalidateTaskAttempt(task, task.assignee, false)
    task.status = 'pending'
    changed = true
  }
  if (!changed && !live) throw new Error(`${label}: nothing to update on task ${task.id}`)
  return { task, changed }
}

/**
 * Apply one atomic batch to a copy of the team (WP7/S17).
 *
 * Every operation is validated against the draft before the next one runs, and
 * the returned team is a new record: the caller either writes a fully valid plan
 * or keeps the old one. A batch is refused as a whole when any operation is
 * invalid, when it would introduce a dependency cycle, or when a live attempt is
 * rewritten without `invalidate: true`.
 *
 * @param team - the current team record (never mutated).
 * @param operations - the batch, in the order the captain wants it applied.
 * @param options - the batch reason (required) and an injectable clock.
 * @returns the next team record plus the diff that was applied.
 */
export function replanTeam(
  team: TeamState,
  operations: readonly ReplanOperation[],
  options: { readonly reason: string; readonly now?: number },
): ReplanOutcome {
  const reason = options.reason?.trim() ?? ''
  if (reason === '') throw new Error('replan requires a non-empty reason')
  if (operations.length === 0) throw new Error('at least one replan operation is required')
  if (operations.length > MAX_REPLAN_OPERATIONS) {
    throw new Error(`a replan batch takes at most ${String(MAX_REPLAN_OPERATIONS)} operations`)
  }
  const now = options.now ?? Date.now()
  const draft = draftOf(team)
  const changes: ReplanChange[] = []
  const added: string[] = []
  const removed: string[] = []
  const rebound: string[] = []
  const invalidated: string[] = []
  const invalidationDetails: ReplanInvalidation[] = []

  for (const [index, operation] of operations.entries()) {
    const label = `operation ${String(index + 1)} (${String(operation.action)})`
    if (!ACTIONS.includes(operation.action)) throw new Error(`${label}: unknown action`)
    const operationReason = operation.reason?.trim() ?? ''
    const effectiveReason = operationReason === '' ? reason : operationReason

    if (operation.action === 'add_task') {
      const task = appendTask(draft, operation, now)
      const phaseId = (operation.phase_id ?? '').trim()
      if (phaseId !== '') {
        const phase = phaseFor(draft, phaseId, operation.title, true)
        if (phase !== undefined) attachToPhase(draft, phase, task.id)
      }
      added.push(task.id)
      changes.push({ action: 'add_task', taskId: task.id, subject: task.subject, detail: `added ${task.id}: ${task.subject}` })
      continue
    }

    if (operation.action === 'move_phase') {
      const taskId = (operation.task_id ?? '').trim()
      const task = requireDraftTask(draft, taskId, label)
      const phaseId = (operation.phase_id ?? '').trim()
      if (phaseId === '') {
        detachFromPhases(draft, task.id)
        changes.push({ action: 'move_phase', taskId: task.id, subject: task.subject, detail: `removed ${task.id} from its phase` })
        continue
      }
      const phase = phaseFor(draft, phaseId, operation.title, true)
      if (phase === undefined) throw new Error(`${label}: phase "${phaseId}" cannot be resolved`)
      attachToPhase(draft, phase, task.id)
      changes.push({ action: 'move_phase', taskId: task.id, subject: task.subject, detail: `moved ${task.id} to phase ${phase.id}` })
      continue
    }

    // Round 3: closing a phase is the captain's own bookkeeping step after he
    // accepted its tasks. A phase may only close when nothing in it can still
    // move, otherwise a later update would have to reopen it.
    if (operation.action === 'close_phase') {
      const phaseId = (operation.phase_id ?? '').trim()
      if (phaseId === '') throw new Error(`${label}: close_phase requires phase_id ('' is not a phase)`)
      const phase = declaredPhase(draft, phaseId, label)
      if (phase.closed === true) throw new Error(`${label}: phase "${phase.id}" is already closed`)
      const open = draft.tasks.filter((task) => phase.taskIds.includes(task.id) && !isTaskSettled(task))
      if (open.length > 0) {
        throw new Error(
          `${label}: phase "${phase.id}" still has ${String(open.length)} open task(s): `
          + open.slice(0, 5).map((task) => `${task.id} (${task.status})`).join(', ')
          + ' — accept and settle them first',
        )
      }
      phase.closed = true
      phase.closedAt = now
      changes.push({
        action: 'close_phase',
        subject: phase.title ?? phase.id,
        detail: `closed phase ${phase.id} (${String(phase.taskIds.length)} task(s))`,
      })
      continue
    }

    if (operation.action === 'accept_paths') {
      const task = requireDraftTask(draft, (operation.task_id ?? '').trim(), label)
      const accepted = acceptTaskPaths(
        draft,
        task,
        operation.paths ?? [],
        CAPTAIN_KEY,
        effectiveReason,
        operation.force === true,
      )
      if (!accepted.ok || accepted.task === undefined) throw new Error(`${label}: ${accepted.error ?? 'paths rejected'}`)
      const next = accepted.task
      // A task held for this decision completes as soon as the widened scope
      // covers everything the worker reported: the evidence is already on the
      // task, so the same completion gate the tool uses is re-evaluated.
      let remaining: string[] = []
      if (next.status === 'awaiting_scope_review') {
        const gate = evaluateQualityCompletion(next, { status: 'completed' }, draft.reviewPolicy?.allowWaivers !== false)
        if (gate.ok) {
          const transition = transitionError(next.status, 'completed')
          if (transition !== undefined) throw new Error(`${label}: ${transition}`)
          next.status = 'completed'
        } else if (gate.scopeReview !== undefined) {
          remaining = [...gate.scopeReview]
        } else {
          throw new Error(`${label}: ${gate.error ?? 'the accepted scope still cannot complete the task'}`)
        }
      }
      draft.tasks = draft.tasks.map((candidate) => (candidate.id === next.id ? next : candidate))
      changes.push({
        action: 'accept_paths',
        taskId: next.id,
        subject: next.subject,
        detail: remaining.length === 0
          ? `accepted ${(operation.paths ?? []).join(', ')} on ${next.id} (status ${next.status})`
          : `accepted ${(operation.paths ?? []).join(', ')} on ${next.id}; still undeclared: ${remaining.join(', ')}`,
      })
      continue
    }

    if (operation.action === 'amend_task') {
      const task = requireDraftTask(draft, (operation.task_id ?? '').trim(), label)
      const input: ContractAmendmentInput = {
        ...operation.subject === undefined ? {} : { subject: operation.subject },
        ...operation.description === undefined ? {} : { description: operation.description },
        ...operation.objective === undefined ? {} : { objective: operation.objective },
        ...operation.acceptance === undefined ? {} : { acceptance: operation.acceptance.map((item) => (
          typeof item === 'string' ? item : item.text
        )) },
        ...operation.verify === undefined ? {} : { verify: [...operation.verify] },
        ...operation.inScope === undefined ? {} : { inScope: [...operation.inScope] },
        ...operation.outOfScope === undefined ? {} : { outOfScope: [...operation.outOfScope] },
        ...operation.deliverables === undefined ? {} : { deliverables: [...operation.deliverables] },
        ...operation.nonGoals === undefined ? {} : { nonGoals: [...operation.nonGoals] },
        ...operation.reviewedTaskId === undefined ? {} : { reviewedTaskId: operation.reviewedTaskId },
      }
      const amended = amendTaskContract(draft, task, input, CAPTAIN_KEY, effectiveReason, operation.force === true)
      if (!amended.ok || amended.task === undefined) throw new Error(`${label}: ${amended.error ?? 'amendment rejected'}`)
      // A forced amendment stales the passing verdicts that judged this
      // contract; they are persisted in the same batch, never left behind.
      const staled = new Map((amended.invalidatedReviews ?? []).map((review) => [review.id, review]))
      draft.tasks = draft.tasks.map((candidate) => {
        if (candidate.id === amended.task?.id) return amended.task
        return staled.get(candidate.id) ?? candidate
      })
      changes.push({
        action: 'amend_task',
        taskId: amended.task.id,
        subject: amended.task.subject,
        detail: `amended ${amended.task.id}: ${effectiveReason}`,
      })
      continue
    }

    if (operation.action === 'cancel_task') {
      const task = requireDraftTask(draft, (operation.task_id ?? '').trim(), label)
      if (task.status === 'completed') throw new Error(`${label}: completed task ${task.id} is immutable`)
      if (task.status === 'cancelled') throw new Error(`${label}: task ${task.id} is already cancelled`)
      if (task.status === 'superseded') throw new Error(`${label}: task ${task.id} is superseded; cancel nothing`)
      const live = isLiveAttempt(task)
      if (live && operation.invalidate !== true) {
        throw new Error(
          `${label}: task ${task.id} is held by ${task.assignee ?? 'a member'} (${task.status});`
          + ' pass invalidate=true to stop that member before cancelling its lane',
        )
      }
      const holder = live ? holderOf(draft, task) : undefined
      task.status = 'cancelled'
      task.attemptId = undefined
      task.updatedAt = now
      task.output = task.output ?? `Cancelled during replan: ${effectiveReason}`
      detachFromPhases(draft, task.id)
      if (holder !== undefined) {
        invalidated.push(task.id)
        invalidationDetails.push({
          taskId: task.id,
          memberName: holder.name,
          memberId: holder.id,
          previousAssignee: task.assignee ?? '',
        })
        changes.push({
          action: 'cancel_task',
          taskId: task.id,
          subject: task.subject,
          detail: `cancelled ${task.id} and stopped ${holder.name}`,
          invalidation: invalidationDetails[invalidationDetails.length - 1]!,
        })
      } else {
        changes.push({ action: 'cancel_task', taskId: task.id, subject: task.subject, detail: `cancelled ${task.id}` })
      }
      continue
    }

    if (operation.action === 'supersede_task') {
      const oldId = (operation.task_id ?? '').trim()
      const old = requireDraftTask(draft, oldId, label)
      if (isLiveAttempt(old) && operation.invalidate !== true) {
        throw new Error(
          `${label}: task ${old.id} is held by ${old.assignee ?? 'a member'} (${old.status});`
          + ' pass invalidate=true to stop that member before replacing the lane',
        )
      }
      const holder = isLiveAttempt(old) ? holderOf(draft, old) : undefined
      const replacementId = (operation.replacement_task_id ?? '').trim()
      let replacement: TeamTask
      if (replacementId !== '') {
        replacement = requireDraftTask(draft, replacementId, label)
        if (replacement.status === 'superseded' || replacement.status === 'cancelled') {
          throw new Error(`${label}: replacement ${replacement.id} is ${replacement.status}`)
        }
      } else {
        replacement = appendTask(draft, {
          ...operation,
          action: 'add_task',
          subject: operation.subject ?? `${old.subject} (replacement)`,
          kind: operation.kind ?? taskKindOf(old) as TaskKind,
          round: operation.round ?? old.round,
          sourceTaskId: operation.sourceTaskId ?? old.sourceTaskId,
          coverageOf: operation.coverageOf ?? old.coverageOf,
          dependencies: operation.dependencies ?? old.dependencies.filter((id) => id !== old.id),
        }, now)
        added.push(replacement.id)
      }
      const applied = applySupersession(draft, old.id, replacement.id)
      if (!applied.ok) throw new Error(`${label}: ${applied.error ?? 'supersede rejected'}`)
      removed.push(old.id)
      for (const touched of applied.touched ?? []) {
        if (touched !== old.id && touched !== replacement.id) rebound.push(touched)
      }
      detachFromPhases(draft, old.id)
      if (holder !== undefined) {
        invalidated.push(old.id)
        invalidationDetails.push({
          taskId: old.id,
          memberName: holder.name,
          memberId: holder.id,
          previousAssignee: taskAssigneeOf(applied.previousAssignee, old),
        })
      }
      changes.push({
        action: 'supersede_task',
        taskId: old.id,
        subject: old.subject,
        detail: `replaced ${old.id} with ${replacement.id}`,
        ...holder === undefined ? {} : { invalidation: invalidationDetails[invalidationDetails.length - 1]! },
      })
      continue
    }

    const { task, changed } = updateTask(draft, operation, label)
    if (isLiveAttempt(task) && operation.invalidate === true) {
      const holder = holderOf(draft, task)
      invalidateTaskAttempt(task, task.assignee, true)
      task.updatedAt = now
      invalidated.push(task.id)
      if (holder !== undefined) {
        invalidationDetails.push({
          taskId: task.id,
          memberName: holder.name,
          memberId: holder.id,
          previousAssignee: holder.name,
        })
      }
      changes.push({
        action: 'update_task',
        taskId: task.id,
        subject: task.subject,
        detail: `replanned ${task.id}; the previous attempt was revoked`,
        ...holder === undefined ? {} : { invalidation: invalidationDetails[invalidationDetails.length - 1]! },
      })
      continue
    }
    if (changed) {
      task.updatedAt = now
      rebound.push(task.id)
      changes.push({
        action: 'update_task',
        taskId: task.id,
        subject: task.subject,
        detail: operation.retry === true ? `retried ${task.id} (status ${task.status})` : `updated ${task.id}`,
      })
    }
  }

  validateTeamGraph(draft, false)
  const revision = revisePlan(draft, now)
  // A member whose only remaining work disappeared goes idle; its session is
  // deliberately kept (retirement stays exclusive to remove_member).
  for (const detail of invalidationDetails) {
    if (hasOtherOpenWork(draft, detail.memberName, detail.taskId)) continue
    const member = draft.members.find((candidate) => candidate.id === detail.memberId)
    if (member !== undefined && member.status !== 'removed') member.status = 'idle'
  }
  return {
    team: draft,
    result: {
      revision,
      changes,
      added,
      removed,
      rebound: [...new Set(rebound)],
      invalidated,
      invalidationDetails,
    },
  }
}

/** The `previousAssignee` a supersession reported, falling back to the task's own owner. */
function taskAssigneeOf(reported: string | undefined, task: TeamTask): string {
  return reported ?? task.assignee ?? ''
}
