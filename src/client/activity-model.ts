/** Pure relationship projections used by the AgentTeams activity panel. */

import type { TaskOrigin } from '../types.ts'

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

// ── WP11 phase 2: several teams in one panel ───────────────────────────────

/** Where the panel remembers which team the reader is looking at. */
export const PANEL_TEAM_STORAGE_KEY = 'dsh-agent-teams:activity-panel:team:v1'

/** One tab of the panel's team switcher. */
export interface PanelTeamTab {
  readonly teamId: string
  readonly name: string
  readonly halted: boolean
  readonly phase: string
  /** Members currently working, for the tab's activity dot. */
  readonly working: number
  readonly done: number
  readonly total: number
}

/**
 * The tabs of the team switcher: one per live team of the current session, in
 * the order the snapshots arrive. Counters come from each team's own tasks, so a
 * tab can never report another team's work.
 */
export function panelTeamTabs<T extends {
  readonly teamId: string
  readonly name: string
  readonly halted?: boolean
  readonly phase?: string
  readonly members: readonly { readonly status?: string; readonly activity?: string }[]
  readonly tasks: readonly { readonly status: string }[]
}>(teams: readonly T[]): readonly PanelTeamTab[] {
  return teams.map((team) => ({
    teamId: team.teamId,
    name: team.name,
    halted: team.halted === true,
    phase: team.phase ?? 'running',
    working: team.members.filter((member) => member.activity === 'working' || member.status === 'working').length,
    done: team.tasks.filter((task) => task.status === 'completed').length,
    total: team.tasks.length,
  }))
}

/** A stored switcher preference, trimmed; `null` when nothing usable was stored. */
export function parsePanelTeamSelection(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * Which team the panel shows: the stored choice while that team still exists,
 * otherwise the first live team. A halted team stays selectable — it is stopped
 * work, not hidden work — and an empty session has no selection at all.
 */
export function panelSelectedTeamId<T extends { readonly teamId: string }>(
  teams: readonly T[],
  stored: string | null | undefined,
): string | null {
  if (teams.length === 0) return null
  const wanted = parsePanelTeamSelection(stored)
  if (wanted !== null && teams.some((team) => team.teamId === wanted)) return wanted
  return teams[0]?.teamId ?? null
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

/**
 * The progress block as the panel renders it.
 *
 * The panel shows one bar. The snapshot also publishes a per-phase roll-up
 * (`byPhase`) and the wire mirror below keeps it, but no view field surfaces it:
 * the owner read the row-per-phase block as a wall of bars and removed it
 * (2026-09-20, round 2), so the selector deliberately has nothing to map.
 */
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
  /**
   * Round 3: the bar is one line in three colours — the original plan, what the
   * captain added while it ran, and what arrived after the plan had settled. Always
   * three entries, in that order, so the bar can draw its zones without guessing.
   */
  readonly segments: readonly ProgressSegmentView[]
}

/** One coloured stretch of the progress bar. */
export interface ProgressSegmentView {
  readonly origin: TaskOrigin
  readonly completed: number
  readonly total: number
  readonly percent: number
}

/**
 * The host progress payload, mirrored structurally (see activity-monitor).
 * `byPhase` is part of the published snapshot, not of what the panel draws.
 */
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
  /** Round 3: the three stretches of the plan, in bar order. */
  readonly segments?: readonly { origin: TaskOrigin; completed: number; total: number; percent: number }[]
}

/** A stored progress-mode preference, or `null` when nothing usable was stored. */
export function parseProgressMode(raw: string | null | undefined): ProgressMode | null {
  if (raw === 'equal' || raw === 'byKind') return raw
  return null
}

/** The three stretches in bar order; a host payload is normalized against it. */
const FALLBACK_ORIGINS: readonly TaskOrigin[] = ['plan', 'added', 'followup']

