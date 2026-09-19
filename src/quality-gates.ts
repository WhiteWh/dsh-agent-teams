/**
 * Pure quality-gate rules: contracts, path audit, completion, follow-up,
 * coverage, and resume. Tools and persistence call these; they do not I/O.
 * @module dsh-agent-teams/quality-gates
 */

import {
  FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  TASK_KINDS,
  TERMINAL_TASK_STATUSES,
  type AcceptanceCriterion,
  type AcceptanceResult,
  type CommandResult,
  type FindingSeverity,
  type ReviewFinding,
  type ReviewPolicy,
  type ReviewVerdict,
  type TaskKind,
  type TaskRevision,
  type TaskStatus,
  type TeamState,
  type TeamTask,
  type WaiverConfirmation,
} from './types.ts'
// The task-status machine has exactly one owner: `state.ts`. Reading the same
// binding here (instead of keeping a second copy) is what keeps the completion
// gate and `transitionError` from drifting apart when a status is added. This
// matches the existing `state.ts` ↔ `quality-gates.ts` import cycle, and the
// binding is only read inside functions: a module-scope copy would hit the
// binding before `state.ts` finished initializing it.
import { TASK_TRANSITIONS } from './state.ts'
export { TASK_TRANSITIONS }

const QUALITY_KINDS: readonly TaskKind[] = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
]

const WRITE_KINDS: readonly TaskKind[] = ['implementation', 'repair']
const OPEN_STATUSES: readonly TaskStatus[] = ['pending', 'claimed', 'in_progress']
const DEFAULT_REVIEW_POLICY: Required<Pick<
  ReviewPolicy,
  'requirementsMinRounds' | 'requirementsMaxRounds' | 'codeMaxRounds' | 'maxRepairAttempts'
>> = {
  requirementsMinRounds: 1,
  requirementsMaxRounds: 4,
  codeMaxRounds: 3,
  maxRepairAttempts: 2,
}

export type PathClassification = 'in_scope' | 'out_of_scope' | 'undeclared' | 'illegal'

