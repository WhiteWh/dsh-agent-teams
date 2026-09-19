/** Pure relationship projections used by the AgentTeams activity panel. */

/** Minimum task shape needed to derive dependency relationships. */
export interface RelationshipTask {
  readonly id: string
  readonly dependencies: readonly string[]
  readonly depth: number
}

/** One dependency-depth stage in stable display order. */
export interface RelationshipStage<T extends RelationshipTask> {
  readonly depth: number
  readonly tasks: readonly T[]
}

/** Geometry used by the compact task DAG in the activity panel. */
export interface CompactDagNode<T extends RelationshipTask> {
  readonly task: T
  readonly x: number
  readonly y: number
}

/** One dependency edge routed between two compact DAG nodes. */
export interface CompactDagEdge {
  readonly from: string
  readonly to: string
  readonly path: string
}

/** Complete, scrollable compact DAG projection. */
export interface CompactDagLayout<T extends RelationshipTask> {
  readonly width: number
  readonly height: number
  readonly nodes: readonly CompactDagNode<T>[]
  readonly edges: readonly CompactDagEdge[]
}

/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export const COMPACT_DAG_NODE_WIDTH = 92
export const COMPACT_DAG_NODE_HEIGHT = 30
export const COMPACT_DAG_COLUMN_GAP = 26
export const COMPACT_DAG_ROW_GAP = 8

/** Compact `provider/model` route, or just the model when the provider is absent. */
export function memberRouteLabel(member: { readonly provider?: string; readonly model?: string } | undefined): string {
  if (member === undefined) return ''
  const provider = member.provider?.trim() ?? ''
  const model = member.model?.trim() ?? ''
  if (provider !== '' && model !== '') return `${provider}/${model}`
  return model
}

/**
 * Compact route shown on a running task. Prefer the task's own snapshot
 * field; fall back to the assignee member when older hosts omit it.
 */
export function taskModelLabel(
  task: { readonly model?: string; readonly assignee: string },
  members: readonly { readonly name: string; readonly provider?: string; readonly model?: string }[],
): string {
  const direct = task.model?.trim() ?? ''
  if (direct !== '') return direct
  return memberRouteLabel(members.find((candidate) => candidate.name === task.assignee))
}

/** Short model id for tight DAG/chip surfaces (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export function compactModelLabel(route: string): string {
  const trimmed = route.trim()
  if (trimmed === '') return ''
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** A live team the current captain still owns and has not halted. */
export function liveCaptainTeam<T extends { readonly captainSessionId: string; readonly halted?: boolean }>(
  teams: readonly T[],
  sessionId: string | undefined,
): T | undefined {
  const owner = sessionId?.trim() ?? ''
  if (owner === '') return undefined
  return teams.find((team) => team.captainSessionId === owner && team.halted !== true)
}