/** Equal-weight percentage over the tasks themselves (no host payload). */
function fallbackProgress(tasks: readonly { readonly status: string; readonly state?: string; readonly origin?: TaskOrigin }[]): PlanProgressView {
  let total = 0
  let completed = 0
  let running = 0
  let blocked = 0
  let failed = 0
  let superseded = 0
  let cancelled = 0
  const byOrigin = new Map<TaskOrigin, { completed: number; total: number }>()
  const bucketOf = (origin: TaskOrigin) => {
    const existing = byOrigin.get(origin) ?? { completed: 0, total: 0 }
    byOrigin.set(origin, existing)
    return existing
  }
  for (const task of tasks) {
    const bucket = bucketOf(task.origin ?? 'plan')
    if (task.status === 'completed') {
      completed += 1
      total += 1
      bucket.completed += 1
      bucket.total += 1
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
    bucket.total += 1
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
    segments: FALLBACK_ORIGINS.map((origin) => {
      const bucket = byOrigin.get(origin) ?? { completed: 0, total: 0 }
      return {
        origin,
        completed: bucket.completed,
        total: bucket.total,
        percent: bucket.total === 0 ? 0 : Math.round((bucket.completed / bucket.total) * 100),
      }
    }),
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
 * @returns the numbers the panel draws.
 */
export function planProgress(
  team: { readonly tasks: readonly { readonly status: string; readonly state?: string; readonly origin?: TaskOrigin }[]; readonly progress?: ProgressPayload },
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
    // A payload from a host older than round 3 carries no segments; the bar then
    // shows the whole plan as one zone instead of inventing a split.
    segments: payload.segments === undefined
      ? FALLBACK_ORIGINS.map((origin) => ({
        origin,
        completed: origin === 'plan' ? payload.completed : 0,
        total: origin === 'plan' ? payload.total : 0,
        percent: origin === 'plan' ? percentOf(payload) : 0,
      }))
      : FALLBACK_ORIGINS.map((origin) => payload.segments?.find((segment) => segment.origin === origin)
        ?? { origin, completed: 0, total: 0, percent: 0 }),
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
 * Whether a task is settled: done, red, or dead (cancelled, or replaced by
 * another task). A superseded task will never finish, so every projection that
 * asks "is this lane over" must treat it like the other terminal statuses.
 */
export function settledTask(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'superseded'
}

/** Natural-id ordering used by every projection below. */
function byTaskId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id, 'en', { numeric: true })
}

// ── WP10: the phase board, the panel's only cut of the same state ──

/** One task as the phase board needs to see it. */
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
  /** Set on a review task: the task it judges, so a blocked review stays visible. */
  readonly reviewedTaskId?: string
}

/** A manually declared phase (comes from `plan.phases` once WP7 lands). */
export interface ManualPhase {
  readonly id: string
  readonly title?: string
  readonly taskIds: readonly string[]
  /** Round 3: a closed phase takes no new work; the board marks its column. */
  readonly closed?: boolean
  readonly closedAt?: number
}

/** One phase column of the phase board. */
export interface PhaseColumn<T extends PhaseTask> {
  /** `level-N` for a derived column, or the manual phase id. */
  readonly phaseId: string
  readonly order: number
  readonly title?: string
  readonly tasks: readonly T[]
  /** Round 3: the captain closed this phase, so its column is marked as settled. */
  readonly closed?: boolean
  readonly closedAt?: number
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
 * Phase columns for the phase board.
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
      ...phase.closed === true ? { closed: true } : {},
      ...phase.closedAt === undefined ? {} : { closedAt: phase.closedAt },
    })
  }
  const rest = tasks.filter((task) => !assigned.has(task.id))
  // A declared plan wins even when it accounts for every task: the unphased
  // column only collects what the plan left out. Requiring `rest` to be non-empty
  // here discarded the declared columns for a fully declared plan and fell
  // through to the DAG levels, which then had nothing left to lay out — the
  // board came out empty, exactly for the max-effort plans that declare phases.
  if (columns.length > 0) {
    if (rest.length > 0) {
      columns.push({ phaseId: 'unphased', order: columns.length, tasks: rest.slice().sort(byTaskId) })
    }
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

/** Palette shared by every view; the same agent keeps one colour everywhere. */
const AGENT_COLORS = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-label-tertiary)',
] as const

/**
 * Stable colour token for one agent name, identical on the phase board and in
 * the member list. `captain` and unassigned work get their own reserved tokens so
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

/** A phase board: one flexible column per phase, chains laid out inside it. */
export interface PhaseBoardLayout<T extends PhaseTask> {
  readonly width: number
  readonly height: number
  readonly columns: readonly {
    readonly phaseId: string
    readonly order: number
    readonly title?: string
    /** Left edge of the column; the column spans {@link width}. */
    readonly x: number
    /** How wide this column grew to fit its longest same-phase chain. */
    readonly width: number
    /** Task ids of this column, so a reader never has to infer them from x. */
    readonly taskIds: readonly string[]
    /** Round 3: the column belongs to a phase the captain closed. */
    readonly closed?: boolean
    readonly closedAt?: number
  }[]
  readonly nodes: readonly PhaseNode<T>[]
  readonly edges: readonly PhaseEdge[]
}