export interface CreateTaskInput {
  subject: string
  description?: string
  dependencies?: string[]
  assignee?: string
  kind?: TaskKind
  round?: number
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  /** A plain criterion, or a `{text, mode: 'no_regression', baseline?}` object. */
  acceptance?: (string | AcceptanceCriterion)[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  reviewedTaskId?: string
  sourceTaskId?: string
  sourceFindingIds?: string[]
  coverageOf?: string[]
  resume?: boolean
  resumeReason?: string
  /**
   * The id this task will occupy once created (`t{n}`). The pure validator does
   * not allocate ids, so callers that already know the next id pass it in;
   * without it the mirror overlap direction cannot be checked.
   */
  nextTaskId?: string
}

export interface ValidateCreateTaskResult {
  ok: boolean
  error?: string
  kind?: TaskKind
  task?: Partial<TeamTask>
  team?: TeamState
}

export interface QualityCompletionUpdate {
  status?: TaskStatus
  output?: string
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
}

export interface QualityCompletionResult {
  ok: boolean
  error?: string
  requiredStatus?: TaskStatus
}

export interface PlannedFollowUpTask {
  id?: string
  kind: TaskKind
  subject?: string
  assignee?: string
  dependencies?: string[]
  round?: number
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: (string | AcceptanceCriterion)[]
  verify?: string[]
  sourceTaskId?: string
  sourceFindingIds?: string[]
  reviewedTaskId?: string
}

export interface PlanQualityFollowUpResult {
  created: PlannedFollowUpTask[]
  tasks: PlannedFollowUpTask[]
  escalated?: boolean
  status?: 'escalated'
}

export interface CoverageRow {
  goal_item: string
  task_ids: string[]
  status: 'missing' | 'in_progress' | 'passed' | 'blocked'
  evidence?: string
}

export interface DeliveryResult {
  ok: boolean
  blockers: string[]
}

export interface ResumeTeamResult {
  ok?: boolean
  status: 'resumed' | 'already_running' | 'rejected'
  team?: TeamState
  error?: string
}

export type QualityLoopState = 'running' | 'halted' | 'escalated' | 'deliverable' | 'blocked'

export interface QualityLoopSnapshot {
  state: QualityLoopState
  halted: boolean
  escalated: boolean
  deliverable: boolean
  summary: string
}

export interface QualityGraphDraft {
  subject: string
  kind: TaskKind
  assignee?: string
  dependencies: string[]
  objective: string
  acceptance: string[]
  inScope?: string[]
  verify?: string[]
  coverageOf?: string[]
}

export const DEFAULT_REVIEW_ACCEPTANCE = [
  'The latest implementation meets the user goal',
  'No unresolved blocker or high findings',
] as const

export const DEFAULT_REVIEW_OBJECTIVE = 'Review whether the latest implementation satisfies the user goal'

const GATE_TEST_CONTRACT = /needs[_ ]revision|拒绝路径|verdict\s*=\s*needs_revision|cannot complete|不能完成|触发拒绝/iu

export function taskKindOf(task: Pick<TeamTask, 'kind'> | undefined): TaskKind {
  return task?.kind ?? 'work'
}

export function isQualityKind(kind: TaskKind | undefined): boolean {
  return kind !== undefined && kind !== 'work' && (QUALITY_KINDS as readonly string[]).includes(kind)
}

export function resolveReviewPolicy(policy: ReviewPolicy | undefined): Required<typeof DEFAULT_REVIEW_POLICY> & ReviewPolicy {
  return {
    ...DEFAULT_REVIEW_POLICY,
    ...policy,
    requirementsMinRounds: policy?.requirementsMinRounds ?? DEFAULT_REVIEW_POLICY.requirementsMinRounds,
    requirementsMaxRounds: policy?.requirementsMaxRounds ?? DEFAULT_REVIEW_POLICY.requirementsMaxRounds,
    codeMaxRounds: policy?.codeMaxRounds ?? DEFAULT_REVIEW_POLICY.codeMaxRounds,
    maxRepairAttempts: policy?.maxRepairAttempts ?? DEFAULT_REVIEW_POLICY.maxRepairAttempts,
  }
}

export function isReviewPolicy(value: unknown): value is ReviewPolicy {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const numbers = ['requirementsMinRounds', 'requirementsMaxRounds', 'codeMaxRounds', 'maxRepairAttempts'] as const
  for (const key of numbers) {
    const item = value[key]
    if (item === undefined) continue
    if (!Number.isSafeInteger(item) || (item as number) < 1) return false
  }
  const min = (value['requirementsMinRounds'] as number | undefined) ?? DEFAULT_REVIEW_POLICY.requirementsMinRounds
  const max = (value['requirementsMaxRounds'] as number | undefined) ?? DEFAULT_REVIEW_POLICY.requirementsMaxRounds
  if (min > max) return false
  if (value['requiredReviewers'] !== undefined) {
    if (!Array.isArray(value['requiredReviewers'])) return false
    if (!value['requiredReviewers'].every((item) => typeof item === 'string' && item.trim() !== '')) return false
  }
  if (value['allowWaivers'] !== undefined && typeof value['allowWaivers'] !== 'boolean') return false
  const allowed = new Set([...numbers, 'requiredReviewers', 'allowWaivers'])
  return Object.keys(value).every((key) => allowed.has(key))
}

/** Normalize a workspace-relative POSIX path. `undefined` means illegal. */
export function normalizeWorkspacePath(path: string): string | undefined {
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('~') || /^[A-Za-z]:/.test(trimmed)) return undefined
  const posix = trimmed.replaceAll('\\', '/')
  if (posix.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  return parts.join('/')
}

export function pathMatchesScope(path: string, pattern: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path)
  if (normalizedPath === undefined) return false
  const rawPattern = pattern.trim().replaceAll('\\', '/')
  if (rawPattern.startsWith('~') || rawPattern.startsWith('/') || /^[A-Za-z]:/.test(rawPattern)) return false
  const directory = rawPattern.endsWith('/')
  const normalizedPattern = normalizeWorkspacePath(rawPattern)
  if (normalizedPattern === undefined) {
    if (directory && (rawPattern === './' || rawPattern === '/' || rawPattern === '.')) return true
    return false
  }
  if (directory || rawPattern === './' || rawPattern === '.') {
    if (normalizedPattern === '') return true
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`)
  }
  return normalizedPath === normalizedPattern
}

function isDefaultExcluded(path: string): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (normalized === undefined) return false
  const segments = normalized.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (segments[0] === '.git' || segments[0] === '.dsh') return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (segments.includes('secrets')) return true
  if (base.startsWith('id_rsa')) return true
  return false
}

export function classifyChangedPath(
  path: string,
  inScope: readonly string[] = [],
  outOfScope: readonly string[] = [],
): PathClassification {
  if (normalizeWorkspacePath(path) === undefined) return 'illegal'
  if (isDefaultExcluded(path)) return 'out_of_scope'
  if (outOfScope.some((pattern) => pathMatchesScope(path, pattern))) return 'out_of_scope'
  if (inScope.some((pattern) => pathMatchesScope(path, pattern))) return 'in_scope'
  return 'undeclared'
}

export function collectChangedPaths(gitStatusText: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const rawLine of gitStatusText.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    let candidate = line
    const rename = /->\s+(\S+)$/u.exec(line)
    if (/^[ MADRCU?!]{1,2}\s+/u.test(line)) {
      candidate = rename?.[1] ?? line.replace(/^[ MADRCU?!]{1,2}\s+/u, '')
    }
    const cleaned = candidate.replace(/^"|"$/gu, '').trim()
    const normalized = normalizeWorkspacePath(cleaned)
    if (normalized === undefined || seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return paths
}

export function inScopeOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] {
  if (left === undefined || right === undefined) return []
  const hits: string[] = []
  for (const a of left) {
    for (const b of right) {
      if (pathMatchesScope(a, b) || pathMatchesScope(b, a) || a === b) {
        if (!hits.includes(a)) hits.push(a)
      }
    }
  }
  return hits
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function nonemptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonemptyString)
}

/** A non-empty list of well-formed acceptance criteria (string or object form). */
function isAcceptanceCriterionList(value: unknown): value is (string | AcceptanceCriterion)[] {
  return Array.isArray(value) && value.length > 0 && value.every(isAcceptanceCriterion)
}

function dependencyClosureContains(
  tasks: readonly TeamTask[],
  dependencies: readonly string[],
  targetId: string,
): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const pending = [...dependencies]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || visited.has(id)) continue
    if (id === targetId) return true
    visited.add(id)
    pending.push(...(byId.get(id)?.dependencies ?? []))
  }
  return false
}

/**
 * Whether a new task is already serialized against one existing open task, so
 * their `inScope` sets can never be held at the same time.
 *
 * {@link dependencyClosureContains} walks *upstream*: it answers "is `target`
 * among the transitive dependencies of `dependencies`". So to ask "is the
 * candidate fenced behind `other`" the candidate's own dependencies are the
 * starting set and `other` is the target — the direct-edge test
 * (`dependencies.includes(other.id)`) is just the one-hop case of this. The
 * mirror question ("is `other` fenced behind the candidate") starts from
 * `other`'s dependencies and targets the id the candidate is about to take.
 * A *shared ancestor* answers neither question, so it is deliberately not
 * treated as serialization.
 *
 * @param tasks - the team's tasks.
 * @param other - the existing open write task being compared.
 * @param dependencies - the candidate's dependency list.
 * @param nextTaskId - the id the candidate will occupy, when the caller knows it.
 */
function serializedAgainst(
  tasks: readonly TeamTask[],
  other: TeamTask,
  dependencies: readonly string[],
  nextTaskId: string | undefined,
): boolean {
  if (dependencyClosureContains(tasks, dependencies, other.id)) return true
  return nextTaskId !== undefined
    && dependencyClosureContains(tasks, other.dependencies, nextTaskId)
}

export function validateCreateTask(team: TeamState, input: CreateTaskInput): ValidateCreateTaskResult {
  const kind = input.kind ?? 'work'
  if (!(TASK_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `unknown task kind "${String(kind)}"` }
  }

  if (team.halted === true) {
    const reason = input.resumeReason?.trim() ?? ''
    if (input.resume !== true || reason === '') {
      return { ok: false, error: 'team is halted; resume with a non-empty reason before create_task' }
    }
  }

  if (isQualityKind(kind)) {
    if (!nonemptyString(input.objective)) {
      return { ok: false, error: `${kind} tasks require a non-empty objective` }
    }
    if (!isAcceptanceCriterionList(input.acceptance)) {
      return { ok: false, error: `${kind} tasks require at least one acceptance criterion` }
    }
  }
  if (WRITE_KINDS.includes(kind)) {
    if (!nonemptyStringList(input.inScope)) {
      return { ok: false, error: `${kind} tasks require a non-empty inScope` }
    }
    if (!nonemptyStringList(input.verify)) {
      return { ok: false, error: `${kind} tasks require a non-empty verify list` }
    }
  }
  if (kind === 'review') {
    if (!nonemptyString(input.reviewedTaskId)) {
      return { ok: false, error: 'review tasks require reviewedTaskId' }
    }
    if (!team.tasks.some((item) => item.id === input.reviewedTaskId)) {
      return { ok: false, error: `reviewed task "${input.reviewedTaskId}" does not exist` }
    }
  }
  if (kind === 'repair') {
    if (!nonemptyString(input.sourceTaskId) || !nonemptyStringList(input.sourceFindingIds)) {
      return { ok: false, error: 'repair tasks require sourceTaskId and at least one sourceFindingId' }
    }
    if (!team.tasks.some((item) => item.id === input.sourceTaskId)) {
      return { ok: false, error: `source task "${input.sourceTaskId}" does not exist` }
    }
  }

  const dependencies = input.dependencies ?? []
  for (const dependency of dependencies) {
    const upstream = team.tasks.find((item) => item.id === dependency)
    if (upstream === undefined) {
      return { ok: false, error: `dependency "${dependency}" does not exist` }
    }
    if ((kind === 'repair' || kind === 'review') && (upstream.status === 'failed' || upstream.status === 'cancelled')) {
      return { ok: false, error: `${kind} must not depend on ${upstream.status} task "${dependency}"` }
    }
  }

  if (WRITE_KINDS.includes(kind) && nonemptyStringList(input.inScope)) {
    for (const other of team.tasks) {
      if (!WRITE_KINDS.includes(taskKindOf(other))) continue
      if (!OPEN_STATUSES.includes(other.status)) continue
      // Serialization is transitive: `other` is safe whenever the candidate is
      // fenced behind it through any chain of dependencies, and mirrored when
      // `other` is already fenced behind the id the candidate is about to take.
      // The direct-edge test alone refused a replacement whose whole downstream
      // subtree still pointed at the task being replaced (feedback §5), forcing
      // a cancel cascade first. Note that a merely shared ancestor is NOT
      // serialization: nothing orders the candidate after `other` there, so that
      // conflict is still reported.
      if (serializedAgainst(team.tasks, other, dependencies, input.nextTaskId)) continue
      const overlap = inScopeOverlap(input.inScope, other.inScope)
      if (overlap.length > 0) {
        return {
          ok: false,
          error: `inScope overlaps ${other.id} at ${overlap.join(', ')}; serialize these tasks or split the paths`,
        }
      }
    }
  }

  if (kind === 'implementation') {
    const requirements = team.tasks.filter((item) => taskKindOf(item) === 'requirements')
    const passed = requirements.some((item) => item.status === 'completed' && item.verdict === 'pass')
    const behindRequirements = requirements.some((item) => (
      dependencyClosureContains(team.tasks, dependencies, item.id)
    ))
    // Planning an implementation is safe in either approval mode when its
    // dependency chain fences execution behind requirements. Scheduling and
    // claiming still wait for successful dependency completion.
    if (requirements.length > 0 && !passed && !behindRequirements) {
      return {
        ok: false,
        error: 'implementation must depend on a requirements task until requirements completes with verdict=pass',
      }
    }
  }

  const nextTeam = team.halted === true && input.resume === true
    ? { ...team, halted: false, haltedAt: undefined }
    : team
  return {
    ok: true,
    kind,
    team: nextTeam,
    task: {
      subject: input.subject,
      kind,
      ...input.description === undefined ? {} : { description: input.description },
      ...input.assignee === undefined ? {} : { assignee: input.assignee },
      dependencies,
      ...input.round === undefined ? {} : { round: input.round },
      ...input.objective === undefined ? {} : { objective: input.objective },
      ...input.inScope === undefined ? {} : { inScope: input.inScope },
      ...input.outOfScope === undefined ? {} : { outOfScope: input.outOfScope },
      ...input.acceptance === undefined ? {} : { acceptance: input.acceptance },      ...input.verify === undefined ? {} : { verify: input.verify },
      ...input.deliverables === undefined ? {} : { deliverables: input.deliverables },
      ...input.nonGoals === undefined ? {} : { nonGoals: input.nonGoals },
      ...input.reviewedTaskId === undefined ? {} : { reviewedTaskId: input.reviewedTaskId },
      ...input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId },
      ...input.sourceFindingIds === undefined ? {} : { sourceFindingIds: input.sourceFindingIds },
      ...input.coverageOf === undefined ? {} : { coverageOf: input.coverageOf },
    },
  }
}

function openHighFindings(findings: readonly ReviewFinding[] | undefined): ReviewFinding[] {
  return (findings ?? []).filter((finding) => (
    finding.resolved !== true && (finding.severity === 'high' || finding.severity === 'blocker')
  ))
}

/** The display text of one acceptance criterion, whichever shape it has. */
export function acceptanceCriterionText(criterion: string | AcceptanceCriterion): string {
  return typeof criterion === 'string' ? criterion : criterion.text
}

/** Whether one acceptance criterion demands a baseline comparison. */
function isNoRegression(criterion: string | AcceptanceCriterion): boolean {
  return typeof criterion !== 'string' && criterion.mode === 'no_regression'
}

/**
 * Criterion / command text normalization for gate matching.
 *
 * The contract text is display text, not an opaque id, so a model that re-types
 * it must not fail on punctuation alone: surrounding whitespace is trimmed,
 * internal whitespace runs collapse to one space, and trailing punctuation is
 * dropped. It is deliberately NOT a semantic comparison — the removed
 * length-parity fallback accepted any same-length all-pass report, which let a
 * report about entirely different criteria satisfy the contract.
 */
function normalizeCriterionText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.。,，;；:：!！?？]+$/u, '')
    .trim()
}

/** A waiver is only honest with a stated reason; `no_regression` needs a baseline. */
function resultCovered(status: string | undefined, evidence: string | undefined, needsBaseline: boolean): boolean {
  if (status === 'passed') return !needsBaseline || nonemptyString(evidence)
  if (status === 'waived') return nonemptyString(evidence)
  return false
}

/**
 * Whether one report covers every required acceptance criterion.
 *
 * A criterion counts when its matching result is `passed` (with the baseline
 * named for a `no_regression` criterion) or `waived` with a non-empty evidence
 * string. Matching is by normalized text — see {@link normalizeCriterionText}.
 *
 * @param required - the task's acceptance criteria.
 * @param results - the submitted results.
 * @param allowWaivers - false makes every waiver an ordinary failure.
 * @returns the uncovered criterion texts, empty when everything is covered.
 */
export function uncoveredAcceptance(
  required: readonly (string | AcceptanceCriterion)[] | undefined,
  results: readonly AcceptanceResult[] | undefined,
  allowWaivers = true,
): string[] {
  if (results === undefined) return (required ?? []).map(acceptanceCriterionText)
  const byCriterion = new Map<string, AcceptanceResult>()
  for (const item of results) byCriterion.set(normalizeCriterionText(item.criterion), item)
  return (required ?? [])
    .filter((criterion) => {
      const match = byCriterion.get(normalizeCriterionText(acceptanceCriterionText(criterion)))
      const status = match?.status === 'waived' && !allowWaivers ? 'failed' : match?.status
      return !resultCovered(status, match?.evidence, isNoRegression(criterion))
    })
    .map(acceptanceCriterionText)
}

/** Whether one report covers every required verify command (same rules). */
export function uncoveredCommands(
  required: readonly string[] | undefined,
  results: readonly CommandResult[] | undefined,
  allowWaivers = true,
): string[] {
  if (results === undefined) return [...(required ?? [])]
  const byCommand = new Map<string, CommandResult>()
  for (const item of results) byCommand.set(normalizeCriterionText(item.command), item)
  return (required ?? []).filter((command) => {
    const match = byCommand.get(normalizeCriterionText(command))
    const status = match?.status === 'waived' && !allowWaivers ? 'failed' : match?.status
    return !resultCovered(status, match?.evidence, false)
  })
}

/** Whether a submitted result reports at least one waiver. */
export function reportsWaiver(results: readonly { status: string }[] | undefined): boolean {
  return results?.some((item) => item.status === 'waived') === true
}

/** Whether one task's own latest report contains waivers. */
export function taskHasWaivers(task: TeamTask): boolean {
  return task.hasWaivers === true
    || reportsWaiver(task.acceptanceResults)
    || reportsWaiver(task.commandsRun)
}

/** Whether a review task has confirmed the waivers of the task it judged. */
export function waiversConfirmed(team: TeamState, task: TeamTask): boolean {
  if (!taskHasWaivers(task)) return true
  return team.tasks.some((candidate) => (
    taskKindOf(candidate) === 'review'
    && candidate.reviewedTaskId === task.id
    && candidate.status === 'completed'
    && candidate.verdict === 'pass'
    && nonemptyString(candidate.waiverConfirmation?.reason)
    && (candidate.waiverConfirmation?.taskId ?? task.id) === task.id
  ))
}

/** The ids of every task whose waivers still need a reviewer's confirmation. */
export function unconfirmedWaivers(team: TeamState): string[] {
  return team.tasks
    .filter((task) => taskHasWaivers(task) && !waiversConfirmed(team, task))
    .map((task) => task.id)
}

export function evaluateQualityCompletion(
  task: TeamTask,
  update: QualityCompletionUpdate,
  allowWaivers = true,
): QualityCompletionResult {
  const nextStatus = update.status
  if (nextStatus !== undefined && nextStatus !== task.status) {
    if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
      return { ok: false, error: `task status cannot move from "${task.status}" to "${nextStatus}"` }
    }
  }

  const kind = taskKindOf(task)
  if (kind === 'work') return { ok: true }

  const verdict = update.verdict ?? task.verdict
  const findings = update.findings ?? task.findings
  if (kind === 'review' || kind === 'requirements') {
    if (nextStatus === 'completed') {
      if (verdict === undefined) return { ok: false, error: `${kind} cannot complete without verdict=pass` }
      if (verdict !== 'pass') return { ok: false, error: `${kind} with verdict=${verdict} cannot complete` }
      if (openHighFindings(findings).length > 0) {
        return { ok: false, error: `${kind} pass cannot leave unresolved high/blocker findings` }
      }
    }
    if (nextStatus === 'failed' && (verdict === 'needs_revision' || verdict === 'reject')) {
      if ((findings ?? []).length < 1) {
        return { ok: false, error: `${kind} ${verdict} requires at least one finding` }
      }
    }
    return { ok: true }
  }

  if (kind === 'implementation' || kind === 'repair' || kind === 'verification' || kind === 'integration') {
    const commands = update.commandsRun ?? task.commandsRun
    if (commands?.some((item) => item.status === 'failed') === true) {
      if (nextStatus === 'completed') {
        return { ok: false, error: 'verify failure must fail the task', requiredStatus: 'failed' }
      }
    }
    if (nextStatus !== 'completed') return { ok: true }
    const acceptanceResults = update.acceptanceResults ?? task.acceptanceResults
    const uncovered = uncoveredAcceptance(task.acceptance, acceptanceResults, allowWaivers)
    if (acceptanceResults === undefined || uncovered.length > 0) {
      return {
        ok: false,
        error: uncovered.length === 0
          ? `${kind} completion requires passed acceptanceResults for every acceptance item`
          : `${kind} completion requires a passed or waived acceptanceResult for every acceptance item; not covered: ${uncovered.join('; ')}`,
      }
    }
    const uncoveredVerify = uncoveredCommands(task.verify, commands, allowWaivers)
    if (commands === undefined || uncoveredVerify.length > 0) {
      return {
        ok: false,
        error: uncoveredVerify.length === 0
          ? `${kind} completion requires a passed commandsRun entry for every verify command`
          : `${kind} completion requires a passed or waived commandsRun entry for every verify command; not covered: ${uncoveredVerify.join('; ')}`,
      }
    }
    if (kind === 'implementation' || kind === 'repair') {
      const changed = update.changedPaths ?? task.changedPaths
      if (changed === undefined) {
        return { ok: false, error: `${kind} completion requires changedPaths` }
      }
      for (const path of changed) {
        const classification = classifyChangedPath(path, task.inScope ?? [], task.outOfScope ?? [])
        if (classification !== 'in_scope') {
          return { ok: false, error: `${kind} cannot complete: ${path} is ${classification}` }
        }
      }
    }
  }
  return { ok: true }
}

function unresolvedFindings(task: TeamTask): ReviewFinding[] {
  return (task.findings ?? []).filter((finding) => finding.resolved !== true)
}

function findingKey(ids: readonly string[]): string {
  return [...ids].sort().join(',')
}

/**
 * Path-like tokens worth considering as repair-scope candidates. Two shapes:
 * slash paths (`src/parser.ts`, `docs/guide.md`) and bare filenames with a
 * known code/doc extension (`README.md`, `wc.js`). An optional `:line`
 * suffix is tolerated and stripped. The extension allowlist keeps version
 * tokens (`v0.1.17`), hex hashes, and prose out of the derived scope.
 */
const REPAIR_SCOPE_PATH_PATTERN = /(?:[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+|[\w.\-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|txt|ya?ml|py|rs|go|java|html?|css|scss|sh|ps1|toml|xml|sql))(?::\d+)?/gu
const REPAIR_SCOPE_LINE_SUFFIX = /:\d+$/

/**
 * Derive the repair round's inScope from the findings that caused it.
 *
 * `finding.file` records where the problem was OBSERVED, but the fix often
 * targets a different file named in `requiredFix` (docs vs sample data,
 * config vs code). Deriving the scope from both keeps the auto-generated
 * repair contract satisfiable; deriving from `file` alone can produce a
 * contract where the acceptance ("edit README.md") names a path the scope
 * forbids, so no honest completion exists and the repair dead-locks.
 *
 * Absolute and otherwise illegal paths are dropped (they can never match
 * workspace-relative scope patterns anyway); when nothing legal remains,
 * the source task's own inScope is kept as the fallback. Over-inclusion is
 * accepted: inScope is an audit upper bound, and the requiredFix text still
 * tells the implementer what to touch.
 *
 * Keep all derived paths until the generator resolves inherited exclusions;
 * filtering first would silently discard a required fix target.
 */
export function repairScopeFromFindings(
  findings: readonly ReviewFinding[],
  fallback: string[] | undefined,
): string[] | undefined {
  const derived: string[] = []
  const push = (raw: string): void => {
    const normalized = normalizeWorkspacePath(raw.replace(REPAIR_SCOPE_LINE_SUFFIX, ''))
    if (normalized === undefined || derived.includes(normalized)) return
    derived.push(normalized)
  }
  for (const finding of findings) {
    if (nonemptyString(finding.file)) push(finding.file)
    for (const match of finding.requiredFix.matchAll(REPAIR_SCOPE_PATH_PATTERN)) push(match[0])
  }
  return derived.length > 0 ? derived : fallback === undefined ? undefined : [...new Set(fallback)]
}

/** Captain-only amendment payload: replacement values for contract fields. */
export interface ContractAmendmentInput {
  objective?: string
  acceptance?: string[]
  verify?: string[]
  inScope?: string[]
  outOfScope?: string[]
}

export interface AmendTaskContractResult {
  ok: boolean
  error?: string
  task?: TeamTask
  revision?: TaskRevision
}

const AMENDABLE_CONTRACT_FIELDS = ['objective', 'acceptance', 'verify', 'inScope', 'outOfScope'] as const

/**
 * Controlled contract amendment (the pure rule; tooling keeps it
 * captain-only). When a quality contract is wrong — a verify command that
 * cannot pass, an inScope that forbids the file the objective names — the
 * worker has no honest completion and either dead-locks or games the gate.
 * Instead the captain may fix the contract mid-flight: every amendment is
 * recorded on the task as a {@link TaskRevision} (previous values + reason),
 * and once a review/requirements task has passed judgment on this task the
 * contract is frozen. Amendments replace whole fields (lists are full
 * replacements, not deltas); the implementer re-reads the amended contract
 * before its next quality gate. Completion gates need no special casing:
 * they read the task's current fields, so they naturally evaluate the
 * amended contract.
 */
export function amendTaskContract(
  team: TeamState,
  task: TeamTask,
  input: ContractAmendmentInput,
  by: string,
  reason: string,
): AmendTaskContractResult {
  if (!nonemptyString(by)) return { ok: false, error: 'contract amendment requires a non-empty author identity' }
  if (!nonemptyString(reason)) return { ok: false, error: 'contract amendment requires a non-empty reason' }
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return { ok: false, error: `task ${task.id} is ${task.status}; terminal contracts are immutable` }
  }
  if (taskKindOf(task) === 'work') {
    return { ok: false, error: `task ${task.id} has kind=work and no contract to amend` }
  }
  if (!AMENDABLE_CONTRACT_FIELDS.some((field) => input[field] !== undefined)) {
    return { ok: false, error: `amendment requires at least one of: ${AMENDABLE_CONTRACT_FIELDS.join(', ')}` }
  }
  const next: Record<string, unknown> = {}
  const previous: Record<string, unknown> = {}
  if (input.objective !== undefined) {
    if (!nonemptyString(input.objective)) {
      return { ok: false, error: 'amended objective must be a non-empty string' }
    }
    next['objective'] = input.objective
    previous['objective'] = task.objective
  }
  for (const field of ['acceptance', 'verify'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (!nonemptyStringList(value)) {
      return { ok: false, error: `amended ${field} must be a non-empty list of non-empty strings` }
    }
    next[field] = value
    previous[field] = task[field]
  }
  for (const field of ['inScope', 'outOfScope'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (!nonemptyStringList(value)) {
      return { ok: false, error: `amended ${field} must be a non-empty list of non-empty strings` }
    }
    for (const entry of value) {
      if (normalizeWorkspacePath(entry) === undefined) {
        return {
          ok: false,
          error: `amended ${field} entry "${entry}" is not a workspace-relative path (absolute paths and ".." can never match scope patterns)`,
        }
      }
    }
    next[field] = value
    previous[field] = task[field]
  }
  const reviewPassed = team.tasks.some((item) => (
    (taskKindOf(item) === 'review' || taskKindOf(item) === 'requirements')
    && item.reviewedTaskId === task.id
    && item.verdict === 'pass'
  ))
  if (reviewPassed) {
    return { ok: false, error: `task ${task.id} already passed review; its contract is frozen` }
  }
  const revision: TaskRevision = {
    at: Date.now(),
    by,
    reason,
    fields: Object.keys(next),
    previous,
  }
  return {
    ok: true,
    revision,
    task: {
      ...task,
      ...next,
      revisions: [...(task.revisions ?? []), revision],
      updatedAt: Date.now(),
    } as TeamTask,
  }
}


const CAPTAIN_ASSIGNEE = 'captain'
const OPEN_FOLLOW_UP_STATUSES: readonly TaskStatus[] = ['pending', 'claimed', 'in_progress']

function schedulableAssignee(preferred: string | undefined, team: TeamState, forbidden?: string): string | undefined {
  if (preferred !== undefined && preferred !== CAPTAIN_ASSIGNEE && preferred !== forbidden) {
    const live = team.members.find((member) => member.name === preferred && member.status !== 'removed')
    if (live !== undefined) return live.name
  }
  return team.members.find((member) => (
    member.status !== 'removed'
    && member.name !== CAPTAIN_ASSIGNEE
    && member.name !== forbidden
  ))?.name
}

function countRepairAttempts(team: TeamState, sourceTaskId: string, findingIds: readonly string[]): number {
  const key = findingKey(findingIds)
  return team.tasks.filter((item) => (
    taskKindOf(item) === 'repair'
    && item.sourceTaskId === sourceTaskId
    && findingKey(item.sourceFindingIds ?? []) === key
  )).length
}

function hasOpenFollowUp(team: TeamState, sourceTaskId: string, findingIds: readonly string[]): boolean {
  const key = findingKey(findingIds)
  return team.tasks.some((item) => (
    taskKindOf(item) === 'repair'
    && item.sourceTaskId === sourceTaskId
    && findingKey(item.sourceFindingIds ?? []) === key
    && OPEN_FOLLOW_UP_STATUSES.includes(item.status)
  ))
}

/** Drop previous-round exclusions that intersect this generated repair's scope. */
function withoutScopeConflicts(
  outOfScope: readonly string[] | undefined,
  inScope: readonly string[] | undefined,
): string[] | undefined {
  if (outOfScope === undefined) return undefined
  const conflicting = new Set(inScopeOverlap(outOfScope, inScope ?? []))
  return outOfScope.filter((pattern) => !conflicting.has(pattern))
}

export function planQualityFollowUp(team: TeamState, closed: TeamTask): PlanQualityFollowUpResult {
  const empty = { created: [] as PlannedFollowUpTask[], tasks: [] as PlannedFollowUpTask[] }
  const kind = taskKindOf(closed)
  if ((kind !== 'review' && kind !== 'requirements') || closed.status !== 'failed') return empty
  if (closed.verdict === 'reject') return { ...empty, escalated: true, status: 'escalated' }
  if (closed.verdict !== 'needs_revision') return empty

  const policy = resolveReviewPolicy(team.reviewPolicy)
  const currentRound = closed.round ?? 1
  const nextRound = currentRound + 1
  const maxRounds = kind === 'requirements' ? policy.requirementsMaxRounds : policy.codeMaxRounds
  if (nextRound > maxRounds) return { ...empty, escalated: true, status: 'escalated' }

  if (kind === 'requirements') {
    const next: PlannedFollowUpTask = {
      kind: 'requirements',
      subject: `requirements-round-${nextRound}`,
      assignee: closed.assignee,
      dependencies: [],
      round: nextRound,
      objective: sanitizeReviewObjective(closed.objective, 'Converge remaining open questions'),
      acceptance: sanitizeReviewAcceptance(unresolvedFindings(closed).map((finding) => finding.requiredFix)),
    }
    return { created: [next], tasks: [next] }
  }

  const sourceId = closed.reviewedTaskId ?? closed.sourceTaskId
  if (sourceId === undefined) return empty
  const source = team.tasks.find((item) => item.id === sourceId)
  const findings = unresolvedFindings(closed)
  const findingIds = findings.map((finding) => finding.id)
  if (hasOpenFollowUp(team, sourceId, findingIds)) return empty
  if (countRepairAttempts(team, sourceId, findingIds) >= policy.maxRepairAttempts) {
    return { ...empty, escalated: true, status: 'escalated' }
  }
  // inScope is derived from the findings below: the observed file plus any
  // workspace-relative paths referenced by the requiredFix instructions.

  const repairScope = repairScopeFromFindings(findings, source?.inScope)
  const implementer = schedulableAssignee(source?.assignee, team)
  const repair: PlannedFollowUpTask = {
    id: `repair-round-${nextRound}`,
    kind: 'repair',
    subject: `repair-round-${nextRound}`,
    assignee: implementer,
    dependencies: [sourceId],
    round: nextRound,
    objective: source?.objective ?? closed.objective ?? `Fix findings from ${sourceId}`,
    inScope: repairScope,
    outOfScope: withoutScopeConflicts(source?.outOfScope, repairScope),
    verify: source?.verify,
    acceptance: findings.map((finding) => finding.requiredFix),
    sourceTaskId: sourceId,
    sourceFindingIds: findingIds,
  }
  const reviewer = schedulableAssignee(
    closed.assignee !== implementer ? closed.assignee : undefined,
    team,
    implementer,
  )
  const review: PlannedFollowUpTask = {
    id: `review-round-${nextRound}`,
    kind: 'review',
    subject: `review-round-${nextRound}`,
    assignee: reviewer,
    dependencies: [repair.id ?? `repair-round-${nextRound}`],
    round: nextRound,
    objective: sanitizeReviewObjective(closed.objective, DEFAULT_REVIEW_OBJECTIVE),
    acceptance: sanitizeReviewAcceptance(closed.acceptance),
    reviewedTaskId: repair.id,
  }
  return { created: [repair, review], tasks: [repair, review] }
}

export function buildCoverageMatrix(goalItems: readonly string[], tasks: readonly TeamTask[]): CoverageRow[] {
  return goalItems.map((goalItem) => {
    const covering = tasks.filter((item) => item.coverageOf?.includes(goalItem))
    const taskIds = covering.map((item) => item.id)
    if (covering.length === 0) return { goal_item: goalItem, task_ids: taskIds, status: 'missing' }
    if (covering.some((item) => item.status === 'failed' || item.status === 'cancelled')) {
      return { goal_item: goalItem, task_ids: taskIds, status: 'blocked' }
    }
    if (covering.every((item) => item.status === 'completed')) {
      return { goal_item: goalItem, task_ids: taskIds, status: 'passed' }
    }
    return { goal_item: goalItem, task_ids: taskIds, status: 'in_progress' }
  })
}

export function canDeclareDelivery(team: TeamState): DeliveryResult {
  const blockers: string[] = []
  if (team.phase === 'staged') blockers.push('team plan is awaiting approval')
  if (team.halted === true) blockers.push('team is halted')
  if (team.escalated === true) blockers.push('team requires escalation resolution')
  if (team.tasks.length === 0) blockers.push('team has no completed work')
  for (const item of team.tasks.filter(item => !isQualityKind(taskKindOf(item)))) {
    if (item.status !== 'completed' && item.status !== 'cancelled') blockers.push(`${item.id} (${taskKindOf(item)}) is not completed`)
  }
  if (team.tasks.length > 0 && team.tasks.every(item => item.status === 'cancelled')) blockers.push('all work was cancelled')
  const quality = team.tasks.filter((item) => isQualityKind(taskKindOf(item)))
  const implementations = quality.filter((item) => taskKindOf(item) === 'implementation' || taskKindOf(item) === 'repair')
  const reviews = quality.filter((item) => taskKindOf(item) === 'review')

  for (const item of quality) {
    const kind = taskKindOf(item)
    if (item.status === 'completed') {
      if ((kind === 'review' || kind === 'requirements') && item.verdict !== 'pass') {
        blockers.push(`${item.id} completed without verdict=pass`)
      }
      continue
    }
    if (item.status === 'failed') {
      const repaired = kind === 'review'
        ? quality.some((candidate) => (
          taskKindOf(candidate) === 'repair'
          && candidate.sourceTaskId === (item.reviewedTaskId ?? item.sourceTaskId)
          && (candidate.status === 'pending' || candidate.status === 'claimed' || candidate.status === 'in_progress' || candidate.status === 'completed')
        ))
        : kind === 'requirements'
          ? quality.some((candidate) => (
            taskKindOf(candidate) === 'requirements'
            && (candidate.round ?? 1) > (item.round ?? 1)
          ))
          : quality.some((candidate) => (
            taskKindOf(candidate) === 'repair' && candidate.sourceTaskId === item.id
          ))
      if (!repaired) blockers.push(`${item.id} failed without a follow-up repair`)
      continue
    }
    if (item.status === 'cancelled') continue
    blockers.push(`${item.id} (${kind}) is not completed`)
  }

  if (implementations.some((item) => item.status === 'completed') && !reviews.some((item) => item.status === 'completed' && item.verdict === 'pass')) {
    if (!blockers.some((item) => item.includes('review'))) {
      blockers.push('completed implementation has no passing review')
    }
  }

  // Only work that actually landed can have an unaudited path. A `cancelled`
  // (and, from WP3, `superseded`) task keeps whatever `changedPaths` it had
  // reported, and feedback §6.2 was that the captain had to scrub those by hand
  // before Delivery would clear. The status filter is on the loop itself, so the
  // audit still fires for every completed task.
  for (const item of implementations) {
    if (item.status !== 'completed') continue
    for (const path of item.changedPaths ?? []) {
      if (classifyChangedPath(path, item.inScope ?? [], item.outOfScope ?? []) !== 'in_scope') {
        blockers.push(`${item.id} has unaudited path ${path}`)
      }
    }
  }

  // A waiver is a claim the worker could not verify; the captain's reviewer has
  // to accept that claim before the team may report delivery (Q1).
  for (const id of unconfirmedWaivers(team)) {
    blockers.push(`${id} has unconfirmed waivers`)
  }

  return { ok: blockers.length === 0, blockers }
}

export function resumeTeamState(team: TeamState, reason: string): ResumeTeamResult {
  if (!nonemptyString(reason)) {
    return { ok: false, status: 'rejected', error: 'resume requires a non-empty reason' }
  }
  if (team.halted !== true) {
    return { ok: true, status: 'already_running', team }
  }
  return {
    ok: true,
    status: 'resumed',
    team: {
      ...team,
      halted: false,
      haltedAt: undefined,
    },
  }
}

export function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) return false
  return nonemptyString(value['id'])
    && (FINDING_SEVERITIES as readonly string[]).includes(value['severity'] as string)
    && nonemptyString(value['problem'])
    && nonemptyString(value['requiredFix'])
    && (value['file'] === undefined || nonemptyString(value['file']))
    && (value['line'] === undefined || (Number.isSafeInteger(value['line']) && (value['line'] as number) >= 0))
    && (value['resolved'] === undefined || typeof value['resolved'] === 'boolean')
}

export function isAcceptanceResult(value: unknown): value is AcceptanceResult {
  if (!isRecord(value)) return false
  const status = value['status']
  if (status !== 'passed' && status !== 'failed' && status !== 'waived') return false
  // A waiver is a claim that the criterion could not be measured honestly, so
  // it is meaningless without the stated reason.
  if (status === 'waived' && !nonemptyString(value['evidence'])) return false
  return nonemptyString(value['criterion'])
    && (value['evidence'] === undefined || typeof value['evidence'] === 'string')
}

/** Validate one acceptance criterion: a plain string, or `{text, mode?, baseline?}`. */
export function isAcceptanceCriterion(value: unknown): value is string | AcceptanceCriterion {
  if (nonemptyString(value)) return true
  if (!isRecord(value)) return false
  if (!nonemptyString(value['text'])) return false
  if (value['mode'] !== undefined && value['mode'] !== 'pass' && value['mode'] !== 'no_regression') return false
  if (value['baseline'] !== undefined && typeof value['baseline'] !== 'string') return false
  return Object.keys(value).every((key) => key === 'text' || key === 'mode' || key === 'baseline')
}

/** Validate one review waiver confirmation. */
export function isWaiverConfirmation(value: unknown): value is WaiverConfirmation {
  if (!isRecord(value)) return false
  if (!nonemptyString(value['taskId']) || !nonemptyString(value['reason'])) return false
  if (value['waived'] !== undefined) {
    if (!Array.isArray(value['waived']) || !(value['waived'] as unknown[]).every(nonemptyString)) return false
  }
  return Object.keys(value).every((key) => key === 'taskId' || key === 'reason' || key === 'waived')
}

export function isCommandResult(value: unknown): value is CommandResult {
  if (!isRecord(value)) return false
  const status = value['status']
  if (status !== 'passed' && status !== 'failed' && status !== 'waived') return false
  if (status === 'waived' && !nonemptyString(value['evidence'])) return false
  return nonemptyString(value['command'])
    && (value['exitCode'] === undefined || (Number.isSafeInteger(value['exitCode'])))
    && (value['evidence'] === undefined || typeof value['evidence'] === 'string')
}

export function isTaskRevision(value: unknown): value is TaskRevision {
  if (!isRecord(value)) return false
  return Number.isSafeInteger(value['at'])
    && nonemptyString(value['by'])
    && nonemptyString(value['reason'])
    && nonemptyStringList(value['fields'])
    && isRecord(value['previous'])
}

// Optional fields whose persisted values must be non-empty when present
// (mirrors the checks in hasValidQualityTaskFields). Some models materialize
// optional tool parameters as "" instead of omitting them (e.g. GPT-5.6
// sending reviewedTaskId:"" or profile:""), which would otherwise be written
// to team.json and then brick the whole team state on reload.
const BLANK_SENSITIVE_STRING_FIELDS = ['objective', 'reviewedTaskId', 'sourceTaskId'] as const
const BLANK_SENSITIVE_STRING_LIST_FIELDS = [
  'inScope',
  'outOfScope',
  'acceptance',
  'verify',
  'deliverables',
  'nonGoals',
  'changedPaths',
  'sourceFindingIds',
  'coverageOf',
] as const

/**
 * Normalize blank optional task fields to omitted ("blank means absent").
 * Blank string scalars are deleted; string lists have blank entries filtered
 * out, and a list that only contained blanks is omitted entirely. Non-blank
 * values and every other field are passed through untouched, so durable-state
 * validation stays strict.
 */
export function normalizeBlankOptionalTaskFields<T extends object>(task: T): T {
  const next = { ...task } as Record<string, unknown>
  for (const key of BLANK_SENSITIVE_STRING_FIELDS) {
    const value = next[key]
    if (typeof value === 'string' && value.trim() === '') delete next[key]
  }
  for (const key of BLANK_SENSITIVE_STRING_LIST_FIELDS) {
    const value = next[key]
    if (!Array.isArray(value)) continue
    const kept = value.filter((item) => !(typeof item === 'string' && item.trim() === ''))
    if (kept.length === value.length) continue
    if (kept.length === 0) delete next[key]
    else next[key] = kept
  }
  return next as T
}

export function hasValidQualityTaskFields(value: Record<string, unknown>): boolean {
  if (value['kind'] !== undefined && !(TASK_KINDS as readonly string[]).includes(value['kind'] as string)) return false
  if (value['verdict'] !== undefined && !(REVIEW_VERDICTS as readonly string[]).includes(value['verdict'] as string)) return false
  if (value['round'] !== undefined && !(Number.isSafeInteger(value['round']) && (value['round'] as number) >= 1)) return false
  if (value['objective'] !== undefined && !nonemptyString(value['objective'])) return false
  if (value['reviewedTaskId'] !== undefined && !nonemptyString(value['reviewedTaskId'])) return false
  if (value['sourceTaskId'] !== undefined && !nonemptyString(value['sourceTaskId'])) return false
  if (value['reviewedAttempt'] !== undefined && !(Number.isSafeInteger(value['reviewedAttempt']) && (value['reviewedAttempt'] as number) >= 0)) {
    return false
  }
  const stringLists = ['inScope', 'outOfScope', 'verify', 'deliverables', 'nonGoals', 'changedPaths', 'sourceFindingIds', 'coverageOf'] as const
  for (const key of stringLists) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(nonemptyString)) return false
  }
  if (value['acceptance'] !== undefined) {
    if (!Array.isArray(value['acceptance']) || !(value['acceptance'] as unknown[]).every(isAcceptanceCriterion)) return false
  }
  if (value['hasWaivers'] !== undefined && typeof value['hasWaivers'] !== 'boolean') return false
  if (value['waiverConfirmation'] !== undefined && !isWaiverConfirmation(value['waiverConfirmation'])) return false
  if (value['findings'] !== undefined) {
    if (!Array.isArray(value['findings']) || !value['findings'].every(isReviewFinding)) return false
    const ids = (value['findings'] as ReviewFinding[]).map((finding) => finding.id)
    if (new Set(ids).size !== ids.length) return false
  }
  if (value['acceptanceResults'] !== undefined) {
    if (!Array.isArray(value['acceptanceResults']) || !value['acceptanceResults'].every(isAcceptanceResult)) return false
  }
  if (value['commandsRun'] !== undefined) {
    if (!Array.isArray(value['commandsRun']) || !value['commandsRun'].every(isCommandResult)) return false
  }
  if (value['revisions'] !== undefined) {
    if (!Array.isArray(value['revisions']) || !value['revisions'].every(isTaskRevision)) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value)
}

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value)
}

export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value)
}

export function looksLikeGateTestContract(value: string | undefined): boolean {
  return typeof value === 'string' && GATE_TEST_CONTRACT.test(value)
}

export function sanitizeReviewObjective(value: string | undefined, fallback = DEFAULT_REVIEW_OBJECTIVE): string {
  if (!nonemptyString(value) || looksLikeGateTestContract(value)) return fallback
  return value.trim()
}

/** Accept a list that the union type allows to contain plain strings or objects. */
function acceptanceTexts(values: readonly (string | AcceptanceCriterion)[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  return values.map(acceptanceCriterionText)
}

/** Normalize review acceptance criteria coming from another review contract. */
export function sanitizeReviewAcceptance(values: readonly (string | AcceptanceCriterion)[] | undefined): string[] {
  const cleaned = (acceptanceTexts(values) ?? [])
    .map((item) => item.trim())
    .filter((item) => item !== '' && !looksLikeGateTestContract(item))
  return cleaned.length > 0 ? cleaned : [...DEFAULT_REVIEW_ACCEPTANCE]
}

export function defaultQualityDeliveryGraph(input: {
  goal: string
  implementer?: string
  reviewer?: string
  analyst?: string
  tester?: string
  integrator?: string
}): QualityGraphDraft[] {
  const goal = input.goal.trim() || 'the stated user goal'
  const analyst = input.analyst
  const implementer = input.implementer
  const tester = input.tester ?? input.implementer
  const reviewer = input.reviewer
  const integrator = input.integrator ?? input.reviewer
  return [
    {
      subject: 'requirements-round-1',
      kind: 'requirements',
      assignee: analyst,
      dependencies: [],
      objective: `Converge requirements for: ${goal}`,
      acceptance: ['Open questions are closed or explicitly deferred', 'Acceptance criteria are testable'],
      coverageOf: [goal],
    },
    {
      subject: 'implementation',
      kind: 'implementation',
      assignee: implementer,
      dependencies: ['requirements-round-1'],
      objective: `Implement the approved requirements for: ${goal}`,
      acceptance: ['The implementation matches the approved requirements'],
      inScope: ['src/'],
      verify: ['pnpm test'],
      coverageOf: [goal],
    },
    {
      subject: 'verification',
      kind: 'verification',
      assignee: tester,
      dependencies: ['implementation'],
      objective: `Verify the implementation of: ${goal}`,
      acceptance: ['Declared verification commands pass'],
      coverageOf: [goal],
    },
    {
      subject: 'review-round-1',
      kind: 'review',
      assignee: reviewer,
      dependencies: ['verification'],
      objective: DEFAULT_REVIEW_OBJECTIVE,
      acceptance: [...DEFAULT_REVIEW_ACCEPTANCE],
      coverageOf: [goal],
    },
    {
      subject: 'integration',
      kind: 'integration',
      assignee: integrator,
      dependencies: ['review-round-1'],
      objective: `Confirm the team can declare delivery for: ${goal}`,
      acceptance: ['All required quality tasks are completed with passing reviews'],
      coverageOf: [goal],
    },
  ]
}

export function qualityPlanningPrompt(): string {
  return [
    'When the user explicitly requests full quality-mode planning, use this order unless a constraint forbids a stage: requirements → implementation → verification → review → integration.',
    'Build that entire DAG while the team is staged: an implementation may be created before requirements finishes when its dependency chain includes that requirements task. This is supported; do not wait for requirements to run and do not inspect plugin source to confirm it.',
    'A staged integration task may depend on review round 1. If that review later returns needs_revision, the system automatically rewires still-pending downstream dependencies to the generated repair + next-review gate, so keep integration in the original plan instead of omitting or manually recreating it.',
    'Derive inScope and verification commands from the actual workspace or explicit profile; never assume src/ or pnpm test.',
    'Give every quality task a contract. Review acceptance must judge the latest implementation, not whether the gate rejects needs_revision.',
    'Do not write smoke-test scripts into tasks. Do not ask reviewers to submit needs_revision on purpose.',
    'Do not claim implementation or review yourself unless the user asked the captain to take over.',
    'After a failed review, wait for the automatic repair + next review. Do not recreate that loop by hand.',
    'halted means the human stopped the team; call agent_teams_resume before creating more work. escalated means the automatic review loop hit its ceiling; that is not halt.',
  ].join(' ')
}

export function describeQualityLoop(team: TeamState): QualityLoopSnapshot {
  const delivery = canDeclareDelivery(team)
  if (team.halted === true) {
    return {
      state: 'halted',
      halted: true,
      escalated: team.escalated === true,
      deliverable: false,
      summary: 'Team is halted. Call agent_teams_resume with a reason before creating more work.',
    }
  }
  if (delivery.ok) {
    return {
      state: 'deliverable',
      halted: false,
      escalated: team.escalated === true,
      deliverable: true,
      summary: 'All required work and quality gates passed. The captain may report delivery.',
    }
  }
  if (team.escalated === true) {
    return {
      state: 'escalated',
      halted: false,
      escalated: true,
      deliverable: false,
      summary: 'Automatic review/repair loop hit its ceiling. The team is still running; do not treat this as halt. Escalate to the user instead of inventing another needs_revision cycle.',
    }
  }
  const open = team.tasks.some((item) => OPEN_STATUSES.includes(item.status))
  return {
    state: open ? 'running' : 'blocked',
    halted: false,
    escalated: false,
    deliverable: false,
    summary: open
      ? 'Work remains on the shared task list; wait for the scheduler or complete owned tasks.'
      : `Delivery is blocked: ${delivery.blockers.join('; ') || 'unresolved quality gates'}.`,
  }
}

export { QUALITY_KINDS, WRITE_KINDS }