/** Whether the captain chat should keep showing the in-progress banner. */
export function teamIsActive(team: {
  readonly phase?: string
  readonly halted?: boolean
  readonly members: readonly { readonly status?: string; readonly activity?: string }[]
  readonly tasks: readonly { readonly status: string }[]
}): boolean {
  if (team.halted === true || team.phase === 'staged') return false
  if (team.members.some((member) => member.activity === 'working' || member.status === 'working')) return true
  if (team.tasks.some((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress')) return true
  return team.members.length > 0 && team.tasks.length === 0
}

/** Compact banner copy: running members, otherwise the current planning state. */
export function teamProgressSummary(
  team: {
    readonly members: readonly { readonly name: string; readonly status?: string; readonly activity?: string; readonly currentTask?: string }[]
    readonly tasks: readonly { readonly id: string; readonly subject: string; readonly status: string }[]
  },
  separator: string,
): { readonly working: number; readonly detail: string } {
  const workingMembers = team.members.filter((member) => member.activity === 'working' || member.status === 'working')
  const runningTasks = team.tasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress')
  const labels = runningTasks.map((task) => task.subject.trim() || task.id).filter((label) => label !== '')
  if (workingMembers.length > 0 || labels.length > 0) {
    return {
      working: Math.max(workingMembers.length, labels.length),
      detail: labels.slice(0, 2).join(separator),
    }
  }
  if (team.tasks.length === 0) return { working: 0, detail: '' }
  return { working: 0, detail: '' }
}

// ── WP8: plan progress and the task checklist ──────────────────────────────

/** How the headline percentage is computed. Both numbers arrive from the host. */
export type ProgressMode = 'byKind' | 'equal'

/** Where the panel remembers the reader's progress-mode choice. */
export const PROGRESS_MODE_STORAGE_KEY = 'dsh-agent-teams:activity-panel:progress:v1'

/** One phase row of the progress block. */
export interface ProgressPhaseView {
  readonly phaseId: string
  readonly title?: string
  readonly percent: number
  readonly completed: number
  readonly total: number
}

/** The progress block as the panel renders it. */
export interface PlanProgressView {
  readonly mode: ProgressMode
  readonly percent: number
  readonly percentByKind: number
  readonly percentEqual: number
  readonly completed: number
  readonly total: number
  readonly running: number
  readonly blocked: number
  readonly failed: number
  readonly waived: number
  readonly superseded: number
  readonly cancelled: number
  readonly phases: readonly ProgressPhaseView[]
}

/** The host progress payload, mirrored structurally (see activity-monitor). */
interface ProgressPayload {
  readonly mode: ProgressMode
  readonly percentByKind: number
  readonly percentEqual: number
  readonly completed: number
  readonly total: number
  readonly running: number
  readonly blocked: number
  readonly failed: number
  readonly waived: number
  readonly superseded: number
  readonly cancelled: number
  readonly byPhase: readonly { phaseId: string; title?: string; percentByKind: number; percentEqual: number; completed: number; total: number }[]
}

/** A stored progress-mode preference, or `null` when nothing usable was stored. */
export function parseProgressMode(raw: string | null | undefined): ProgressMode | null {
  if (raw === 'equal' || raw === 'byKind') return raw
  return null
}

/** Equal-weight percentage over the tasks themselves (no host payload). */
function fallbackProgress(tasks: readonly { readonly status: string; readonly state?: string }[]): PlanProgressView {
  let total = 0
  let completed = 0
  let running = 0
  let blocked = 0
  let failed = 0
  let superseded = 0
  let cancelled = 0
  for (const task of tasks) {
    if (task.status === 'completed') {
      completed += 1
      total += 1
      continue
    }
    if (task.status === 'cancelled') {
      cancelled += 1
      continue
    }
    if (task.status === 'superseded') {
      superseded += 1
      continue
    }
    total += 1
    if (task.status === 'failed') failed += 1
    else if (task.state === 'blocked') blocked += 1
    else if (task.status !== 'pending') running += 1
  }
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)
  return {
    // Without the host payload only the equal count is computable, so the
    // fallback reports the mode it actually used instead of mislabelling it.
    mode: 'equal',
    percent,
    percentByKind: percent,
    percentEqual: percent,
    completed,
    total,
    running,
    blocked,
    failed,
    waived: 0,
    superseded,
    cancelled,
    phases: [],
  }
}

/**
 * The progress block of one team: the host's two percentages, with the one the
 * reader asked for selected. The math stays on the server (WP8) — this selector
 * only picks a number and follows the mode switch, so the text report, the
 * conversation card and the panel cannot drift apart.
 *
 * A synthetic team (a legacy card rebuilt without a snapshot payload) has no
 * host numbers; it falls back to the equal count over its own tasks.
 *
 * @param team - the team snapshot, with or without a `progress` payload.
 * @param mode - the requested mode, or undefined for the team's default.
 * @returns the numbers and phase rows the panel draws.
 */
export function planProgress(
  team: { readonly tasks: readonly { readonly status: string; readonly state?: string }[]; readonly progress?: ProgressPayload },
  mode?: ProgressMode | null,
): PlanProgressView {
  const payload = team.progress
  if (payload === undefined) return fallbackProgress(team.tasks)
  const selected: ProgressMode = mode ?? payload.mode
  const percentOf = (entry: { percentByKind: number; percentEqual: number }): number => (
    selected === 'equal' ? entry.percentEqual : entry.percentByKind
  )
  return {
    mode: selected,
    percent: percentOf(payload),
    percentByKind: payload.percentByKind,
    percentEqual: payload.percentEqual,
    completed: payload.completed,
    total: payload.total,
    running: payload.running,
    blocked: payload.blocked,
    failed: payload.failed,
    waived: payload.waived,
    superseded: payload.superseded,
    cancelled: payload.cancelled,
    phases: payload.byPhase.map((phase) => ({
      phaseId: phase.phaseId,
      ...phase.title === undefined ? {} : { title: phase.title },
      percent: percentOf(phase),
      completed: phase.completed,
      total: phase.total,
    })),
  }
}

/** The four states a checklist row can show. */
export type ChecklistTone = 'done' | 'open' | 'running' | 'failed'

/**
 * The checkbox of one task status: the glyph the checklist row draws plus the
 * tone its styling keys off. A cancelled or superseded task is a crossed box —
 * it is settled and will not be delivered.
 */
export function taskCheckGlyph(status: string): { readonly tone: ChecklistTone; readonly glyph: string } {
  if (status === 'completed') return { tone: 'done', glyph: '✓' }
  if (status === 'failed' || status === 'cancelled' || status === 'superseded') return { tone: 'failed', glyph: '✕' }
  if (status === 'claimed' || status === 'in_progress' || status === 'awaiting_scope_review') {
    return { tone: 'running', glyph: '◐' }
  }
  return { tone: 'open', glyph: '○' }
}

/** Use a fill-width grid when the task graph has no real dependency edges. */
export function usesParallelTaskGrid<T extends RelationshipTask>(tasks: readonly T[]): boolean {  if (tasks.length === 0) return false
  const taskIds = new Set(tasks.map((task) => task.id))
  return tasks.every((task) => task.dependencies.every((dependency) => !taskIds.has(dependency)))
}

/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export function activityPanelExpandedForSession(
  open: boolean,
  owner: string | undefined,
  current: string | undefined,
): boolean {
  return open && owner !== undefined && owner === current
}

/** Inputs for deciding whether genuinely new live work may expand the panel. */
export interface ActivityPanelAutoExpandInput {
  readonly alreadyAutoOpened: boolean
  readonly pageSettled: boolean
  readonly restoreComplete: boolean
  readonly previousLiveTeamIds: ReadonlySet<string>
  readonly currentLiveTeamIds: readonly string[]
}

/**
 * Auto-expand only for live teams that appear after the current session's
 * initial restore pass. Replayed cards, archived teams, and live teams restored
 * while reopening a conversation must remain behind the collapsed badge.
 */
export function activityPanelShouldAutoExpand({
  alreadyAutoOpened,
  pageSettled,
  restoreComplete,
  previousLiveTeamIds,
  currentLiveTeamIds,
}: ActivityPanelAutoExpandInput): boolean {
  return !alreadyAutoOpened
    && pageSettled
    && restoreComplete
    && currentLiveTeamIds.some((teamId) => !previousLiveTeamIds.has(teamId))
}

/**
 * Resolve the task whose dependency chain should be highlighted.
 *
 * A pinned task is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the task map with the keyboard.
 */
export function dependencyFocusTaskId(
  pinnedTaskId: string | null,
  keyboardTaskId: string | null,
  hoverTaskId: string | null,
): string | null {
  return pinnedTaskId ?? keyboardTaskId ?? hoverTaskId
}

/** Group tasks by their precomputed dependency depth. */
export function taskStages<T extends RelationshipTask>(tasks: readonly T[]): readonly RelationshipStage<T>[] {
  const byDepth = new Map<number, T[]>()
  for (const task of tasks) {
    const depth = Number.isFinite(task.depth) ? Math.max(0, Math.floor(task.depth)) : 0
    const stage = byDepth.get(depth) ?? []
    stage.push(task)
    byDepth.set(depth, stage)
  }
  return [...byDepth.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, stageTasks]) => ({
      depth,
      tasks: stageTasks.slice().sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true })),
    }))
}

