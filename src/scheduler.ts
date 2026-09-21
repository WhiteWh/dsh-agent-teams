/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member. A resident member that becomes idle while it
 * still owns an open attempt is parked: only an explicit captain reassignment
 * may rotate that capability. Automatic retry is reserved for cold recovery,
 * when this process has not observed the durable owner settle its open attempt.
 * @module dsh-agent-teams/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { deliverToMember } from './members.ts'
import { isCurrentMail, mailboxPrompt } from './mailbox.ts'
import {
  acceptanceCriterionText,
  markMailboxDelivered,
  discardMailboxMessages,
  beginTaskAttempt,
  CAPTAIN_KEY,
  claimMailboxDelivery,
  findTeamsByParticipant,
  invalidateTaskAttempt,
  listTeams,
  readTeam,
  readPendingMailbox,
  releaseMailboxDelivery,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
} from './state.ts'
import type { AcceptanceCriterion, TeamMember, TeamState, TeamTask } from './types.ts'

/** Per-dependency output cap in the assignment prompt. */
export const DEPENDENCY_OUTPUT_MAX_CHARS = 2_000
/** Combined dependency-output budget in the assignment prompt. */
export const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000

/**
 * How many members of one team may be dispatched at the same time (WP11 phase 2).
 *
 * The upstream `maxConcurrentWorkers` mechanics: a fuse on concurrent work, not a
 * limit on the roster. The default equals the default roster cap (8), so an
 * existing team is never silently throttled; a host or profile lowers it on
 * purpose, and phase 3 exposes the key on the profile.
 */
export const MAX_WORKERS_PER_TEAM = 8
/** How many members may work at once across every live team of the workspace. */
export const MAX_CONCURRENT_WORKERS_GLOBAL = 8

export interface SchedulerConfig {
  readonly stateDir: string
  readonly executionPrompt?: string
  readonly dispatch?: (captain: Agent, teamId: string, memberName: string, text: string, signal: AbortSignal, mode: 'queue' | 'steer', attemptId?: string) => Promise<boolean>
  /**
   * Every workspace the host knows (WP11 phase 2), used by {@link TeamScheduler.sweepAll}.
   * Omitted in tests and in hosts without a workspace registry, where the sweep
   * falls back to the workspace of the calling captain.
   */
  readonly workspaces?: () => readonly string[]
  /** Per-team concurrency cap; defaults to {@link MAX_WORKERS_PER_TEAM}. */
  readonly maxWorkersPerTeam?: number
  /** Workspace-wide concurrency cap; defaults to {@link MAX_CONCURRENT_WORKERS_GLOBAL}. */
  readonly maxConcurrentWorkersGlobal?: number
}

export interface TeamScheduler {
  /** Try to give every genuinely idle/ready member one unit of ready work. */
  kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>
  /** Try to flush fallback mail or give one member one ready task. */
  kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<boolean>
  /**
   * Sweep every live team of every known workspace (WP11 phase 2).
   *
   * The phase-1 scheduler only ever moved the team whose tool call woke it, so a
   * second team could sit with ready work until something touched it. The sweep
   * visits all live teams, honours the per-team and global worker caps, and never
   * gives a member a second task (a member belongs to exactly one team, and
   * {@link TeamScheduler.kickMember} refuses a member that already holds work).
   *
   * @param captain - the live captain asking for the sweep, when there is one.
   * @returns how many teams were visited and how many members were dispatched.
   */
  sweepAll(captain?: Agent): Promise<{ readonly teams: number; readonly dispatched: number }>
  /**
   * Record a capability the plugin minted for a member outside a dispatch
   * (`claim_task`). The scheduler must never treat one of these as a lost owner
   * and re-claim the task underneath the member; see the note on the recovery
   * marker in {@link installTeamScheduler}.
   */
  noteClaimedAttempt(memberId: string, attemptId: string): void
}

/** One completed recursive dependency shown to the assignee. */
export interface DependencyOutput {
  readonly id: string
  readonly subject: string
  readonly profileSeedId?: string
  readonly output?: string
}

export interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly previousAssignee?: string
  /** True when this ticket rotates an unobserved durable open attempt. */
  readonly recoveredOwned: boolean
  /** Original task generation, used to restore a failed automatic recovery. */
  readonly previousStatus?: 'claimed' | 'in_progress'
  readonly previousAttempt?: number
  readonly previousAttemptId?: string
  readonly subject: string
  readonly description?: string
  readonly teamDescription?: string
  readonly profileProtocol?: string
  readonly profileSeedId?: string
  readonly dependencyOutputs: readonly DependencyOutput[]
  readonly executionPrompt?: string
  readonly kind?: string
  readonly round?: number
  readonly objective?: string
  readonly inScope?: readonly string[]
  readonly outOfScope?: readonly string[]
  readonly acceptance?: readonly (string | AcceptanceCriterion)[]
  readonly verify?: readonly string[]
  readonly reviewedTaskId?: string
}

function taskProfileSeedId(task: TeamTask): string | undefined {
  const seed = task.profileSeedId?.trim()
  return seed === undefined || seed === '' ? undefined : seed
}

function teamProfileProtocol(team: TeamState): string | undefined {
  return team.profile?.protocol
}

/**
 * Recursively collect `status=completed` ancestors of `taskId` in topological
 * order (dependencies before dependents). Cycles stop that branch only.
 */
