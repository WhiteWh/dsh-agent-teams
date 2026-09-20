/**
 * AgentTeams activity panel: the top-right floater monitoring every team.
 *
 * Modeled on the Claude Code desktop SessionActivityPanel: a shell-overlay
 * panel that docks at the conversation's top-right edge by default, can be
 * dragged into a floating window, resized, and folded into an activity badge.
 * On wide viewports the docked panel makes the conversation column yield
 * space; narrow viewports keep a simple inset overlay. It
 * polls the host `/plugins/dsh-agent-teams/state` route for
 * server-side snapshots (durable files + live subagent activity), with a
 * collapsed badge that auto-expands once when activity appears. Archived
 * teams stay available for the owning conversation after live work ends.
 *
 * The floater mounts in ui-layout's additive `shell.overlay`; it is not a
 * conversation node — the in-conversation panel was removed in favor of this
 * always-available monitor.
 * @module dsh-agent-teams/client/activity
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, Component,
} from 'react'
import {
  IconBranchOutline16, IconChevronDownOutline14, IconPanelLeftOutline16,
  IconStopFill16, IconWarningOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectory, ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  activityPanelExpandedForSession,
  activityPanelShouldAutoExpand,
  agentColor,
  compactModelLabel,
  COMPACT_DAG_NODE_HEIGHT,
  COMPACT_DAG_NODE_WIDTH,
  memberRouteLabel,
  parsePanelTeamSelection,
  parseProgressMode,
  PANEL_TEAM_STORAGE_KEY,
  panelSelectedTeamId,
  panelTeamTabs,
  phaseBoardLayout,
  phaseColumns,
  planProgress as planProgressView,
  PROGRESS_MODE_STORAGE_KEY,
  settledTask,
  taskCheckGlyph,
  taskModelLabel,
  teamIsActive,
  type ManualPhase,
  type PanelTeamTab,
  type ProgressMode,
} from './activity-model.ts'
import {
  ACTIVITY_HALT_URL,
  getActivityMonitorTargetsSnapshot,
  getActivitySnapshotsSnapshot,
  startActivityPolling,
  subscribeActivityMonitorTargets,
  subscribeActivitySnapshots,
  type ActivityMember,
  type ActivityTask,
  type ActivityTeam,
} from './activity-monitor.ts'

/** The authenticated plan route: the running-mode replan editor posts here. */
const ACTIVITY_PLAN_URL = '/plugins/dsh-agent-teams/plan'
import { ACTION_SYMBOL, LEAD_ART, memberArtUrl, memberSymbolUrl, ownerSymbolUrl } from './artwork.ts'
import { OPEN_PANEL_EVENT } from './AgentTeamsCard.tsx'
import { StagingPlanEditor } from './StagingPlanEditor.tsx'
import type { AgentTeamsCardData } from './agent-teams-card-definition.ts'
import type { AgentTeamsLocaleKey, AgentTeamsTranslate } from './locales.ts'
import {
  DEFAULT_PANEL_LAYOUT,
  PANEL_LAYOUT_STORAGE_KEY,
  compactPanelForBounds,
  dockPanelLayout,
  floatPanelLayout,
  movePanelLayout,
  panelMaximumHeight,
  panelUsesAutoHeight,
  parsePanelLayout,
  resizePanelLayout,
  resolvePanelGeometry,
  type PanelBounds,
  type PanelLayout,
  type PanelResizeEdge,
} from './panel-geometry.ts'
import css from './ActivityPanel.module.css'

/** Grace before the panel collapses once no team remains. */
const AUTOCLOSE_GRACE_MS = 2000
/**
 * Page-settle window after mount: activity restored on page load only shows
 * the collapsed badge, so the panel never yanks the conversation column
 * right after load. New activity after this window auto-expands as usual.
 */
const AUTO_OPEN_SETTLE_MS = 4000
/** Root marker shared with the panel CSS while the shell overlay is expanded. */
const PANEL_OPEN_ATTRIBUTE = 'data-agent-teams-panel-open'
/** Shared width concession consumed by the conversation root CSS. */
const PANEL_SHIFT_PROPERTY = '--agent-teams-panel-shift'
const PANEL_CONVERSATION_GAP = 14
const MOVE_THRESHOLD = 4
const CAPTAIN_ASSIGNEE = 'captain'

type PanelGesture = {
  readonly kind: 'move' | 'resize'
  readonly edge?: PanelResizeEdge
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  readonly start: PanelLayout
  activated: boolean
}

function initialPanelLayout(): PanelLayout {
  if (typeof window === 'undefined') return DEFAULT_PANEL_LAYOUT
  return parsePanelLayout(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY))
}

function initialPanelBounds(): PanelBounds {
  if (typeof window === 'undefined') return { width: 1440, height: 900, anchorRight: 1440 }
  return { width: window.innerWidth, height: window.innerHeight, anchorRight: window.innerWidth }
}

/** Initial-letter fallback for unmatched roles. */
function memberInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function stableHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

const ACCENTS = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-label-tertiary)',
] as const

function accentOf(id: string): string {
  return ACCENTS[stableHash(id) % ACCENTS.length] ?? ACCENTS[0]
}

/** Badge text follows the raw task status (finer than the 4 visual states):
 * claimed/pending/failed/cancelled keep their own labels and colors. */
const TASK_STATUS_LABEL: Record<string, AgentTeamsLocaleKey> = {
  pending: 'task.status.pending',
  claimed: 'task.status.claimed',
  in_progress: 'task.status.inProgress',
  awaiting_scope_review: 'task.status.awaitingScopeReview',
  completed: 'task.status.completed',
  failed: 'task.status.failed',
  cancelled: 'task.status.cancelled',
  superseded: 'task.status.superseded',
}

function taskStatusLabel(status: string, t: AgentTeamsTranslate): string {
  const key = TASK_STATUS_LABEL[status]
  return key === undefined ? status : t(key)
}

function formatTaskIds(ids: readonly string[], t: AgentTeamsTranslate): string {
  return ids.join(t('format.listSeparator'))
}

function taskTitle(task: ActivityTask, model: string): string {
  const extras = [
    task.kind,
    task.round === undefined ? undefined : `r${task.round}`,
    task.verdict,
    model === '' ? undefined : model,
  ].filter((item): item is string => item !== undefined)
  return extras.length === 0 ? `${task.id} · ${task.subject}` : `${task.id} · ${task.subject} · ${extras.join(' · ')}`
}

/** Badge/bar coloring key: visual state, widened for terminal statuses. */
function taskTone(state: ActivityTask['state'], status: string): string {
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  // A replaced lane is dead, not red: it gets its own grey tone (WP3).
  if (status === 'superseded') return 'superseded'
  return state
}

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg className={css.chevron} data-open={open} width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M3.5 2l3 3-3 3" />
    </svg>
  )
}

function WorkGlyph({ active }: { readonly active: boolean }) {
  return (
    <svg className={css.workGlyph} data-active={active} width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden>
      {[[0, 0], [4.2, 0], [8.4, 0], [0, 4.2], [4.2, 4.2], [8.4, 4.2]].map(([x, y], index) => (
        <rect key={`${x}:${y}`} x={x} y={y} width="2.6" height="2.6" rx=".6" style={{ animationDelay: `${index * 0.15}s` }} />
      ))}
    </svg>
  )
}

/**
 * The work plaque of a member node (owner request, 2026-09-20).
 *
 * The compact six-dot mark read as decoration: it said "something is running"
 * without being part of the node it described. The plaque is the node's own
 * height and three dots wide, and its dots run a top-to-bottom wave while the
 * member works, so the state is visible from the shape of the row itself.
 * The text label next to it stays the accessible answer.
 */