/**
 * Lay tasks out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages. Rows are stable task-id order within
 * each stage. Edges use cubic curves so fan-in remains readable without
 * turning every task into a large card.
 */
export function compactDagLayout<T extends RelationshipTask>(tasks: readonly T[]): CompactDagLayout<T> {
  const stages = taskStages(tasks)
  const positions = new Map<string, { x: number; y: number }>()
  const nodes: CompactDagNode<T>[] = []
  for (const [column, stage] of stages.entries()) {
    for (const [row, task] of stage.tasks.entries()) {
      const x = column * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP)
      const y = row * (COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
      positions.set(task.id, { x, y })
      nodes.push({ task, x, y })
    }
  }
  const edges: CompactDagEdge[] = []
  for (const task of tasks) {
    const target = positions.get(task.id)
    if (target === undefined) continue
    for (const dependency of task.dependencies) {
      const source = positions.get(dependency)
      if (source === undefined) continue
      const x1 = source.x + COMPACT_DAG_NODE_WIDTH
      const y1 = source.y + COMPACT_DAG_NODE_HEIGHT / 2
      const x2 = target.x
      const y2 = target.y + COMPACT_DAG_NODE_HEIGHT / 2
      edges.push({
        from: dependency,
        to: task.id,
        path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
      })
    }
  }
  const rows = Math.max(1, ...stages.map((stage) => stage.tasks.length))
  return {
    width: stages.length === 0
      ? 0
      : stages.length * COMPACT_DAG_NODE_WIDTH + (stages.length - 1) * COMPACT_DAG_COLUMN_GAP,
    height: stages.length === 0
      ? 0
      : rows * COMPACT_DAG_NODE_HEIGHT + (rows - 1) * COMPACT_DAG_ROW_GAP,
    nodes,
    edges,
  }
}