export function collectCompletedDependencyOutputs(
  tasks: readonly TeamTask[],
  taskId: string,
  warn?: (message: string) => void,
): DependencyOutput[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: TeamTask[] = []

  const walk = (id: string): void => {
    if (visiting.has(id)) {
      warn?.(`agent-teams: dependency cycle involving "${id}" while collecting outputs; stopping this branch`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const task = byId.get(id)
    if (task !== undefined) {
      for (const dependency of task.dependencies) walk(dependency)
      if (id !== taskId) ordered.push(task)
    }
    visiting.delete(id)
    visited.add(id)
  }

  walk(taskId)
  return ordered
    .filter(task => task.status === 'completed')
    .map((task) => {
      const profileSeedId = taskProfileSeedId(task)
      return {
        id: task.id,
        subject: task.subject,
        ...profileSeedId === undefined ? {} : { profileSeedId },
        ...task.output === undefined ? {} : { output: task.output },
      }
    })
}

/** Format completed-dependency outputs with per-item and total truncation. */
export function formatDependencyOutputs(items: readonly DependencyOutput[]): string {
  if (items.length === 0) return '(none)'
  const formatted = items.map((item) => {
    const seed = item.profileSeedId === undefined ? '' : ` [${item.profileSeedId}]`
    const raw = item.output === undefined || item.output === ''
      ? '(no output recorded)'
      : item.output
    const truncated = raw.length > DEPENDENCY_OUTPUT_MAX_CHARS
    const body = truncated ? `${raw.slice(0, DEPENDENCY_OUTPUT_MAX_CHARS)} [truncated]` : raw
    return `- ${item.id}${seed} ${item.subject}:\n  ${body}`
  })
  let selected = formatted
  while (selected.length > 1 && selected.join('\n').length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = selected.slice(1)
  }
  const last = selected[0]
  if (selected.length === 1 && last !== undefined && last.length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = [`${last.slice(0, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS)} [truncated]`]
  }
  return selected.join('\n')
}

function stateRootOf(workspace: string, config: SchedulerConfig): string {
  return join(workspace, config.stateDir)
}

/** The workspace a captain session runs in (the state root's parent). */
function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/** Members of one team that are working right now, for the concurrency caps. */
/**
 * The members that are actually working.
 *
 * Φ1 item 2 (owner report, measured seven times in the material-layers run: t185, t186,
 * t194, t195, t202, t203, t204 — a lane assigned and pending next to an idle member that
 * nothing woke until the captain sent a message). The dispatch caps used to count
 * `member.status`, and that field is written from the host's `agent/status` stream: one
 * missed idle event left a member marked `working` forever, the cap looked full, and
 * every idle member with an assigned lane stayed undispatched. Counting the work a
 * member actually holds is state-based, exactly like the create-time guards (owner
 * decision D6), and it cannot drift from the graph the report shows.
 */
export function workingMemberNames(team: Pick<TeamState, 'members' | 'tasks'>): string[] {
  return team.members
    .filter((member) => member.status !== 'removed')
    .filter((member) => team.tasks.some((task) => task.assignee === member.name
      && (task.status === 'claimed' || task.status === 'in_progress')))
    .map((member) => member.name)
}

function workingCount(team: TeamState): number {
  return workingMemberNames(team).length
}

function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

function liveCaptain(ctx: Context, captainSessionId: string, supplied?: Agent): Agent | undefined {
  if (supplied !== undefined && supplied.id === captainSessionId) return supplied
  return ctx.agents.get(captainSessionId as SessionId)
}

function liveMember(ctx: Context, member: TeamMember): Agent | undefined {
  return ctx.agents.get(member.id as SessionId)
}

function isMemberAvailable(ctx: Context, member: TeamMember): boolean {
  if (member.stopping === true) return false
  const live = liveMember(ctx, member)
  return live === undefined || live.status === 'idle'
}

function ownedOpenTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  return tasks.find(task => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

function nextReadyTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  const ready = tasks.filter(task => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies([...tasks], task.dependencies).length === 0)
  return ready.find(task => task.assignee === memberName)
    ?? ready.find(task => task.assignee === undefined)
}

export function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  const seed = ticket.profileSeedId === undefined ? '' : ` [${ticket.profileSeedId}]`
  const goal = ticket.teamDescription?.trim() || '(not provided)'
  const protocol = ticket.profileProtocol?.trim() || '(none)'
  const executionPrompt = ticket.executionPrompt?.trim()
  const kind = ticket.kind?.trim() || 'work'
  const contract = [
    `Kind: ${kind}${ticket.round === undefined ? '' : ` (round ${ticket.round})`}`,
    ticket.objective === undefined || ticket.objective === '' ? '' : `Objective: ${ticket.objective}`,
    ticket.inScope === undefined || ticket.inScope.length === 0 ? '' : `In scope: ${ticket.inScope.join(', ')}`,
    ticket.outOfScope === undefined || ticket.outOfScope.length === 0 ? '' : `Out of scope: ${ticket.outOfScope.join(', ')}`,
    ticket.acceptance === undefined || ticket.acceptance.length === 0 ? '' : `Acceptance: ${ticket.acceptance.map(acceptanceCriterionText).join('; ')}`,
    ticket.verify === undefined || ticket.verify.length === 0 ? '' : `Verify: ${ticket.verify.join('; ')}`,
    ticket.reviewedTaskId === undefined ? '' : `Reviewed task: ${ticket.reviewedTaskId}`,
  ].filter((line) => line !== '').join('\n')
  const structuredCompletion = ['implementation', 'repair', 'verification', 'integration'].includes(kind)
    ? `
Structured completion payload (keep these arrays in contract order; a criterion whose text is re-typed must still match after whitespace/punctuation normalization):
acceptanceResults: ${JSON.stringify((ticket.acceptance ?? []).map((criterion) => ({ criterion: acceptanceCriterionText(criterion), status: 'passed', evidence: '<what proved it>' })))}
commandsRun: ${JSON.stringify((ticket.verify ?? []).map((command) => ({ command, status: 'passed', exitCode: 0, evidence: '<observed result>' })))}
If a criterion or command cannot honestly be measured green — it is red on HEAD for a reason outside this task, or no measurement exists — submit status "waived" with evidence that names the reason and the baseline you compared against. Never write "passed" for a measurement you did not make. A graded criterion written as {text, mode:"no_regression"} needs the baseline reference in its evidence.
${kind === 'implementation' || kind === 'repair' ? 'changedPaths: list the actual workspace-relative POSIX paths you changed.\n' : ''}`
    : ''
  return `AgentTeams automatic task assignment from the shared task list.

You are executing as configured member "${ticket.memberName}".
Do not start a teammate's assigned task.

Team goal:
${goal}

Profile protocol:
${protocol}
${executionPrompt === undefined || executionPrompt === '' ? '' : `
Execution guidance:
${executionPrompt}
`}
Completed dependency results:
${formatDependencyOutputs(ticket.dependencyOutputs)}

Task: ${ticket.taskId}${seed} — ${ticket.subject}${description}
${contract === '' ? '' : `\nContract:\n${contract}\n`}
${structuredCompletion}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

Call agent_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every agent_teams_update_task call. If it is rejected as stale, stop work because the task was reassigned. claimed cannot jump to completed. Mark in_progress first, then completed or failed. Include attempt_id on every update. Then send_message to captain and become idle.
When finishing: use status=completed only when the task's success criteria are satisfied; use status=failed when blocking findings or validation failures mean downstream work must not proceed; include a concise output in either case. Quality kinds must submit structured fields: review/requirements need verdict=pass to complete (needs_revision/reject must fail with findings); implementation/repair/verification/integration need acceptanceResults and commandsRun, while implementation/repair also need in-scope changedPaths. Use status values "passed" or "failed" inside those arrays. After the work and verification finish, call agent_teams_update_task immediately; do not wait for captain confirmation and do not continue exploring. Do not approve your own implementation. Mail is not a formal next review. Treat the dependency results above as source material. Do not ignore them. Work only this task and only its in-scope paths in this turn.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through agent_teams_* tools.`
}

/** Install one scheduler and its member activity observer. */
export function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler {
  const memberQueues = new Map<string, Promise<unknown>>()
  // An idle edge in this process proves that the resident member ended its
  // turn while the current attempt was still open. Remember that capability
  // even after Harness disposes the continuable AgentHandle: later status or
  // graph kicks must keep it parked. A cold process starts with an empty map,
  // so durable open attempts are still recovered after restart.
  const parkedAttempts = new Map<string, string>()
  /**
   * Members that may have an attempt adopted on their next dispatch.
   *
   * A member's own capability is one the scheduler never minted: `update_task`
   * creates no new attempt, so an `in_progress` task carries an `attemptId` this
   * process has never seen. That makes "unfamiliar capability" ambiguous between
   * a live worker and an attempt stranded by a previous process, which is why
   * the scheduler refuses to recover while the member is mid-turn
   * ({@link isMemberAvailable}) and allows exactly one adoption per idle edge
   * here. The member's own `claim`/`in_progress` window therefore keeps its
   * attempt: without this, recovery re-claimed the task under the member
   * (`claimed`/`in_progress` dropped back to `claimed`, the attempt counter
   * grew, and the member's next `update_task` was refused as stale or as an
   * illegal `claimed → completed` transition).
   *
   * A member that is durably `idle` at first sight (a cold start, or work
   * queued while it was idle) is reclaimable immediately, which preserves
   * crash recovery; a member that starts out `working` must reach an idle edge
   * first, because its durable attempt belongs to a turn that is still running.
   */
  const nextDispatchReclaims = new Set<string>()
  /**
   * Capabilities this process minted outside a dispatch.
   *
   * A member's own `claim_task` creates an `attemptId` the scheduler never
   * handed out, so by capability alone it is indistinguishable from an attempt
   * stranded by a previous process — and recovering it would re-claim the task
   * under the member (`claimed`/`in_progress` drops back to `claimed`, the
   * counter grows, and the member's next `update_task` is refused as stale or as
   * an illegal `claimed → completed` transition). {@link noteClaimedAttempt}
   * closes that gap: a capability the plugin minted for a member is known here,
   * so it is never treated as a lost owner.
   */
  const knownAttempts = new Set<string>()

  const memberQueueKey = (stateRoot: string, teamId: string, memberName: string): string => (
    `${stateRoot}\u0000${teamId}\u0000${memberName}`
  )

  /**
   * Members working right now across every workspace of the sweep (WP11 phase 2).
   *
   * The caps live on the dispatch primitive rather than on its callers: the
   * phase-2 sweep, a single-team kick and the `agent/status` idle wake-up all end
   * up here, so none of them can exceed the fuse by taking a different route.
   */
  const globalWorkingCount = async (fallbackWorkspace: string): Promise<number> => {
    const workspaces = config.workspaces === undefined ? [fallbackWorkspace] : [...config.workspaces()]
    let total = 0
    for (const workspace of workspaces) {
      const stateRoot = stateRootOf(workspace, config)
      for (const team of await listTeams(stateRoot)) total += workingCount(team)
    }
    return total
  }

  const serializeMember = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = memberQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    memberQueues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (memberQueues.get(key) === tail) memberQueues.delete(key)
    }
  }

  const runtime: TeamScheduler = {
    noteClaimedAttempt() {},

    /**
     * Sweep every live team of every known workspace (WP11 phase 2).
     *
     * Caps are state-based, like the create-time guard: the number of members
     * that are *working* right now, per team and across the sweep. A team at its
     * cap is skipped rather than queued, and the sweep stops early once the global
     * cap is reached, so two busy teams cannot starve a third of its budget.
     */
    async sweepAll(suppliedCaptain) {
      const workspaces = config.workspaces === undefined
        ? suppliedCaptain === undefined ? [] : [workspaceOf(suppliedCaptain)]
        : [...config.workspaces()]
      const maxPerTeam = config.maxWorkersPerTeam ?? MAX_WORKERS_PER_TEAM
      const maxGlobal = config.maxConcurrentWorkersGlobal ?? MAX_CONCURRENT_WORKERS_GLOBAL
      const entries: { workspace: string; team: TeamState }[] = []
      for (const workspace of workspaces) {
        const stateRoot = stateRootOf(workspace, config)
        for (const team of await listTeams(stateRoot)) entries.push({ workspace, team })
      }
      let globalWorkers = entries.reduce((sum, entry) => sum + workingCount(entry.team), 0)
      let visited = 0
      let dispatched = 0
      for (const entry of entries) {
        if (globalWorkers >= maxGlobal) break
        if (entry.team.halted === true || entry.team.phase === 'staged') continue
        const captain = liveCaptain(ctx, entry.team.captainSessionId, suppliedCaptain)
        if (captain === undefined) continue
        visited += 1
        let teamWorkers = workingCount(entry.team)
        for (const member of entry.team.members) {
          if (teamWorkers >= maxPerTeam || globalWorkers >= maxGlobal) break
          if (member.status === 'removed') continue
          // A durable `working` status is not evidence that the member is still
          // running: after a restart it is stale, and its open attempt is exactly
          // what the recovery path inside `kickMember` has to redeliver. The
          // member's own availability check decides, not this loop.
          const did = await runtime.kickMember(entry.workspace, entry.team.id, member.name, captain)
          if (!did) continue
          teamWorkers += 1
          globalWorkers += 1
          dispatched += 1
        }
      }
      return { teams: visited, dispatched }
    },

    async kickTeam(workspace, teamId, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      const team = await readTeam(stateRoot, teamId)
      if (team === undefined || team.halted === true || team.phase === 'staged') return
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
      if (captain === undefined) return
      const maxPerTeam = config.maxWorkersPerTeam ?? MAX_WORKERS_PER_TEAM
      let teamWorkers = workingCount(team)
      for (const member of team.members) {
        if (member.status === 'removed') continue
        if (teamWorkers >= maxPerTeam) return
        const did = await runtime.kickMember(workspace, teamId, member.name, captain)
        if (did) teamWorkers += 1
      }
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      const queueKey = memberQueueKey(stateRoot, teamId, memberName)
      return serializeMember(queueKey, async () => {
        let team = await readTeam(stateRoot, teamId)
        if (team === undefined || team.halted === true || team.phase === 'staged') return false
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
        if (captain === undefined) return false
        let member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || !isMemberAvailable(ctx, member)) return false

        // A mailbox-only fallback is real pending work. Deliver it before a
        // fresh task and acknowledge only after Harness accepts the follow-up.
        const unread = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return []
          const pending = await readPendingMailbox(stateRoot, fresh.id, member!.name)
          await discardMailboxMessages(stateRoot, fresh.id, member!.name, pending.filter(message => !isCurrentMail(fresh, message)).map(message => message.id))
          const current = pending.filter(message => isCurrentMail(fresh, message))
          await claimMailboxDelivery(stateRoot, fresh.id, member!.name, current.map(message => message.id))
          return current
        })
        if (unread.length > 0) {
          const prompt = mailboxPrompt(team.id, member.name, unread)
          const signal = new AbortController().signal
          const accepted = config.dispatch === undefined
            ? await deliverToMember(ctx, captain, member.id, prompt, signal, 'steer')
            : await config.dispatch(captain, team.id, member.name, prompt, signal, 'steer')
          if (accepted) {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              markMailboxDelivered(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          } else {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              releaseMailboxDelivery(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          }
          return accepted
        }

        const maxPerTeam = config.maxWorkersPerTeam ?? MAX_WORKERS_PER_TEAM
        const maxGlobal = config.maxConcurrentWorkersGlobal ?? MAX_CONCURRENT_WORKERS_GLOBAL

        const ticket = await withTeamLock(teamLockKey(stateRoot, team.id), async (): Promise<DispatchTicket | undefined> => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined || fresh.halted === true || fresh.phase === 'staged') return undefined
          const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
          if (currentMember === undefined || !isMemberAvailable(ctx, currentMember)) return undefined
          // WP11 phase 2 caps: this team may not exceed its own fuse, and the
          // workspace may not exceed the global one. Checked here so every kick
          // path (sweep, team kick, idle wake-up) obeys the same numbers.
          if (workingCount(fresh) >= maxPerTeam) return undefined
          if (await globalWorkingCount(workspace) >= maxGlobal) return undefined
          const owned = ownedOpenTask(fresh.tasks, currentMember.name)
          // An idle edge observed by this scheduler parks the exact open
          // capability. Harness may dispose its AgentHandle after settlement,
          // so registry absence is not evidence that the owner was lost. Keep
          // the marker sticky across later kicks; only a durable attempt that
          // this process has not observed is eligible for one cold recovery.
          //
          // A member's *own* capability is one this process never minted:
          // `update_task` starts no new attempt, so the whole window between the
          // member's `claim` and its first `update_task` carries an `attemptId`
          // the scheduler has never seen. Recovering that would re-claim the task
          // under the member (`claimed`/`in_progress` drops back to `claimed`,
          // the counter grows, and the member's next `update_task` is refused as
          // stale or as an illegal `claimed → completed` transition). So an
          // attempt-less task — one whose capability the scheduler itself
          // minted, or none at all — is the only recovery target.
          const parkedAttemptId = parkedAttempts.get(currentMember.id)
          const lackedCapability = owned !== undefined && owned.attemptId === undefined
          const recoverOwned = owned !== undefined
            && (lackedCapability || !knownAttempts.has(owned.attemptId as string))
            && owned.attemptId !== parkedAttemptId
          // Fresh ready work wins over re-claiming an attempt the member already
          // holds. An open owned task used to shadow the queue entirely, so a
          // member whose previous attempt was left open could never pick up the
          // next task; recovery is the fallback, not the first choice.
          const ready = nextReadyTask(fresh.tasks, currentMember.name)
          const task = ready ?? (recoverOwned ? owned : undefined)
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeTeam(stateRoot, fresh)
            }
            return undefined
          }
          const previousAssignee = task.assignee
          const previousStatus = recoverOwned ? task.status as 'claimed' | 'in_progress' : undefined
          const previousAttempt = recoverOwned ? task.attempt : undefined
          const previousAttemptId = recoverOwned ? task.attemptId : undefined
          const attemptId = beginTaskAttempt(task, currentMember.name)
          // A recovered generation is parked before delivery. This makes each
          // (member, attempt) recovery idempotent even if every status poll
          // sees a disposed handle. Fresh pending work remains unparked so a
          // genuinely lost first delivery can be recovered once.
          if (recoverOwned) parkedAttempts.set(currentMember.id, attemptId)
          else parkedAttempts.delete(currentMember.id)
          nextDispatchReclaims.delete(currentMember.id)
          knownAttempts.add(attemptId)
          currentMember.status = 'working'
          await writeTeam(stateRoot, fresh)
          const profileSeedId = taskProfileSeedId(task)
          const protocol = teamProfileProtocol(fresh)
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attempt: task.attempt ?? 1,
            attemptId,
            previousAssignee,
            recoveredOwned: recoverOwned,
            ...previousStatus === undefined ? {} : { previousStatus },
            ...previousAttempt === undefined ? {} : { previousAttempt },
            ...previousAttemptId === undefined ? {} : { previousAttemptId },
            subject: task.subject,
            description: task.description,
            teamDescription: fresh.description,
            ...protocol === undefined ? {} : { profileProtocol: protocol },
            ...profileSeedId === undefined ? {} : { profileSeedId },
            ...fresh.profile?.executionPrompt === undefined && config.executionPrompt === undefined
              ? {}
              : { executionPrompt: fresh.profile?.executionPrompt ?? config.executionPrompt },
            kind: task.kind ?? 'work',
            ...task.round === undefined ? {} : { round: task.round },
            ...task.objective === undefined ? {} : { objective: task.objective },
            ...task.inScope === undefined ? {} : { inScope: task.inScope },
            ...task.outOfScope === undefined ? {} : { outOfScope: task.outOfScope },
            ...task.acceptance === undefined ? {} : { acceptance: task.acceptance },
            ...task.verify === undefined ? {} : { verify: task.verify },
            ...task.reviewedTaskId === undefined ? {} : { reviewedTaskId: task.reviewedTaskId },
            dependencyOutputs: collectCompletedDependencyOutputs(
              fresh.tasks,
              task.id,
              (message) => ctx.logger.warn(message),
            ),
          }
        })
        if (ticket === undefined) return false

        const prompt = assignmentPrompt(ticket, config.stateDir, team.id)
        const signal = new AbortController().signal
        const accepted = config.dispatch === undefined
          ? await deliverToMember(ctx, captain, ticket.memberId, prompt, signal)
          : await config.dispatch(captain, team.id, ticket.memberName, prompt, signal, 'queue', ticket.attemptId)
        if (accepted) return true

        // Roll back only our exact failed dispatch. A concurrent captain
        // handoff has already changed the capability and wins.
        await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return
          const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId)
          if (task?.attemptId !== ticket.attemptId) return
          if (ticket.recoveredOwned && ticket.previousStatus !== undefined && ticket.previousAttemptId !== undefined) {
            // Recovery delivery failed. Restore the durable generation instead
            // of returning it to pending, then keep it parked so later status
            // kicks cannot spend an unbounded sequence of fresh attempts.
            task.status = ticket.previousStatus
            task.assignee = ticket.previousAssignee
            task.attempt = ticket.previousAttempt
            task.attemptId = ticket.previousAttemptId
            parkedAttempts.set(ticket.memberId, ticket.previousAttemptId)
          } else {
            task.status = 'pending'
            task.assignee = ticket.previousAssignee
            task.attemptId = undefined
            parkedAttempts.delete(ticket.memberId)
            // A delivery that never reached the member is the same lost-delivery
            // boundary as an idle edge: the adopted attempt may be reclaimed.
            nextDispatchReclaims.add(ticket.memberId)
          }
          task.handoffId = undefined
          task.reassigning = false
          task.updatedAt = Date.now()
          const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
          await writeTeam(stateRoot, fresh)
        })
        return false
      })
    },
  }

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config)
    // WP11 phase 1: one session may take part in several teams, so every lane of
    // the agent is reconciled in turn instead of assuming a single match.
    const locatedTeams = await findTeamsByParticipant(stateRoot, agent.id)
    if (locatedTeams.length === 0) {
      parkedAttempts.delete(agent.id)
      return
    }
    for (const located of locatedTeams) {
      if (located.captainSessionId === agent.id) {
        // Captain takeover is scoped to the captain's current turn. Unlike a
        // durable member, the captain has no scheduler lane that can resume an
        // abandoned attempt later. Returning unfinished captain-owned work to
        // the shared pool on the idle edge prevents it from becoming a
        // permanently parked `claimed` task after the captain answers, is
        // interrupted, or the user switches conversations.
        if (status === 'running') continue
        let requeued = false
        await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
          const fresh = await readTeam(stateRoot, located.id)
          if (fresh === undefined || fresh.captainSessionId !== agent.id) return
          for (const task of fresh.tasks) {
            if (task.assignee !== CAPTAIN_KEY
              || task.status === 'completed'
              || task.status === 'failed'
              || task.status === 'cancelled') continue
            invalidateTaskAttempt(task)
            task.reassigning = false
            requeued = true
          }
          if (requeued) await writeTeam(stateRoot, fresh)
        })
        if (requeued) await runtime.kickTeam(workspace, located.id, agent)
        continue
      }
      const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
      if (member === undefined) continue
      await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
        const fresh = await readTeam(stateRoot, located.id)
        const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
        if (fresh === undefined || current === undefined) return
        const next = status === 'running' ? 'working' : 'idle'
        if (next === 'idle') {
          const owned = ownedOpenTask(fresh.tasks, current.name)
          if (owned?.attemptId === undefined) parkedAttempts.delete(agent.id)
          else parkedAttempts.set(agent.id, owned.attemptId)
          // The turn ended while this member still owns an open task: that is the
          // lost-delivery window, so its attempt may be adopted once. A delivery
          // failure counts as the same boundary.
          if (owned !== undefined) nextDispatchReclaims.add(agent.id)
        } else {
          parkedAttempts.delete(agent.id)
        nextDispatchReclaims.delete(agent.id)
      }
      if (current.status === next) return
      current.status = next
      await writeTeam(stateRoot, fresh)
      })
      if (status === 'idle') await runtime.kickMember(workspace, located.id, member.name)
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`agent-teams: member status scheduling failed for ${agent.id}: ${String(error)}`)
    })
  })

  return {
    ...runtime,
    noteClaimedAttempt(memberId, attemptId) {
      if (memberId !== '' && attemptId !== '') knownAttempts.add(attemptId)
    },
  }
}