function WorkBar({ active }: { readonly active: boolean }) {
  // Owner request (2026-09-20, round 3): three rows, not five — the plaque was
  // sized for the retired two-line member row, and space-between still spreads
  // the rows over the node's height, so the wave stays readable while the node
  // gets shorter.
  const rows = [0, 1, 2]
  const columns = [0, 1, 2]
  return (
    <span className={css.workBar} data-active={active} data-work-bar={active} aria-hidden>
      {rows.map((row) => (
        <span key={`row-${String(row)}`} className={css.workBarRow}>
          {columns.map((column) => (
            <span
              key={`dot-${String(row)}-${String(column)}`}
              className={css.workBarDot}
              style={{ animationDelay: `${String(row * 0.12)}s` }}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

/** Collapsed badge: an always-visible corner pill while any team exists. */
function CollapsedBadge({ count, busy, onClick, t }: {
  readonly count: number
  readonly busy: boolean
  readonly onClick: () => void
  readonly t: AgentTeamsTranslate
}) {
  return (
    <button type="button" className={css.badge} data-agent-teams-collapsed data-busy={busy} onClick={onClick} aria-label={t('activity.badgeAria', { count })}>
      {/* The pill is the most compact surface in the product: a mascot cannot
          fit and a coloured dot says only "something is on". The action symbol
          carries the same busy/idle meaning and stays readable at this size. */}
      <img className={css.badgeSymbol} data-busy={busy} src={busy ? ACTION_SYMBOL.working : ACTION_SYMBOL.idle} alt="" aria-hidden />
      <span className={css.badgeCount}>{count}</span>
    </button>
  )
}

function memberStateLabel(
  member: ActivityMember,
  tasks: readonly ActivityTask[],
  historic: boolean,
  t: AgentTeamsTranslate,
): string {
  const owned = tasks.filter((task) => task.assignee === member.name)
  if (member.activity === 'working') return t('member.state.working')
  if (owned.some((task) => task.status === 'failed')) return t('member.state.failed')
  if (owned.some((task) => task.state === 'blocked')) return t('member.state.waiting')
  if (owned.length > 0 && owned.every((task) => task.status === 'completed')) return t('member.state.delivered')
  if (member.status === 'removed') return t(historic ? 'member.state.left' : 'member.state.removed')
  if (owned.length > 0) return t('member.state.pending')
  return t('member.state.unassigned')
}

/**
 * The second line of a large member node: the sentence behind the state word.
 *
 * It names the concrete task a member is holding, the dependency that holds it
 * back, or why it has nothing to do — the detail the compact tray leaves to the
 * chip row. Round 3 restored it together with the large default node.
 */
function memberStatusText(
  member: ActivityMember,
  tasks: readonly ActivityTask[],
  t: AgentTeamsTranslate,
): string {
  const owned = tasks.filter((task) => task.assignee === member.name)
  const current = owned.find((task) => task.id === member.currentTask)
  const blocked = owned.find((task) => task.state === 'blocked')
  if (member.activity === 'working' && current !== undefined) {
    const model = taskModelLabel(current, [member])
    return model === ''
      ? t('member.status.executing', { taskId: current.id })
      : t('member.status.executingModel', { taskId: current.id, model })
  }
  if (member.activity === 'working') return t('member.status.working')
  if (blocked !== undefined) {
    const dependency = tasks.find((task) => blocked.dependencies.includes(task.id) && task.state !== 'completed')
    if (dependency !== undefined) {
      return t('member.status.waitingOn', {
        taskId: dependency.id,
        assignee: dependency.assignee || t('task.assignee.unclaimed'),
      })
    }
    return t('member.status.waitingPrerequisite')
  }
  if (member.total === 0) return t('member.status.waitingAssignment')
  if (member.done === member.total) return t('member.status.delivered')
  return t(member.activity === 'idle' ? 'member.status.idle' : 'member.status.unknown')
}

function compactTaskLabel(subject: string): string {
  const withoutVerb = subject.replace(/^开发\s*/u, '').replace(/^\d+[-_.、\s]*/u, '')
  const head = withoutVerb.split(/[（(·：:]/u)[0]?.trim() ?? withoutVerb
  return head.length > 18 ? `${head.slice(0, 17)}…` : head
}

function taskSummary(team: ActivityTeam, t: AgentTeamsTranslate, discarded = false): string {
  const completed = team.tasks.filter((task) => task.status === 'completed')
  const cancelled = team.tasks.filter((task) => task.status === 'cancelled')
  const superseded = team.tasks.filter((task) => task.status === 'superseded')
  const running = team.tasks.filter((task) => task.state === 'running')
  const blocked = team.tasks.filter((task) => task.state === 'blocked')
  const ready = team.tasks.filter((task) => task.state === 'open' && !settledTask(task.status))
  const failed = team.tasks.filter((task) => task.status === 'failed')
  if (discarded) return t('task.summary.discarded', { count: team.tasks.length })
  if (team.tasks.length === 0) return t('task.summary.waitingBreakdown')
  if (team.phase === 'staged') return t('task.summary.staged', { count: team.tasks.length })
  if (completed.length === team.tasks.length) return t('task.summary.allDelivered', { count: completed.length })
  if (completed.length + cancelled.length + failed.length + superseded.length === team.tasks.length) {
    return t('task.summary.ended', {
      completed: completed.length,
      cancelled: cancelled.length,
      failed: failed.length,
      superseded: superseded.length,
    })
  }
  if (failed.length > 0 && running.length === 0 && ready.length === 0 && blocked.length === 0) {
    return t('task.summary.failedSettled', { count: failed.length })
  }
  if (blocked.length > 0 && running.length > 0) {
    return t('task.summary.blockedAndRunning', {
      tasks: formatTaskIds(blocked.slice(0, 3).map((task) => task.id), t),
      more: blocked.length > 3 ? t('task.summary.more', { count: blocked.length - 3 }) : '',
    })
  }
  if (running.length > 0) return t('task.summary.running', { tasks: formatTaskIds(running.map((task) => task.id), t) })
  if (ready.length > 0) return t('task.summary.ready', { tasks: formatTaskIds(ready.map((task) => task.id), t) })
  if (blocked.length > 0) return t('task.summary.blocked', { tasks: formatTaskIds(blocked.map((task) => task.id), t) })
  return t('task.summary.waitingSchedule')
}

function ProgressOverview({ team, t, discarded = false }: { readonly team: ActivityTeam; readonly t: AgentTeamsTranslate; readonly discarded?: boolean }) {
  const running = discarded ? 0 : team.tasks.filter((task) => task.state === 'running').length
  const blocked = discarded ? 0 : team.tasks.filter((task) => task.state === 'blocked').length
  const completed = discarded ? 0 : team.tasks.filter((task) => task.status === 'completed').length
  const settled = !discarded && team.tasks.length > 0 && team.tasks.every((task) => settledTask(task.status))
  const summaryTone = discarded ? 'discarded' : blocked > 0 ? 'warning' : settled ? 'completed' : 'running'
  // WP8: the two percentages come from the host; this only selects one and
  // remembers the reader's choice, so the panel matches `agent_teams_status`.
  const [mode, setMode] = useState<ProgressMode | null>(() => {
    try {
      return parseProgressMode(window.localStorage.getItem(PROGRESS_MODE_STORAGE_KEY))
    } catch {
      return null
    }
  })
  const progress = planProgressView(team, mode)
  const selectMode = (): void => {
    const next: ProgressMode = progress.mode === 'equal' ? 'byKind' : 'equal'
    setMode(next)
    try {
      window.localStorage.setItem(PROGRESS_MODE_STORAGE_KEY, next)
    } catch {
      // A blocked localStorage only costs the preference, never the switch.
    }
  }
  return (
    <section className={css.progressOverview} aria-label={t('progress.aria')} data-progress-summary>
      <span className={css.progressTitle}>{t('progress.title')}</span>
      {discarded
        ? <span className={css.progressEmpty} />
        : (
          <span className={css.progressBarBlock} data-progress-bar={progress.percent}>
            {/* Round 3 (owner request): one line, three colours. Each zone is as
                wide as its stretch is big, and the filled part of the zone is the
                work already delivered in that stretch — so "how much of this was
                the plan" reads off the bar itself. */}
            <span className={css.progressBar} data-progress-segments>
              {progress.segments.map((segment) => (
                <span
                  key={segment.origin}
                  className={css.progressSegment}
                  data-origin={segment.origin}
                  style={{ flexGrow: Math.max(segment.total, 0.0001) }}
                  title={t('progress.segment.title', {
                    label: t(`progress.segment.${segment.origin}`),
                    percent: segment.percent,
                    completed: segment.completed,
                    total: segment.total,
                  })}
                >
                  <span
                    className={css.progressSegmentFill}
                    style={{ width: `${String(segment.percent)}%` }}
                    data-segment-fill={segment.origin}
                  />
                </span>
              ))}
            </span>
            <span className={css.progressPercent}>
              {t('progress.percent', { percent: progress.percent, completed: progress.completed, total: progress.total })}
            </span>
            <button
              type="button"
              className={css.progressModeButton}
              data-progress-mode={progress.mode}
              title={t('progress.mode.hint')}
              onClick={selectMode}
            >
              {t(progress.mode === 'equal' ? 'progress.mode.equal' : 'progress.mode.byKind')}
            </button>
          </span>
        )}
      {!discarded && progress.segments.some((segment) => segment.total > 0) && (
        <span className={css.progressSegmentLegend} data-progress-segment-legend>
          {progress.segments.filter((segment) => segment.total > 0).map((segment) => (
            <span key={segment.origin} className={css.progressSegmentKey} data-origin={segment.origin}>
              {`${t(`progress.segment.${segment.origin}`)} ${String(segment.completed)}/${String(segment.total)}`}
            </span>
          ))}
        </span>
      )}
      {team.tasks.length > 0 ? (
        <span className={css.progressSegments} aria-hidden>
          {team.tasks.map((task) => <span key={task.id} data-state={discarded ? 'cancelled' : taskTone(task.state, task.status)} />)}
        </span>
      ) : <span className={css.progressEmpty} />}
      <span className={css.progressLegend}>
        <span data-state="running">{t('progress.running', { count: running })}</span>
        <span data-state="blocked">{t('progress.blocked', { count: blocked })}</span>
        <span data-state="completed">{t('progress.delivered', { count: completed })}</span>
      </span>
      <span className={css.progressSummary} data-state={summaryTone}>
        <span className={css.progressSummaryDot} />
        <span>{taskSummary(team, t, discarded)}</span>
      </span>
    </section>
  )
}

/**
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
        <span className={css.taskDetailSubject} title={task.subject}>{task.subject.replace(/^开发\s*/u, '')}</span>
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
function TaskNode({ task, members, t, style, parallel = false, discarded = false, pinned = false, focused = true, dimmed = false, onClick, onHover }: {
  readonly task: ActivityTask
  readonly members: readonly ActivityMember[]
  readonly t: AgentTeamsTranslate
  readonly style: CSSProperties
  readonly parallel?: boolean
  readonly discarded?: boolean
  readonly pinned?: boolean
  readonly focused?: boolean
  readonly dimmed?: boolean
  readonly onClick?: () => void
  readonly onHover?: (id: string | null) => void
}) {
  const model = taskModelLabel(task, members)
  const shortModel = compactModelLabel(model)
  return (
    <button
      type="button"
      className={css.dagNode}
      style={{ ...style, ...(parallel ? { height: COMPACT_DAG_NODE_HEIGHT } : { width: COMPACT_DAG_NODE_WIDTH, height: COMPACT_DAG_NODE_HEIGHT }) }}
      data-task-id={task.id}
      data-state={discarded ? 'cancelled' : taskTone(task.state, task.status)}
      data-task-model={model || undefined}
      data-agent={task.assignee || 'unassigned'}
      data-focused={focused}
      data-dimmed={dimmed}
      aria-pressed={pinned}
      title={taskTitle(task, model)}
      onClick={onClick}
      onMouseEnter={onHover === undefined ? undefined : () => { onHover(task.id) }}
      onMouseLeave={onHover === undefined ? undefined : () => { onHover(null) }}
    >
      {/* The node head stays text: a 12px role mark next to a 9.5px id was the
          least readable spot in the panel (owner report), and the assignment is
          already named in the task detail line below the board. */}
      <span className={css.dagNodeHead}><span className={css.dagNodeDot} style={{ background: agentColor(task.assignee) }} />{task.id}</span>
      <span className={css.dagNodeLabel}>
        {task.state === 'running' && shortModel !== '' ? shortModel : compactTaskLabel(task.subject)}
      </span>
      {task.state === 'running' && (
        <span className={css.dagRunningState} aria-label={t('task.runningAria')}>
          <WorkGlyph active />
        </span>
      )}
    </button>
  )
}

/** Phase board: one column per phase, stretched to the longest chain it holds. */
function PhaseBoard({ tasks, members, t, discarded = false, pinnedTaskId, onPin, manualPhases = [] }: {
  readonly tasks: readonly ActivityTask[]
  readonly members: readonly ActivityMember[]
  readonly t: AgentTeamsTranslate
  readonly discarded?: boolean
  readonly pinnedTaskId?: string | null
  readonly onPin?: (id: string) => void
  /** Declared phases (WP7): they win over the derived DAG levels. */
  readonly manualPhases?: readonly ManualPhase[]
}) {
  const layout = useMemo(() => phaseBoardLayout(tasks, manualPhases), [tasks, manualPhases])
  if (tasks.length === 0) return null
  return (
    <div className={css.phaseBoardViewport} data-phase-board>
      {/* Headers and canvas live in one scroller so the phase titles cannot
          drift away from the columns they name; each header sits at the same
          x the layout gave that column's nodes. */}
      <div className={css.phaseBoardScroll} data-phase-scroll>
        <div className={css.phaseHeaderRow} style={{ width: layout.width }}>
          {layout.columns.map((column) => {
            // A column owns its phase's tasks; the count cannot be derived from
            // x any more, because a chain spreads across the column's width.
            const count = column.taskIds.length
            const title = column.title ?? (column.phaseId === 'unphased'
              ? t('phase.unphased')
              : t('phase.column', { order: column.order + 1 }))
            return (
              <div
                key={column.phaseId}
                className={css.phaseColumn}
                style={{ left: column.x, width: column.width }}
                data-phase-id={column.phaseId}
                data-closed={column.closed === true}
              >
                <span className={css.phaseColumnHead} title={title}>{title}</span>
                <span className={css.phaseColumnCount}>{t('phase.count', { count })}</span>
                {column.closed === true && <span className={css.phaseClosedMark}>{t('phase.closed')}</span>}
              </div>
            )
          })}
        </div>
        <div className={css.dagCanvas} data-layout="phases" style={{ width: layout.width, height: layout.height }}>
          <svg className={css.dagEdges} width={layout.width} height={layout.height} aria-hidden>
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}:${edge.to}`}
                d={edge.path}
                data-active={pinnedTaskId !== undefined && pinnedTaskId !== null && (edge.from === pinnedTaskId || edge.to === pinnedTaskId)}
              />
            ))}
          </svg>
          {layout.nodes.map(({ task, x, y }) => (
            <TaskNode
              key={task.id}
              task={task}
              members={members}
              t={t}
              style={{ left: x, top: y }}
              discarded={discarded}
              pinned={pinnedTaskId === task.id}
              onClick={onPin === undefined ? undefined : () => { onPin(task.id) }}
            />
          ))}
        </div>
      </div>
      <p className={css.phaseHint}>{t('phase.autoHint')}</p>
    </div>
  )
}

/** Task checklist: every task in phase order, carrying its check glyph. */
function TaskChecklist({ tasks, t, onFocus, manualPhases = [] }: {
  readonly tasks: readonly ActivityTask[]
  readonly t: AgentTeamsTranslate
  readonly onFocus: (taskId: string) => void
  /** Declared phases (WP7): they order the rows before the DAG depth does. */
  readonly manualPhases?: readonly ManualPhase[]
}) {
  const [open, setOpen] = useState(true)
  const rows = useMemo(() => {
    const ordered: ActivityTask[] = []
    for (const column of phaseColumns(tasks, manualPhases)) {
      ordered.push(...column.tasks.slice().sort((left, right) => (
        left.depth - right.depth || left.id.localeCompare(right.id)
      )))
    }
    return ordered
  }, [tasks, manualPhases])
  return (
    <section className={css.checklist} aria-label={t('checklist.aria')} data-task-checklist>
      <button
        type="button"
        className={css.checklistToggle}
        aria-expanded={open}
        onClick={() => { setOpen((current) => !current) }}
        data-checklist-toggle
      >
        <span><Chevron open={open} />{t('checklist.title', { count: rows.length })}</span>
        <span>{t(open ? 'checklist.collapse' : 'checklist.expand')}</span>
      </button>
      {open && (rows.length === 0
        ? <span className={css.emptyHint}>{t('checklist.empty')}</span>
        : (
          <div className={css.checklistRows}>
            {rows.map((task) => {
              const check = taskCheckGlyph(task.status)
              const waived = task.waived === undefined || task.waived === 0
                ? ''
                : t('checklist.waivers', { count: task.waived })
              const supersededBy = (task as { supersededBy?: string }).supersededBy
              return (
                <button
                  type="button"
                  key={task.id}
                  className={css.checklistRow}
                  data-checklist-row={task.id}
                  data-check={check.tone}
                  title={taskTitle(task, task.model ?? '')}
                  onClick={() => { onFocus(task.id) }}
                >
                  <span className={css.checklistBox} data-check={check.tone}>{check.glyph}</span>
                  <span className={css.checklistId}>{task.id}</span>
                  <span className={css.checklistSubject}>{task.subject}</span>
                  {task.kind !== undefined && (
                    <span className={css.checklistKind}>
                      {task.kind}{task.round === undefined ? '' : ` r${String(task.round)}`}
                    </span>
                  )}
                  <span className={css.checklistAssignee}>{task.assignee || t('checklist.unassigned')}</span>
                  <span className={css.checklistStatus} data-state={taskTone(task.state, task.status)}>
                    {taskStatusLabel(task.status, t)}
                  </span>
                  {waived !== '' && <span className={css.checklistFlag}>{waived}</span>}
                  {supersededBy !== undefined && supersededBy !== '' && (
                    <span className={css.checklistFlag}>{t('checklist.supersededBy', { task: supersededBy })}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
    </section>
  )
}

/** One dependency level of an auto-derived phase column. */
function declaredPhasesOf(team: ActivityTeam): ManualPhase[] {
  return (team.plan?.phases ?? []).map((phase) => ({
    id: phase.id,
    ...phase.title === undefined ? {} : { title: phase.title },
    taskIds: phase.taskIds,
    ...phase.closed === true ? { closed: true } : {},
    ...phase.closedAt === undefined ? {} : { closedAt: phase.closedAt },
  }))
}

/**
 * The running-plan editor (WP7/S17).
 *
 * One batch, one reason: every row the captain edits becomes one operation of a
 * single `action: 'replan'` request, so the whole repair is atomic exactly like
 * the `agent_teams_replan` tool. Only the fields each status allows are offered —
 * a pending task can be retargeted, a failed lane can be retried or replaced, a
 * scope-held lane can be accepted, and a task a member holds needs the explicit
 * "stop the member" box before it can be rewritten.
 */
function RunningPlanEditor({ team, t }: {
  readonly team: ActivityTeam
  readonly t: AgentTeamsTranslate
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [rows, setRows] = useState<Record<string, {
    subject?: string
    assignee?: string
    dependencies?: string
    action?: 'update' | 'retry' | 'supersede' | 'cancel' | 'accept' | 'move'
    invalidate?: boolean
    paths?: string
    phase?: string
  }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [applied, setApplied] = useState('')
  const members = team.members.filter((member) => member.status !== 'removed').map((member) => member.name)
  const phases = team.plan?.phases ?? []
  const ordered = useMemo(() => {
    const list: ActivityTask[] = []
    for (const column of phaseColumns(team.tasks, declaredPhasesOf(team))) {
      list.push(...column.tasks.slice().sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id)))
    }
    return list
  }, [team])
  const edit = (taskId: string, patch: Record<string, unknown>): void => {
    setRows((current) => ({ ...current, [taskId]: { ...current[taskId], ...patch } }))
  }
  const buildOperations = (): Record<string, unknown>[] => {
    const operations: Record<string, unknown>[] = []
    for (const task of ordered) {
      const row = rows[task.id]
      if (row === undefined) continue
      const chosen = row.action ?? 'update'
      if (chosen === 'cancel') {
        operations.push({ action: 'cancel_task', taskId: task.id, ...row.invalidate === true ? { invalidate: true } : {} })
        continue
      }
      if (chosen === 'accept') {
        operations.push({
          action: 'accept_paths',
          taskId: task.id,
          paths: (row.paths ?? '').split(',').map((item) => item.trim()).filter(Boolean),
        })
        continue
      }
      if (chosen === 'move') {
        operations.push({ action: 'move_phase', taskId: task.id, phaseId: (row.phase ?? '').trim(), title: (row.phase ?? '').trim() })
        continue
      }
      if (chosen === 'supersede') {
        operations.push({
          action: 'supersede_task',
          taskId: task.id,
          subject: row.subject?.trim() || `${task.subject} (replacement)`,
          ...row.assignee === undefined || row.assignee === '' ? {} : { assignee: row.assignee },
          ...row.invalidate === true ? { invalidate: true } : {},
        })
        continue
      }
      operations.push({
        action: 'update_task',
        taskId: task.id,
        ...row.subject === undefined || row.subject.trim() === '' ? {} : { subject: row.subject.trim() },
        ...row.assignee === undefined ? {} : { assignee: row.assignee },
        ...row.dependencies === undefined ? {} : {
          dependencies: row.dependencies.split(',').map((item) => item.trim()).filter((item) => item !== ''),
        },
        ...row.invalidate === true ? { invalidate: true } : {},
        ...chosen === 'retry' ? { retry: true } : {},
      })
    }
    return operations
  }
  const submit = async (): Promise<void> => {
    if (busy) return
    setError('')
    setApplied('')
    const operations = buildOperations()
    if (operations.length === 0) {
      setError(t('replan.empty'))
      return
    }
    const trimmed = reason.trim()
    if (trimmed === '') {
      setError(t('replan.reasonRequired'))
      return
    }
    setBusy(true)
    try {
      const response = await fetch(ACTIVITY_PLAN_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: team.captainSessionId, teamId: team.teamId, action: 'replan', reason: trimmed, operations }),
      })
      const body = await response.json() as { error?: unknown; revision?: unknown; applied?: unknown }
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : t('replan.failed'))
      setApplied(t('replan.applied', { count: Number(body.applied ?? operations.length), revision: Number(body.revision ?? 0) }))
      setRows({})
      setReason('')
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  if (team.phase !== 'running') return null
  return (
    <section className={css.replan} aria-label={t('replan.aria')} data-replan-editor>
      <button
        type="button"
        className={css.checklistToggle}
        aria-expanded={open}
        onClick={() => { setOpen((current) => !current) }}
        data-replan-toggle
      >
        <span><Chevron open={open} />{t('replan.title')}</span>
        <span>{t(open ? 'checklist.collapse' : 'checklist.expand')}</span>
      </button>
      {open && (
        <div className={css.replanBody}>
          <p className={css.replanHint}>{t('replan.hint')}</p>
          {ordered.length === 0 && <span className={css.emptyHint}>{t('checklist.empty')}</span>}
          {ordered.map((task) => {
            const row = rows[task.id] ?? {}
            const live = task.state === 'running'
            const retryable = task.status === 'failed'
            const held = task.status === 'awaiting_scope_review'
            const editable = task.status === 'pending' || retryable
            const chosen = row.action ?? 'update'
            return (
              <div key={task.id} className={css.replanRow} data-replan-row={task.id}>
                <span className={css.checklistId}>{task.id}</span>
                <input
                  className={css.replanInput}
                  value={row.subject ?? ''}
                  placeholder={task.subject}
                  aria-label={t('replan.subject')}
                  data-replan-subject={task.id}
                  disabled={!editable}
                  onChange={(event) => { edit(task.id, { subject: event.target.value, action: chosen === 'retry' || chosen === 'supersede' || chosen === 'cancel' || chosen === 'accept' || chosen === 'move' ? chosen : 'update' }) }}
                />
                <input
                  className={css.replanInput}
                  value={row.dependencies ?? ''}
                  placeholder={task.dependencies.join(',')}
                  aria-label={t('replan.dependencies')}
                  data-replan-deps={task.id}
                  disabled={!editable}
                  onChange={(event) => { edit(task.id, { dependencies: event.target.value, action: 'update' }) }}
                />
                <select
                  className={css.replanInput}
                  value={row.assignee ?? ''}
                  aria-label={t('replan.assignee')}
                  data-replan-assignee={task.id}
                  disabled={!editable}
                  onChange={(event) => { edit(task.id, { assignee: event.target.value }) }}
                >
                  <option value="">—</option>
                  {members.map((member) => <option key={member} value={member}>{member}</option>)}
                </select>
                {retryable && (
                  <button type="button" className={css.replanAction} data-replan-retry={task.id} onClick={() => { edit(task.id, { action: 'retry' }) }}>
                    {t('replan.retry')}
                  </button>
                )}
                {retryable && (
                  <button type="button" className={css.replanAction} data-replan-supersede={task.id} onClick={() => { edit(task.id, { action: 'supersede' }) }}>
                    {t('replan.supersede')}
                  </button>
                )}
                {held && (
                  <>
                    <input
                      className={css.replanInput}
                      value={row.paths ?? ''}
                      placeholder="src/file.ts, src/other.ts"
                      aria-label={t('replan.paths')}
                      data-replan-paths={task.id}
                      onChange={(event) => { edit(task.id, { paths: event.target.value, action: 'accept' }) }}
                    />
                    <button type="button" className={css.replanAction} data-replan-accept={task.id} onClick={() => { edit(task.id, { action: 'accept' }) }}>
                      {t('replan.accept')}
                    </button>
                  </>
                )}
                {editable && phases.some((phase) => phase.closed !== true) && (
                  <select
                    className={css.replanInput}
                    value={row.phase ?? ''}
                    aria-label={t('replan.phase')}
                    data-replan-phase={task.id}
                    onChange={(event) => { edit(task.id, { phase: event.target.value, action: 'move' }) }}
                  >
                    <option value="">—</option>
                    {/* Round 3: a closed phase is never a target. It stays listed but
                        disabled, so the reader sees why the phase is missing instead
                        of wondering where it went; a new phase is typed by hand. */}
                    {phases.map((phase) => (
                      <option key={phase.id} value={phase.id} disabled={phase.closed === true}>
                        {phase.closed === true
                          ? `${phase.title ?? phase.id} · ${t('phase.closed')}`
                          : phase.title ?? phase.id}
                      </option>
                    ))}
                  </select>
                )}
                {live && (
                  <label className={css.replanInvalidate} data-replan-invalidate={task.id}>
                    <input
                      type="checkbox"
                      checked={row.invalidate === true}
                      onChange={(event) => { edit(task.id, { invalidate: event.target.checked }) }}
                    />
                    {t('replan.invalidate')}
                  </label>
                )}
                {task.status === 'pending' && (
                  <button type="button" className={css.replanAction} data-replan-cancel={task.id} onClick={() => { edit(task.id, { action: 'cancel' }) }}>
                    {t('replan.cancel')}
                  </button>
                )}
                {chosen !== 'update' && <span className={css.replanChosen} data-replan-chosen={chosen}>{chosen}</span>}
              </div>
            )
          })}
          <div className={css.replanFooter}>
            <input
              className={css.replanInput}
              value={reason}
              placeholder={t('replan.reason')}
              aria-label={t('replan.reason')}
              data-replan-reason
              onChange={(event) => { setReason(event.target.value) }}
            />
            <button type="button" className={css.replanApply} disabled={busy} data-replan-apply onClick={() => { void submit() }}>
              {busy ? t('replan.applying') : t('replan.apply')}
            </button>
          </div>
          {error !== '' && <p className={css.replanError} role="alert">{error}</p>}
          {applied !== '' && <p className={css.replanOk} role="status">{applied}</p>}
        </div>
      )}
    </section>
  )
}

/** Switch between the session's live teams (WP11 phase 2). */
/**
 * The panel's only graph view: the phase board, its detail card and the checklist.
 *
 * The owner dropped the tree and the queues view (2026-09-20, round 2): inside a
 * phase the board already draws sequential work as a line and the column stretches
 * to fit it, so a second view of the same graph only split attention. The checklist
 * underneath stays the flat list, and a row click pins the node in the board.
 *
 * Round 3 gave the board the same collapsible header the members list and the
 * checklist already had: a reader scrolling to the list underneath folds the graph
 * away instead of dragging past it, and the header names how many columns it holds.
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
  const [phasesOpen, setPhasesOpen] = useState(true)
  const columns = useMemo(() => phaseColumns(tasks, manualPhases), [tasks, manualPhases])
  const pin = (id: string): void => { setPinnedTaskId((current) => current === id ? null : id) }
  const pinned = pinnedTaskId === null ? undefined : tasks.find((task) => task.id === pinnedTaskId)
  return (
    <>
      <section className={css.dependencySection} aria-label={t('phase.aria')} data-phase-section>
        <button
          type="button"
          className={css.phasesToggle}
          aria-expanded={phasesOpen}
          onClick={() => { setPhasesOpen((current) => !current) }}
          data-phases-toggle
        >
          <span><Chevron open={phasesOpen} />{t('phase.toggle', { count: columns.length })}</span>
          <span>{t(phasesOpen ? 'phase.collapse' : 'phase.expand')}</span>
        </button>
        {phasesOpen && (
          <PhaseBoard
            tasks={tasks}
            members={members}
            t={t}
            discarded={discarded}
            pinnedTaskId={pinnedTaskId}
            onPin={pin}
            manualPhases={manualPhases}
          />
        )}
      </section>
      {pinned !== undefined && (
        <TaskDetail task={pinned} tasks={tasks} members={members} t={t} discarded={discarded} />
      )}
      <TaskChecklist tasks={tasks} t={t} onFocus={setPinnedTaskId} manualPhases={manualPhases} />
    </>
  )
}
function TeamSwitcher({ tabs, selected, onSelect, t }: {
  readonly tabs: readonly PanelTeamTab[]
  readonly selected: string | null
  readonly onSelect: (teamId: string) => void
  readonly t: AgentTeamsTranslate
}) {
  return (
    <div className={css.teamSwitcher} role="tablist" aria-label={t('teams.switcher')} data-team-switcher>
      {tabs.map((tab) => (
        <button
          key={tab.teamId}
          type="button"
          role="tab"
          aria-selected={tab.teamId === selected}
          className={css.teamTab}
          data-team-tab={tab.teamId}
          data-active={tab.teamId === selected}
          data-halted={tab.halted}
          title={t('teams.tab', {
            name: tab.name,
            done: tab.done,
            total: tab.total,
            state: t(tab.halted ? 'team.stopped' : tab.working > 0 ? 'teams.tabWorking' : 'teams.tabIdle'),
          })}
          onClick={() => { onSelect(tab.teamId) }}
        >
          <span className={css.teamTabDot} data-halted={tab.halted} data-working={tab.working > 0} />
          <span className={css.teamTabName}>{tab.name}</span>
          <span className={css.teamTabCount}>{tab.done}/{tab.total}</span>
        </button>
      ))}
    </div>
  )
}

/** The three read-only cuts plus the tree, switching on the stored view. */
function TeamSection({ team, modelDirectory, onContinuePlanning, onDiscarded, onNavigate, t, historic = false }: {
  readonly team: ActivityTeam
  readonly modelDirectory?: ModelDirectory
  readonly onContinuePlanning?: () => void
  readonly onDiscarded?: () => void
  /** Navigate to a member transcript (floater hides immediately). */
  readonly onNavigate: (parentId: SessionId, childId: SessionId) => void
  readonly t: AgentTeamsTranslate
  readonly historic?: boolean
}) {
  const [membersOpen, setMembersOpen] = useState(true)
  // Owner request (2026-09-20, round 3): a member is large until the reader folds
  // *that* member away, so the default is an empty set and the state is per member.
  const [collapsedMembers, setCollapsedMembers] = useState<ReadonlySet<string>>(() => new Set())
  const [stopOpen, setStopOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const discarded = historic && team.phase === 'staged'
  const stopped = !historic && team.halted === true
  const busyCount = team.members.filter((member) => member.activity === 'working').length
  const assignedCount = team.tasks.filter((task) => task.assignee !== '' && task.assignee !== CAPTAIN_ASSIGNEE).length
  const captainOwned = team.tasks.filter((task) => task.assignee === CAPTAIN_ASSIGNEE && !settledTask(task.status))
  const captainBusy = captainOwned.length > 0
  const captainTaskIds = formatTaskIds(captainOwned.map((task) => task.id), t)
  const completedCount = team.tasks.filter((task) => task.status === 'completed').length
  const allCompleted = team.tasks.length > 0 && completedCount === team.tasks.length
  const allSettled = team.tasks.length > 0 && team.tasks.every((task) => settledTask(task.status))
  const unfinishedCount = team.tasks.filter((task) => !settledTask(task.status)).length
  const canStop = !historic && team.phase === 'running' && team.halted !== true && teamIsActive(team)
  const stopTeam = async (): Promise<void> => {
    if (stopping) return
    setStopping(true)
    setStopError('')
    try {
      const response = await fetch(ACTIVITY_HALT_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: team.captainSessionId, teamId: team.teamId }),
      })
      if (!response.ok) {
        let message = t('team.stopRequestFailed')
        try {
          const body = await response.json() as { error?: unknown }
          if (typeof body.error === 'string' && body.error.trim() !== '') message = body.error
        } catch {}
        throw new Error(message)
      }
      setStopOpen(false)
    } catch (error: unknown) {
      setStopError(t('team.stopFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setStopping(false)
    }
  }
  return (
    <>
      <section className={css.team} data-team-id={team.teamId}>
        <header className={css.teamHead}>
          <span className={css.teamName} title={team.name}>{team.name}</span>
          {historic && <span className={css.historicPill}>{t(discarded ? 'team.discarded' : 'team.ended')}</span>}
          {stopped && <span className={css.historicPill}>{t('team.stopped')}</span>}
          <span className={css.teamStats}>
            <span data-stat="members">{t('team.stats.members', { count: team.members.length })}</span>
            <span data-stat="tasks">{t('team.stats.completed', { completed: completedCount, total: team.tasks.length })}</span>
            <span data-stat="messages">{t('team.stats.messages', { count: team.messageCount })}</span>
          </span>
          {canStop && (
            <button
              type="button"
              className={css.teamStopButton}
              aria-label={t('team.stop')}
              title={t('team.stop')}
              onClick={() => { setStopError(''); setStopOpen(true) }}
            >
              <IconStopFill16 />
            </button>
          )}
        </header>

        {team.phase === 'staged' && !historic && modelDirectory !== undefined && onContinuePlanning !== undefined && onDiscarded !== undefined && (
          <StagingPlanEditor
            team={team}
            modelDirectory={modelDirectory}
            onContinuePlanning={onContinuePlanning}
            onDiscarded={onDiscarded}
            t={t}
          />
        )}

      <section className={css.delegationSection} aria-label={t('delegation.aria')} data-delegation-map>
        <div className={css.captainNode}>
          <span className={css.captainAvatar}>
            <img className={css.leadAvatar} src={LEAD_ART} alt="" aria-hidden />
          </span>
          <span className={css.captainInfo}>
            <span className={css.captainLine}>
              <span className={css.captainName}>{t('captain.name')}</span>
              <span className={css.captainRole}>{t('captain.role')}</span>
            </span>
            <span className={css.captainSummary}>{discarded
              ? t('captain.summary.discarded', { tasks: team.tasks.length, members: team.members.length })
              : captainBusy
                ? t('captain.summary.withTakeover', { tasks: assignedCount, captainTasks: captainTaskIds })
              : team.phase === 'staged'
                ? t(team.planReviewState === 'awaiting_feedback'
                  ? 'captain.summary.awaitingFeedback'
                  : 'captain.summary.staged', { tasks: team.tasks.length, members: team.members.length })
                : t('captain.summary', { tasks: assignedCount, members: team.members.length })}</span>
          </span>
          <span className={css.captainState} data-busy={captainBusy || busyCount > 0}>
            <WorkGlyph active={captainBusy || busyCount > 0} />
            {discarded
              ? t('captain.state.discarded')
              : captainBusy
                ? t('captain.state.takeover', { tasks: captainTaskIds })
              : team.phase === 'staged'
                ? t(team.planReviewState === 'awaiting_feedback'
                  ? 'captain.state.awaitingFeedback'
                  : 'captain.state.staged')
              : busyCount > 0
                ? t('captain.state.working', { count: busyCount })
                : t(allCompleted
                  ? 'captain.state.collected'
                  : allSettled
                    ? 'captain.state.settled'
                    : 'captain.state.waiting')}
          </span>
        </div>

        <ProgressOverview team={team} t={t} discarded={discarded} />

        <button type="button" className={css.membersToggle} onClick={() => { setMembersOpen((current) => !current) }} aria-expanded={membersOpen} data-members-toggle>
          <span><Chevron open={membersOpen} />{t('members.toggle', { count: team.members.length })}</span>
          <span>{t(membersOpen ? 'members.collapse' : 'members.expand')}</span>
        </button>

        {membersOpen && <div className={css.delegationTree}>
          {team.members.length === 0 && <span className={css.emptyHint}>{t('members.empty')}</span>}
          {team.members.map((member) => {
            const owned = team.tasks.filter((task) => task.assignee === member.name)
            const memberModel = memberRouteLabel(member)
            const memberKey = member.id || member.name
            // Owner request (2026-09-20, round 3): the large node is the default and
            // the compact icon line is what a member looks like *folded away*. The
            // set starts empty, so a reader who never touches the control sees the
            // full roster, and folding one member leaves its neighbours alone.
            const compact = collapsedMembers.has(memberKey)
            const stateLabel = discarded
              ? t('member.state.notCreated')
              : stopped
                ? t('member.state.stopped')
                : team.phase === 'staged'
                  ? t('member.state.staged')
                  : memberStateLabel(member, team.tasks, historic, t)
            const statusText = discarded
              ? t('member.status.discarded')
              : stopped
                ? t('member.status.stopped')
                : team.phase === 'staged'
                  ? t('member.status.staged')
                  : historic && owned.length > 0 && owned.every((task) => settledTask(task.status))
                    ? t('member.status.settled')
                    : memberStatusText(member, team.tasks, t)
            const chips = owned.length === 0
              ? <span className={css.taskEmpty}>{t(discarded ? 'assignment.empty' : 'checklist.unassigned')}</span>
              : owned.map((task) => {
                  const model = taskModelLabel(task, team.members)
                  const shortModel = compactModelLabel(model)
                  return (
                    <span
                      key={task.id}
                      className={css.assignmentChip}
                      data-state={discarded ? 'cancelled' : taskTone(task.state, task.status)}
                      data-task-model={model || undefined}
                      title={taskTitle(task, model)}
                    >
                      {task.state === 'running' && shortModel !== '' ? `${task.id} · ${shortModel}` : task.id}
                    </span>
                  )
                })
            const stateWord = <span className={css.memberState} data-activity={member.activity}>{stateLabel}</span>
            const modelBadge = memberModel === ''
              ? null
              : (
                <span className={css.memberModel} role="img" data-member-model={memberModel} title={memberModel} aria-label={memberModel}>
                  {compactModelLabel(memberModel)}
                </span>
              )
            const portrait = (
              <span className={css.memberAvatar} data-unread={member.unread > 0}>
                {memberArtUrl(member.name, member.role) !== null ? (
                  <img className={css.memberArt} src={memberArtUrl(member.name, member.role) ?? ''} alt="" aria-hidden />
                ) : (
                  <span className={css.memberInitial} style={{ background: accentOf(member.id) }}>{memberInitial(member.name)}</span>
                )}
                {!compact && (
                  <img className={css.stateArt} data-activity={member.activity} src={ACTION_SYMBOL[member.activity]} alt="" aria-hidden />
                )}
              </span>
            )
            return (
              <div key={memberKey} className={css.memberBlock} data-activity={member.activity} data-compact={compact}>
                <span className={css.memberBranch} aria-hidden><span /></span>
                {/* The fold control is a sibling of the row, not a child: the row is
                    itself a button that navigates to the member's session, and a
                    button may not contain another button. */}
                <button
                  type="button"
                  className={css.memberCollapse}
                  data-member-collapse={memberKey}
                  aria-expanded={!compact}
                  title={t(compact ? 'member.expandRow' : 'member.collapseRow')}
                  aria-label={t(compact ? 'member.expandRow' : 'member.collapseRow')}
                  onClick={() => {
                    setCollapsedMembers((current) => {
                      const next = new Set(current)
                      if (next.has(memberKey)) next.delete(memberKey)
                      else next.add(memberKey)
                      return next
                    })
                  }}
                >
                  <Chevron open={!compact} />
                </button>
                <button
                  type="button"
                  className={css.memberRow}
                  data-activity={member.activity}
                  data-compact={compact}
                  onClick={() => {
                    if (member.id !== '') {
                      onNavigate(team.captainSessionId as SessionId, member.id as SessionId)
                    }
                  }}
                >
                  {compact ? (
                    <>
                      {portrait}
                      {/* The tray keeps the role as its symbol, with the words in the
                          tooltip: at one line there is no room for the label the
                          large node shows. */}
                      {memberSymbolUrl(member.name, member.role) !== null && (
                        <img
                          className={css.memberRoleIcon}
                          src={memberSymbolUrl(member.name, member.role) ?? ''}
                          alt=""
                          aria-hidden
                          title={member.role}
                        />
                      )}
                      <span className={css.memberInfo}>
                        <span className={css.memberLine}>
                          <span className={css.memberName} title={member.role === '' ? member.name : `${member.name} · ${member.role}`}>{member.name}</span>
                          {modelBadge}
                          <span className={css.memberStateIcon} data-activity={member.activity}>
                            <img
                              className={css.stateArt}
                              data-activity={member.activity}
                              src={ACTION_SYMBOL[member.activity]}
                              alt=""
                              aria-hidden
                            />
                            {stateWord}
                          </span>
                        </span>
                      </span>
                      <span className={css.memberCount}>{member.done}/{member.total}</span>
                      <span className={css.assignmentLine}>
                        <span className={css.assignmentTasks}>{chips}</span>
                      </span>
                      <WorkBar active={!discarded && !stopped && member.activity === 'working'} />
                    </>
                  ) : (
                    <>
                      {portrait}
                      <span className={css.memberInfo}>
                        <span className={css.memberLine}>
                          <span className={css.memberName}>{member.name}</span>
                          {member.role !== '' && <span className={css.memberRole}>{member.role}</span>}
                          {modelBadge}
                          {stateWord}
                        </span>
                        <span className={css.memberStatusLine}>{statusText}</span>
                      </span>
                      <span className={css.memberCount}>{member.done}/{member.total}</span>
                      <WorkBar active={!discarded && !stopped && member.activity === 'working'} />
                      <span className={css.assignmentLine}>
                        <span className={css.assignmentLabel}>{t(discarded
                          ? 'assignment.discarded'
                          : team.phase === 'staged'
                            ? 'assignment.staged'
                            : 'assignment.label')}</span>
                        <span className={css.assignmentTasks}>{chips}</span>
                      </span>
                    </>
                  )}
                </button>
              </div>
            )
          })}
        </div>}
      </section>

      <TaskViews tasks={team.tasks} members={team.members} t={t} discarded={discarded} manualPhases={declaredPhasesOf(team)} />
      {!historic && !discarded && <RunningPlanEditor team={team} t={t} />}
      </section>
      <Modal
        open={stopOpen}
        onClose={() => { if (!stopping) setStopOpen(false) }}
        title={t('team.stopTitle', { team: team.name })}
        closeLabel={t('plan.cancel')}
        description={t('team.stopDescription', { tasks: unfinishedCount, members: busyCount })}
        footer={(
          <span className={css.stopModalActions}>
            <button type="button" disabled={stopping} onClick={() => { setStopOpen(false) }}>{t('team.stopCancel')}</button>
            <button type="button" data-danger disabled={stopping} onClick={() => { void stopTeam() }}>
              <IconStopFill16 />
              {stopping ? t('team.stopping') : t('team.stopConfirm')}
            </button>
          </span>
        )}
      >
        {stopError !== '' && <p className={css.stopModalError} role="alert"><IconWarningOutline16 />{stopError}</p>}
      </Modal>
    </>
  )
}

/** Legacy conversation cards may outlive their host archive. Project their
 * durable roster through the same rebuilt panel instead of a second UI. */
function historicCardTeam(data: AgentTeamsCardData, owner: string): ActivityTeam {
  return {
    workspace: '',
    teamId: data.teamId,
    name: data.teamName,
    captainSessionId: data.captainSessionId || owner,
    phase: 'running',
    members: data.members.map((member) => ({
      ...member,
      status: 'removed',
      activity: 'idle',
      progress: 0,
      done: 0,
      total: 0,
      currentTask: '',
      unread: 0,
    })),
    tasks: [],
    messageCount: 0,
    captainInbox: [],
  }
}

/** The top-right activity floater. Teams follow the current session: live
 * snapshots and historic card summaries are only shown while their captain
 * session is the one currently open. */
export type ActivityPanelProps = {
  readonly conversationVisible?: boolean
  readonly sessionsList: ObservableSnapshot<SessionListState>
  readonly modelDirectories: ModelDirectoryResolver
  readonly openMember: (parentId: SessionId, childId: SessionId) => void
} & PropsLocale<'agentTeams'>

/**
 * Keeps a panel fault from taking the shell down.
 *
 * The panel is mounted into the shell's additive overlay, which does not isolate a
 * render exception: an error thrown here unmounts the host's tree and the reader is
 * left with a blank page — which is exactly what a defect in this plugin must never
 * be able to do. The boundary renders one line naming the failure instead, so the
 * conversation keeps working and the panel can be dismissed.
 *
 * It catches throws. Long work is a separate matter: the layout is memoised (see
 * `phaseBoardLayout`) precisely because a boundary cannot help against a hang.
 */
export class PanelErrorBoundary extends Component<
  { readonly children: ReactNode; readonly t?: AgentTeamsTranslate },
  { readonly error: string }
> {
  constructor(props: { readonly children: ReactNode; readonly t?: AgentTeamsTranslate }) {
    super(props)
    this.state = { error: '' }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override render(): ReactNode {
    if (this.state.error === '') return this.props.children
    const message = this.props.t === undefined
      ? `AgentTeams panel failed: ${this.state.error}`
      : this.props.t('panel.error', { error: this.state.error })
    return <span className={css.panelError} role="alert" data-agent-teams-error>{message}</span>
  }
}

export function ActivityPanel({ sessionsList, modelDirectories, openMember, t, conversationVisible = true }: ActivityPanelProps) {
  // Navigating to a member's subagent transcript is an explicit departure:
  // hide the floater immediately instead of waiting out the autocollapse
  // grace, so the panel never lingers over the member session.
  const navigateToSession = (parentId: SessionId, childId: SessionId): void => {
    setOpen(false)
    setWasActive(false)
    openMember(parentId, childId)
  }
  const [open, setOpen] = useState(false)
  const [openOwner, setOpenOwner] = useState<SessionId | undefined>()
  const [autoOpened, setAutoOpened] = useState(false)
  const [wasActive, setWasActive] = useState(false)
  const [historic, setHistoric] = useState<ReadonlyMap<string, { data: AgentTeamsCardData; owner: string }>>(new Map())
  const [layout, setLayout] = useState<PanelLayout>(initialPanelLayout)
  const [bounds, setBounds] = useState<PanelBounds>(initialPanelBounds)
  const [interaction, setInteraction] = useState<'dragging' | 'resizing' | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const boundsRef = useRef(bounds)
  const gestureRef = useRef<PanelGesture | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingLayoutRef = useRef<PanelLayout | null>(null)
  const current = useSyncExternalStore(
    sessionsList.subscribe,
    sessionsList.getSnapshot,
  ).current
  const autoOpenTrackerRef = useRef<{
    sessionId: SessionId | undefined
    restoreComplete: boolean
    liveTeamIds: ReadonlySet<string>
  }>({ sessionId: current, restoreComplete: false, liveTeamIds: new Set() })
  const monitorTargets = useSyncExternalStore(
    subscribeActivityMonitorTargets,
    getActivityMonitorTargetsSnapshot,
  )
  const returnToComposer = (): void => {
    setOpen(false)
    setOpenOwner(undefined)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        '[data-composer-card] [contenteditable="true"][role="textbox"], [data-composer-card] textarea',
      )?.focus()
    })
  }
  const { teams, archivedTeams } = useSyncExternalStore(
    subscribeActivitySnapshots,
    getActivitySnapshotsSnapshot,
  )
  const currentTargets = useMemo(
    () => current === undefined ? [] : monitorTargets.filter((target) => target.sessionId === current),
    [current, monitorTargets],
  )
  const currentRef = useRef(current)
  useEffect(() => { currentRef.current = current }, [current])
  const mountedAtRef = useRef(performance.now())
  const expanded = conversationVisible && activityPanelExpandedForSession(open, openOwner, current)
  const geometry = useMemo(() => resolvePanelGeometry(layout, bounds), [layout, bounds])
  const compact = compactPanelForBounds(bounds)

  const commitLayout = useCallback((next: PanelLayout): void => {
    setLayout(next)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  }, [layout])

  // The slot sits inside AppFrame, so all geometry is measured against the
  // shell overlay rather than the browser viewport. The conversation's real
  // right edge is the dock anchor and naturally follows sidebar/details
  // concessions without importing their hashed implementation classes.
  useLayoutEffect(() => {
    const overlay = document.querySelector<HTMLElement>('[data-shell-overlay]')
    if (overlay === null) return
    const conversation = document.querySelector<HTMLElement>("[data-phase='active']")
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const overlayRect = overlay.getBoundingClientRect()
      const conversationRect = conversation?.getBoundingClientRect()
      const next: PanelBounds = {
        width: overlayRect.width,
        height: overlayRect.height,
        anchorRight: conversationRect === undefined
          ? overlayRect.width
          : Math.min(Math.max(conversationRect.right - overlayRect.left, 0), overlayRect.width),
      }
      const previous = boundsRef.current
      if (previous.width === next.width
        && previous.height === next.height
        && previous.anchorRight === next.anchorRight) return
      boundsRef.current = next
      setBounds(next)
    }
    const scheduleMeasure = (): void => {
      frame ??= requestAnimationFrame(measure)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure)
    observer?.observe(overlay)
    if (conversation !== null) observer?.observe(conversation)
    window.addEventListener('resize', scheduleMeasure)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [current])

  // This shell overlay survives conversation route changes. Gate expansion by its
  // owning session during render, then clear stale state before paint. This
  // removes the old panel immediately instead of waiting for the no-team
  // autoclose grace period on the destination page.
  useLayoutEffect(() => {
    const tracker = autoOpenTrackerRef.current
    if (tracker.sessionId !== current) {
      tracker.sessionId = current
      tracker.restoreComplete = false
      tracker.liveTeamIds = new Set()
      setWasActive(false)
      setAutoOpened(false)
    }
    if (openOwner === undefined || openOwner === current) return
    setOpen(false)
    setOpenOwner(undefined)
  }, [current, openOwner])

  // Only the wide docked mode asks the conversation column to yield. Floating
  // and compact modes are intentionally true overlays. The width is written as
  // one shared variable so the panel and the concession cannot drift apart.
  useLayoutEffect(() => {
    const root = document.documentElement
    const shouldYield = expanded && geometry.mode === 'docked' && !compact
    if (shouldYield) {
      root.setAttribute(PANEL_OPEN_ATTRIBUTE, '')
      root.style.setProperty(PANEL_SHIFT_PROPERTY, `${geometry.width + PANEL_CONVERSATION_GAP + 18}px`)
    } else {
      root.removeAttribute(PANEL_OPEN_ATTRIBUTE)
      root.style.removeProperty(PANEL_SHIFT_PROPERTY)
    }
    return () => {
      root.removeAttribute(PANEL_OPEN_ATTRIBUTE)
      root.style.removeProperty(PANEL_SHIFT_PROPERTY)
    }
  }, [compact, expanded, geometry.mode, geometry.width])

  useEffect(() => {
    if (current === undefined) return
    // Cards keep live teams on the normal cadence. The current-session scope
    // also performs one cold-start discovery pass so archived/cardless teams
    // survive a browser or `dsh web` restart.
    const controller = startActivityPolling(currentTargets, { discoverySessionId: current })
    let active = true
    const tracker = autoOpenTrackerRef.current
    if (tracker.sessionId === current && !tracker.restoreComplete) {
      void controller.firstTick.then(() => {
        const latest = autoOpenTrackerRef.current
        if (!active || latest.sessionId !== current || latest.restoreComplete) return
        latest.liveTeamIds = new Set(getActivitySnapshotsSnapshot().teams
          .filter((team) => team.captainSessionId === current)
          .map((team) => team.teamId))
        latest.restoreComplete = true
      })
    }
    return () => {
      active = false
      controller.stop()
    }
  }, [current, currentTargets])

  useEffect(() => {
    const onOpenPanel = (event: Event): void => {
      const activeSession = currentRef.current
      if (activeSession === undefined) return
      setOpenOwner(activeSession)
      setOpen(true)
      const detail = (event as CustomEvent<AgentTeamsCardData>).detail
      if (detail?.teamId !== undefined) {
        // A card from a log that predates captainSessionId belongs to the
        // session that activated it (the current one at injection time).
        const owner = detail.captainSessionId !== '' ? detail.captainSessionId : currentRef.current ?? ''
        const teamKey = `${owner}:${detail.teamId}`
        setHistoric((previous) => {
          const next = new Map(previous)
          next.set(teamKey, { data: detail, owner })
          return next
        })
      }
    }
    window.addEventListener(OPEN_PANEL_EVENT, onOpenPanel)
    return () => {
      window.removeEventListener(OPEN_PANEL_EVENT, onOpenPanel)
    }
  }, [])

  // Teams follow the current session: live snapshots and historic card
  // summaries are visible only while their captain session is current.
  const visibleTeams = useMemo(
    // No current session (initial load): show nothing until one is picked,
    // so cross-session teams never leak into the floater.
    () => (current === undefined ? [] : teams.filter((team) => team.captainSessionId === current)),
    [teams, current],
  )
  const visibleHistoric = useMemo(
    () => (current === undefined ? [] : [...historic.values()].filter(({ data, owner }) =>
      owner === current && !teams.some((live) =>
        live.captainSessionId === current && live.teamId === data.teamId,
      ) && !archivedTeams.some((archived) =>
        archived.captainSessionId === current && archived.teamId === data.teamId,
      ),
    )),
    [historic, current, teams, archivedTeams],
  )
  const visibleArchived = useMemo(
    () => (current === undefined ? [] : archivedTeams.filter((team) =>
      team.captainSessionId === current && !teams.some((live) =>
        live.captainSessionId === current && live.teamId === team.teamId,
      ),
    )),
    [archivedTeams, current, teams],
  )
  // WP11 phase 2: one team at a time. Stacking every live team made two DAGs
  // read as one; the switcher shows the selected team's graph, members, progress
  // and slices only, and remembers the reader's choice per browser.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(() => {
    try {
      return parsePanelTeamSelection(window.localStorage.getItem(PANEL_TEAM_STORAGE_KEY))
    } catch {
      return null
    }
  })
  const selectedTeam = useMemo(
    () => visibleTeams.find((team) => team.teamId === panelSelectedTeamId(visibleTeams, selectedTeamId)),
    [visibleTeams, selectedTeamId],
  )
  const selectTeam = (teamId: string): void => {
    setSelectedTeamId(teamId)
    try {
      window.localStorage.setItem(PANEL_TEAM_STORAGE_KEY, teamId)
    } catch {
      // A blocked localStorage only costs the preference, never the switch.
    }
  }
  const visibleCount = visibleTeams.length + visibleArchived.length + visibleHistoric.length
  const visibleLiveTeamIds = useMemo(
    () => visibleTeams.map((team) => team.teamId).sort(),
    [visibleTeams],
  )
  const visibleLiveTeamKey = visibleLiveTeamIds.join('\u0000')

  useEffect(() => {
    const tracker = autoOpenTrackerRef.current
    const settled = performance.now() - mountedAtRef.current >= AUTO_OPEN_SETTLE_MS
    const shouldAutoExpand = tracker.sessionId === current && activityPanelShouldAutoExpand({
      alreadyAutoOpened: autoOpened,
      pageSettled: settled,
      restoreComplete: tracker.restoreComplete,
      previousLiveTeamIds: tracker.liveTeamIds,
      currentLiveTeamIds: visibleLiveTeamIds,
    })
    if (tracker.sessionId === current && tracker.restoreComplete) {
      tracker.liveTeamIds = new Set(visibleLiveTeamIds)
    }
    if (visibleCount > 0) {
      setWasActive(true)
      // Existing state restored for a reopened conversation stays collapsed.
      // Only a live team that appears after the restore pass may auto-expand.
      if (shouldAutoExpand) {
        setOpenOwner(current)
        setOpen(true)
        setAutoOpened(true)
      }
      return
    }
    if (!wasActive) return
    const timer = setTimeout(() => {
      setOpen(false)
      setOpenOwner(undefined)
      setWasActive(false)
      // Re-arm auto-expand: a later activity (new team, new session) may
      // open the panel on its own again.
      setAutoOpened(false)
    }, AUTOCLOSE_GRACE_MS)
    return () => { clearTimeout(timer) }
  }, [visibleCount, visibleLiveTeamKey, autoOpened, wasActive, current])

  const busy = useMemo(
    () => visibleTeams.some((team) => team.members.some((member) => member.activity === 'working')),
    [visibleTeams],
  )
  const hasTeams = visibleCount > 0

  // Auto-height panels do not store their live content height. Capture the
  // rendered box when a pointer gesture starts so movement and a first manual
  // resize clamp against what the user actually sees.
  const panelGeometryForGesture = useCallback((): PanelLayout => {
    const measuredHeight = panelRef.current?.getBoundingClientRect().height
    if (measuredHeight === undefined || measuredHeight <= 0) return geometry
    return { ...geometry, height: measuredHeight }
  }, [geometry])

  const flushScheduledLayout = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    const pending = pendingLayoutRef.current
    pendingLayoutRef.current = null
    if (pending !== null) commitLayout(pending)
  }, [commitLayout])

  const scheduleLayout = useCallback((next: PanelLayout): void => {
    pendingLayoutRef.current = next
    frameRef.current ??= requestAnimationFrame(() => {
      frameRef.current = null
      const pending = pendingLayoutRef.current
      pendingLayoutRef.current = null
      if (pending !== null) commitLayout(pending)
    })
  }, [commitLayout])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  const beginMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (compact || event.button !== 0 || (event.target as Element).closest('button') !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      start: panelGeometryForGesture(),
      activated: false,
    }
  }, [compact, panelGeometryForGesture])

  const beginResize = useCallback((edge: PanelResizeEdge, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (compact || event.button !== 0 || (geometry.mode === 'docked' && edge !== 'left')) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      kind: 'resize',
      edge,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      start: panelGeometryForGesture(),
      activated: true,
    }
    setInteraction('resizing')
  }, [compact, geometry.mode, panelGeometryForGesture])

  const updateGesture = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId
      || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const dx = event.clientX - gesture.originX
    const dy = event.clientY - gesture.originY
    const activeBounds = boundsRef.current
    if (gesture.kind === 'move') {
      if (!gesture.activated && Math.hypot(dx, dy) < MOVE_THRESHOLD) return
      if (!gesture.activated) {
        gesture.activated = true
        setInteraction('dragging')
      }
      scheduleLayout(movePanelLayout(
        floatPanelLayout(gesture.start, activeBounds),
        dx,
        dy,
        activeBounds,
      ))
      return
    }
    scheduleLayout(resizePanelLayout(
      gesture.start,
      gesture.edge ?? 'left',
      dx,
      dy,
      activeBounds,
    ))
  }, [scheduleLayout])

  const endGesture = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    updateGesture(event)
    flushScheduledLayout()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    gestureRef.current = null
    setInteraction(null)
  }, [flushScheduledLayout, updateGesture])

  const cancelGesture = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    flushScheduledLayout()
    gestureRef.current = null
    setInteraction(null)
  }, [flushScheduledLayout])

  const toggleDock = useCallback((): void => {
    const liveGeometry = panelGeometryForGesture()
    commitLayout(liveGeometry.mode === 'docked'
      ? floatPanelLayout(liveGeometry, boundsRef.current)
      : dockPanelLayout(liveGeometry, boundsRef.current))
  }, [commitLayout, panelGeometryForGesture])

  const autoHeight = panelUsesAutoHeight(geometry, bounds)

  const panelStyle: CSSProperties = {
    width: geometry.width,
    height: autoHeight ? 'auto' : geometry.height,
    maxHeight: panelMaximumHeight(geometry, bounds),
    transform: `translate3d(${geometry.x}px, ${geometry.y}px, 0)`,
  }

  if (!conversationVisible || (!hasTeams && !expanded)) return null

  return (
    <>
      {!expanded && (
        <CollapsedBadge count={visibleCount} busy={busy} t={t} onClick={() => {
          if (current === undefined) return
          setOpenOwner(current)
          setOpen(true)
        }} />
      )}
      {expanded && (
        <aside
          ref={panelRef}
          className={css.panel}
          style={panelStyle}
          data-agent-teams-activity
          data-panel-mode={geometry.mode}
          data-height-mode={autoHeight ? 'auto' : 'manual'}
          data-compact={compact || undefined}
          data-dragging={interaction === 'dragging' || undefined}
          data-resizing={interaction === 'resizing' || undefined}
          aria-label={t('activity.panelAria')}
        >
          <header
            className={css.panelHead}
            onPointerDown={beginMove}
            onPointerMove={updateGesture}
            onPointerUp={endGesture}
            onPointerCancel={cancelGesture}
            data-drag-handle={!compact || undefined}
          >
            <span className={css.panelTitle}>
              {t('activity.title')}
              <span className={css.panelDot} data-busy={busy} aria-hidden />
            </span>
            <span className={css.panelControls}>
              {!compact && (
                <button
                  type="button"
                  className={css.iconButton}
                  data-control="dock"
                  data-mode={geometry.mode}
                  onClick={toggleDock}
                  aria-label={t(geometry.mode === 'docked' ? 'activity.float' : 'activity.dockRight')}
                  title={t(geometry.mode === 'docked' ? 'activity.float' : 'activity.dockRight')}
                >
                  <IconPanelLeftOutline16 />
                </button>
              )}
              <button
                type="button"
                className={css.iconButton}
                data-control="collapse"
                onClick={() => {
                  setOpen(false)
                  setOpenOwner(undefined)
                }}
                aria-label={t('activity.collapse')}
                title={t('activity.collapse')}
              >
                <IconChevronDownOutline14 />
              </button>
            </span>
          </header>
          <div className={css.teams}>
            {visibleCount === 0
              ? <span className={css.emptyHint}>{t('activity.empty')}</span>
              : (
                <>
                  {visibleTeams.length > 1 && (
                    <TeamSwitcher
                      tabs={panelTeamTabs(visibleTeams)}
                      selected={selectedTeam?.teamId ?? null}
                      onSelect={selectTeam}
                      t={t}
                    />
                  )}
                  {selectedTeam !== undefined && (
                    <TeamSection
                      key={selectedTeam.teamId}
                      team={selectedTeam}
                      modelDirectory={selectedTeam.phase === 'staged'
                        ? modelDirectories.directoryFor(selectedTeam.captainSessionId as SessionId)
                        : undefined}
                      onContinuePlanning={returnToComposer}
                      onDiscarded={returnToComposer}
                      onNavigate={navigateToSession}
                      t={t}
                    />
                  )}
                  {visibleArchived.map((team) => (
                    <div key={`${team.captainSessionId}:${team.teamId}`} data-team-id={team.teamId} data-historic>
                      <span className={css.archiveLabel}>{t(team.phase === 'staged' ? 'archive.discardedLabel' : 'archive.label')}</span>
                      <TeamSection team={team} onNavigate={navigateToSession} t={t} historic />
                    </div>
                  ))}
                  {visibleHistoric.map(({ data: team, owner }) => {
                    const teamKey = `${owner}:${team.teamId}`
                    return (
                      <TeamSection key={teamKey} team={historicCardTeam(team, owner)} onNavigate={navigateToSession} t={t} historic />
                    )
                  })}
                </>
              )}
          </div>
          {!compact && (
            <div
              className={css.resizeHandle}
              data-resize-edge="left"
              onPointerDown={(event) => { beginResize('left', event) }}
              onPointerMove={updateGesture}
              onPointerUp={endGesture}
              onPointerCancel={cancelGesture}
              aria-hidden
            />
          )}
          {!compact && geometry.mode === 'floating' && (
            <>
              <div
                className={css.resizeHandle}
                data-resize-edge="bottom"
                onPointerDown={(event) => { beginResize('bottom', event) }}
                onPointerMove={updateGesture}
                onPointerUp={endGesture}
                onPointerCancel={cancelGesture}
                aria-hidden
              />
              <div
                className={css.resizeHandle}
                data-resize-edge="corner"
                onPointerDown={(event) => { beginResize('corner', event) }}
                onPointerMove={updateGesture}
                onPointerUp={endGesture}
                onPointerCancel={cancelGesture}
                aria-hidden
              />
            </>
          )}
        </aside>
      )}
    </>
  )
}