/**
 * Whether a task is settled: done, red, or dead (cancelled, or replaced by
 * another task). A superseded task will never finish, so every projection that
 * asks "is this lane over" must treat it like the other terminal statuses.
 */
export function settledTask(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'superseded'
}

/** Whether a task has already finished (either way). */
function isTerminal(status: string): boolean {
  return settledTask(status)
}

/** Natural-id ordering used by every projection below. */
function byTaskId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id, 'en', { numeric: true })
}

// ── WP10: three read-only cuts of the same state (phases, agents, queues) ──

/** One task as the three cuts need to see it. */
export interface PhaseTask {
  readonly id: string
  readonly subject?: string
  readonly status: string
  readonly assignee: string
  readonly dependencies: readonly string[]
  readonly state?: string
  readonly kind?: string
  readonly round?: number
  readonly depth?: number
  /** Set on a review task: the task it judges, used for the waiting-review reason. */
  readonly reviewedTaskId?: string
}

/** One member row the three cuts need to see. */
export interface ProjectionMember {
  readonly id?: string
  readonly name: string
  readonly activity?: string
  readonly status?: string
  readonly done?: number
  readonly total?: number
  readonly currentTask?: string
  readonly unread?: number
}

/** A manually declared phase (comes from `plan.phases` once WP7 lands). */
export interface ManualPhase {
  readonly id: string
  readonly title?: string
  readonly taskIds: readonly string[]
}

/** One phase column of the phases view. */
export interface PhaseColumn<T extends PhaseTask> {
  /** `level-N` for a derived column, or the manual phase id. */
  readonly phaseId: string
  readonly order: number
  readonly title?: string
  readonly tasks: readonly T[]
}

/** One dependency level of an auto-derived phase column. */
function autoLevel(taskId: string, byId: ReadonlyMap<string, PhaseTask>): number {
  const seen = new Set<string>()
  const levelOf = (id: string): number => {
    if (seen.has(id)) return 0
    const task = byId.get(id)
    if (task === undefined) return 0
    seen.add(id)
    const dependencies = task.dependencies.filter((dependency) => byId.has(dependency))
    if (dependencies.length === 0) return 0
    return 1 + Math.max(...dependencies.map(levelOf))
  }
  return levelOf(taskId)
}

