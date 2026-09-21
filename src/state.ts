/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code AgentTeams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-agent-teams/state
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OPEN_TASK_STATUSES, SETTLED_TASK_STATUSES, TERMINAL_TASK_STATUSES, requeueableOnRemoval, type TaskOrigin, type TaskStatus, type TeamMember, type TeamMessage, type TeamPlan, type TeamProfileSnapshot, type TeamState, type TeamTask } from './types.ts'
import { hasValidQualityTaskFields, isKnownDelta, isReviewPolicy, normalizeBlankOptionalTaskFields } from './quality-gates.ts'

export {
  acceptanceCriterionText,
  acceptTaskPaths,
  amendTaskContract,
  isKnownDelta,
  pinKnownDelta,
  unpinKnownDelta,
  pinnedWaiverEvidence,
  buildCoverageMatrix,
  canDeclareDelivery,
  classifyChangedPath,
  collectChangedPaths,
  defaultQualityDeliveryGraph,
  describeQualityLoop,
  evaluateQualityCompletion,
  findProfilesInConfig,
  hasValidQualityTaskFields,
  isAcceptanceCriterion,
  isAcceptanceResult,
  isCommandResult,
  isQualityKind,
  isTaskRevision,
  isWaiverConfirmation,
  lintProfileKeys,
  normalizeBlankOptionalTaskFields,
  pathMatchesScope,
  planQualityFollowUp,
  qualityPlanningPrompt,
  reportsWaiver,
  resumeTeamState,
  sanitizeReviewAcceptance,
  sanitizeReviewObjective,
  taskHasWaivers,
  taskKindOf,
  unconfirmedWaivers,
  uncoveredAcceptance,
  uncoveredCommands,
  validateCreateTask,
  waiversConfirmed,
} from './quality-gates.ts'
export type { ContractAmendmentInput } from './quality-gates.ts'

/** Mailbox key of the captain. */
export const CAPTAIN_KEY = 'captain'
/** A crashed live-delivery attempt becomes retryable after this interval. */
const MAILBOX_DELIVERY_LEASE_MS = 60_000
/** Durable deny-list for AgentTeams members that must never be resumed. */
const RETIRED_MEMBERS_FILE = 'retired-members.json'

/** In-process per-team mutation queues (promise chains). */
const locks = new Map<string, Promise<unknown>>()

/**
 * Serialize mutations of one team across the whole process.
 * @param key - the team id (or any mutation scope).
 * @param fn - the mutation to run exclusively.
 * @returns the mutation's result.
 */
export async function withTeamLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  locks.set(key, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    // Drop this key's queue entry once we are still its tail, so settled
    // teams do not leave one resolved promise chained forever (the same
    // cleanup discipline as the scheduler's serializeMember). A successor
    // that already appended itself owns the map slot; keep its entry.
    if (locks.get(key) === tail) locks.delete(key)
  }
}

/**
 * Keys with an in-process lock queue (held or waiting), snapshot for
 * diagnostics and leak checks. The queue promises themselves stay private.
 */
export function teamLockQueueKeys(): readonly string[] {
  return [...locks.keys()]
}

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay
 * distinct and readable; everything else — spaces, punctuation, path
 * separators, control characters — folds to `-`. An ASCII-only whitelist
 * mapped *every* non-Latin name onto one shared fallback, which silently
 * merged their mailboxes and rejected the second such member as a duplicate.
 *
 * A name with no letters or digits at all (pure emoji or punctuation) cannot
 * yield a readable key, so it gets a digest rather than a shared constant.
 * Over-long names are truncated with a digest appended, so names sharing a
 * long prefix stay distinct and the result stays within filesystem limits
 * (CJK costs 3 bytes per character in UTF-8).
 *
 * @param name - any user-supplied name.
 * @returns a non-empty key safe as a single path segment.
 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  }
  return cleaned
}

/**
 * Whether `dependencies` are all satisfied (every named task exists and
 * completed) for the given task list.
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the candidate depends on.
 * @returns the ids that are still unsatisfied, empty when claimable.
 */
/**
 * Unfinished prerequisites of one task.
 *
 * A dependency is satisfied when the task is `completed`, or when it was
 * `superseded` and its replacement is satisfied — recursively, with cycle
 * protection. The redirect keeps the live graph readable, but a historical
 * dependency on a replaced task must not fence its descendants forever; a
 * `superseded` task with no recorded replacement never satisfies anything.
 * @param tasks - every task of the team.
 * @param dependencies - the dependency ids to test.
 * @returns the ids that are still unsatisfied.
 */