/**
 * Lay the phase board out: one column per phase, and inside a column the work
 * runs left to right along its own chain.
 *
 * The owner's request (2026-09-20, round 2): a phase that contains sequential
 * work must read as a line rather than a stack, and the column stretches to fit
 * the longest chain it holds. So a task's x inside its column is its **chain
 * depth** — the longest path of dependencies that live in the same phase — and
 * its row is the row its same-column predecessors already use when they agree,
 * otherwise the first free row at that depth. Parallel work therefore keeps its
 * own row while a chain stays on one line, which is what makes a separate tree
 * view unnecessary. An edge is emitted for every dependency whose other end also
 * landed on the board.
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
  const placed: {
    phaseId: string
    order: number
    title?: string
    x: number
    width: number
    taskIds: string[]
    closed?: boolean
    closedAt?: number
  }[] = []
  let columnX = 0
  let boardHeight = 0
  for (const column of columns) {
    const inColumn = new Map(column.tasks.map((task) => [task.id, task]))
    /** Longest chain of dependencies that stay inside this phase. */
    const depthOf = (task: T, seen: ReadonlySet<string> = new Set()): number => {
      const local = task.dependencies.filter((id) => inColumn.has(id) && !seen.has(id))
      if (local.length === 0) return 0
      return 1 + Math.max(...local.map((id) => depthOf(inColumn.get(id) as T, new Set([...seen, task.id]))))
    }
    const depths = new Map(column.tasks.map((task) => [task.id, depthOf(task)]))
    const rowsAtDepth = new Map<number, Set<number>>()
    const rowOfTask = new Map<string, number>()
    const ordered = [...column.tasks].sort((left, right) => (
      (depths.get(left.id) ?? 0) - (depths.get(right.id) ?? 0) || left.id.localeCompare(right.id)
    ))
    for (const task of ordered) {
      const depth = depths.get(task.id) ?? 0
      const used = rowsAtDepth.get(depth) ?? new Set<number>()
      // A chain continues on its predecessor's row; parallel work stacks.
      const predecessorRows = task.dependencies
        .map((id) => rowOfTask.get(id))
        .filter((row): row is number => row !== undefined)
      const shared = predecessorRows.length > 0 && predecessorRows.every((row) => row === predecessorRows[0])
        ? predecessorRows[0]
        : undefined
      let row = shared !== undefined && !used.has(shared) ? shared : 0
      while (used.has(row)) row += 1
      used.add(row)
      rowsAtDepth.set(depth, used)
      rowOfTask.set(task.id, row)
    }
    const maxDepth = Math.max(0, ...[...depths.values()])
    const maxRow = Math.max(0, ...[...rowOfTask.values()])
    const width = (maxDepth + 1) * COMPACT_DAG_NODE_WIDTH + maxDepth * COMPACT_DAG_COLUMN_GAP
    placed.push({
      phaseId: column.phaseId,
      order: column.order,
      ...column.title === undefined ? {} : { title: column.title },
      x: columnX,
      width,
      taskIds: column.tasks.map((task) => task.id),
      ...column.closed === true ? { closed: true } : {},
      ...column.closedAt === undefined ? {} : { closedAt: column.closedAt },
    })
    for (const task of column.tasks) {
      const x = columnX + (depths.get(task.id) ?? 0) * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP)
      const y = (rowOfTask.get(task.id) ?? 0) * (COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
      positions.set(task.id, { x, y })
      nodes.push({ task, x, y })
    }
    columnX += width + COMPACT_DAG_COLUMN_GAP
    boardHeight = Math.max(boardHeight, (maxRow + 1) * COMPACT_DAG_NODE_HEIGHT + maxRow * COMPACT_DAG_ROW_GAP)
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
  return {
    width: columns.length === 0 ? 0 : columnX - COMPACT_DAG_COLUMN_GAP,
    height: columns.length === 0 ? 0 : boardHeight,
    columns: placed,
    nodes,
    edges,
  }
}