/**
 * Phase columns for the phases view.
 *
 * Manual phases win when they are present (WP7 stores them in `plan.phases`);
 * every task they do not mention falls back into an auto-derived column built
 * from the DAG levels, so a partially declared plan still renders completely.
 * Levels are computed here from the task list, not read from the snapshot's
 * `depth`, so the column count cannot silently disagree with the dependency
 * edges the panel draws.
 *
 * @param tasks - the team's tasks.
 * @param manualPhases - optional declared phases.
 * @returns the columns in display order, left to right.
 */
export function phaseColumns<T extends PhaseTask>(
  tasks: readonly T[],
  manualPhases: readonly ManualPhase[] = [],
): readonly PhaseColumn<T>[] {
  if (tasks.length === 0) return []
  const byId = new Map<string, PhaseTask>(tasks.map((task) => [task.id, task]))
  const columns: PhaseColumn<T>[] = []
  const assigned = new Set<string>()
  for (const [order, phase] of manualPhases.entries()) {
    const members = phase.taskIds
      .filter((taskId) => byId.has(taskId) && !assigned.has(taskId))
      .map((taskId) => byId.get(taskId) as T)
    for (const task of members) assigned.add(task.id)
    columns.push({
      phaseId: phase.id,
      order,
      ...phase.title === undefined ? {} : { title: phase.title },
      tasks: members.slice().sort(byTaskId),
    })
  }
  const rest = tasks.filter((task) => !assigned.has(task.id))
  if (rest.length > 0 && columns.length > 0) {
    columns.push({ phaseId: 'unphased', order: columns.length, tasks: rest.slice().sort(byTaskId) })
    return columns
  }
  const byLevel = new Map<number, T[]>()
  for (const task of rest) {
    const level = autoLevel(task.id, byId)
    const bucket = byLevel.get(level) ?? []
    bucket.push(task)
    byLevel.set(level, bucket)
  }
  return [...byLevel.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, bucket]) => ({
      phaseId: `level-${level}`,
      order: level,
      tasks: bucket.slice().sort(byTaskId),
    }))
}

/** One participant lane of the agents view. */
export interface Swimlane<T extends PhaseTask> {
  readonly member?: ProjectionMember
  readonly name: string
  readonly completed: readonly T[]
  readonly running: readonly T[]
  readonly queued: readonly T[]
  readonly blocked: readonly T[]
  /** Unfinished dependencies of the blocked tasks, deduplicated. */
  readonly blockedBy: readonly string[]
}

/**
 * One row per participant: what they finished, what they hold now, what they
 * can pick up next and what a failed dependency is holding back.
 *
 * A task is `queued` when every dependency reached `completed`, and `blocked`
 * otherwise (with the offending ids surfaced as {@link Swimlane.blockedBy}) —
 * that pair is what answers "why is the team standing still".
 *
 * Since v0.1.22 the panel no longer renders this projection: the owner dropped
 * the Agents view because the member tree above carries the same information.
 * The projection stays as tested model code (see FOLLOWUPS F5) — either a future
 * view renders it again, or it goes together with its checks.
 */
export function agentSwimlanes<T extends PhaseTask>(
  tasks: readonly T[],
  members: readonly ProjectionMember[],
): readonly Swimlane<T>[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]))
  const lane = (member: ProjectionMember | undefined, name: string): Swimlane<T> => {
    const owned = tasks.filter((task) => task.assignee === name)
    const unfinished = owned.filter((task) => !isTerminal(task.status))
    const blocked = unfinished.filter((task) => blockingIds(task, statusById).length > 0)
    const blockedBy: string[] = []
    for (const task of blocked) {
      for (const id of blockingIds(task, statusById)) {
        if (blockedBy.includes(id)) continue
        blockedBy.push(id)
      }
    }
    return {
      ...member === undefined ? {} : { member },
      name,
      completed: owned.filter((task) => task.status === 'completed').sort(byTaskId),
      running: owned.filter((task) => task.status === 'in_progress' || task.status === 'claimed').sort(byTaskId),
      queued: unfinished.filter((task) => !blocked.includes(task)).sort(byTaskId),
      blocked: blocked.slice().sort(byTaskId),
      blockedBy,
    }
  }
  const lanes = members.map((member) => lane(member, member.name))
  const unassigned = lane(undefined, '')
  if (unassigned.completed.length + unassigned.running.length + unassigned.queued.length + unassigned.blocked.length > 0) {
    lanes.push(unassigned)
  }
  return lanes
}