export function unsatisfiedDependencies(tasks: TeamTask[], dependencies: string[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const satisfied = (id: string, seen: ReadonlySet<string>): boolean => {
    const task = byId.get(id)
    if (task === undefined) return false
    if (task.status === 'completed') return true
    if (task.status !== 'superseded') return false
    const next = task.supersededBy
    if (next === undefined || seen.has(next)) return false
    return satisfied(next, new Set([...seen, next]))
  }
  return dependencies.filter((id) => !satisfied(id, new Set([id])))
}

/**
 * Whether the original plan has nothing left to run (round 3).
 *
 * This is what makes "work the user adds after the plan first completed" a fact
 * rather than a guess: a task created while the plan still owes work is `added`,
 * and one created after every original task settled is a `followup`. Tasks without
 * an `origin` count as plan work, so a state file written before the field existed
 * still answers the question. An empty plan is not settled — nothing was planned.
 *
 * @param team - the team whose tasks to inspect.
 * @returns true when at least one plan task exists and every one of them is terminal.
 */
export function planHasSettled(team: Pick<TeamState, 'tasks'>): boolean {
  const planned = team.tasks.filter((task) => (task.origin ?? 'plan') === 'plan')
  return planned.length > 0 && planned.every((task) => TERMINAL_TASK_STATUSES.includes(task.status))
}

/**
 * The origin to stamp on a task being created right now (round 3).
 *
 * Called at creation time only: a task keeps the stretch it was born into even
 * after the plan is reopened, so the three progress segments never shuffle.
 *
 * @param team - the team the task is being added to.
 * @returns `followup` when the plan had already settled, otherwise `added`.
 */
export function originForNewTask(team: Pick<TeamState, 'tasks'>): TaskOrigin {
  return planHasSettled(team) ? 'followup' : 'added'
}

/**
 * The allowed task status transitions, keyed by current status.
 *
 * `failed -> pending` is the retry: `agent_teams_reassign_task` has always
 * produced it through {@link invalidateTaskAttempt}, so leaving it out of the
 * table made the table lie about the behaviour the tools have (WP2/S08).
 * `superseded` is reachable from every non-completed status (WP3/S09): the
 * captain replaces a red or abandoned lane with a new task instead of leaving a
 * `failed` row and permanently pending descendants.
 * `completed` and `cancelled` stay terminal otherwise.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['claimed', 'cancelled', 'superseded'],
  claimed: ['in_progress', 'failed', 'cancelled', 'superseded'],
  // `awaiting_scope_review` is entered when a worker reports completion together
  // with a path outside its declared inScope (WP4/S10); the captain then either
  // accepts the paths (`completed`), retries the lane (`pending`), or replaces it.
  in_progress: ['awaiting_scope_review', 'completed', 'failed', 'cancelled', 'superseded'],
  awaiting_scope_review: ['completed', 'pending', 'failed', 'cancelled', 'superseded'],
  completed: [],
  failed: ['pending', 'superseded'],
  cancelled: ['superseded'],
  superseded: [],
}

/**
 * Validate one task status transition.
 * @param current - the task's current status.
 * @param next - the requested status.
 * @returns the transition error, or undefined when allowed.
 */
export function transitionError(current: TaskStatus, next: TaskStatus): string | undefined {
  if (current === next) return undefined
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`
  }
  return undefined
}

/** Activate the task's current generation for one owner and return its capability id. */
export function activateTaskAttempt(task: TeamTask, assignee: string): string {
  const attemptId = randomUUID()
  task.status = 'claimed'
  task.assignee = assignee
  task.attemptId = attemptId
  task.handoffId = undefined
  task.reassigning = false
  task.output = undefined
  task.updatedAt = Date.now()
  return attemptId
}

/** Start a fresh task generation for one owner. */
export function beginTaskAttempt(task: TeamTask, assignee: string): string {
  task.attempt = (task.attempt ?? 0) + 1
  return activateTaskAttempt(task, assignee)
}

/**
 * Revoke the current worker immediately. Clearing its capability makes old
 * updates stale; a separate handoff generation serializes async quiescence.
 */
/** Cancel one unfinished task without returning it to the ready pool. */
export function cancelUnfinishedTask(task: TeamTask, output?: string): void {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) return
  task.status = 'cancelled'
  task.attemptId = undefined
  task.handoffId = undefined
  task.reassigning = false
  if (output !== undefined) task.output = output
  task.updatedAt = Date.now()
}

/** Outcome of {@link applySupersession}. */
export interface SupersedeTaskResult {
  readonly ok: boolean
  readonly error?: string
  /** Every task the operation changed, oldest first (the replaced one included). */
  readonly touched?: readonly string[]
  /** The member that was working on the replaced task, when it was still live. */
  readonly previousAssignee?: string
}

/**
 * Replace one task with another, in place and in one step (WP3/S09).
 *
 * The captain's only way out of a red lane used to be takeover plus cancel: the
 * `failed` row stayed, descendants waited forever on a task nobody would finish,
 * and a review kept pointing at the dead id. This rule does the whole rewiring
 * on the team record:
 *
 * 1. the replaced task becomes `superseded` with `supersededBy`, its capability
 *    and `changedPaths` are dropped (nothing can complete or audit it any more),
 *    while its `output` stays as history;
 * 2. every non-terminal task that depended on it now depends on the replacement;
 * 3. every non-terminal review/repair contract that pointed at it
 *    (`reviewedTaskId` / `sourceTaskId`) is retargeted to the replacement.
 *
 * A replacement that itself depends on the task it replaces is refused: rewiring
 * would build a dependency cycle, and `unsatisfiedDependencies` can only resolve
 * a supersession chain that is acyclic.
 * @param team - the team record, mutated in place.
 * @param oldId - the task being replaced.
 * @param newId - the task that replaces it.
 * @returns the touched ids, or the reason the pair cannot be superseded.
 */
export function applySupersession(team: TeamState, oldId: string, newId: string): SupersedeTaskResult {
  const old = team.tasks.find((task) => task.id === oldId)
  if (old === undefined) return { ok: false, error: `task "${oldId}" does not exist` }
  const replacement = team.tasks.find((task) => task.id === newId)
  if (replacement === undefined) return { ok: false, error: `task "${newId}" does not exist` }
  if (old.id === replacement.id) return { ok: false, error: `task "${oldId}" cannot replace itself` }
  if (old.status === 'completed') {
    return { ok: false, error: `completed task ${old.id} cannot be superseded; it is immutable` }
  }
  if (old.status === 'superseded') {
    return { ok: false, error: `task ${old.id} is already superseded by ${old.supersededBy ?? 'an unknown task'}` }
  }
  const dependsOn = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    const task = team.tasks.find((candidate) => candidate.id === from)
    return task === undefined ? false : task.dependencies.some((id) => dependsOn(id, target, seen))
  }
  if (dependsOn(replacement.id, old.id)) {
    return {
      ok: false,
      error: `replacement ${replacement.id} depends on ${old.id}; a supersession cannot build a dependency cycle`,
    }
  }
  const now = Date.now()
  const touched: string[] = [old.id]
  const previousAssignee = old.assignee !== undefined && old.status !== 'pending' ? old.assignee : undefined
  old.status = 'superseded'
  old.supersededBy = replacement.id
  old.attemptId = undefined
  old.handoffId = undefined
  old.handoffFromMemberId = undefined
  old.reassigning = false
  old.changedPaths = undefined
  old.updatedAt = now
  for (const task of team.tasks) {
    if (task.id === old.id || task.id === replacement.id) continue
    if (!OPEN_TASK_STATUSES.includes(task.status)) continue
    let changed = false
    if (task.dependencies.includes(old.id)) {
      task.dependencies = task.dependencies.map((id) => (id === old.id ? replacement.id : id))
      changed = true
    }
    if (task.reviewedTaskId === old.id) {
      task.reviewedTaskId = replacement.id
      changed = true
    }
    if (task.sourceTaskId === old.id) {
      task.sourceTaskId = replacement.id
      changed = true
    }
    if (!changed) continue
    task.updatedAt = now
    touched.push(task.id)
  }
  // WP7: a supersession rewrites the live graph, so the plan revision moves.
  revisePlan(team, now)
  return {
    ok: true,
    touched,
    ...previousAssignee === undefined ? {} : { previousAssignee },
  }
}

export function invalidateTaskAttempt(
  task: TeamTask,
  nextAssignee?: string,
  reassigning = false,
): void {
  task.attemptId = undefined
  task.handoffId = randomUUID()
  task.status = 'pending'
  task.assignee = nextAssignee
  task.reassigning = reassigning
  task.output = undefined
  task.updatedAt = Date.now()
}

/**
 * Return a removed member's work to the pool (Φ1 feedback F3).
 *
 * Only work that still expects an owner comes back. `completed`, `failed`,
 * `cancelled` and `superseded` are history: reviving them made dead lanes look
 * claimable again in the dx9 run — six of eight "requeued tasks" had been superseded
 * long before, and one of them put a second writer on a file a live lane was editing.
 *
 * Extracted from the `agent_teams_remove_member` handler so the rule is testable
 * without a tool execution context.
 *
 * @param team - the team record; requeued tasks are mutated in place.
 * @param memberName - the member being removed.
 * @returns the ids it requeued, in task order.
 */
export function requeueMemberTasks(team: TeamState, memberName: string): string[] {
  const requeued: string[] = []
  for (const task of team.tasks) {
    if (task.assignee !== memberName) continue
    if (!requeueableOnRemoval(task)) continue
    invalidateTaskAttempt(task)
    task.reassigning = false
    requeued.push(task.id)
  }
  return requeued
}

/**
 * Create the team directory structure and the initial team record.
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the initial team record.
 */
export async function createTeamDir(stateRoot: string, state: TeamState): Promise<void> {
  const dir = join(stateRoot, state.id)
  await mkdir(join(dir, 'inbox'), { recursive: true })
  await atomicWriteText(join(dir, 'team.json'), JSON.stringify(state, null, 2))
}

/**
 * Read one team record; `undefined` when absent.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  try {
    const raw = await readFile(join(stateRoot, teamId, 'team.json'), 'utf8')
    const value: unknown = JSON.parse(stripLeadingBom(raw))
    const team = coerceTeamState(value, teamId)
    if (team === undefined) {
      throw new Error(`invalid AgentTeams state in team "${teamId}"`)
    }
    return team
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Synchronously read one team record while a continuable child is being
 * composed. Harness requires child setup contributions to be synchronous;
 * this narrow boundary lets a cold-resumed member restore its durable model
 * selection before its first request can be published.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 * @returns the team record, or `undefined` when absent.
 */
export function readTeamSync(stateRoot: string, teamId: string): TeamState | undefined {
  try {
    const raw = readFileSync(join(stateRoot, teamId, 'team.json'), 'utf8')
    const value: unknown = JSON.parse(stripLeadingBom(raw))
    const team = coerceTeamState(value, teamId)
    if (team === undefined) {
      throw new Error(`invalid AgentTeams state in team "${teamId}"`)
    }
    return team
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Persist one team record (inside the caller's lock).
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the record to persist.
 */
export async function writeTeam(stateRoot: string, state: TeamState): Promise<void> {
  await atomicWriteText(join(stateRoot, state.id, 'team.json'), JSON.stringify(state, null, 2))
}

/** Read the durable set of member session ids retired by remove/delete. */
function parseRetiredMemberIds(raw: string): Set<string> {
  const parsed: unknown = JSON.parse(stripLeadingBom(raw))
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || value === '')) {
    throw new Error('invalid AgentTeams retired member index')
  }
  return new Set(parsed)
}

/** Synchronous role hydration before the host's first prompt assembly. */
export function readRetiredMemberIdsSync(stateRoot: string): Set<string> {
  try { return parseRetiredMemberIds(readFileSync(join(stateRoot, RETIRED_MEMBERS_FILE), 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
}

export async function readRetiredMemberIds(stateRoot: string): Promise<Set<string>> {
  try {
    return parseRetiredMemberIds(await readFile(join(stateRoot, RETIRED_MEMBERS_FILE), 'utf8'))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set()
    }
    throw error
  }
}

/** Atomically add session ids to the durable retired-member deny-list. */
export async function recordRetiredMemberIds(stateRoot: string, memberIds: readonly string[]): Promise<void> {
  const additions = memberIds.filter(id => id !== '')
  if (additions.length === 0) return
  await withTeamLock(`retired-members:${stateRoot}`, async () => {
    const retired = await readRetiredMemberIds(stateRoot)
    for (const id of additions) retired.add(id)
    await mkdir(stateRoot, { recursive: true })
    await atomicWriteText(
      join(stateRoot, RETIRED_MEMBERS_FILE),
      `${JSON.stringify([...retired].sort(), null, 2)}\n`,
    )
  })
}

/**
 * Find the team owned by one captain session (at most one per captain).
 * @param stateRoot - resolved absolute state root directory.
 * @param captainSessionId - the owning session id.
 * @returns the team record, or undefined when the captain leads no team.
 */
/**
 * Every live team in one state root, oldest first (WP11 phase 1).
 *
 * Team identity is data: a captain may lead several teams in the same workspace
 * (and one team per workspace is only the common case), so nothing may assume a
 * single match. Callers address a team by id and use this list to build the
 * "your teams" error text a missing id produces.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the readable team records.
 */
export async function listTeams(stateRoot: string): Promise<TeamState[]> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const teams: TeamState[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const team = await readTeam(stateRoot, entry.name)
    if (team !== undefined) teams.push(team)
  }
  return teams.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

/**
 * The teams one captain session leads, oldest first.
 * @param stateRoot - resolved absolute state root directory.
 * @param captainSessionId - the calling captain session id.
 * @returns every team whose captain is that session (possibly none).
 */
export async function findTeamsByCaptain(stateRoot: string, captainSessionId: string): Promise<TeamState[]> {
  return (await listTeams(stateRoot)).filter((team) => team.captainSessionId === captainSessionId)
}

/**
 * The teams in which one session is an active participant, oldest first.
 * Captains match `captainSessionId`; members match their durable child session
 * id, and a removed member no longer participates.
 * @param stateRoot - resolved absolute state root directory.
 * @param agentSessionId - calling captain/member session id.
 * @returns every team the caller belongs to (possibly none).
 */
export async function findTeamsByParticipant(stateRoot: string, agentSessionId: string): Promise<TeamState[]> {
  return (await listTeams(stateRoot)).filter((team) => (
    team.captainSessionId === agentSessionId
    || team.members.some((member) => member.id === agentSessionId && member.status !== 'removed')
  ))
}

/** One team's id and name, for the "pass team_id" error text. */
export interface TeamHandle {
  readonly id: string
  readonly name: string
}

/**
 * Render the caller's teams as `id (name)` pairs (WP11 phase 1).
 * @param teams - the teams to describe.
 * @returns a comma-joined list, or a phrase when there are none.
 */
export function describeTeamHandles(teams: readonly TeamHandle[]): string {
  if (teams.length === 0) return 'none — call agent_teams_create first'
  return teams.map((team) => `${team.id} (${team.name})`).join(', ')
}

/** Build a fresh message record. */
export function createMessage(from: string, to: string, content: string): TeamMessage {
  return { id: randomUUID(), from, to, content, ts: Date.now() }
}

/**
 * Append one message to an agent's mailbox (JSONL).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param message - the message to append.
 */
export async function appendMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<void> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  await mkdir(join(stateRoot, teamId, 'inbox'), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error
    }
  }
  const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
  await atomicWriteText(file, `${existing}${separator}${JSON.stringify(message)}\n`)
}

/**
 * Read one agent's whole mailbox, oldest first.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook; malformed records are
 * skipped so one manually damaged line cannot make the whole team unreadable.
 * @returns the messages, empty when the mailbox does not exist yet.
 */
export async function readMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  try {
    const raw = await readFile(file, 'utf8')
    const messages: TeamMessage[] = []
    for (const [index, rawLine] of raw.split('\n').entries()) {
      const line = stripLeadingBom(rawLine)
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        onMalformedLine?.(index + 1, new Error('invalid JSON'))
        continue
      }
      if (!isTeamMessage(value)) {
        onMalformedLine?.(index + 1, new Error('invalid message shape'))
        continue
      }
      messages.push(value)
    }
    return messages
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** Read only messages that have not been acknowledged by their recipient. */
export async function readUnreadMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  return (await readMailbox(stateRoot, teamId, agentKey, onMalformedLine))
    .filter(message => message.readAt === undefined && message.discardedAt === undefined)
}

/** Pending delivery is distinct from delivered-but-not-yet-read input. */
export async function readPendingMailbox(stateRoot: string, teamId: string, agentKey: string): Promise<TeamMessage[]> {
  const now = Date.now()
  return (await readUnreadMailbox(stateRoot, teamId, agentKey))
    .filter(message => message.deliveredAt === undefined
      && (message.deliveryClaimedAt === undefined
        || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS))
}

async function mutateMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  mutate: (message: TeamMessage) => TeamMessage,
): Promise<void> {
  if (messageIds.length === 0) return
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const selected = new Set(messageIds)
  const lines = raw.split('\n').map((rawLine) => {
    const line = stripLeadingBom(rawLine)
    if (line.trim() === '') return rawLine
    try {
      const value: unknown = JSON.parse(line)
      if (!isTeamMessage(value) || !selected.has(value.id)) return rawLine
      return JSON.stringify(mutate(value))
    } catch {
      return rawLine
    }
  })
  await atomicWriteText(file, lines.join('\n'))
}

/** Lease selected fallback messages to one delivery path. */
export async function claimMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, message => ({
    ...message,
    deliveryClaimedAt: now,
  }))
}

/** Release a failed delivery lease so the scheduler can retry it later. */
export async function releaseMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...released } = message
    return released
  })
}

/**
 * Mark selected durable mailbox records delivered/read while preserving
 * malformed lines for diagnostics. Callers serialize this with the team lock.
 */
export async function acknowledgeMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message
    return {
      ...rest,
      deliveredAt: message.deliveredAt ?? now,
      readAt: message.readAt ?? now,
    }
  })
}

/** Acceptance by Harness is not evidence that a model step consumed input. */
export async function markMailboxDelivered(stateRoot: string, teamId: string, agentKey: string, ids: readonly string[]): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message
    return { ...rest, deliveredAt: message.deliveredAt ?? Date.now() }
  })
}

export async function discardMailboxMessages(stateRoot: string, teamId: string, agentKey: string, ids: readonly string[]): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, ids, message => ({ ...message, discardedAt: message.discardedAt ?? Date.now() }))
}

/** Remove the optional UTF-8 BOM some editors prepend to JSON text. */
function stripLeadingBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/** Rename attempts before falling back to a direct overwrite. */
const ATOMIC_RENAME_RETRIES = 3
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
const ATOMIC_RENAME_RETRY_DELAY_MS = 50
/**
 * Rename error codes worth retrying before the direct-write fallback. On
 * Windows, replacing an existing file whose target is momentarily held open
 * without FILE_SHARE_DELETE surfaces as EPERM (or EACCES/EBUSY variants);
 * EEXIST/ENOTEMPTY cover other "target busy" edge shapes.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY'])

function isRetryableRenameError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Filesystem primitives used by {@link replaceFileAtomicOrDirect}; injectable for tests. */
export interface AtomicReplacePrimitives {
  rename: (from: string, to: string) => Promise<void>
  writeFile: (file: string, content: string) => Promise<void>
  remove: (file: string) => Promise<void>
}

/** Tuning knobs for {@link replaceFileAtomicOrDirect} (defaults match production). */
export interface AtomicReplaceOptions {
  /** Rename attempts before the direct-write fallback (default 3). */
  retries?: number
  /** Delay between rename attempts in ms (default 50). */
  retryDelayMs?: number
}

/**
 * Replace `file` with `content`, preferring an atomic same-directory rename of
 * an already-written temp file.
 *
 * On Windows, `rename(tmp, file)` over an existing target throws EPERM while
 * any other process keeps the target open without FILE_SHARE_DELETE (editors,
 * indexers, antivirus scans, preview panes). By that point the payload has
 * already been fully written to the temp file, so a direct overwrite of the
 * target is a content-equivalent degraded path: retry the rename a few times
 * (transient locks clear quickly), then write the target in place. Every path
 * removes the temp file; when both the atomic rename and the direct write
 * fail, the combined error surfaces as an {@link AggregateError}.
 *
 * @returns nothing once the file has been replaced by one of the two paths.
 */
export async function replaceFileAtomicOrDirect(
  temporary: string,
  file: string,
  content: string,
  primitives: AtomicReplacePrimitives,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const retries = options.retries ?? ATOMIC_RENAME_RETRIES
  const retryDelayMs = options.retryDelayMs ?? ATOMIC_RENAME_RETRY_DELAY_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      await primitives.rename(temporary, file)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < retries) {
        await sleep(retryDelayMs)
        continue
      }
      let fallbackError: unknown
      try {
        await primitives.writeFile(file, content)
      } catch (writeError: unknown) {
        fallbackError = writeError
      }
      await primitives.remove(temporary).catch(() => undefined)
      if (fallbackError !== undefined) {
        throw new AggregateError(
          [error, fallbackError],
          `failed to replace "${file}" atomically (${String(error)}) or by direct write (${String(fallbackError)})`,
        )
      }
      return
    }
  }
}

/**
 * Atomically replace one UTF-8 state file from a same-directory temp file,
 * degrading to a direct overwrite when the atomic rename cannot proceed
 * (see {@link replaceFileAtomicOrDirect} for the Windows EPERM rationale).
 */
async function atomicWriteText(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await replaceFileAtomicOrDirect(temporary, file, content, {
    rename: (from, to) => rename(from, to),
    writeFile: (target, payload) => writeFile(target, payload, 'utf8'),
    remove: (path) => rm(path, { force: true }),
  })
}

/** Whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is an optional string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Whether a value is a finite timestamp/counter number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validate one member record at the durable JSON boundary. */
function isTeamMember(value: unknown): value is TeamMember {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['role'])
    && (value['stopping'] === undefined || typeof value['stopping'] === 'boolean')
    && isOptionalString(value['provider'])
    && isOptionalString(value['model'])
    && isOptionalString(value['reasoningEffort'])
    && isOptionalString(value['activeProvider'])
    && isOptionalString(value['activeModel'])
    && isOptionalString(value['spawnError'])
    && (value['executionPrompt'] === undefined || typeof value['executionPrompt'] === 'string')
    && (value['fallback'] === undefined || (isRecord(value['fallback']) && typeof value['fallback']['provider'] === 'string' && typeof value['fallback']['model'] === 'string'))
    && (value['fallbackActive'] === undefined || typeof value['fallbackActive'] === 'boolean')
    && isFiniteNumber(value['joinedAt'])
    && (value['status'] === 'idle' || value['status'] === 'working' || value['status'] === 'removed')
}

/**
 * `taskPlanning.weights` as it is frozen into a team profile (WP8/S16).
 *
 * The predicate is repeated here instead of importing `resolveProgressWeights`
 * on purpose: `progress.ts` reads the dependency helpers from this module, so
 * importing it back would close an ESM cycle (`state.ts` ↔ `progress.ts`), the
 * same trap that already forces `quality-gates.ts` to import one-way only.
 */
function isProgressWeightsValue(value: unknown): boolean {
  if (value === 'equal') return true
  if (!isRecord(value)) return false
  return Object.values(value).every(
    (weight) => typeof weight === 'number' && Number.isFinite(weight) && weight > 0,
  )
}

/** Validate one task record at the durable JSON boundary. */
function isTeamProfileSnapshot(value: unknown): value is TeamProfileSnapshot {
  return isRecord(value)
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && isOptionalString(value['protocol'])
    && (value['executionPrompt'] === undefined || typeof value['executionPrompt'] === 'string')
    && (value['fallback'] === undefined || (isRecord(value['fallback']) && typeof value['fallback']['provider'] === 'string' && typeof value['fallback']['model'] === 'string'))
    && (value['taskPlanning'] === undefined || value['taskPlanning'] === 'captain' || value['taskPlanning'] === 'seed')
    && (value['reviewPolicy'] === undefined || isReviewPolicy(value['reviewPolicy']))
    && (value['progressWeights'] === undefined || isProgressWeightsValue(value['progressWeights']))
}

function coerceProfileSnapshot(value: unknown): TeamProfileSnapshot | undefined {
  if (typeof value === 'string') {
    const name = value.trim()
    return name === '' ? undefined : { name }
  }
  if (!isRecord(value)) return undefined
  if (!isTeamProfileSnapshot(value)) return undefined
  return {
    name: value.name.trim(),
    ...value.description === undefined ? {} : { description: value.description },
    ...value.protocol === undefined ? {} : { protocol: value.protocol },
    ...value.taskPlanning === undefined ? {} : { taskPlanning: value.taskPlanning },
  }
}

function coerceTeamState(value: unknown, expectedId: string): TeamState | undefined {
  if (!isRecord(value)) return undefined
  if (value['profile'] !== undefined && !isTeamProfileSnapshot(value['profile']) && typeof value['profile'] !== 'string') {
    const next = { ...value }
    delete next['profile']
    value = next
  } else if (typeof value['profile'] === 'string') {
    const upgraded = coerceProfileSnapshot(value['profile'])
    value = upgraded === undefined
      ? (() => {
        const next = { ...value as Record<string, unknown> }
        delete next['profile']
        return next
      })()
      : { ...value, profile: upgraded }
  }
  if (!isRecord(value) || !Array.isArray(value['tasks'])) {
    return isTeamState(value, expectedId) ? value : undefined
  }
  const tasks = (value['tasks'] as unknown[]).map((task) => {
    if (!isRecord(task)) return task
    // Tolerate legacy dirty records instead of bricking the whole team on
    // reload: blank optional fields written by older builds (or by models that
    // materialize optionals as "") are normalized to omitted, matching the
    // profileSeedId handling below and the tool-input normalization.
    const cleaned = normalizeBlankOptionalTaskFields(task)
    if (cleaned['profileSeedId'] !== undefined && (typeof cleaned['profileSeedId'] !== 'string' || cleaned['profileSeedId'].trim() === '')) {
      const next = { ...cleaned }
      delete next['profileSeedId']
      return next
    }
    return cleaned
  })
  const coerced = { ...value, tasks }
  return isTeamState(coerced, expectedId) ? coerced : undefined
}

/** Validate one declared plan phase at the durable boundary (WP7). */
function isTeamPlanPhase(value: unknown): boolean {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && value['id'].trim() !== ''
    && isOptionalString(value['title'])
    && (value['closed'] === undefined || typeof value['closed'] === 'boolean')
    && (value['closedAt'] === undefined || isFiniteNumber(value['closedAt']))
    && Array.isArray(value['taskIds'])
    && value['taskIds'].every((taskId) => typeof taskId === 'string' && taskId.trim() !== '')
}

/** Validate the plan record at the durable boundary (WP7). */
function isTeamPlan(value: unknown): boolean {
  return isRecord(value)
    && Number.isSafeInteger(value['revision'])
    && (value['revision'] as number) >= 0
    && isFiniteNumber(value['updatedAt'])
    && isOptionalString(value['goal'])
    && (value['phases'] === undefined
      || (Array.isArray(value['phases']) && value['phases'].every(isTeamPlanPhase)))
}

/**
 * The plan record of a team, materialized for the readers (WP7/S17).
 *
 * A team created before the plan entity existed has none; reading it as revision
 * 0 with no phases keeps every reader simple without writing anything.
 */
export function planOf(team: TeamState): TeamPlan {
  return {
    revision: team.plan?.revision ?? 0,
    updatedAt: team.plan?.updatedAt ?? team.createdAt,
    ...team.plan?.goal === undefined ? {} : { goal: team.plan.goal },
    ...team.plan?.phases === undefined ? {} : { phases: team.plan.phases },
  }
}

/**
 * Bump the plan revision after a graph mutation (WP7/S17).
 *
 * `revision` is a monotone counter, not a content hash: the panel and the event
 * stream use it to tell "the graph changed since you last looked" from "nothing
 * moved", so an idempotent edit still advances it.
 * @param team - the team record to revise in place.
 * @param now - the timestamp to record (injectable for tests).
 * @returns the new revision.
 */
export function revisePlan(team: TeamState, now = Date.now()): number {
  const current = planOf(team)
  team.plan = { ...current, revision: current.revision + 1, updatedAt: now }
  return team.plan.revision
}

/**
 * Validate task references and cycles of a whole graph (WP7/S17 moved this here
 * from the staged-plan tool, so the staged editor and the live replan batch share
 * one rule instead of two that can drift).
 *
 * `requireRunnable` adds the two conditions a team needs before members are
 * spawned: at least one member and at least one task.
 * @param team - the team record to validate (not mutated).
 * @param requireRunnable - also require a runnable roster and graph.
 */
export function validateTeamGraph(team: TeamState, requireRunnable: boolean): void {
  const members = team.members.filter((member) => member.status !== 'removed')
  if (requireRunnable && members.length === 0) throw new Error('add at least one member before approving the plan')
  if (requireRunnable && team.tasks.length === 0) throw new Error('add at least one task before approving the plan')
  const memberNames = new Set(members.map((member) => member.name))
  const taskIds = new Set(team.tasks.map((task) => task.id))
  for (const task of team.tasks) {
    if (task.subject.trim() === '') throw new Error(`task "${task.id}" must have a subject`)
    // Φ1 feedback F1: an owner is only a live constraint while the task can still be
    // dispatched. A member session that had to be replaced (remove_member + add_member)
    // leaves its name on everything it finished, and checking those made every replan
    // batch impossible in a healthy team — a settled lane cannot be reassigned and a
    // removed name cannot be re-added, so the whole batch tool was lost for good.
    // Every terminal status is history here, `failed` included: a removal leaves a red
    // lane untouched (Φ1/F3), and the only path that can revive it — `retry` — names the
    // owner it is about to make dispatchable again (see `updateTask`).
    const historical = SETTLED_TASK_STATUSES.includes(task.status)
    if (!historical && task.assignee !== undefined && task.assignee !== CAPTAIN_KEY && !memberNames.has(task.assignee)) {
      throw new Error(`task "${task.id}" assignee "${task.assignee}" is not an active member`)
    }
    for (const dependency of task.dependencies) {
      if (dependency === task.id) throw new Error(`task "${task.id}" cannot depend on itself`)
      if (!taskIds.has(dependency)) throw new Error(`task "${task.id}" depends on unknown task "${dependency}"`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(team.tasks.map((task) => [task.id, task]))
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`task dependency graph contains a cycle at "${taskId}"`)
    if (visited.has(taskId)) return
    visiting.add(taskId)
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of team.tasks) visit(task.id)
}

export function isTeamTask(value: unknown): value is TeamTask {  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && isOptionalString(value['profileSeedId'])
    && (value['profileSeedId'] === undefined || value['profileSeedId'].trim() !== '')
    && typeof value['subject'] === 'string'
    && isOptionalString(value['description'])
    && (value['status'] === 'pending'
      || value['status'] === 'claimed'
      || value['status'] === 'in_progress'
      || value['status'] === 'awaiting_scope_review'
      || value['status'] === 'completed'
      || value['status'] === 'failed'
      || value['status'] === 'cancelled'
      || value['status'] === 'superseded')
    && isOptionalString(value['assignee'])
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every((dependency) => typeof dependency === 'string')
    && isOptionalString(value['output'])
    && (value['attempt'] === undefined
      || (Number.isSafeInteger(value['attempt']) && (value['attempt'] as number) >= 0))
    && isOptionalString(value['attemptId'])
    && isOptionalString(value['handoffId'])
    && isOptionalString(value['handoffFromMemberId'])
    && isOptionalString(value['supersededBy'])
    && (value['origin'] === undefined
      || value['origin'] === 'plan'
      || value['origin'] === 'added'
      || value['origin'] === 'followup')
    && (value['reassigning'] === undefined || typeof value['reassigning'] === 'boolean')
    && isFiniteNumber(value['createdAt'])
    && isFiniteNumber(value['updatedAt'])
    && hasValidQualityTaskFields(value)
}

/** Validate the full team record before it can participate in authorization. */
function isTeamState(value: unknown, expectedId: string): value is TeamState {
  if (!isRecord(value)) return false
  const validShape = value['id'] === expectedId
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && (value['profile'] === undefined || isTeamProfileSnapshot(value['profile']))
    && typeof value['captainSessionId'] === 'string'
    && value['captainSessionId'] !== ''
    && isFiniteNumber(value['createdAt'])
    && Array.isArray(value['members'])
    && value['members'].every(isTeamMember)
    && Array.isArray(value['tasks'])
    && value['tasks'].every(isTeamTask)
    && Number.isSafeInteger(value['taskSeq'])
    && (value['taskSeq'] as number) >= 0
    && (value['phase'] === undefined || value['phase'] === 'staged' || value['phase'] === 'running')
    && (value['planReviewState'] === undefined
      || value['planReviewState'] === 'awaiting_review'
      || value['planReviewState'] === 'awaiting_feedback')
    && (value['approvedAt'] === undefined || isFiniteNumber(value['approvedAt']))
    && (value['halted'] === undefined || typeof value['halted'] === 'boolean')
    && (value['haltedAt'] === undefined || isFiniteNumber(value['haltedAt']))
    && (value['reviewPolicy'] === undefined || isReviewPolicy(value['reviewPolicy']))
    && (value['knownDeltas'] === undefined
      || (Array.isArray(value['knownDeltas']) && value['knownDeltas'].every(isKnownDelta)))
    && (value['escalated'] === undefined || typeof value['escalated'] === 'boolean')
    && (value['plan'] === undefined || isTeamPlan(value['plan']))
  if (!validShape) return false

  const members = value['members'] as TeamMember[]
  const tasks = value['tasks'] as TeamTask[]
  const memberIds = new Set<string>()
  const memberKeys = new Set<string>()
  for (const member of members) {
    const key = sanitizeKey(member.name)
    if (key === CAPTAIN_KEY || memberKeys.has(key)) return false
    if (member.id !== '') {
      if (memberIds.has(member.id)) return false
      memberIds.add(member.id)
    }
    memberKeys.add(key)
  }
  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (task.id === '' || taskIds.has(task.id)) return false
    taskIds.add(task.id)
  }
  return true
}

/** Validate a mailbox record so later rendering cannot crash on `{}`/`null`. */
function isTeamMessage(value: unknown): value is TeamMessage {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['from'] === 'string'
    && typeof value['to'] === 'string'
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['ts'])
    && (value['deliveryClaimedAt'] === undefined || isFiniteNumber(value['deliveryClaimedAt']))
    && (value['deliveredAt'] === undefined || isFiniteNumber(value['deliveredAt']))
    && (value['readAt'] === undefined || isFiniteNumber(value['readAt']))
    && (value['discardedAt'] === undefined || isFiniteNumber(value['discardedAt']))
    && (value['taskId'] === undefined || typeof value['taskId'] === 'string')
    && (value['attemptId'] === undefined || typeof value['attemptId'] === 'string')
}

/**
 * Remove a team's whole directory (members should be interrupted first).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function removeTeamDir(stateRoot: string, teamId: string): Promise<void> {
  await rm(join(stateRoot, teamId), { recursive: true, force: true })
}

/**
 * `rename` with the same transient retry policy as the state-file atomic
 * write, for paths (like archiving a whole team directory) where there is no
 * content-equivalent direct-write degradation on Windows. A short-lived
 * delete-sharing lock on any file below the renamed path is retried a few
 * times before the error propagates.
 * @param from - source path.
 * @param to - destination path.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < ATOMIC_RENAME_RETRIES) {
        await sleep(ATOMIC_RENAME_RETRY_DELAY_MS)
        continue
      }
      throw error
    }
  }
}

/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function archiveTeamDir(stateRoot: string, teamId: string): Promise<void> {
  const archiveRoot = join(stateRoot, 'archive')
  await mkdir(archiveRoot, { recursive: true })
  const source = join(stateRoot, teamId)
  const target = join(archiveRoot, teamId)
  const previous = join(archiveRoot, `.${teamId}.previous-${randomUUID()}`)
  let displaced = false
  try {
    // The same Windows EPERM-on-rename applies at the directory boundary: a
    // delete-sharing violation on any file below `target` blocks the move, so
    // retry the transient-lock case before giving up.
    await renameWithRetry(target, previous)
    displaced = true
  } catch (error: unknown) {
    // Only ENOENT means there was nothing to displace; any other failure
    // (including a persistent EPERM lock) surfaces to the caller.
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error
    }
  }

  try {
    await renameWithRetry(source, target)
  } catch (error: unknown) {
    if (displaced) {
      try {
        await renameWithRetry(previous, target)
      } catch (restoreError: unknown) {
        throw new AggregateError(
          [error, restoreError],
          `failed to archive team "${teamId}" and restore its previous archive`,
        )
      }
    }
    throw error
  }

  // The new generation is authoritative. A failed cleanup only leaves a
  // hidden recovery directory, which archive discovery deliberately ignores.
  if (displaced) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Read one archived team (already moved under `archive/`), or undefined when
 * it was never archived.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function readArchivedTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  return readTeam(join(stateRoot, 'archive'), teamId)
}

/**
 * List every archived team id under the state root.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the archived team ids, empty when the archive does not exist.
 */
export async function listArchivedTeamIds(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(stateRoot, 'archive'), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

// ── activity snapshot (server-side, like the Claude Code desktop watcher) ──

/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'running' | 'completed' | 'failed' | 'cancelled' | 'superseded'

/**
 * How many acceptance criteria and verify commands of this task were reported
 * `waived` (WP1). Both the status report and the panel checklist show the count,
 * so one team cannot report two different numbers for the same task.
 */
export function waivedResultCount(task: TeamTask): number {
  return [
    ...task.acceptanceResults ?? [],
    ...task.commandsRun ?? [],
  ].filter((item) => item.status === 'waived').length
}

/**
 * The visual state of one task: `running` while in_progress or held for a scope
 * decision, `completed` when done, `failed`/`cancelled`/`superseded` when
 * terminal without success, `blocked` while any dependency is unfinished, else
 * `open`.
 */
export function taskVisualState(
  status: string,
  dependencies: readonly string[],
  tasks: readonly TeamTask[],
): VisualTaskState {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'superseded') return 'superseded'
  // A task held for a scope decision is still in flight: the work exists, the
  // captain has to rule on the paths. It is not claimable and it blocks its
  // descendants exactly like in_progress.
  if (status === 'in_progress' || status === 'awaiting_scope_review') return 'running'
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const openDependency = dependencies.some((dependencyId) => {
    const dependency = byId.get(dependencyId)
    return dependency !== undefined && dependency.status !== 'completed' && dependency.status !== 'superseded'
  })
  return openDependency ? 'blocked' : 'open'
}

/**
 * Longest dependency path depth per task id (each depth = one lane column).
 */
export function taskDepthsById(tasks: readonly TeamTask[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (taskId: string): number => {
    const cached = depths.get(taskId)
    if (cached !== undefined) return cached
    if (visiting.has(taskId)) return 0
    const task = byId.get(taskId)
    if (task === undefined) return 0
    visiting.add(taskId)
    const dependencies = task.dependencies
      .filter((dependencyId) => byId.has(dependencyId))
      .sort()
    const depth = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map(depthOf))
    visiting.delete(taskId)
    depths.set(taskId, depth)
    return depth
  }
  for (const task of tasks) depthOf(task.id)
  return depths
}