/** Why one participant has nothing to do right now. */
export type IdleReason =
  | { readonly kind: 'no-tasks' }
  | { readonly kind: 'all-done' }
  | { readonly kind: 'blocked-by'; readonly tasks: readonly string[] }
  | { readonly kind: 'waiting-review-of'; readonly taskId: string }

/** One participant's queue: what they hold, what is next, and why not. */
export interface AgentQueue<T extends PhaseTask> {
  readonly member?: ProjectionMember
  readonly taken: readonly T[]
  readonly next?: T
  readonly waitingOn: readonly string[]
  readonly idleReason: IdleReason
}

/** Unfinished dependencies of one task. */
function waitingDependencies(task: PhaseTask, statusById: ReadonlyMap<string, string>): string[] {
  return task.dependencies.filter((dependency) => statusById.get(dependency) !== 'completed')
}

/**
 * Everything that still fences one task: unfinished dependencies plus, for a
 * `review`, the task it judges. A review of a task that has not finished is not
 * claimable — closing it would certify work that does not exist yet.
 */
function blockingIds(task: PhaseTask, statusById: ReadonlyMap<string, string>): string[] {
  const blocking = waitingDependencies(task, statusById)
  if (task.kind === 'review'
    && task.reviewedTaskId !== undefined
    && !isTerminal(statusById.get(task.reviewedTaskId) ?? 'pending')
    && !blocking.includes(task.reviewedTaskId)) {
    blocking.push(task.reviewedTaskId)
  }
  return blocking
}

/** Whether a task can be picked up right now. */
function isClaimable(task: PhaseTask, statusById: ReadonlyMap<string, string>): boolean {
  return !isTerminal(task.status) && blockingIds(task, statusById).length === 0
}

/**
 * The queue view's row for one participant.
 *
 * `next` is the first claimable task assigned to them; `idleReason` says why
 * there is none, in the order the panel explains it: the member holds no work
 * at all, everything they hold is terminal, their next task waits on named
 * upstream tasks, or they are the reviewer of a task that has not finished.
 */
export function agentQueue<T extends PhaseTask>(
  tasks: readonly T[],
  members: readonly ProjectionMember[],
  member: ProjectionMember | undefined,
): AgentQueue<T> {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]))
  if (member === undefined) {
    const unassigned = tasks.filter((task) => task.assignee === '').sort(byTaskId)
    const next = unassigned.find((task) => isClaimable(task, statusById))
    const waitingOn = [...new Set(unassigned.flatMap((task) => blockingIds(task, statusById)))]
    const idleReason: IdleReason = next !== undefined
      ? { kind: 'no-tasks' }
      : waitingOn.length > 0
        ? { kind: 'blocked-by', tasks: waitingOn }
        : { kind: 'no-tasks' }
    return {
      taken: unassigned,
      ...next === undefined ? {} : { next },
      waitingOn,
      idleReason,
    }
  }
  const taken = tasks.filter((task) => task.assignee === member.name).sort(byTaskId)
  const next = taken.find((task) => isClaimable(task, statusById))
  const waitingOn = [...new Set(taken.flatMap((task) => blockingIds(task, statusById)))]
  if (next !== undefined) return { member, taken, next, waitingOn, idleReason: { kind: 'no-tasks' } }
  if (taken.length > 0 && taken.every((task) => isTerminal(task.status))) {
    return { member, taken, waitingOn, idleReason: { kind: 'all-done' } }
  }
  const waitingReview = taken.find((task) => (
    task.kind === 'review'
    && task.reviewedTaskId !== undefined
    && !isTerminal(statusById.get(task.reviewedTaskId) ?? 'pending')
  ))
  if (waitingReview?.reviewedTaskId !== undefined) {
    return { member, taken, waitingOn, idleReason: { kind: 'waiting-review-of', taskId: waitingReview.reviewedTaskId } }
  }
  if (waitingOn.length > 0) {
    return { member, taken, waitingOn, idleReason: { kind: 'blocked-by', tasks: waitingOn } }
  }
  return { member, taken, waitingOn, idleReason: { kind: 'no-tasks' } }
}

/** Locale key plus params for one idle reason. */
export interface IdleReasonSummary {
  readonly key: 'queue.idle.noTasks' | 'queue.idle.allDone' | 'queue.idle.blockedBy' | 'queue.idle.waitingReview'
  readonly params: { readonly tasks?: string; readonly taskId?: string }
}

/** Translate one idle reason into its locale key and interpolation params. */
export function idleReasonSummary(reason: IdleReason): IdleReasonSummary {
  switch (reason.kind) {
    case 'all-done':
      return { key: 'queue.idle.allDone', params: {} }
    case 'blocked-by':
      return { key: 'queue.idle.blockedBy', params: { tasks: reason.tasks.join(', ') } }
    case 'waiting-review-of':
      return { key: 'queue.idle.waitingReview', params: { taskId: reason.taskId } }
    default:
      return { key: 'queue.idle.noTasks', params: {} }
  }
}

/** One grouped idle reason of the queue overview. */
export interface IdleReasonGroup {
  readonly key: IdleReasonSummary['key']
  readonly count: number
}

/** Headline plus grouped reasons for the queue view. */
export interface QueueOverview {
  readonly idleCount: number
  readonly idleTotal: number
  readonly groups: readonly IdleReasonGroup[]
}

/**
 * Group the team's idle reasons: the direct answer to "8 of 9 are idle — why?".
 *
 * A member whose next task exists is working, not idle, and is excluded from
 * both the count and the groups.
 */
export function queueOverview<T extends PhaseTask>(
  tasks: readonly T[],
  members: readonly ProjectionMember[],
): QueueOverview {
  const groups: IdleReasonGroup[] = []
  let idleCount = 0
  for (const member of members) {
    const queue = agentQueue(tasks, members, member)
    if (queue.next !== undefined) continue
    idleCount += 1
    const key = idleReasonSummary(queue.idleReason).key
    const existing = groups.find((group) => group.key === key)
    if (existing === undefined) groups.push({ key, count: 1 })
    else groups[groups.indexOf(existing)] = { key, count: existing.count + 1 }
  }
  return {
    idleCount,
    idleTotal: members.length,
    groups: groups.slice().sort((left, right) => right.count - left.count || left.key.localeCompare(right.key, 'en')),
  }
}

/** Palette shared by every view; the same agent keeps one colour everywhere. */
const AGENT_COLORS = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-label-tertiary)',
] as const

/**
 * Stable colour token for one agent name, identical in the tree, phase and
 * agent views. `captain` and unassigned work get their own reserved tokens so
 * they never collide with a member's colour.
 *
 * @param name - member name, `captain`, or `''` for unassigned work.
 */
export function agentColor(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return AGENT_COLORS[4]
  if (trimmed === 'captain') return AGENT_COLORS[0]
  let hash = 0
  for (let index = 0; index < trimmed.length; index += 1) {
    hash = ((hash << 5) - hash + trimmed.charCodeAt(index)) | 0
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length] ?? AGENT_COLORS[0]
}

/** The two read-only cuts plus the original dependency tree. */
export type ActivityViewMode = 'tree' | 'phases' | 'queues'

/** Persisted per-browser choice of panel view, next to the panel geometry. */
export const ACTIVITY_VIEW_STORAGE_KEY = 'dsh-agent-teams:activity-panel:view:v1'

/** One positioned node of the phase board. */
export interface PhaseNode<T extends PhaseTask> {
  readonly task: T
  readonly x: number
  readonly y: number
}

/** One dependency edge of the phase board. */
export interface PhaseEdge {
  readonly from: string
  readonly to: string
  readonly path: string
}

/** A phase board laid out in fixed columns, one per phase. */
export interface PhaseBoardLayout<T extends PhaseTask> {
  readonly width: number
  readonly height: number
  readonly columns: readonly { readonly phaseId: string; readonly order: number; readonly title?: string; readonly x: number }[]
  readonly nodes: readonly PhaseNode<T>[]
  readonly edges: readonly PhaseEdge[]
}

/**
 * Parse a persisted view choice, falling back to the dependency tree.
 *
 * A stored `agents` — the swimlane view the panel no longer renders, because the
 * member tree above already carries the same information — falls back to the
 * tree rather than leaving the tab strip without a selected tab.
 */
export function parseActivityView(raw: string | null | undefined): ActivityViewMode {
  return raw === 'phases' || raw === 'queues' ? raw : 'tree'
}

/**
 * Lay the phase board out with a fixed X per phase column.
 *
 * This is {@link compactDagLayout}'s geometry with the column taken from the
 * phase instead of the dependency depth, so a manually declared phase keeps its
 * declared order even when its tasks sit at mixed depths. Rows are assigned in
 * task-id order inside each column, and an edge is emitted for every dependency
 * whose other end also landed on the board.
 *
 * @param tasks - the team's tasks.
 * @param manualPhases - optional declared phases (WP7's `plan.phases`).
 */
export function phaseBoardLayout<T extends PhaseTask>(
  tasks: readonly T[],
  manualPhases: readonly ManualPhase[] = [],
): PhaseBoardLayout<T> {
  const columns = phaseColumns(tasks, manualPhases)
  const positions = new Map<string, { x: number; y: number }>()
  const nodes: PhaseNode<T>[] = []
  const placed: { phaseId: string; order: number; title?: string; x: number }[] = []
  for (const [index, column] of columns.entries()) {
    const x = index * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP)
    placed.push({
      phaseId: column.phaseId,
      order: column.order,
      ...column.title === undefined ? {} : { title: column.title },
      x,
    })
    for (const [row, task] of column.tasks.entries()) {
      const y = row * (COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
      positions.set(task.id, { x, y })
      nodes.push({ task, x, y })
    }
  }
  const edges: PhaseEdge[] = []
  for (const task of tasks) {
    const target = positions.get(task.id)
    if (target === undefined) continue
    for (const dependency of task.dependencies) {
      const source = positions.get(dependency)
      if (source === undefined) continue
      const x1 = source.x + COMPACT_DAG_NODE_WIDTH
      const y1 = source.y + COMPACT_DAG_NODE_HEIGHT / 2
      const x2 = target.x
      const y2 = target.y + COMPACT_DAG_NODE_HEIGHT / 2
      edges.push({
        from: dependency,
        to: task.id,
        path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
      })
    }
  }
  const rows = Math.max(1, ...columns.map((column) => column.tasks.length))
  return {
    width: columns.length === 0
      ? 0
      : columns.length * COMPACT_DAG_NODE_WIDTH + (columns.length - 1) * COMPACT_DAG_COLUMN_GAP,
    height: columns.length === 0 ? 0 : rows * COMPACT_DAG_NODE_HEIGHT + (rows - 1) * COMPACT_DAG_ROW_GAP,
    columns: placed,
    nodes,
    edges,
  }
}

/**
 * Return the complete upstream/downstream chain around one task.
 *
 * Traversal uses both dependency directions and remains cycle-safe, so the UI
 * can highlight every handoff related to the focused task even if malformed
 * durable data contains a cycle.
 */
export function relatedTaskIds(taskId: string, tasks: readonly RelationshipTask[]): ReadonlySet<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  if (!byId.has(taskId)) return new Set()
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const targets = dependents.get(dependency) ?? []
      targets.push(task.id)
      dependents.set(dependency, targets)
    }
  }
  const related = new Set<string>()
  const upstreamSeen = new Set<string>()
  const downstreamSeen = new Set<string>()
  const visitUpstream = (id: string): void => {
    if (upstreamSeen.has(id)) return
    upstreamSeen.add(id)
    related.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) visitUpstream(dependency)
  }
  const visitDownstream = (id: string): void => {
    if (downstreamSeen.has(id)) return
    downstreamSeen.add(id)
    related.add(id)
    for (const dependent of dependents.get(id) ?? []) visitDownstream(dependent)
  }
  visitUpstream(taskId)
  visitDownstream(taskId)
  return related
}
