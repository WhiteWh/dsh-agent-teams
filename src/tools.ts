/**
 * The `agent_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code AgentTeams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-agent-teams/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { appendTeamEvent, captainSessionOf } from './events.ts'
import {
  amendTaskContract,
  acknowledgeMailbox,
  markMailboxDelivered,
  discardMailboxMessages,
  appendMailbox,
  archiveTeamDir,
  beginTaskAttempt,
  CAPTAIN_KEY,
  createMessage,
  createTeamDir,
  findTeamsByCaptain,
  findTeamsByParticipant,
  listTeams,
  describeTeamHandles,
  cancelUnfinishedTask,
  invalidateTaskAttempt,
  readUnreadMailbox,
  recordRetiredMemberIds,
  releaseMailboxDelivery,
  readTeam,
  sanitizeKey,
  transitionError,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
  validateCreateTask,
  evaluateQualityCompletion,
  planQualityFollowUp,
  resumeTeamState,
  buildCoverageMatrix,
  canDeclareDelivery,
  describeQualityLoop,
  reportsWaiver,
  sanitizeReviewAcceptance,
  sanitizeReviewObjective,
  normalizeBlankOptionalTaskFields,
  taskHasWaivers,
  taskKindOf,
  applySupersession,
  acceptTaskPaths,
  pinKnownDelta,
  unpinKnownDelta,
  pinnedWaiverEvidence,
  revisePlan,
  validateTeamGraph,
  waivedResultCount,
  waiversConfirmed,
} from './state.ts'
import type { ContractAmendmentInput } from './state.ts'
import type { AcceptanceResult, CommandResult, ReviewFinding, ReviewVerdict, TaskKind, WaiverConfirmation } from './types.ts'
import {
  deliverToMember,
  installRetiredMemberGuard,
  installMemberSelectionRuntime,
  installMemberDelegationGuard,
  memberActivity,
  resolveMemberLlmSelection,
  spawnMember,
  steerCaptainReport,
  validateMemberLlmSelections,
  type MemberRuntimeConfig,
} from './members.ts'
import { TERMINAL_TASK_STATUSES, type KnownDelta, type TeamMember, type TeamState, type TeamTask } from './types.ts'
import { collectCompletedDependencyOutputs, formatDependencyOutputs, installTeamScheduler } from './scheduler.ts'
import { installMailboxAdmission, mailboxPrompt } from './mailbox.ts'
import { resolveTeamProfile } from './profiles.ts'
import { planProgress } from './progress.ts'
import { replanTeam } from './replan.ts'

export { steerCaptainReport } from './members.ts'

/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Member subagent provider name. */
  memberProvider: string
  /** Optional member model override. */
  memberModel?: string
  /** Prompt injected into member personas and assignments. */
  executionPrompt?: string
  /** Plugin fallback route. */
  fallback?: import('./profiles.ts').TeamModelFallbackConfig
  /** Member delegation depth cap. */
  memberMaxDepth?: number
  /** Team size cap (members). */
  maxMembers: number
  /** Named team profiles from the active DSH profile. */
  profiles: Record<string, import('./profiles.ts').TeamProfileConfig>
  /**
   * Every workspace the host knows, for the phase-2 scheduler sweep. The host
   * injects this (it owns the workspace registry); absent means "the calling
   * captain's workspace only", which is what tests and older hosts get.
   */
  workspaces?: () => readonly string[]
  /**
   * Per-team concurrent-worker cap (WP11 phase 2). Defaults to
   * `MAX_WORKERS_PER_TEAM`; phase 3 exposes it as a profile key.
   */
  maxWorkersPerTeam?: number
  /** Workspace-wide concurrent-worker cap; defaults to `MAX_CONCURRENT_WORKERS_GLOBAL`. */
  maxConcurrentWorkersGlobal?: number
}

/** Browser/UI mutations allowed while a plan is waiting for approval. */
export type StagedPlanMutation =
  | {
      action: 'update_member'
      memberName: string
      role?: string | null
      provider: string
      model: string
      reasoningEffort?: string | null
      executionPrompt?: string | null
    }
  | {
      action: 'update_task'
      taskId: string
      subject: string
      description?: string | null
      assignee?: string | null
      dependencies: string[]
    }
  | {
      action: 'add_task'
      subject: string
      description?: string | null
      assignee?: string | null
      dependencies: string[]
    }
  | { action: 'remove_task'; taskId: string }
  | { action: 'remove_member'; memberName: string }

/** The result the Web surface and the tool both report for one replan batch. */
export interface ReplanRuntimeResult {
  readonly revision: number
  readonly applied: number
  readonly changes: string[]
  readonly added: string[]
  readonly removed: string[]
  readonly rebound: string[]
  readonly invalidated: string[]
}

/** Runtime bridge shared by model-facing tools and the Web staging surface. */
export interface AgentTeamsRuntime {
  isPendingMember(agent: Agent): boolean
  updateStagedPlan(captain: Agent, teamId: string, mutation: StagedPlanMutation, signal?: AbortSignal): Promise<TeamState>
  updateStagedPlanBatch(captain: Agent, teamId: string, mutations: readonly StagedPlanMutation[], signal?: AbortSignal): Promise<TeamState>
  approveStagedTeam(captain: Agent, teamId: string, signal?: AbortSignal): Promise<{ teamId: string; members: number; tasks: number }>
  continueStagedPlanning(captain: Agent, teamId: string): Promise<{ teamId: string; alreadyWaiting: boolean }>
  discardStagedTeam(captain: Agent, teamId: string): Promise<{ teamId: string }>
  /**
   * WP7/S17: revise a RUNNING plan in one atomic batch. Shared by
   * `agent_teams_replan` and the Web running-mode plan editor, so both paths
   * validate, write, emit the same event and wake the same members.
   */
  replanLiveTeam(
    captain: Agent,
    teamId: string,
    operations: readonly import('./replan.ts').ReplanOperation[],
    reason: string,
    signal?: AbortSignal,
  ): Promise<ReplanRuntimeResult>
}

/** Workspace fuse for WP11 phase 1 (configurable keys arrive in phase 3). */
const MAX_TEAMS_PER_WORKSPACE = 4

/** Workspace-wide active-worker fuse for WP11 phase 1 (owner decision D6). */
const MAX_CONCURRENT_WORKERS_GLOBAL = 8

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** The captain's workspace directory (team state root parent). */
function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/** Resolved absolute state root. */
function stateRootOf(workspace: string, config: ToolsConfig): string {
  return join(workspace, config.stateDir)
}

/** Process-local lock key scoped by workspace state root and team id. */
function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

/** Process-local lock key enforcing one active team per captain session. */
function captainLockKey(stateRoot: string, captainId: string): string {
  return `captain:${stateRoot}:${captainId}`
}

/**
 * The `team_id` parameter every team-scoped tool declares (WP11 phase 1).
 *
 * It stays optional in the schema on purpose. The runtime validates arguments
 * before the handler runs, so a schema-level `required` would answer a missing id
 * with a bare "missing required property" instead of the list of teams the caller
 * can address. `pickCallerTeam` enforces presence and names those teams, which is
 * what lets the model correct itself in one step.
 * @returns a fresh parameter descriptor.
 */
function teamIdParam(): { type: 'string'; description: string } {
  return {
    type: 'string',
    description: 'Team id this call acts on (required): get it from agent_teams_create, or from agent_teams_status with no argument. An omitted id fails with the list of your teams.',
  }
}

/**
 * Pick one team out of the caller's teams (WP11 phase 1).
 *
 * Team identity is an argument, not a property of the calling session: a captain
 * may lead several teams in one workspace, so a missing id is an error that lists
 * the caller's teams instead of guessing. The one exception is a member of exactly
 * one team — the capability context substitutes that team, so the member prompt
 * does not change.
 * @param teams - the caller's teams, oldest first.
 * @param teamId - the requested team id, when the caller passed one.
 * @param allowSoleParticipantTeam - substitute the only team the caller belongs to.
 * @param emptyMessage - message when the caller has no team at all.
 * @returns the selected team record.
 */
function pickCallerTeam(
  teams: readonly TeamState[],
  teamId: string | undefined,
  allowSoleParticipantTeam: boolean,
  emptyMessage: string,
): TeamState {
  const wanted = teamId?.trim() ?? ''
  if (wanted !== '') {
    const match = teams.find((team) => team.id === wanted)
    if (match === undefined) {
      throw new Error(
        `team "${wanted}" is not one of your teams; your teams: ${describeTeamHandles(teams)}`,
      )
    }
    return match
  }
  if (teams.length === 0) throw new Error(emptyMessage)
  const sole = teams[0]
  if (allowSoleParticipantTeam && teams.length === 1 && sole !== undefined) return sole
  throw new Error(
    `team_id is required: you participate in ${String(teams.length)} teams (${describeTeamHandles(teams)})`,
  )
}

/** The team this captain leads, or a loud failure naming every team they lead. */
async function requireCaptainTeam(
  workspace: string,
  config: ToolsConfig,
  captain: Agent,
  teamId?: string,
): Promise<TeamState> {
  const teams = await findTeamsByCaptain(stateRootOf(workspace, config), captain.id)
  return pickCallerTeam(teams, teamId, false, 'you are not leading any team yet — call agent_teams_create first')
}

/** The team this captain leads or this member belongs to. */
async function requireParticipantTeam(
  workspace: string,
  config: ToolsConfig,
  caller: Agent,
  teamId?: string,
): Promise<TeamState> {
  const teams = await findTeamsByParticipant(stateRootOf(workspace, config), caller.id)
  return pickCallerTeam(teams, teamId, true, 'you do not lead or belong to any active team yet')
}

type ParticipantIdentity =
  | { kind: 'captain'; name: typeof CAPTAIN_KEY }
  | { kind: 'member'; name: string }

/** Re-derive a caller's role from fresh state while holding the team lock. */
function participantIdentityOf(team: TeamState, agentId: string): ParticipantIdentity | undefined {
  if (team.captainSessionId === agentId) return { kind: 'captain', name: CAPTAIN_KEY }
  const member = team.members.find((candidate) => candidate.id === agentId && candidate.status !== 'removed')
  return member === undefined ? undefined : { kind: 'member', name: member.name }
}

/** Fresh state for a team that still exists; never falls back to stale lookup data. */
async function requireFreshTeam(stateRoot: string, teamId: string): Promise<TeamState> {
  const fresh = await readTeam(stateRoot, teamId)
  if (fresh === undefined) throw new Error(`team "${teamId}" is no longer active`)
  return fresh
}

/** Fresh state with captain authorization rechecked inside the lock. */
async function requireFreshCaptainTeam(
  stateRoot: string,
  teamId: string,
  captainId: string,
): Promise<TeamState> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  if (fresh.captainSessionId !== captainId) {
    throw new Error(`only the captain of team "${fresh.name}" may perform this operation`)
  }
  return fresh
}

/** Fresh state and caller identity rechecked inside the lock. */
async function requireFreshParticipant(
  stateRoot: string,
  teamId: string,
  callerId: string,
): Promise<{ team: TeamState; identity: ParticipantIdentity }> {
  const fresh = await requireFreshTeam(stateRoot, teamId)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer an active participant in team "${fresh.name}"`)
  return { team: fresh, identity }
}

/** Look up one live (non-removed) member by display name. */
function requireMember(team: TeamState, name: string): TeamMember {
  const member = team.members.find((candidate) => candidate.name === name && candidate.status !== 'removed')
  if (member === undefined) {
    throw new Error(`no active member named "${name}" in team "${team.name}"`)
  }
  return member
}

/** Look up one task by id. */
function requireTask(team: TeamState, taskId: string): TeamTask {
  const task = team.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) {
    throw new Error(`no task "${taskId}" in team "${team.name}" — use agent_teams_status to list tasks`)
  }
  return task
}

function requireStagedTeam(team: TeamState): void {
  if (team.phase !== 'staged') {
    throw new Error(`team "${team.name}" is already running; its plan can no longer be edited`)
  }
  if (team.halted === true) throw new Error(`team "${team.name}" is halted, not awaiting plan approval`)
}

function trimmedOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Validate references and cycles before a staged graph can be saved or run.
 *
 * The rule itself lives in `state.ts` (`validateTeamGraph`) because the live
 * replan batch of WP7 has to enforce exactly the same thing; this wrapper keeps
 * the staged call sites reading as they did.
 */
function validateStagedGraph(team: TeamState, requireRunnable: boolean): void {
  validateTeamGraph(team, requireRunnable)
}

function memberOpenTask(team: TeamState, memberName: string, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

function taskDetails(team: TeamState, task: TeamTask): string {
  return [task.subject, task.description ?? '',
    `Kind: ${task.kind ?? 'work'}`,
    `Objective: ${task.objective ?? ''}`,
    `In scope: ${(task.inScope ?? []).join(', ')}; Out of scope: ${(task.outOfScope ?? []).join(', ')}`,
    `Acceptance: ${(task.acceptance ?? []).join('; ')}`,
    `Verify: ${(task.verify ?? []).join('; ')}`,
    `Dependency results:\n${formatDependencyOutputs(collectCompletedDependencyOutputs(team.tasks, task.id))}`,
  ].join('\n')
}

/** Captain work is immediate, not a durable scheduler lane: allow one unfinished takeover at a time. */
function captainOpenTask(team: TeamState, exceptTaskId?: string): TeamTask | undefined {
  return team.tasks.find(task => task.id !== exceptTaskId
    && task.assignee === CAPTAIN_KEY
    && !TERMINAL_TASK_STATUSES.includes(task.status))
}

/** Stop every currently-resident member activation for one halted team.
 *
 * Interrupt requests only cancel the member's current model turn and retain its
 * activation. Draining the selected direct children is the stronger lifecycle
 * boundary: it waits for the activation handles to release, so a child cannot
 * keep executing after the captain-chat Stop control has reported success.
 */
async function stopTeamMemberActivations(
  ctx: Context,
  captain: Agent,
  members: readonly TeamMember[],
  signal?: AbortSignal,
): Promise<void> {
  const memberIds = members.filter(member => member.id !== '').map(member => member.id as SessionId)
  if (memberIds.length === 0) return
  // Every supported exact host has targeted recursive drain. Unlike interrupt,
  // it closes admission and clears queued work before awaiting descendants.
  signal?.throwIfAborted()
  await ctx.subagents.drainContinuableChildren(captain, memberIds)
}

export async function haltTeamWork(input: {
  ctx: Context
  stateRoot: string
  teamId: string
  captain: Agent
  signal?: AbortSignal
}): Promise<{ teamName: string; cancelledTasks: number; alreadyHalted: boolean }> {
  const halted = await withTeamLock(teamLockKey(input.stateRoot, input.teamId), async () => {
    const fresh = await requireFreshCaptainTeam(input.stateRoot, input.teamId, input.captain.id)
    if (fresh.halted === true) {
      return {
        teamName: fresh.name,
        cancelledTasks: fresh.tasks.filter((task) => task.status === 'cancelled').length,
        alreadyHalted: true,
        members: fresh.members.filter((member) => member.id !== '' && member.status !== 'removed').map((member) => ({ ...member })),
      }
    }
    const now = Date.now()
    let cancelledTasks = 0
    for (const task of fresh.tasks) {
      if (TERMINAL_TASK_STATUSES.includes(task.status)) continue
      cancelUnfinishedTask(task, 'Stopped from the captain chat.')
      cancelledTasks += 1
    }
    for (const member of fresh.members) {
      if (member.status === 'removed') continue
      member.status = 'idle'
    }
    fresh.halted = true
    fresh.haltedAt = now
    await writeTeam(input.stateRoot, fresh)
    appendTeamEvent(input.ctx, captainSessionOf(input.ctx, fresh.captainSessionId, input.captain.session), 'agent-teams/team-halted', {
      teamId: fresh.id,
      cancelledTasks,
    })
    return {
      teamName: fresh.name,
      cancelledTasks,
      alreadyHalted: false,
      members: fresh.members.filter((member) => member.id !== '' && member.status !== 'removed').map((member) => ({ ...member })),
    }
  })
  // Persist the stop boundary first, then abort the Captain before draining
  // children. Otherwise its current model turn can observe `halted`, call
  // resume, and race the still-running HTTP stop request.
  input.captain.cancel({ kind: 'user' }, { keepInbox: true })
  await stopTeamMemberActivations(input.ctx, input.captain, halted.members, input.signal)
  // Interrupting a child emits a trailing subagent-settled notification. That
  // notification can start a fresh Captain turn after the first cancellation,
  // so close the stop boundary again once every child activation has drained.
  // Queued user input is preserved both times; only runtime-generated work is
  // prevented from silently resuming the halted team.
  input.captain.cancel({ kind: 'user' }, { keepInbox: true })
  return {
    teamName: halted.teamName,
    cancelledTasks: halted.cancelledTasks,
    alreadyHalted: halted.alreadyHalted,
  }
}

/** Web approval has no tool result in the captain's conversation. */
export function stagedPlanApprovedContext(teamName: string): string {
  return [
    `The user approved the staged AgentTeams plan "${teamName}" from the pre-run review UI.`,
    'Approval has committed; the scheduler owns dispatch of the approved team. Do not approve again, recreate the roster, or send messages merely to start assigned tasks.',
    'Acknowledge the approval and handle any reports or user work already pending. Yield only when waiting for members is the remaining action. Their reports will wake you automatically; do not busy-poll status or keep a turn running just to wait.',
    'On a report, inspect the result and coordinate the next necessary action. If work has since been halted, respect that state and resume only on an explicit user request.',
  ].join('\n')
}

/** Context queued after the human rejects a staged plan. */
export function stagedPlanDiscardContext(teamName: string): string {
  return [
    `The user discarded the staged AgentTeams plan "${teamName}" from the pre-run review UI.`,
    'That decision is final for this draft: it has been archived, no members were created, and no tasks may run.',
    'Do not call agent_teams_create, agent_teams_approve, or recreate a replacement team merely because the old team is no longer active.',
    'Wait for a later explicit user request. If the next user message is unrelated to AgentTeams, answer it normally and do not start a team.',
  ].join('\n')
}

/** Model-facing continuation that turns the review UI back into a conversation. */
export function stagedPlanFeedbackContext(teamName: string): string {
  return [
    `The user selected "Return to chat and revise" for the staged AgentTeams plan "${teamName}".`,
    'The existing staged plan is still the only draft. Do not create a replacement team, approve it, spawn members, edit the plan, or start work in this turn.',
    'Ask the user one concise, concrete question about what they want changed, then stop and wait for their answer.',
    'After the user answers, revise this same staged roster and DAG with one atomic agent_teams_edit_plan call, summarize the changes, and ask the user to review the updated plan again.',
  ].join('\n')
}

/**
 * Register every `agent_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 */
export function registerAgentTeamsTools(ctx: Context, config: ToolsConfig): AgentTeamsRuntime {
  installRetiredMemberGuard(ctx, config.stateDir)
  installMemberDelegationGuard(ctx, config.stateDir, config.memberMaxDepth ?? 0)
  installMailboxAdmission(ctx, config.stateDir)
  const scheduler = installTeamScheduler(ctx, {
    stateDir: config.stateDir,
    executionPrompt: config.executionPrompt,
    dispatch: dispatchMember,
    // WP11 phase 2: the sweep walks every workspace the host knows; without the
    // injected provider it falls back to the calling captain's workspace.
    ...config.workspaces === undefined ? {} : { workspaces: config.workspaces },
    // The per-team fuse defaults to the roster cap, so an existing team is never
    // throttled by a default nobody asked for (WP11 phase 2).
    maxWorkersPerTeam: config.maxWorkersPerTeam ?? config.maxMembers,
    ...config.maxConcurrentWorkersGlobal === undefined ? {} : { maxConcurrentWorkersGlobal: config.maxConcurrentWorkersGlobal },
  })
  const memberSelections = installMemberSelectionRuntime(ctx, config.stateDir, async (workspace, teamId, memberName) => {
    await scheduler.kickMember(workspace, teamId, memberName)
  })

  async function dispatchMember(captain: Agent, teamId: string, memberName: string, text: string, signal: AbortSignal, mode: 'queue' | 'steer', attemptId?: string): Promise<boolean> {
    const root = stateRootOf(workspaceOf(captain), config)
    // Record why a member never started. The scheduler treats a failed dispatch as
    // "not now" and retries, so without this the captain only ever sees an
    // unexplained `unspawned` member and no diagnostic reaches any surface.
    const recordSpawnError = async (reason: string): Promise<void> => {
      try {
        await withTeamLock(teamLockKey(root, teamId), async () => {
          const fresh = await requireFreshCaptainTeam(root, teamId, captain.id)
          const failed = fresh.members.find(item => item.name === memberName && item.status !== 'removed')
          if (failed === undefined || failed.id !== '') return
          failed.spawnError = reason
          await writeTeam(root, fresh)
        })
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: could not record the member start failure for ${memberName}: ${String(error)}`)
      }
    }
    let orphan: TeamMember | undefined
    try {
      return await withTeamLock(teamLockKey(root, teamId), async () => {
        const team = await readTeam(root, teamId)
        if (team?.captainSessionId !== captain.id || team.halted === true || team.phase === 'staged') return false
        const member = team.members.find(item => item.name === memberName && item.status !== 'removed')
        if (member === undefined || member.stopping === true || team.tasks.some(task => task.reassigning === true && task.assignee === memberName)) return false
        if (attemptId !== undefined && !team.tasks.some(task => task.attemptId === attemptId && task.assignee === memberName && (task.status === 'claimed' || task.status === 'in_progress'))) return false
        if (member.id !== '') return deliverToMember(ctx, captain, member.id, text, signal, mode)
        const selection = await resolveMemberLlmSelection(ctx, captain, {
          provider: member.provider, model: member.model, reasoningEffort: member.reasoningEffort, fallback: member.fallback,
        }, signal)
        await spawnMember(ctx, memberRuntime(config), memberSelections, selection, captain, team, member, config.stateDir, signal, text)
        orphan = { ...member }
        delete member.spawnError
        await writeTeam(root, team)
        orphan = undefined
        return true
      })
    } catch (error: unknown) {
      if (orphan !== undefined) {
        await recordRetiredMemberIds(root, [orphan.id])
        await stopTeamMemberActivations(ctx, captain, [orphan])
      }
      // The stack carries the failing frame; the message alone rarely does.
      let reason = String(error)
      if (error instanceof Error && typeof error.stack === 'string' && error.stack !== '') reason = error.stack
      ctx.logger.warn(`agent-teams: member dispatch failed for ${memberName}: ${String(error)}`)
      await recordSpawnError(reason)
      return false
    }
  }

  const updatePlanBatch = async (captain: Agent, teamId: string, mutations: readonly StagedPlanMutation[], signal?: AbortSignal, allowPendingEdits = false): Promise<TeamState> => {
    if (mutations.length === 0) throw new Error('at least one staged plan operation is required')
    const workspace = workspaceOf(captain)
    const stateRoot = stateRootOf(workspace, config)
    return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id)
      const staged = fresh.phase === 'staged'
      if (!staged && !allowPendingEdits) requireStagedTeam(fresh)
      if (fresh.halted === true) throw new Error('team is halted; resume before editing tasks')
      if (!staged && mutations.some(mutation => mutation.action !== 'update_task')) {
        throw new Error('a running team only permits update_task edits to pending, never-started tasks; roster and removal edits require a staged plan')
      }
      for (const mutation of mutations) {
        if (mutation.action === 'update_member') {
          const member = requireMember(fresh, mutation.memberName)
          if (member.id !== '') throw new Error(`staged member "${member.name}" was already spawned`)
          const selection = await resolveMemberLlmSelection(ctx, captain, {
            provider: mutation.provider,
            model: mutation.model,
            reasoningEffort: trimmedOptional(mutation.reasoningEffort),
            fallback: member.fallback,
          }, signal)
          member.role = trimmedOptional(mutation.role)
          member.provider = selection.provider
          member.model = selection.model
          member.reasoningEffort = selection.reasoningEffort
          member.executionPrompt = trimmedOptional(mutation.executionPrompt)
        } else if (mutation.action === 'update_task') {
          const task = requireTask(fresh, mutation.taskId)
          // WP2/S08: on a running team the captain may retarget a task that has
          // not started (`pending`, any attempt) and one that failed — retrying a
          // failed lane is the point. A task a member currently holds
          // (`claimed`/`in_progress`) is still off limits here: that edit needs
          // the explicit replan with attempt invalidation (WP4/S10).
          const editable = staged
            ? task.status === 'pending' && (task.attempt ?? 0) === 0
            : task.status === 'pending' || task.status === 'failed'
          if (!editable || task.reassigning === true) {
            throw new Error(`task "${task.id}" has already started and cannot be edited`)
          }
          if (!staged && mutation.assignee === CAPTAIN_KEY) throw new Error('use reassign_task for captain takeover')
          const subject = mutation.subject.trim()
          if (subject === '') throw new Error('task subject must not be empty')
          task.subject = subject
          task.description = trimmedOptional(mutation.description)
          task.assignee = trimmedOptional(mutation.assignee)
          task.dependencies = [...new Set(mutation.dependencies.map((item) => item.trim()).filter(Boolean))]
          task.updatedAt = Date.now()
        } else if (mutation.action === 'add_task') {
          const subject = mutation.subject.trim()
          if (subject === '') throw new Error('task subject must not be empty')
          fresh.taskSeq += 1
          const now = Date.now()
          fresh.tasks.push({
            id: `t${fresh.taskSeq}`,
            subject,
            description: trimmedOptional(mutation.description),
            status: 'pending',
            assignee: trimmedOptional(mutation.assignee),
            dependencies: [...new Set(mutation.dependencies.map((item) => item.trim()).filter(Boolean))],
            attempt: 0,
            kind: 'work',
            createdAt: now,
            updatedAt: now,
          })
        } else if (mutation.action === 'remove_task') {
          const task = requireTask(fresh, mutation.taskId)
          const dependent = fresh.tasks.find((candidate) => candidate.dependencies.includes(task.id))
          if (dependent !== undefined) {
            throw new Error(`task "${task.id}" is still required by "${dependent.id}"; update that dependency before removing the task`)
          }
          fresh.tasks = fresh.tasks.filter((candidate) => candidate.id !== task.id)
        } else {
          const member = requireMember(fresh, mutation.memberName)
          if (member.id !== '') throw new Error(`staged member "${member.name}" was already spawned`)
          const owned = fresh.tasks.filter((task) => task.assignee === member.name)
          if (owned.length > 0) {
            throw new Error(`member "${member.name}" still owns planned tasks: ${owned.map((task) => task.id).join(', ')}; update or remove those tasks first`)
          }
          fresh.members = fresh.members.filter((candidate) => candidate !== member)
        }
      }
      validateStagedGraph(fresh, false)
      if (!staged) {
        for (const mutation of mutations) {
          if (mutation.action !== 'update_task') continue
          const task = requireTask(fresh, mutation.taskId)
          const validation = validateCreateTask({ ...fresh, tasks: fresh.tasks.filter(item => item.id !== task.id) }, task)
          if (!validation.ok) throw new Error(validation.error ?? 'edited task violates the quality contract')
        }
      } else fresh.planReviewState = 'awaiting_review'
      signal?.throwIfAborted()
      revisePlan(fresh)
      await writeTeam(stateRoot, fresh)
      return fresh
    })
  }

  // Browser review controls retain their staged-only contract.
  const updateStagedPlanBatch: AgentTeamsRuntime['updateStagedPlanBatch'] = (captain, teamId, mutations, signal) => (
    updatePlanBatch(captain, teamId, mutations, signal)
  )

  /**
   * Revise a running plan (WP7/S17).
   *
   * One implementation for the model tool and the Web running-mode editor: the
   * batch is validated and written under the team lock, the plan-revised event
   * records the diff, a revoked attempt is stopped and told why, and the
   * scheduler is woken once for whatever became ready.
   */
  const replanLiveTeam: AgentTeamsRuntime['replanLiveTeam'] = async (captain, teamId, operations, reason, signal) => {
    const workspace = workspaceOf(captain)
    const stateRoot = stateRootOf(workspace, config)
    const team = await requireCaptainTeam(workspace, config, captain, teamId)
    if (operations.length === 0) throw new Error('at least one replan operation is required')

    const applied = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
      const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
      if (fresh.phase === 'staged') {
        throw new Error('this team is still staged; use agent_teams_edit_plan until the plan is approved')
      }
      if (fresh.halted === true) throw new Error('team is halted; resume before replanning')
      const { team: next, result } = replanTeam(fresh, operations, { reason })
      await writeTeam(stateRoot, next)
      return { next, result }
    })

    appendTeamEvent(ctx, captainSessionOf(ctx, applied.next.captainSessionId, captain.session), 'agent-teams/plan-revised', {
      teamId: applied.next.id,
      revision: applied.result.revision,
      reason,
      added: applied.result.added,
      removed: applied.result.removed,
      rebound: applied.result.rebound,
      invalidated: applied.result.invalidated,
    })

    // A revoked attempt has to stop being worked on before anything else is
    // dispatched, and the member has to learn why its lane moved: the durable
    // mailbox note is written first, then the activation is drained.
    for (const detail of applied.result.invalidationDetails) {
      const message = createMessage(
        CAPTAIN_KEY,
        detail.memberName,
        `task ${detail.taskId} replanned: ${reason}. Stop working on it; the captain owns the new plan.`,
      )
      await appendMailbox(stateRoot, applied.next.id, detail.memberName, message)
      const member = applied.next.members.find((candidate) => candidate.id === detail.memberId)
      if (member === undefined) continue
      await stopTeamMemberActivations(ctx, captain, [member], signal)
      // A live steer tells the member now; when it cannot be accepted the
      // durable mailbox note above is what it reads on its next turn.
      await dispatchMember(
        captain,
        applied.next.id,
        detail.memberName,
        mailboxPrompt(applied.next.id, detail.memberName, [message]),
        signal ?? new AbortController().signal,
        'steer',
      ).catch(() => false)
    }

    await scheduler.kickTeam(workspace, applied.next.id, captain)
    return {
      revision: applied.result.revision,
      applied: applied.result.changes.length,
      changes: applied.result.changes.map((change) => `${change.action} ${change.taskId}: ${change.detail}`),
      added: [...applied.result.added],
      removed: [...applied.result.removed],
      rebound: [...applied.result.rebound],
      invalidated: [...applied.result.invalidated],
    }
  }

  const updateStagedPlan: AgentTeamsRuntime['updateStagedPlan'] = async (captain, teamId, mutation, signal) => (
    updateStagedPlanBatch(captain, teamId, [mutation], signal)
  )

  const approveStagedTeam: AgentTeamsRuntime['approveStagedTeam'] = async (captain, teamId, signal) => {
    const workspace = workspaceOf(captain)
    const stateRoot = stateRootOf(workspace, config)
    const runSignal = signal ?? new AbortController().signal
    const approved = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id)
      requireStagedTeam(fresh)
      // A staged removal has no child session to retain in history. Drop those
      // placeholders before transitioning to the stricter running shape.
      fresh.members = fresh.members.filter((member) => member.status !== 'removed')
      validateStagedGraph(fresh, true)
      const selections = []
      for (const member of fresh.members) {
        const selection = await resolveMemberLlmSelection(ctx, captain, {
          provider: member.provider, model: member.model, reasoningEffort: member.reasoningEffort, fallback: member.fallback,
        }, runSignal)
        selections.push(selection)
        member.provider = selection.provider
        member.model = selection.model
        member.reasoningEffort = selection.reasoningEffort
      }
      await validateMemberLlmSelections(ctx, selections, runSignal)
      fresh.phase = 'running'
      delete fresh.planReviewState
      fresh.approvedAt = Date.now()
      await writeTeam(stateRoot, fresh)
      return { teamId: fresh.id, members: fresh.members.length, tasks: fresh.tasks.length }
    })
    try {
      await scheduler.kickTeam(workspace, teamId, captain)
    } catch (error: unknown) {
      // Approval is already durably committed. A transient wake-up failure is
      // recoverable by the next status/member lifecycle kick and must not make
      // the UI report that an already-running team failed to approve.
      ctx.logger.warn(`agent-teams: post-approval kick failed for "${teamId}": ${String(error)}`)
    }
    return approved
  }

  const continueStagedPlanning: AgentTeamsRuntime['continueStagedPlanning'] = async (captain, teamId) => {
    const workspace = workspaceOf(captain)
    const stateRoot = stateRootOf(workspace, config)
    const prepared = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id)
      requireStagedTeam(fresh)
      if (fresh.planReviewState === 'awaiting_feedback') {
        return { teamName: fresh.name, alreadyWaiting: true }
      }
      fresh.planReviewState = 'awaiting_feedback'
      await writeTeam(stateRoot, fresh)
      return { teamName: fresh.name, alreadyWaiting: false }
    })
    if (prepared.alreadyWaiting) return { teamId, alreadyWaiting: true }

    // End any planning turn that is still producing tool calls. A plugin
    // follow-up submitted after cancellation is queued as the next turn by the
    // Harness Agent contract, so it cannot race ahead and recreate the team.
    captain.cancel({ kind: 'user' }, { keepInbox: true })
    try {
      captain.followup(createUserMessage({
        content: [{ type: 'text', text: stagedPlanFeedbackContext(prepared.teamName) }],
        source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
      }))
    } catch (error: unknown) {
      // Do not leave the durable UI in a false waiting state when the live
      // Captain disappeared between lookup and delivery.
      await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id)
        requireStagedTeam(fresh)
        if (fresh.planReviewState === 'awaiting_feedback') {
          fresh.planReviewState = 'awaiting_review'
          await writeTeam(stateRoot, fresh)
        }
      })
      throw error
    }
    return { teamId, alreadyWaiting: false }
  }

  const discardStagedTeam: AgentTeamsRuntime['discardStagedTeam'] = async (captain, teamId) => {
    const workspace = workspaceOf(captain)
    const stateRoot = stateRootOf(workspace, config)
    const discarded = await withTeamLock(teamLockKey(stateRoot, teamId), async () => {
      const fresh = await requireFreshCaptainTeam(stateRoot, teamId, captain.id)
      requireStagedTeam(fresh)
      appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/plan-discarded', {
        teamId: fresh.id,
      })
      // A staged plan owns no child sessions. Archiving releases the captain
      // immediately while retaining the rejected graph for later inspection.
      await archiveTeamDir(stateRoot, fresh.id)
      return { teamId: fresh.id, teamName: fresh.name }
    })
    // Preserve this control fact for the next genuine user turn, then abort the
    // still-running Captain turn. Without both operations a late model step can
    // observe the missing active team and incorrectly create it again.
    try {
      captain.inject(createUserMessage({
        content: [{ type: 'text', text: stagedPlanDiscardContext(discarded.teamName) }],
        source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
      }))
    } catch (error: unknown) {
      // The archive is already authoritative. Cancellation still prevents a
      // late step from recreating work; failure to park extra context is only a
      // live-delivery warning and must not turn a successful discard into 409.
      ctx.logger.warn(`agent-teams: failed to inject discard context for "${discarded.teamId}": ${String(error)}`)
    }
    captain.cancel({ kind: 'user' }, { keepInbox: true })
    return { teamId: discarded.teamId }
  }

  const runtime: AgentTeamsRuntime = {
    isPendingMember: memberSelections.isPendingMember,
    updateStagedPlan,
    updateStagedPlanBatch,
    approveStagedTeam,
    continueStagedPlanning,
    discardStagedTeam,
    replanLiveTeam,
  }

  ctx.tools.register(defineTool({
    name: 'agent_teams_create',
    description: 'Create a team. Use approval=required for a two-phase plan: members and tasks remain unspawned/unclaimed until the user reviews the Web plan and explicitly approves it. Optional profiles expand their configured roster; seed profiles also expand template tasks, while captain profiles leave the graph for the Captain to design. approval=automatic preserves the legacy immediate-execution path. A captain may lead several teams at once, so this tool creates a new one only when the user explicitly asked for it: pass new_team=true in that case, and otherwise continue the team whose id you already have (agent_teams_status with no argument lists your teams).',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new team (used as its stable id).' },
      new_team: { type: 'boolean', description: 'Set when the user explicitly asked for a separate new team although you already lead one or more. Without it, a second create is refused and names the teams you lead.' },
      description: { type: 'string', description: 'Team purpose / the goal the team will work on.' },
      profile: { type: 'string', description: 'Optional configured profile name.' },
      plan: {
        type: 'object', additionalProperties: false,
        description: 'Optional complete ordinary-work roster and DAG in one atomic call, instead of separate add_member/create_task rounds. Mutually exclusive with profile. For quality gates use create_task with the explicit quality contract.',
        properties: {
          members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            name: { type: 'string', required: true }, role: { type: 'string' },
            provider: { type: 'string' }, model: { type: 'string' }, reasoning_effort: { type: 'string' },
          } } },
          tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true, description: 'Local reference used by dependencies in this plan; the result maps it to a durable task id.' },
            subject: { type: 'string', required: true }, description: { type: 'string' }, assignee: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
          } } },
        },
      },
      approval: {
        type: 'string',
        enum: ['required', 'automatic'],
        description: 'required stages the plan for explicit user review; automatic starts immediately. Defaults to automatic for API compatibility.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          state_dir: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          profile: { type: 'string' },
          task_planning: { type: 'string' },
          members: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { member_name: { type: 'string', required: true }, member_id: { type: 'string', required: true }, provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoning_effort: { type: 'string' }, status: { type: 'string', required: true } } } },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { task_id: { type: 'string', required: true }, seed_id: { type: 'string', required: true }, subject: { type: 'string', required: true }, status: { type: 'string', required: true }, kind: { type: 'string' }, assignee: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' }, required: true } } } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.phase === 'staged'
          ? `Team "${value.team_name}" plan created under ${value.state_dir}. It is staged: finish the roster and DAG, then wait for the user to edit and approve it. Do not start or approve it yourself.`
          : `Team "${value.team_name}" created (id ${value.team_id}) under ${value.state_dir}. You are the captain.`)
          + (value.tasks === undefined ? '' : '\n' + value.tasks.map(task => `${task.task_id} [${task.seed_id}]: ${task.subject}; assignee=${task.assignee ?? 'unassigned'}; dependencies=${task.dependencies.join(',')}`).join('\n')),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const teamName = args.name.trim()
      if (teamName === '') throw new Error('team name must not be empty')
      const teamId = sanitizeKey(teamName)
      const staged = args.approval === 'required'
      // Some models materialize optional parameters as "" instead of omitting
      // them (issue #99). The profile is optional, so treat a blank value
      // exactly like an omitted one instead of failing every create call.
      const profileName = args.profile !== undefined && args.profile.trim() !== ''
        ? args.profile.trim()
        : undefined
      if (profileName !== undefined && args.plan !== undefined) throw new Error('choose either a configured profile or an inline plan')
      const created = await withTeamLock(captainLockKey(stateRoot, captain.id), async () => {
        const participated = await findTeamsByParticipant(stateRoot, captain.id)
        // WP11 phase 1: "one team per captain" is gone — a captain may lead several
        // teams in one workspace, and each call addresses one by team_id. A member
        // session still must not create a team of its own, and a second team needs
        // the explicit `new_team` flag (an explicit user request, not a model mood).
        const memberTeam = participated.find((team) => team.captainSessionId !== captain.id)
        if (memberTeam !== undefined) {
          throw new Error(
            `you already belong to team "${memberTeam.name}" (id ${memberTeam.id}) as a member.`
            + ' Continue your assigned member work and report to your captain; do not create a separate team.',
          )
        }
        const owned = participated.filter((team) => team.captainSessionId === captain.id)
        if (owned.length > 0 && args.new_team !== true) {
          throw new Error(
            `you already lead ${String(owned.length)} team(s): ${describeTeamHandles(owned)}.`
            + ' Use agent_teams_status and continue the existing team.'
            + ' Do not delete and recreate it merely to continue work. Pass new_team=true only when'
            + ' the user explicitly asked for a separate new team.',
          )
        }
        // State-based guard (owner decision D6): a fuse on the workspace, not a
        // fixed count of teams. The configurable keys arrive with WP11 phase 3.
        const live = await listTeams(stateRoot)
        if (live.length >= MAX_TEAMS_PER_WORKSPACE) {
          throw new Error(
            `this workspace already has ${String(live.length)} live teams (limit ${String(MAX_TEAMS_PER_WORKSPACE)});`
            + ' archive one before creating another',
          )
        }
        const activeWorkers = live.reduce((total, team) => (
          total + team.members.filter((member) => member.status === 'working').length
        ), 0)
        if (activeWorkers >= MAX_CONCURRENT_WORKERS_GLOBAL) {
          throw new Error(
            `this workspace already runs ${String(activeWorkers)} active workers`
            + ` (limit ${String(MAX_CONCURRENT_WORKERS_GLOBAL)}); let some of them finish first`,
          )
        }
        return withTeamLock(teamLockKey(stateRoot, teamId), async () => {
          const existing = await readTeam(stateRoot, teamId)
          if (existing !== undefined) {
            throw new Error(`team id "${teamId}" is taken by another captain — pick a different team name`)
          }
          if (profileName === undefined && args.plan === undefined) {
            const state: TeamState = {
              name: teamName,
              id: teamId,
              description: args.description,
              captainSessionId: captain.id,
              createdAt: Date.now(),
              members: [],
              tasks: [],
              taskSeq: 0,
              // WP7: the plan record exists from creation, so any reader can
              // rely on a revision without a fallback branch of its own.
              plan: { revision: 1, updatedAt: Date.now(), ...args.description === undefined ? {} : { goal: args.description } },
              ...staged ? { phase: 'staged' as const, planReviewState: 'awaiting_review' as const } : {},
            }
            await createTeamDir(stateRoot, state)
            return { committed: true as const, state }
          }
          return initializeProfileTeam({
            ctx,
            config,
            memberSelections,
            captain,
            exec,
            stateRoot,
            teamName,
            teamId,
            profileName: profileName ?? 'inline-plan',
            inlinePlan: args.plan,
            description: args.description,
            staged,
          })
        })
      })
      if (created.committed) {
        try {
          await scheduler.kickTeam(workspace, created.state.id, captain)
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: post-create kick failed for "${created.state.id}": ${String(error)}`)
        }
        try {
          appendTeamEvent(ctx, captain.session, 'agent-teams/team-created', {
            teamId: created.state.id,
            captainSessionId: captain.id,
            name: created.state.name,
            ...created.state.description !== undefined ? { description: created.state.description } : {},
            ...created.state.profile?.name === undefined ? {} : { profile: created.state.profile.name },
          })
          for (const member of created.state.members) {
            appendTeamEvent(ctx, captain.session, 'agent-teams/member-added', {
              teamId: created.state.id,
              memberId: member.id,
              name: member.name,
              ...member.role === undefined ? {} : { role: member.role },
            })
          }
          for (const task of created.state.tasks) {
            appendTeamEvent(ctx, captain.session, 'agent-teams/task-created', {
              teamId: created.state.id,
              taskId: task.id,
              subject: task.subject,
              dependencies: task.dependencies,
              ...task.assignee === undefined ? {} : { assignee: task.assignee },
            })
          }
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: post-create events failed for "${created.state.id}": ${String(error)}`)
        }
      }
      const persisted = await readTeam(stateRoot, created.state.id).catch(() => undefined)
      const snapshot = persisted ?? created.state
      if (snapshot.profile === undefined && args.plan === undefined) {
        return {
          team_id: snapshot.id,
          team_name: snapshot.name,
          state_dir: join(stateRoot, snapshot.id),
          phase: snapshot.phase ?? 'running',
        }
      }
      return {
        team_id: snapshot.id,
        team_name: snapshot.name,
        state_dir: join(stateRoot, snapshot.id),
        phase: snapshot.phase ?? 'running',
        ...snapshot.profile === undefined ? {} : { profile: snapshot.profile.name },
        task_planning: snapshot.profile?.taskPlanning ?? 'seed',
        members: snapshot.members.map((member) => ({
          member_name: member.name,
          member_id: member.id,
          provider: member.provider ?? '',
          model: member.model ?? '',
          ...member.reasoningEffort === undefined ? {} : { reasoning_effort: member.reasoningEffort },
          status: member.status,
        })),
        tasks: snapshot.tasks.map((task) => ({
          task_id: task.id,
          seed_id: task.profileSeedId ?? '',
          subject: task.subject,
          status: task.status,
          ...task.kind === undefined ? {} : { kind: task.kind },
          ...task.assignee === undefined ? {} : { assignee: task.assignee },
          dependencies: task.dependencies,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_edit_plan',
    description: 'Atomically revise an AgentTeams plan. While staged, edit tasks and roster without starting work. While running, only update_task is allowed, and only for pending tasks with no prior attempt: correct dependencies, assignees or descriptions before they start; newly ready work is scheduled after commit. Never edit active/finished attempts. Submit dependent edits in order. Never modify .agent-teams files directly.',
    parameters: {
      team_id: teamIdParam(),
      operations: {
        type: 'array',
        required: true,
        description: 'One atomic, ordered batch. Running teams allow only update_task for never-started pending tasks. If any operation is invalid, none of the edits are saved.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              required: true,
              enum: ['update_member', 'update_task', 'add_task', 'remove_task', 'remove_member'],
            },
            member_name: { type: 'string', description: 'Member name for update_member or remove_member.' },
            task_id: { type: 'string', description: 'Task id for update_task or remove_task.' },
            subject: { type: 'string', description: 'Required for add_task; optional replacement for update_task.' },
            description: { type: 'string', description: 'Optional task description.' },
            assignee: { type: 'string', description: 'Optional task assignee; an empty string moves it to the shared pool.' },
            dependencies: { type: 'array', items: { type: 'string' }, description: 'Complete replacement dependency list for a task.' },
            role: { type: 'string', description: 'Optional member role.' },
            provider: { type: 'string', description: 'Optional member provider; defaults to the current staged route.' },
            model: { type: 'string', description: 'Optional member model; defaults to the current staged route.' },
            reasoning_effort: { type: 'string', description: 'Optional member reasoning effort.' },
            execution_prompt: { type: 'string', description: 'Optional member-specific execution prompt.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          team_id: { type: 'string', required: true },
          members: { type: 'number', required: true },
          tasks: { type: 'number', required: true },
          dependencies: { type: 'number', required: true },
          roster: { type: 'array', items: { type: 'string' }, required: true },
          graph: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.status === 'staged' ? 'Staged plan' : 'Pending task graph'} updated atomically (${value.members} members, ${value.tasks} tasks, ${value.dependencies} dependencies). ${value.status === 'staged' ? 'No members were spawned and no tasks were scheduled.' : 'The scheduler will dispatch any newly ready work.'}\n${value.graph.join('\n')}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      if (args.operations.length === 0) throw new Error('at least one staged plan operation is required')

      const mutations: StagedPlanMutation[] = args.operations.map((operation, index) => {
        const label = `operation ${index + 1} (${operation.action})`
        if (operation.action === 'update_member') {
          const memberName = operation.member_name?.trim() ?? ''
          if (memberName === '') throw new Error(`${label} requires member_name`)
          const member = requireMember(team, memberName)
          return {
            action: 'update_member',
            memberName,
            role: operation.role ?? member.role,
            provider: operation.provider?.trim() || member.provider || '',
            model: operation.model?.trim() || member.model || '',
            reasoningEffort: operation.reasoning_effort ?? member.reasoningEffort,
            executionPrompt: operation.execution_prompt ?? member.executionPrompt,
          }
        }
        if (operation.action === 'update_task') {
          const taskId = operation.task_id?.trim() ?? ''
          if (taskId === '') throw new Error(`${label} requires task_id`)
          const task = requireTask(team, taskId)
          return {
            action: 'update_task',
            taskId,
            subject: operation.subject ?? task.subject,
            description: operation.description ?? task.description,
            assignee: operation.assignee ?? task.assignee,
            dependencies: operation.dependencies ?? task.dependencies,
          }
        }
        if (operation.action === 'add_task') {
          const subject = operation.subject?.trim() ?? ''
          if (subject === '') throw new Error(`${label} requires a non-empty subject`)
          return {
            action: 'add_task',
            subject,
            description: operation.description,
            assignee: operation.assignee,
            dependencies: operation.dependencies ?? [],
          }
        }
        if (operation.action === 'remove_task') {
          const taskId = operation.task_id?.trim() ?? ''
          if (taskId === '') throw new Error(`${label} requires task_id`)
          return { action: 'remove_task', taskId }
        }
        const memberName = operation.member_name?.trim() ?? ''
        if (memberName === '') throw new Error(`${label} requires member_name`)
        return { action: 'remove_member', memberName }
      })
      const updated = await updatePlanBatch(captain, team.id, mutations, exec.signal, true)
      if (updated.phase !== 'staged') await scheduler.kickTeam(workspace, team.id, captain)
      return {
        status: updated.phase ?? 'running',
        team_id: updated.id,
        members: updated.members.length,
        tasks: updated.tasks.length,
        dependencies: updated.tasks.reduce((sum, task) => sum + task.dependencies.length, 0),
        roster: updated.members.map((member) => `${member.name} (${member.role || 'member'}; ${member.provider ?? ''}/${member.model ?? ''})`),
        graph: updated.tasks.map((task) => `${task.id}: ${task.subject} -> ${task.assignee || 'shared'}${task.dependencies.length === 0 ? '' : `; depends on ${task.dependencies.join(', ')}`}`),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_replan',
    description: 'Captain-only atomic replan of a RUNNING team: repair the plan instead of cancelling and re-creating it. One batch, one reason, validated as a whole under the team lock — if any operation is invalid, nothing is written. Operations: add_task (full create_task contract fields), update_task (subject/description/assignee/dependencies of a pending or failed task; a task a member currently holds needs invalidate=true, which revokes the attempt, stops that member and leaves a mailbox note), supersede_task (replace a failed or abandoned lane with an existing replacement_task_id or one created in the same call), cancel_task, accept_paths (settle a task held in awaiting_scope_review), amend_task (rewrite a wrong contract; force=true overrides a post-review freeze), move_phase (put a task in a declared phase; pass a title to declare a new one). Prefer this over cancel + create: a replan keeps members, satisfied dependencies and their context.',
    parameters: {
      team_id: teamIdParam(),
      reason: { type: 'string', required: true, description: 'Why the plan is being revised; recorded on the event and used as the default reason of every operation.' },
      operations: {
        type: 'array',
        required: true,
        description: 'The batch, in the order it must apply. Every operation is validated against the result of the previous one, and the whole batch is refused if any step is invalid.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              required: true,
              enum: ['add_task', 'update_task', 'supersede_task', 'cancel_task', 'accept_paths', 'amend_task', 'move_phase'],
            },
            task_id: { type: 'string', description: 'Target task for every action except add_task.' },
            subject: { type: 'string', description: 'add_task: the new task title. update_task: replacement title. supersede_task: the replacement title when the replacement is created inline.' },
            description: { type: 'string', description: 'Optional description (an empty value clears it on update_task/amend_task).' },
            assignee: { type: 'string', description: 'Active member name; an empty string moves the task to the shared pool.' },
            dependencies: { type: 'array', items: { type: 'string' }, description: 'Complete replacement dependency list.' },
            kind: { type: 'string', enum: ['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration'], description: 'Task kind for add_task or an inline replacement.' },
            round: { type: 'number', description: '1-based review/repair round for add_task or an inline replacement.' },
            objective: { type: 'string', description: 'Contract objective (add_task, or the amended field of amend_task).' },
            inScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths the task may change.' },
            outOfScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths the task must not change.' },
            acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria (full list on amend_task).' },
            verify: { type: 'array', items: { type: 'string' }, description: 'Verification commands (full list on amend_task).' },
            deliverables: { type: 'array', items: { type: 'string' }, description: 'Expected deliverable paths or names.' },
            nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicit non-goals.' },
            reviewedTaskId: { type: 'string', description: 'review/repair source task; must exist and be an implementation, repair, verification or integration task.' },
            sourceTaskId: { type: 'string', description: 'Repair source implementation/artifact.' },
            sourceFindingIds: { type: 'array', items: { type: 'string' }, description: 'Finding ids a repair must close.' },
            coverageOf: { type: 'array', items: { type: 'string' }, description: 'User-constraint / goal items this task covers.' },
            replacement_task_id: { type: 'string', description: 'supersede_task: an existing task to promote instead of creating one inline.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'accept_paths: workspace-relative paths to ADD to inScope.' },
            phase_id: { type: 'string', description: 'move_phase / add_task: the phase to place the task in (an empty string removes it from every phase).' },
            title: { type: 'string', description: 'move_phase / add_task: title for a phase that does not exist yet.' },
            reason: { type: 'string', description: 'Per-operation reason; the batch reason is the default.' },
            force: { type: 'boolean', description: 'amend_task / accept_paths: override the freeze a passing review verdict put on the contract (the verdict becomes stale).' },
            invalidate: { type: 'boolean', description: 'Required to rewrite, cancel or replace a task a member currently holds: revokes the attempt, stops that member and leaves a mailbox note explaining the replan.' },
            retry: { type: 'boolean', description: 'update_task: put a failed (or scope-held) task back in the queue after its contract was repaired, instead of replacing the lane.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revision: { type: 'number', required: true },
          applied: { type: 'number', required: true },
          changes: { type: 'array', items: { type: 'string' }, required: true },
          added: { type: 'array', items: { type: 'string' }, required: true },
          removed: { type: 'array', items: { type: 'string' }, required: true },
          rebound: { type: 'array', items: { type: 'string' }, required: true },
          invalidated: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Plan revised to revision ${String(value.revision)} (${String(value.applied)} operation(s)):`
          + `${value.added.length === 0 ? '' : ` added ${value.added.join(', ')};`}`
          + `${value.removed.length === 0 ? '' : ` replaced ${value.removed.join(', ')};`}`
          + `${value.rebound.length === 0 ? '' : ` rebound ${value.rebound.join(', ')};`}`
          + `${value.invalidated.length === 0 ? '' : ` revoked live attempts on ${value.invalidated.join(', ')};`}`
          + `\n${value.changes.join('\n')}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      return replanLiveTeam(captain, args.team_id ?? '', args.operations, args.reason, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_approve',
    description: 'Approve and start a staged team plan. Call this only in response to an explicit user approval in a new user turn; never call it during the turn that created or edited the plan. The Web Approve & Run button uses the same runtime directly.',
    parameters: {
      team_id: teamIdParam(),
      confirmation: { type: 'string', required: true, description: 'The user\'s explicit approval statement.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          team_id: { type: 'string', required: true },
          members: { type: 'number', required: true },
          tasks: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Team ${value.team_id} approved and running (${value.members} members, ${value.tasks} tasks).`,
      }],
    },
    async execute(args, exec) {
      if (args.confirmation.trim() === '') throw new Error('explicit user approval text is required')
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const approved = await approveStagedTeam(captain, team.id, exec.signal)
      return { status: 'running', team_id: approved.teamId, members: approved.members, tasks: approved.tasks }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_add_member',
    description: 'Add a member to the team roster. Planning and idle roster rows do not call a model. After approval, the member session starts with its first ready task or explicit message and remains durable for later work.',
    parameters: {
      team_id: teamIdParam(),
      name: { type: 'string', required: true, description: 'Unique member name inside the team.' },
      role: { type: 'string', description: 'Role of the member (e.g. researcher, engineer, reviewer).' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the configured memberModel default).' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort override: one of the target model\'s supported effort ids, or "default" to force its default. When omitted, the captain\'s effort is inherited only for the same provider/model; a changed route uses the target default.' },
      executionPrompt: { type: 'string', description: 'Optional member-specific execution prompt. It remains editable while staged.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          member_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string' },
          status: { type: 'string', required: true },
          phase: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.phase === 'staged'
          ? `Member "${value.member_name}" added to the staged roster (${value.provider}/${value.model}); no child was spawned.`
          : `Member "${value.member_name}" added (session ${value.member_id || 'starts with first ready task'}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const memberName = args.name.trim()
        if (memberName === '') throw new Error('member name must not be empty')
        const memberKey = sanitizeKey(memberName)
        if (memberKey === CAPTAIN_KEY) {
          throw new Error(`member name "${args.name}" is reserved for the captain`)
        }
        if (fresh.members.some((candidate) => sanitizeKey(candidate.name) === memberKey)) {
          throw new Error(`member name "${args.name}" has already been used in team "${fresh.name}"`)
        }
        if (fresh.members.filter((candidate) => candidate.status !== 'removed').length >= config.maxMembers) {
          throw new Error(`team "${fresh.name}" is at its member cap (${config.maxMembers})`)
        }
        const selection = await resolveMemberLlmSelection(ctx, captain, {
          provider: args.provider,
          model: args.model,
          defaultModel: config.memberModel,
          reasoningEffort: args.reasoning_effort,
          fallback: config.fallback,
        }, exec.signal)
        const member: TeamMember = {
          id: '',
          name: memberName,
          role: args.role,
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
          ...selection.fallback === undefined ? {} : { fallback: selection.fallback },
          executionPrompt: trimmedOptional(args.executionPrompt),
          joinedAt: Date.now(),
          status: 'idle',
        }
        await validateMemberLlmSelections(ctx, [selection], exec.signal)
        fresh.members.push(member)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/member-added', {
          teamId: fresh.id,
          memberId: member.id,
          name: member.name,
          ...member.role !== undefined ? { role: member.role } : {},
        })
        return {
          member_name: member.name,
          member_id: member.id,
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: selection.reasoningEffort },
          status: member.status,
          phase: fresh.phase ?? 'running',
        }
      })
      await scheduler.kickMember(workspace, team.id, created.member_name, captain)
      const latest = (await readTeam(stateRoot, team.id))?.members.find(member => member.name === created.member_name)
      return latest === undefined ? created : { ...created, member_id: latest.id, status: latest.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_remove_member',
    description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
    parameters: {
      team_id: teamIdParam(),
      name: { type: 'string', required: true, description: 'Name of the member to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requeued_tasks: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const member = fresh.members.find(item => item.name === args.name)
        if (member === undefined) throw new Error(`no member \"${args.name}\" in team \"${fresh.name}\"`)
        const requeued: string[] = []
        for (const task of fresh.tasks) {
          if (task.assignee !== member.name || task.status === 'completed') continue
          invalidateTaskAttempt(task)
          task.reassigning = false
          requeued.push(task.id)
        }
        member.status = 'removed'
        await discardMailboxMessages(stateRoot, fresh.id, member.name, (await readUnreadMailbox(stateRoot, fresh.id, member.name)).map(message => message.id))
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/member-removed', {
          teamId: fresh.id,
          memberId: member.id,
        })
        return { member: { ...member }, requeued }
      })
      if (revoked.member.id !== '') {
        await recordRetiredMemberIds(stateRoot, [revoked.member.id])
        await stopTeamMemberActivations(ctx, captain, [revoked.member], exec.signal)
      }
      await scheduler.kickTeam(workspace, team.id, captain)
      return {
        member_name: revoked.member.name,
        status: revoked.member.status,
        requeued_tasks: revoked.requeued,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_create_task',
    description: 'Create a task in your team\'s task list. Use kind=work (default) for research, repository audits and general tasks. kind=review is only a quality gate for an existing implementation/repair task via reviewedTaskId. Every call must include a non-empty subject, including verification and review tasks. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
    parameters: {
      team_id: teamIdParam(),
      subject: { type: 'string', required: true, description: 'Required non-empty title for this task. Never omit it, including for verification or review tasks.' },
      description: { type: 'string', description: 'What needs to be done, in detail.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task depends on (must be completed before this task can be claimed).',
      },
      assignee: { type: 'string', description: 'Member name when an owner is specified. Omission puts this task in the shared pool; roles, subjects and descriptions do not assign an owner.' },
      kind: {
        type: 'string',
        enum: ['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration'],
        description: 'Explicit task kind. Omission means work with no quality gates, even if the subject says implementation/review. Quality kinds require a contract. An implementation may be planned before requirements passes when its dependency chain includes that requirements task.',
      },
      round: { type: 'number', description: '1-based review / requirements / repair round.' },
      objective: { type: 'string', description: 'Required non-empty objective for quality kinds.' },
      inScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative POSIX paths this task may change.' },
      outOfScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative POSIX paths this task must not change.' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria. Required for quality kinds. A criterion may be a plain string ("must be green") or a {text, mode:"no_regression", baseline} object when the honest criterion is "no worse than the named baseline" rather than "green" — put the baseline in the criterion itself, not in the implementer\'s head.' },
      verify: { type: 'array', items: { type: 'string' }, description: 'Verification commands. Required for implementation/repair.' },
      deliverables: { type: 'array', items: { type: 'string' }, description: 'Expected deliverable paths or names.' },
      nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicit non-goals.' },
      reviewedTaskId: { type: 'string', description: 'Existing AgentTeams implementation/repair task id. Required for kind=review; an external repository audit is kind=work.' },
      sourceTaskId: { type: 'string', description: 'Source implementation/artifact. Required for kind=repair.' },
      sourceFindingIds: { type: 'array', items: { type: 'string' }, description: 'Finding ids this repair must close.' },
      coverageOf: { type: 'array', items: { type: 'string' }, description: 'User-constraint / goal items this task covers.' },
      phase: { type: 'string', description: 'Declared phase id to place this task in (`plan.phases`, from `taskPlanning.phases` or a replan `move_phase`). An unknown phase is refused; omit it for an unphased task.' },
      resume: { type: 'boolean', description: 'If true, clear halted in the same lock before creating the task.' },
      resumeReason: { type: 'string', description: 'Required non-empty reason when resume=true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          assignee: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}, kind ${value.kind}, ${value.assignee ? `assigned to ${value.assignee}` : 'unassigned shared pool'}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      // Some models materialize optional parameters as "" instead of omitting
      // them (issue #105). Normalize blank optional fields to omitted before
      // validation so a blank value can neither be rejected spuriously nor be
      // persisted into team.json, where it would brick the team on reload.
      const input = normalizeBlankOptionalTaskFields(args)
      const created = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        // Paths every implementation/repair lane of this team inherits from the
        // creating profile (WP4/S10): added to `inScope`, excluded from the
        // overlap comparison so siblings may both touch generated docs.
        const shared = fresh.profile?.sharedInScope
        const kindOfInput = (input.kind as TaskKind | undefined) ?? 'work'
        const inScope = shared === undefined || (kindOfInput !== 'implementation' && kindOfInput !== 'repair')
          ? input.inScope
          : [...new Set([...(input.inScope ?? []), ...shared])]
        const gate = validateCreateTask(fresh, {
          subject: input.subject,
          description: input.description,
          dependencies: input.dependencies,
          assignee: input.assignee,
          kind: input.kind as TaskKind | undefined,
          round: input.round,
          objective: input.objective,
          inScope,
          outOfScope: input.outOfScope,
          acceptance: input.acceptance,
          verify: input.verify,
          deliverables: input.deliverables,
          nonGoals: input.nonGoals,
          reviewedTaskId: input.reviewedTaskId,
          sourceTaskId: input.sourceTaskId,
          sourceFindingIds: input.sourceFindingIds,
          coverageOf: input.coverageOf,
          resume: input.resume,
          resumeReason: input.resumeReason,
          // The validator is pure and does not allocate ids; hand it the id this
          // task is about to take so the mirror overlap direction (an existing
          // open task already fenced behind this id) can be evaluated.
          nextTaskId: `t${fresh.taskSeq + 1}`,
          ...shared === undefined ? {} : { sharedInScope: shared },
        })
        if (!gate.ok) throw new Error(gate.error ?? 'create_task rejected by quality gates')
        if (fresh.halted === true) {
          const resumed = resumeTeamState(fresh, args.resumeReason ?? '')
          if (resumed.status !== 'resumed' || resumed.team === undefined) {
            throw new Error(resumed.error ?? 'team is halted; call agent_teams_resume or pass resume=true with resumeReason')
          }
          fresh.halted = false
          fresh.haltedAt = undefined
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-resumed', {
            teamId: fresh.id,
            reason: args.resumeReason ?? '',
          })
        }
        const dependencies = args.dependencies ?? []
        for (const dependency of dependencies) {
          if (!fresh.tasks.some((task) => task.id === dependency)) {
            throw new Error(`dependency "${dependency}" does not exist in team "${fresh.name}"`)
          }
        }
        if (args.assignee !== undefined) requireMember(fresh, args.assignee)
        const kind = gate.kind ?? 'work'
        const objective = kind === 'review' || kind === 'requirements'
          ? sanitizeReviewObjective(input.objective)
          : input.objective
        const acceptance = kind === 'review' || kind === 'requirements'
          ? sanitizeReviewAcceptance(input.acceptance)
          : input.acceptance
        const task: TeamTask = {
          id: `t${fresh.taskSeq + 1}`,
          subject: args.subject,
          description: args.description,
          status: 'pending',
          assignee: args.assignee,
          dependencies,
          attempt: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          kind,
          ...args.round === undefined ? {} : { round: args.round },
          ...objective === undefined ? {} : { objective },
          ...inScope === undefined ? {} : { inScope },
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
        fresh.taskSeq += 1
        fresh.tasks.push(task)
        // WP7/S17: a task added to a declared phase joins that phase.
        const phaseId = args.phase?.trim() ?? ''
        if (phaseId !== '') {
          const phases = fresh.plan?.phases ?? []
          const phase = phases.find((candidate) => candidate.id === phaseId)
          if (phase === undefined) {
            throw new Error(`unknown phase "${phaseId}"; declared phases: ${phases.map((candidate) => candidate.id).join(', ') || 'none'}`)
          }
          phase.taskIds.push(task.id)
        }
        revisePlan(fresh)
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/task-created', {
          teamId: fresh.id,
          taskId: task.id,
          subject: task.subject,
          dependencies: task.dependencies,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
          ...task.kind === undefined ? {} : { kind: task.kind },
          ...task.round === undefined ? {} : { round: task.round },
        })
        return {
          task_id: task.id,
          subject: task.subject,
          status: task.status,
          kind: taskKindOf(task),
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
        }
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_reassign_task',
    description: 'Atomically retry, reassign, or let the captain take over one ready unfinished/failed task. The old attempt is revoked before its member is interrupted, so late updates cannot overwrite the new owner. Use assignee="captain" only when you will finish that task in this turn; a captain can own only one unfinished takeover at a time, and an unfinished takeover returns to the member pool when the captain becomes idle.',
    parameters: {
      team_id: teamIdParam(),
      task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
      assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
      reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          previous_assignee: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const target = args.assignee.trim()
      if (target === '') throw new Error('reassignment assignee must not be empty')

      const revoked = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.status === 'completed') throw new Error(`completed task ${task.id} is immutable and cannot be reassigned`)
        if (task.reassigning === true) {
          const previousMember = fresh.members.find(member => member.id === task.handoffFromMemberId && member.stopping === true)
          if (task.assignee !== target || previousMember === undefined) throw new Error(`task ${task.id} is already being reassigned`)
          return { previousAssignee: previousMember.name, previousMember: { ...previousMember }, handoffId: task.handoffId }
        }
        const targetMember = target === CAPTAIN_KEY ? undefined : requireMember(fresh, target)
        if (target === CAPTAIN_KEY) {
          const busy = captainOpenTask(fresh, task.id)
          if (busy !== undefined) {
            throw new Error(`captain is busy with ${busy.id}; complete or reassign it before taking over ${task.id}`)
          }
          const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies)
          if (pending.length > 0) {
            throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them before captain takeover`)
          }
        } else if (targetMember !== undefined) {
          const busy = memberOpenTask(fresh, targetMember.name, task.id)
          if (busy !== undefined) {
            throw new Error(`member "${targetMember.name}" is busy with ${busy.id}; finish or reassign it first`)
          }
        }
        const previousAssignee = task.assignee ?? ''
        const previousMember = (task.status !== 'claimed' && task.status !== 'in_progress')
          || task.assignee === undefined || task.assignee === CAPTAIN_KEY
          ? undefined
          : fresh.members.find(member => member.name === task.assignee && member.status !== 'removed')
        invalidateTaskAttempt(task, target, true)
        if (previousMember !== undefined) {
          previousMember.stopping = true
          task.handoffFromMemberId = previousMember.id
          await discardMailboxMessages(stateRoot, fresh.id, previousMember.name, (await readUnreadMailbox(stateRoot, fresh.id, previousMember.name)).map(message => message.id))
        }
        await writeTeam(stateRoot, fresh)
        return {
          previousAssignee,
          previousMember: previousMember === undefined ? undefined : { ...previousMember },
          handoffId: task.handoffId,
        }
      })

      let quiescenceError: unknown
      if (revoked.previousMember !== undefined) {
        try {
          await stopTeamMemberActivations(ctx, captain, [revoked.previousMember], exec.signal)
        } catch (error: unknown) {
          quiescenceError = error
        }
      }

      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        if (task.handoffId !== revoked.handoffId || task.assignee !== target || task.reassigning !== true) {
          throw new Error(`task ${task.id} changed during reassignment; refusing to overwrite the newer state`)
        }
        task.reassigning = quiescenceError !== undefined
        if (quiescenceError === undefined) {
          const previous = fresh.members.find(member => member.id === revoked.previousMember?.id)
          if (previous !== undefined) delete previous.stopping
          delete task.handoffFromMemberId
        }
        if (quiescenceError === undefined && target === CAPTAIN_KEY) {
          beginTaskAttempt(task, CAPTAIN_KEY)
          // The captain is already in the turn that requested takeover; there
          // is no later member claim handshake to move claimed -> in_progress.
          task.status = 'in_progress'
          task.updatedAt = Date.now()
        }
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captain.session, 'agent-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
          ...args.reason === undefined ? {} : { output: `Reassigned: ${args.reason}` },
        })
      })
      if (quiescenceError !== undefined) throw quiescenceError
      if (target !== CAPTAIN_KEY) await scheduler.kickMember(workspace, team.id, target, captain)
      const current = await readTeam(stateRoot, team.id)
      const task = current === undefined ? undefined : requireTask(current, args.task_id)
      if (task === undefined) throw new Error(`team "${team.name}" ended during reassignment`)
      return {
        task_id: task.id,
        previous_assignee: revoked.previousAssignee,
        assignee: task.assignee ?? '',
        status: task.status,
        attempt: task.attempt ?? 0,
        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_supersede_task',
    description: 'Captain-only atomic replacement of one task that will not finish (failed, abandoned, or pointed at the wrong contract). The replaced task becomes `superseded` with a link to its replacement, its capability and changedPaths are dropped, every non-terminal dependent now depends on the replacement, and every non-terminal review/repair contract that pointed at it is retargeted. The replacement is either an existing task id (`replacement`) or a task created in the same call from the create_task fields (subject required); an inline replacement inherits kind, round, sourceTaskId, coverageOf and, by default, the replaced task\'s dependencies. A completed task cannot be superseded, and a replacement that depends on the task it replaces is refused (dependency cycle).',
    parameters: {
      team_id: teamIdParam(),
      task_id: { type: 'string', required: true, description: 'The task to replace.' },
      reason: { type: 'string', required: true, description: 'Why the lane is being replaced; recorded in the event and the result.' },
      replacement: { type: 'string', description: 'Id of an existing task that replaces this one. Omit to create the replacement in this same call from the fields below.' },
      subject: { type: 'string', description: 'Title of the inline replacement (required when `replacement` is omitted).' },
      description: { type: 'string', description: 'What the replacement has to do, in detail.' },
      assignee: { type: 'string', description: 'Member name for the inline replacement; omission puts it in the shared pool.' },
      kind: { type: 'string', enum: ['work', 'requirements', 'implementation', 'verification', 'review', 'repair', 'integration'], description: 'Kind of the inline replacement; inherits the replaced task\'s kind when omitted.' },
      round: { type: 'number', description: '1-based review / requirements / repair round for the inline replacement.' },
      objective: { type: 'string', description: 'Objective of the inline replacement (required for quality kinds).' },
      inScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative POSIX paths the replacement may change.' },
      outOfScope: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative POSIX paths the replacement must not change.' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria of the inline replacement.' },
      verify: { type: 'array', items: { type: 'string' }, description: 'Verification commands of the inline replacement.' },
      deliverables: { type: 'array', items: { type: 'string' }, description: 'Expected deliverables of the inline replacement.' },
      nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicit non-goals of the inline replacement.' },
      reviewedTaskId: { type: 'string', description: 'Reviewed source task for an inline review/repair replacement.' },
      sourceTaskId: { type: 'string', description: 'Source implementation/artifact for an inline repair replacement.' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Dependencies of the inline replacement; defaults to the replaced task\'s dependencies.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          superseded_by: { type: 'string', required: true },
          replacement_status: { type: 'string', required: true },
          rewired: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} is now ${value.status}, replaced by ${value.superseded_by} (status ${value.replacement_status}).`
          + (value.rewired === '' ? '' : ` Redirected: ${value.rewired}.`),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const inline = normalizeBlankOptionalTaskFields(args)
      const result = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const replaced = requireTask(fresh, args.task_id)
        const explicitReplacement = trimmedOptional(args.replacement)
        if (explicitReplacement !== undefined && explicitReplacement === replaced.id) {
          throw new Error(`task ${replaced.id} cannot replace itself`)
        }
        if (explicitReplacement !== undefined && !fresh.tasks.some((task) => task.id === explicitReplacement)) {
          throw new Error(`replacement task "${explicitReplacement}" does not exist`)
        }
        const inlineSubject = trimmedOptional(args.subject)
        if (explicitReplacement === undefined && inlineSubject === undefined) {
          throw new Error('supersede_task needs either `replacement` (an existing task id) or a non-empty `subject` for the inline replacement')
        }
        const inheritedSource = trimmedOptional(args.sourceTaskId) ?? replaced.sourceTaskId
        const inheritedReview = trimmedOptional(args.reviewedTaskId) ?? replaced.reviewedTaskId
        const dependencies = (args.dependencies ?? replaced.dependencies).filter((id: string) => id !== replaced.id)
        let replacementId = explicitReplacement
        if (replacementId === undefined && inlineSubject !== undefined) {
          const kind = args.kind ?? taskKindOf(replaced)
          const gate = validateCreateTask(fresh, {
            subject: inlineSubject,
            description: inline.description,
            assignee: inline.assignee,
            dependencies,
            kind,
            round: args.round ?? replaced.round,
            objective: inline.objective,
            inScope: inline.inScope,
            outOfScope: inline.outOfScope,
            acceptance: inline.acceptance,
            verify: inline.verify,
            deliverables: inline.deliverables,
            nonGoals: inline.nonGoals,
            reviewedTaskId: inheritedReview,
            sourceTaskId: inheritedSource,
            sourceFindingIds: replaced.sourceFindingIds,
            coverageOf: replaced.coverageOf,
            nextTaskId: `t${fresh.taskSeq + 1}`,
          })
          if (!gate.ok) throw new Error(gate.error ?? 'the inline replacement was rejected by the quality gates')
          const created = `t${fresh.taskSeq + 1}`
          fresh.taskSeq += 1
          const now = Date.now()
          fresh.tasks.push({
            id: created,
            subject: inlineSubject,
            description: inline.description,
            status: 'pending',
            assignee: inline.assignee,
            dependencies,
            attempt: 0,
            createdAt: now,
            updatedAt: now,
            kind,
            ...(args.round ?? replaced.round) === undefined ? {} : { round: args.round ?? replaced.round },
            ...inline.objective === undefined ? {} : { objective: inline.objective },
            ...inline.inScope === undefined ? {} : { inScope: inline.inScope },
            ...inline.outOfScope === undefined ? {} : { outOfScope: inline.outOfScope },
            ...inline.acceptance === undefined ? {} : { acceptance: inline.acceptance },
            ...inline.verify === undefined ? {} : { verify: inline.verify },
            ...inline.deliverables === undefined ? {} : { deliverables: inline.deliverables },
            ...inline.nonGoals === undefined ? {} : { nonGoals: inline.nonGoals },
            ...inheritedReview === undefined ? {} : { reviewedTaskId: inheritedReview },
            ...inheritedSource === undefined ? {} : { sourceTaskId: inheritedSource },
            ...replaced.sourceFindingIds === undefined ? {} : { sourceFindingIds: replaced.sourceFindingIds },
            ...replaced.coverageOf === undefined ? {} : { coverageOf: replaced.coverageOf },
          })
          replacementId = created
        }
        if (replacementId === undefined) throw new Error('supersede_task could not resolve a replacement task')
        const applied = applySupersession(fresh, replaced.id, replacementId)
        if (!applied.ok || applied.touched === undefined) {
          throw new Error(applied.error ?? 'supersede_task was rejected')
        }
        await writeTeam(stateRoot, fresh)
        const replacement = requireTask(fresh, replacementId)
        return {
          taskId: replaced.id,
          supersededBy: replacementId,
          replacementStatus: replacement.status,
          rewired: applied.touched.filter((id) => id !== replaced.id),
          previousAssignee: applied.previousAssignee,
        }
      })
      // The replaced owner must stop: its capability is gone and its lane is not
      // coming back. Quiescence follows the reassign_task pattern, and the kick
      // afterwards lets the redirected descendants dispatch.
      const previousMember = result.previousAssignee === undefined
        ? undefined
        : (await readTeam(stateRoot, team.id))?.members.find((member) => member.name === result.previousAssignee && member.status !== 'removed')
      if (previousMember !== undefined) {
        try {
          await stopTeamMemberActivations(ctx, captain, [{ ...previousMember, stopping: true }], exec.signal)
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: superseded owner ${previousMember.name} did not settle: ${String(error)}`)
        }
      }
      appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, captain.session), 'agent-teams/task-superseded', {
        teamId: team.id,
        taskId: result.taskId,
        replacement: result.supersededBy,
        reason: args.reason,
        rewired: result.rewired,
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return {
        task_id: result.taskId,
        status: 'superseded',
        superseded_by: result.supersededBy,
        replacement_status: result.replacementStatus,
        rewired: result.rewired.join(', '),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_claim_task',
    description: 'Members claim their own ready task or read their existing attempt_id. Captains must use reassign_task to assign and wake a member; claim_task does not dispatch work. A member cannot own a second unfinished task. The returned attempt_id is required for updates and becomes stale after retry/reassignment.',
    parameters: {
      team_id: { type: 'string', description: 'Team id this call acts on. Optional for a single-team member (the plugin substitutes the only team the caller belongs to); required once the caller participates in more than one.' },
      task_id: { type: 'string', required: true, description: 'The task id to claim.' },
      assignee: { type: 'string', description: 'Deprecated: claim_task only supports a member claiming its own task. Captains must use reassign_task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
          task_details: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}, status ${value.status}).\n${value.task_details}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller, args.team_id)
      return withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const task = requireTask(fresh, args.task_id)
        if (task.reassigning === true) {
          throw new Error(`task ${task.id} is being reassigned; wait for the handoff to finish`)
        }
        let assignee = task.assignee
        if (identity.kind === 'captain') {
          // A captain may read the capability of its already-started takeover,
          // but must never create a member claim without dispatching it (#125).
          if (args.assignee !== undefined || task.assignee !== CAPTAIN_KEY
              || (task.status !== 'claimed' && task.status !== 'in_progress')) {
            throw new Error('claim_task is for members claiming their own task; captains must use agent_teams_reassign_task to assign and wake a member')
          }
        } else {
          if (args.assignee !== undefined) {
            throw new Error('members cannot set assignee when claiming a task')
          }
          if (assignee !== undefined && assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${assignee}", not you`)
          }
          assignee = identity.name
        }
        // Authorization must happen before the idempotent return: another
        // member must not receive a false success for somebody else's task.
        if (task.status === 'claimed' || task.status === 'in_progress') {
          if (assignee === undefined || task.assignee !== assignee) {
            throw new Error(`task ${task.id} is already claimed by "${task.assignee ?? 'nobody'}"`)
          }
          return {
            task_details: taskDetails(fresh, task),
            task_id: task.id,
            status: task.status,
            assignee,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          }
        }
        const pending = unsatisfiedDependencies(fresh.tasks, task.dependencies)
        if (pending.length > 0) {
          throw new Error(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them first`)
        }
        const transition = transitionError(task.status, 'claimed')
        if (transition !== undefined) throw new Error(transition)
        if (assignee === undefined) {
          throw new Error('claiming an unassigned task needs an assignee (claim on behalf of a member)')
        }
        const busy = memberOpenTask(fresh, assignee, task.id)
        if (busy !== undefined) {
          throw new Error(`member "${assignee}" is busy with ${busy.id}; finish or reassign it first`)
        }
        const attemptId = beginTaskAttempt(task, assignee)
        // Tell the scheduler this capability is ours, so a concurrent kick
        // cannot treat the member's fresh attempt as a lost owner and re-claim
        // the task underneath it.
        scheduler.noteClaimedAttempt(
          fresh.members.find((candidate) => candidate.name === assignee)?.id ?? '',
          attemptId,
        )
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          assignee: task.assignee,
        })
        return {
          task_details: taskDetails(fresh, task),
          task_id: task.id,
          status: task.status,
          assignee: task.assignee ?? '',
          attempt: task.attempt ?? 0,
          attempt_id: attemptId,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_update_task',
    description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work. An acceptance criterion or verify command that cannot honestly be measured green — it is already red on the baseline for a reason outside this task, or no measurement exists — is reported as status="waived" with evidence naming the reason and the baseline; it counts as covered, but it flags the task and keeps Delivery blocked until a kind=review task completes with verdict=pass and an explicit waiverConfirmation. reviewPolicy.allowWaivers=false forbids waivers.',
    parameters: {
      team_id: { type: 'string', description: 'Team id this call acts on. Optional for a single-team member (the plugin substitutes the only team the caller belongs to); required once the caller participates in more than one.' },
      task_id: { type: 'string', required: true, description: 'The task id to update.' },
      attempt_id: { type: 'string', description: 'Members must explicitly include the current attempt_id from their assignment/claim in EVERY update, including failed reviews with findings. If omitted, retry with the same current id; omission does not revoke the attempt.' },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed', 'cancelled'],
        description: 'New status (in_progress, completed, failed, cancelled).',
      },
      output: { type: 'string', description: 'Result summary; set when completing or failing.' },
      verdict: {
        type: 'string',
        enum: ['pass', 'needs_revision', 'reject'],
        description: 'Required for completing requirements/review. needs_revision and reject must fail the task.',
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'blocker'], required: true },
            problem: { type: 'string', required: true },
            requiredFix: { type: 'string', required: true },
            file: { type: 'string' },
            line: { type: 'number' },
            resolved: { type: 'boolean' },
          },
        },
        description: 'Structured review findings. Required when verdict is needs_revision or reject; each item needs id, severity, problem, and requiredFix.',
      },
      changedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative POSIX paths changed by this implementation/repair.',
      },
      acceptanceResults: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterion: { type: 'string', required: true },
            status: { type: 'string', enum: ['passed', 'failed', 'waived'], required: true },
            evidence: { type: 'string' },
          },
        },
        description: 'Acceptance evidence in contract order: {criterion, status:"passed"|"failed"|"waived", evidence?}. Supply one item per acceptance criterion; criterion text is matched after whitespace/punctuation normalization, so state it as the task states it. "waived" means the criterion could not be measured honestly (it is red on HEAD for a reason outside this task, or no measurement exists); it requires non-empty evidence naming the reason, it flags the task so a reviewer must confirm the waiver, and reviewPolicy.allowWaivers=false forbids it entirely.',
      },
      commandsRun: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', required: true },
            status: { type: 'string', enum: ['passed', 'failed', 'waived'], required: true },
            exitCode: { type: 'number' },
            evidence: { type: 'string' },
          },
        },
        description: 'Verification evidence in contract order: {command, status:"passed"|"failed"|"waived", exitCode?, evidence?}. Supply one item per verify command. "waived" follows the same rule as a waived acceptance criterion: non-empty evidence, reviewer confirmation, and reviewPolicy.allowWaivers=false forbids it. A "failed" command still forces the task to fail.',
      },
      waiverConfirmation: {
        type: 'object',
        description: 'Review-only: confirm the waivers of the task this review judges (reviewedTaskId). Required before delivery when that task reported waived acceptance criteria or verify commands; a review that passes while waivers stay unconfirmed leaves delivery blocked with "<id> has unconfirmed waivers".',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true, description: 'The reviewed task whose waivers are being confirmed.' },
          reason: { type: 'string', required: true, description: 'Why the waivers are acceptable.' },
          waived: { type: 'array', items: { type: 'string' }, description: 'The waived criteria/commands being accepted.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          output: { type: 'string' },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller, args.team_id)
      const updated = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const task = requireTask(fresh, args.task_id)
        if (identity.kind === 'captain'
          && task.assignee !== undefined
          && task.assignee !== CAPTAIN_KEY
          && !(args.status === 'cancelled' && task.status === 'pending' && (task.attempt ?? 0) === 0 && task.reassigning !== true)) {
          throw new Error(`task ${task.id} is owned by member "${task.assignee}"; call agent_teams_reassign_task with assignee="captain" before takeover`)
        }
        if (identity.kind === 'member') {
          if (task.assignee !== identity.name) {
            throw new Error(`task ${task.id} is assigned to "${task.assignee ?? 'nobody'}", not you`)
          }
          if (task.attemptId !== undefined && (args.attempt_id === undefined || args.attempt_id.trim() === '')) {
            throw new Error(`missing attempt_id for task ${task.id}. Retry this update with attempt_id="${task.attemptId}" from your current assignment. This is a missing parameter, not a revoked attempt; do not restart the work or request reassignment.`)
          }
          // A capability the captain revoked (replan/reassign/halt) is not merely
          // "the current one changed": the task has no capability at all, so a
          // member still holding the old id must stop instead of starting a new
          // attempt on a lane that was just replanned underneath it (WP7/S17).
          if (task.attemptId === undefined && args.attempt_id !== undefined && args.attempt_id.trim() !== '') {
            throw new Error(`stale attempt for task ${task.id}: the current plan has no capability for it (it was replanned or revoked); stop work and wait for a fresh assignment`)
          }
          if (task.attemptId !== undefined && args.attempt_id !== task.attemptId) {
            throw new Error(`stale attempt for task ${task.id}: expected the current attempt_id; stop work and request fresh assignment`)
          }
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          const sameStatus = args.status === undefined || args.status === task.status
          const sameOutput = args.output === undefined || args.output === task.output
          if (!sameStatus || !sameOutput) {
            throw new Error(`terminal task ${task.id} is immutable; use agent_teams_reassign_task to retry failed/cancelled work`)
          }
          return {
            task_id: task.id,
            status: task.status,
            attempt: task.attempt ?? 0,
            ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
            ...task.output !== undefined ? { output: task.output } : {},
          }
        }
        // Blank optional list entries (e.g. changedPaths:[""]) must not be
        // persisted: hasValidQualityTaskFields rejects them on reload and
        // would brick the whole team state (issue #105 class).
        const input = normalizeBlankOptionalTaskFields(args)
        const findings = parseFindings(args.findings)
        // WP6.3: a check pinned in the known-delta registry supplies the evidence
        // for a `waived` result, so the lane does not have to invent a reason for a
        // check that is red for a reason outside its control.
        const acceptanceWithPins = applyPinnedDeltaEvidence(
          fresh.knownDeltas,
          parseAcceptanceResults(args.acceptanceResults, true),
          (item) => item.criterion,
          'acceptanceResults',
        )
        const commandsWithPins = applyPinnedDeltaEvidence(
          fresh.knownDeltas,
          parseCommandResults(args.commandsRun, true),
          (item) => item.command,
          'commandsRun',
        )
        const acceptanceResults = acceptanceWithPins
        const commandsRun = commandsWithPins
        const waiverConfirmation = parseWaiverConfirmation(args.waiverConfirmation)
        if (waiverConfirmation !== undefined && taskKindOf(task) !== 'review') {
          throw new Error('waiverConfirmation is review-only: only a kind=review task confirms the waivers of the task it judges')
        }
        if (waiverConfirmation !== undefined && task.reviewedTaskId !== waiverConfirmation.taskId) {
          throw new Error(`waiverConfirmation.taskId must be the task this review judges ("${task.reviewedTaskId ?? 'none'}"), not "${waiverConfirmation.taskId}"`)
        }
        const gate = evaluateQualityCompletion(task, {
          status: args.status,
          output: args.output,
          verdict: args.verdict as ReviewVerdict | undefined,
          findings,
          changedPaths: input.changedPaths,
          acceptanceResults,
          commandsRun,
        }, fresh.reviewPolicy?.allowWaivers !== false)
        if (!gate.ok && gate.scopeReview === undefined) throw new Error(gate.error ?? 'update_task rejected by quality gates')
        if (args.status !== undefined) {
          // WP4/S10: an honest report that touched a path outside inScope does
          // not fail the lane — the task is held in `awaiting_scope_review` until
          // the captain accepts the paths or reassigns/supersedes it.
          const requested = gate.scopeReview === undefined ? args.status : 'awaiting_scope_review'
          const transition = transitionError(task.status, requested)
          if (transition !== undefined) throw new Error(transition)
          task.status = requested
        }
        if (args.output !== undefined) task.output = args.output
        if (args.verdict !== undefined) task.verdict = args.verdict as ReviewVerdict
        if (findings !== undefined) task.findings = findings
        if (input.changedPaths !== undefined) task.changedPaths = input.changedPaths
        if (acceptanceResults !== undefined) task.acceptanceResults = acceptanceResults
        if (commandsRun !== undefined) task.commandsRun = commandsRun
        if (waiverConfirmation !== undefined) task.waiverConfirmation = waiverConfirmation
        // Track waived results on the task itself. The delivery gate re-derives
        // this from the results, so a stale flag can never hide a waiver; the
        // persisted field is what lets `status` and the panel show it.
        if (reportsWaiver(task.acceptanceResults) || reportsWaiver(task.commandsRun)) task.hasWaivers = true
        else delete task.hasWaivers
        task.updatedAt = Date.now()
        const followUp = (task.status === 'failed' && (task.verdict === 'needs_revision' || task.verdict === 'reject'))
          ? applyQualityFollowUp(fresh, task)
          : undefined
        if (followUp?.escalated === true) {
          await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, createMessage(
            CAPTAIN_KEY,
            CAPTAIN_KEY,
            `Quality-gate loop escalated after ${task.id} (${task.kind ?? 'review'} verdict=${task.verdict}). Automatic repair/review stopped.`,
          ))
        }
        await writeTeam(stateRoot, fresh)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-updated', {
          teamId: fresh.id,
          taskId: task.id,
          status: task.status,
          ...task.assignee !== undefined ? { assignee: task.assignee } : {},
          ...task.output !== undefined ? { output: task.output } : {},
          ...task.verdict === undefined ? {} : { verdict: task.verdict },
          ...task.round === undefined ? {} : { round: task.round },
        })
        for (const created of followUp?.created ?? []) {
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/task-created', {
            teamId: fresh.id,
            taskId: created.id,
            subject: created.subject,
            dependencies: created.dependencies,
            ...created.assignee === undefined ? {} : { assignee: created.assignee },
            ...created.kind === undefined ? {} : { kind: created.kind },
            ...created.round === undefined ? {} : { round: created.round },
          })
        }
        return {
          task_id: task.id,
          status: task.status,
          attempt: task.attempt ?? 0,
          ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
          ...task.output !== undefined ? { output: task.output } : {},
        }
      })
      await scheduler.kickTeam(workspace, team.id, team.captainSessionId === caller.id ? caller : undefined)
      return updated
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_pin_delta',
    description: 'Captain-only registry of checks that are red in this workspace for a reason outside the lane that runs them. Pin one entry per check (command or acceptance criterion text) once; afterwards a verification task whose commandsRun names that check may submit status="waived" without writing its own evidence — the plugin fills in "pinned delta <id>: <reason>". A duplicate pin for the same check is refused and names the existing entry, so the auto evidence can never be ambiguous or hide a stale pin. The registry is shown in agent_teams_status.',
    parameters: {
      team_id: teamIdParam(),
      id: { type: 'string', description: 'Stable delta id used by unpin_delta and in the auto evidence. Defaults to the check text.' },
      check: { type: 'string', required: true, description: 'The command or criterion text this delta explains, for example "pnpm run lint".' },
      expected: { type: 'string', required: true, description: 'What a green run would show, for example "exit 0".' },
      reason: { type: 'string', required: true, description: 'Why the check is red here; recorded as the waiver evidence.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delta_id: { type: 'string', required: true },
          check: { type: 'string', required: true },
          pinned: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Pinned known delta ${value.delta_id} for "${value.check}"; ${value.pinned} delta(s) on record.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const pinned = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const result = pinKnownDelta(fresh.knownDeltas, {
          ...args.id === undefined ? {} : { id: args.id },
          check: args.check,
          expected: args.expected,
          reason: args.reason,
          pinnedBy: CAPTAIN_KEY,
        })
        if (!result.ok || result.delta === undefined || result.deltas === undefined) {
          throw new Error(result.error ?? 'pin_delta rejected')
        }
        fresh.knownDeltas = [...result.deltas]
        await writeTeam(stateRoot, fresh)
        return { delta: result.delta, count: result.deltas.length }
      })
      appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, captain.session), 'agent-teams/delta-pinned', {
        teamId: team.id,
        deltaId: pinned.delta.id,
        check: pinned.delta.check,
        action: 'pinned',
        reason: pinned.delta.reason,
      })
      return { delta_id: pinned.delta.id, check: pinned.delta.check, pinned: pinned.count }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_unpin_delta',
    description: 'Captain-only: remove one entry from the known-delta registry by id. A check that is no longer red for an outside reason must be unpinned, otherwise a waived result citing it would look justified. The error names the pinned ids when the given one is unknown.',
    parameters: {
      team_id: teamIdParam(),
      id: { type: 'string', required: true, description: 'Delta id to remove.' },
      reason: { type: 'string', description: 'Why the delta no longer applies; recorded in the event.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delta_id: { type: 'string', required: true },
          check: { type: 'string', required: true },
          remaining: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Unpinned known delta ${value.delta_id} ("${value.check}"); ${value.remaining} delta(s) on record.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const unpinned = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const result = unpinKnownDelta(fresh.knownDeltas, args.id)
        if (!result.ok || result.delta === undefined || result.deltas === undefined) {
          throw new Error(result.error ?? 'unpin_delta rejected')
        }
        fresh.knownDeltas = result.deltas.length === 0 ? undefined : [...result.deltas]
        await writeTeam(stateRoot, fresh)
        return { delta: result.delta, count: result.deltas.length }
      })
      appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, captain.session), 'agent-teams/delta-pinned', {
        teamId: team.id,
        deltaId: unpinned.delta.id,
        check: unpinned.delta.check,
        action: 'unpinned',
        reason: args.reason ?? '',
      })
      return { delta_id: unpinned.delta.id, check: unpinned.delta.check, remaining: unpinned.count }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_accept_paths',
    description: 'Captain-only post-hoc scope acceptance: ADD the given workspace-relative paths to a task\'s inScope instead of replacing the list (use amend_task to replace). A worker that honestly reported a changed path outside its declared inScope leaves the task in `awaiting_scope_review`; accepting the paths completes the lane with the work it actually did. Works on a completed task too, as long as no review/requirements verdict has passed judgment on it — pass force=true with the same mandatory reason to widen the scope after that freeze. Every acceptance is appended to the task\'s revisions ledger.',
    parameters: {
      team_id: teamIdParam(),
      task_id: { type: 'string', required: true, description: 'Task whose inScope is widened.' },
      paths: { type: 'array', items: { type: 'string' }, required: true, description: 'Workspace-relative paths to add to inScope (additive, not a replacement).' },
      reason: { type: 'string', required: true, description: 'Why these paths belong to the lane; recorded in the revisions ledger.' },
      force: { type: 'boolean', description: 'Widen the scope even though a review/requirements verdict already passed judgment on this task. Requires the same non-empty reason.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          accepted_paths: { type: 'string', required: true },
          in_scope: { type: 'string', required: true },
          revision_count: { type: 'number', required: true },
          remaining: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} accepted paths ${value.accepted_paths}; status ${value.status}, ${value.revision_count} revision(s) on record.`
          + ` inScope: ${value.in_scope}.`
          + (value.remaining === '' ? '' : ` Still outside the contract: ${value.remaining}.`),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const accepted = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        const result = acceptTaskPaths(fresh, task, args.paths, CAPTAIN_KEY, args.reason, args.force === true)
        if (!result.ok || result.task === undefined) {
          throw new Error(result.error ?? 'accept_paths rejected by quality gates')
        }
        Object.assign(task, result.task)
        task.updatedAt = Date.now()
        // A task held for this decision completes as soon as the widened scope
        // covers everything the worker reported: the evidence is already on the
        // task, so the completion gate is re-evaluated instead of re-submitted.
        let remaining: string[] = []
        if (task.status === 'awaiting_scope_review') {
          const gate = evaluateQualityCompletion(task, { status: 'completed' }, fresh.reviewPolicy?.allowWaivers !== false)
          if (gate.ok) {
            const transition = transitionError(task.status, 'completed')
            if (transition !== undefined) throw new Error(transition)
            task.status = 'completed'
          } else if (gate.scopeReview !== undefined) {
            remaining = [...gate.scopeReview]
          } else {
            throw new Error(gate.error ?? 'the accepted scope still cannot complete the task')
          }
        }
        revisePlan(fresh)
        await writeTeam(stateRoot, fresh)
        return {
          taskId: task.id,
          status: task.status,
          accepted: args.paths,
          inScope: task.inScope ?? [],
          revisionCount: task.revisions?.length ?? 0,
          remaining,
        }
      })
      appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, captain.session), 'agent-teams/task-amended', {
        teamId: team.id,
        taskId: accepted.taskId,
        fields: ['inScope'],
        reason: args.reason,
      })
      await scheduler.kickTeam(workspace, team.id, captain)
      return {
        task_id: accepted.taskId,
        status: accepted.status,
        accepted_paths: accepted.accepted.join(', '),
        in_scope: JSON.stringify(accepted.inScope),
        revision_count: accepted.revisionCount,
        remaining: accepted.remaining.join(', '),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_amend_task',
    description: 'Captain-only controlled contract amendment for one task that is pending, claimed, in_progress or failed: replace a wrong objective/acceptance/verify/inScope/outOfScope/deliverables/nonGoals/reviewedTaskId when the original contract makes honest completion impossible (for example a verify command that cannot pass, or an inScope that forbids the file the objective names), and amend the subject/description/deliverables of a kind=work task. The amendment is appended to the task\'s revisions ledger with previous values and the reason, and is rejected once a review/requirements task has passed judgment on this task; pass force=true with the same mandatory reason to override that freeze, which marks the passing verdict stale so the changed contract must be reviewed again. A completed or cancelled task stays immutable. Members cannot amend contracts; the implementer re-reads the amended contract before its next quality gate. Lists are full replacements, not deltas.',
    parameters: {
      team_id: teamIdParam(),
      task_id: { type: 'string', required: true, description: 'Task whose contract is being amended.' },
      reason: { type: 'string', required: true, description: 'Why the current contract is wrong; recorded in the revisions ledger.' },
      force: { type: 'boolean', description: 'Override the freeze a passing review/requirements verdict put on this contract. The verdict becomes stale, so the amended contract has to be reviewed again. Requires the same non-empty reason.' },
      objective: { type: 'string', description: 'Replacement objective.' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'Replacement acceptance criteria (full list, not a delta).' },
      verify: { type: 'array', items: { type: 'string' }, description: 'Replacement verification commands (full list, not a delta).' },
      inScope: { type: 'array', items: { type: 'string' }, description: 'Replacement workspace-relative inScope paths (full list).' },
      outOfScope: { type: 'array', items: { type: 'string' }, description: 'Replacement workspace-relative outOfScope paths (full list).' },
      deliverables: { type: 'array', items: { type: 'string' }, description: 'Replacement expected deliverable paths or names (full list).' },
      nonGoals: { type: 'array', items: { type: 'string' }, description: 'Replacement explicit non-goals (full list).' },
      reviewedTaskId: { type: 'string', description: 'Replacement source task for a review/repair contract; it must exist and be an implementation, repair, verification or integration task.' },
      subject: { type: 'string', description: 'Replacement title; for a kind=work task this is the amendable brief.' },
      description: { type: 'string', description: 'Replacement description; for a kind=work task this is the amendable brief. An empty value clears it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          revised_fields: { type: 'string', required: true },
          revision_count: { type: 'number', required: true },
          staled_reviews: { type: 'string', required: true },
          contract: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} contract amended (${value.revised_fields}); ${value.revision_count} revision(s) on record, status ${value.status}. New contract: ${value.contract}`
          + (value.staled_reviews === '' ? '' : ` Staled reviews: ${value.staled_reviews}.`),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const amended = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const task = requireTask(fresh, args.task_id)
        const input: ContractAmendmentInput = {
          ...args.objective === undefined ? {} : { objective: args.objective },
          ...args.acceptance === undefined ? {} : { acceptance: args.acceptance },
          ...args.verify === undefined ? {} : { verify: args.verify },
          ...args.inScope === undefined ? {} : { inScope: args.inScope },
          ...args.outOfScope === undefined ? {} : { outOfScope: args.outOfScope },
          ...args.deliverables === undefined ? {} : { deliverables: args.deliverables },
          ...args.nonGoals === undefined ? {} : { nonGoals: args.nonGoals },
          ...args.reviewedTaskId === undefined ? {} : { reviewedTaskId: args.reviewedTaskId },
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
        }
        const result = amendTaskContract(fresh, task, normalizeBlankOptionalTaskFields(input), CAPTAIN_KEY, args.reason, args.force === true)
        if (!result.ok || result.task === undefined) {
          throw new Error(result.error ?? 'amend_task rejected by quality gates')
        }
        Object.assign(task, result.task)
        task.updatedAt = Date.now()
        // A forced amendment stales the verdict that judged the old contract:
        // delivery must not treat the changed contract as already reviewed.
        for (const review of result.invalidatedReviews ?? []) {
          const current = fresh.tasks.find((item) => item.id === review.id)
          if (current === undefined) continue
          current.verdict = review.verdict
          current.updatedAt = review.updatedAt
        }
        revisePlan(fresh)
        await writeTeam(stateRoot, fresh)
        return {
          taskId: task.id,
          status: task.status,
          fields: result.revision?.fields ?? [],
          revisionCount: task.revisions?.length ?? 0,
          staledReviews: (result.invalidatedReviews ?? []).map((review) => review.id),
          contract: {
            ...task.objective === undefined ? {} : { objective: task.objective },
            ...task.acceptance === undefined ? {} : { acceptance: task.acceptance },
            ...task.verify === undefined ? {} : { verify: task.verify },
            ...task.inScope === undefined ? {} : { inScope: task.inScope },
            ...task.outOfScope === undefined ? {} : { outOfScope: task.outOfScope },
            ...task.deliverables === undefined ? {} : { deliverables: task.deliverables },
            ...task.nonGoals === undefined ? {} : { nonGoals: task.nonGoals },
            ...task.reviewedTaskId === undefined ? {} : { reviewedTaskId: task.reviewedTaskId },
            ...taskKindOf(task) !== 'work' ? {} : { subject: task.subject, ...task.description === undefined ? {} : { description: task.description } },
          },
        }
      })
      appendTeamEvent(ctx, captainSessionOf(ctx, team.captainSessionId, captain.session), 'agent-teams/task-amended', {
        teamId: team.id,
        taskId: amended.taskId,
        fields: amended.fields,
        reason: args.reason,
        ...amended.staledReviews.length === 0 ? {} : { staledReviews: amended.staledReviews },
      })
      return {
        task_id: amended.taskId,
        status: amended.status,
        revised_fields: amended.fields.join(', '),
        revision_count: amended.revisionCount,
        staled_reviews: amended.staledReviews.join(', '),
        contract: JSON.stringify(amended.contract),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_send_message',
    description: 'Send coordination or current-task guidance directly to the captain or a teammate. A running recipient receives it at the next model step; an idle recipient wakes. Messages are durably retained until read. Use task creation/reassignment for a new unit of work, not repeated status nudges.',
    parameters: {
      team_id: { type: 'string', description: 'Team id this call acts on. Optional for a single-team member (the plugin substitutes the only team the caller belongs to); required once the caller participates in more than one.' },
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
      content: { type: 'string', required: true, description: 'The message text.' },
      from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireParticipantTeam(workspace, config, caller, args.team_id)
      const to = args.to.trim()
      const prepared = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const { team: fresh, identity } = await requireFreshParticipant(stateRoot, team.id, caller.id)
        const from = identity.name
        // `from` may only be the caller's own identity: impersonating another
        // member (or the captain) would poison the mailbox and event records.
        if (args.from !== undefined && args.from !== from) {
          throw new Error(`agent_teams_send_message: "from" must be your own identity ("${from}"), not "${args.from}"`)
        }
        if (to === CAPTAIN_KEY) {
          const message = { ...createMessage(from, CAPTAIN_KEY, args.content), deliveryClaimedAt: Date.now() }
          await appendMailbox(stateRoot, fresh.id, CAPTAIN_KEY, message)
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/message-sent', {
            teamId: fresh.id,
            messageId: message.id,
            from,
            to: CAPTAIN_KEY,
            content: args.content,
            ts: message.ts,
          })
          return { kind: 'captain' as const, fresh, identity, message, from }
        }
        if (fresh.halted === true) {
          throw new Error(`team "${fresh.name}" is halted; call agent_teams_resume before waking a member`)
        }
        const recipient = requireMember(fresh, to)
        const owned = memberOpenTask(fresh, recipient.name)
        const message = { ...createMessage(from, recipient.name, args.content), deliveryClaimedAt: Date.now(),
          ...owned?.attemptId === undefined ? {} : { taskId: owned.id, attemptId: owned.attemptId },
        }
        await appendMailbox(stateRoot, fresh.id, recipient.name, message)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, caller.session), 'agent-teams/message-sent', {
          teamId: fresh.id,
          messageId: message.id,
          from,
          to: recipient.name,
          content: args.content,
          ts: message.ts,
        })
        return { kind: 'member' as const, fresh, identity, message, from, recipient }
      })

      // Resolve the exact live captain only after releasing the state lock.
      // The plugin mailbox is already durable if live delivery cannot proceed.
      const captain = ctx.agents.get(prepared.fresh.captainSessionId as SessionId)
      if (prepared.kind === 'captain') {
        let delivered: 'live' | 'mailbox' = 'mailbox'
        if (captain !== undefined && prepared.identity.kind === 'member') {
          delivered = steerCaptainReport(captain, prepared.from, args.content, mailboxPrompt(prepared.fresh.id, CAPTAIN_KEY, [prepared.message])) ? 'live' : 'mailbox'
        }
        if (delivered === 'live') {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            markMailboxDelivered(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
          ))
        } else {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            releaseMailboxDelivery(stateRoot, prepared.fresh.id, CAPTAIN_KEY, [prepared.message.id])
          ))
        }
        return { message_id: prepared.message.id, from: prepared.from, to: CAPTAIN_KEY, delivered }
      }
      let delivered: 'wake' | 'mailbox' = 'mailbox'
      if (captain !== undefined) {
        const text = mailboxPrompt(prepared.fresh.id, prepared.recipient.name, [prepared.message])
        const accepted = await dispatchMember(captain, prepared.fresh.id, prepared.recipient.name, text, exec.signal, 'steer', prepared.message.attemptId)
        delivered = accepted ? 'wake' : 'mailbox'
        if (accepted) {
          await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
            markMailboxDelivered(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
          ))
        }
      }
      if (delivered === 'mailbox') {
        await withTeamLock(teamLockKey(stateRoot, prepared.fresh.id), () => (
          releaseMailboxDelivery(stateRoot, prepared.fresh.id, prepared.recipient.name, [prepared.message.id])
        ))
      }
      return {
        message_id: prepared.message.id,
        from: prepared.from,
        to: prepared.recipient.name,
        delivered,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_status',
    description: 'Team snapshot: members with live activity and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. Use after mailbox progress deliveries or for an explicit status request. After dispatch, end your turn while members work; do not repeatedly poll.',
    parameters: {
      team_id: { type: 'string', description: 'Team id to report on. Omit it to list every team the caller leads or belongs to.' },},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config)
      // WP11 phase 1: with no team_id the caller gets the roster of their teams
      // (that is how a captain reminds itself of an id); with one, the full
      // snapshot of that team. A single-team caller keeps the detailed answer it
      // has always received, so the member prompt does not change.
      const participated = await findTeamsByParticipant(stateRoot, caller.id)
      const requested = _args.team_id?.trim() ?? ''
      if (requested === '' && participated.length > 1) {
        return {
          teams: await Promise.all(participated.map(async (candidate) => {
            const snapshot = await readTeam(stateRoot, candidate.id) ?? candidate
            const done = snapshot.tasks.filter((task) => task.status === 'completed').length
            return {
              team_id: snapshot.id,
              name: snapshot.name,
              phase: snapshot.phase ?? 'running',
              halted: snapshot.halted === true,
              tasks: { total: snapshot.tasks.length, done },
              members: snapshot.members.filter((member) => member.status !== 'removed').length,
              activeWorkers: snapshot.members.filter((member) => member.status === 'working').length,
              role: snapshot.captainSessionId === caller.id ? 'captain' : 'member',
            }
          })),
          note: `you take part in ${String(participated.length)} teams; pass team_id to act on one of them`,
        }
      }
      const located = await requireParticipantTeam(workspace, config, caller, _args.team_id)
      if (located.captainSessionId === caller.id) {
        // WP11 phase 2: a captain who leads several teams gets a workspace-wide
        // sweep instead of a single-team kick, so a second team with ready work
        // is not left waiting for its own status call. The sweep still obeys the
        // per-team and global worker caps.
        if (participated.length > 1) await scheduler.sweepAll(caller)
        else await scheduler.kickTeam(workspace, located.id, caller)
      }
      const { team, identity } = await withTeamLock(
        teamLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = memberActivity(ctx, team.members.map((member) => member.id))
      const members = team.members
        .filter((member) => member.status !== 'removed')
        .map((member) => ({
          name: member.name,
          role: member.role ?? '',
          provider: member.provider ?? '',
          model: member.model ?? '',
          reasoning_effort: member.reasoningEffort ?? '',
          status: member.status,
          activity: member.id !== '' ? (activity.get(member.id) ?? 'unknown') : 'unspawned',
          ...member.spawnError === undefined ? {} : { spawn_error: member.spawnError },
        }))
      const tasks = team.tasks.map((task) => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        assignee: task.assignee ?? '',
        dependencies: task.dependencies,
        attempt: task.attempt ?? 0,
        attempt_id: task.attemptId ?? '',
        reassigning: task.reassigning === true,
        kind: taskKindOf(task),
        ...task.round === undefined ? {} : { round: task.round },
        ...task.verdict === undefined ? {} : { verdict: task.verdict },
        findings_open: (task.findings ?? []).filter((finding) => finding.resolved !== true).length,
        // WP1: waived acceptance criteria / commands are shown as their own
        // count so a reader can see that a completed task was not fully
        // verified, and whether its waivers are still unconfirmed.
        waived: waivedResultCount(task),
        ...taskHasWaivers(task) && !waiversConfirmed(team, task) ? { waivers_unconfirmed: true } : {},
        // WP2/S08: the amendment ledger is part of the contract's identity, so a
        // reader sees that a task is working against a revised brief.
        ...(task.revisions ?? []).length === 0 ? {} : { revisions: (task.revisions ?? []).length },
        ...task.profileSeedId === undefined ? {} : { seed_id: task.profileSeedId },
        ...task.output !== undefined ? { output: task.output } : {},
      }))
      const mailboxWarnings: string[] = []
      let mailboxWarningCount = 0
      const reportMalformed = (agentKey: string) => (lineNumber: number): void => {
        mailboxWarningCount += 1
        if (mailboxWarnings.length < 10) {
          mailboxWarnings.push(`${agentKey} mailbox line ${lineNumber}`)
        }
      }
      const captainInbox = identity.kind === 'captain'
        ? await readUnreadMailbox(stateRoot, team.id, CAPTAIN_KEY, reportMalformed(CAPTAIN_KEY))
        : []
      const ownInbox = identity.kind === 'member' ? (await readUnreadMailbox(stateRoot, team.id, identity.name)).slice(0, 10) : []
      const memberInboxes: Record<string, { count: number; latest: string }> = {}
      const visibleMembers = identity.kind === 'captain'
        ? members
        : members.filter((member) => member.name === identity.name)
      for (const member of visibleMembers) {
        const messages = await readUnreadMailbox(
          stateRoot,
          team.id,
          member.name,
          reportMalformed(member.name),
        )
        if (messages.length > 0) {
          memberInboxes[member.name] = {
            count: messages.length,
            latest: messages[messages.length - 1]?.content.slice(0, 200) ?? '',
          }
        }
      }
      const coverage = buildCoverageMatrix(
        [...new Set(team.tasks.flatMap((item) => item.coverageOf ?? []))],
        team.tasks,
      ).map((row) => ({
        goal_item: row.goal_item,
        task_ids: [...row.task_ids],
        status: row.status,
        ...row.evidence === undefined ? {} : { evidence: row.evidence },
      }))
      const deliveryCheck = canDeclareDelivery(team)
      const delivery = { ok: deliveryCheck.ok, blockers: [...deliveryCheck.blockers] }
      const loop = describeQualityLoop(team)
      const result = {
        team_id: team.id,
        team_name: team.name,
        description: team.description ?? '',
        phase: team.phase ?? 'running',
        halted: loop.halted,
        escalated: loop.escalated,
        loop_state: loop.state,
        loop_summary: loop.summary,
        deliverable: loop.deliverable,
        coverage,
        delivery,
        ...team.profile === undefined ? {} : {
          profile: {
            name: team.profile.name,
            ...team.profile.protocol === undefined
              ? {}
              : { protocol: team.profile.protocol.slice(0, 240) },
            ...team.profile.taskPlanning === undefined ? {} : { task_planning: team.profile.taskPlanning },
          },
        },
        viewer: identity.name,
        members,
        tasks,
        // WP8/S16: the plan percentage is computed here, not in the panel, so
        // the text report and the GUI cannot disagree about the same team.
        progress: progressPayload(team.tasks, team.profile?.progressWeights),
        // WP6.3: the pinned known deltas are part of the team's contract, so the
        // status report carries them.
        known_deltas: (team.knownDeltas ?? []).map((delta) => ({
          id: delta.id,
          check: delta.check,
          expected: delta.expected,
          reason: delta.reason,
          pinned_by: delta.pinnedBy,
        })),
        captain_inbox: captainInbox.slice(0, 10).map((message) => ({
          from: message.from,
          content: message.content,
          ts: message.ts,
        })),
        member_inbox: ownInbox.map(message => ({ from: message.from, content: message.content, ts: message.ts })),
        member_inboxes: memberInboxes,
        mailbox_warnings: mailboxWarnings,
        mailbox_warning_count: mailboxWarningCount,
      }
      const acknowledged = identity.kind === 'captain'
        ? captainInbox.slice(0, 10).map(message => message.id)
        : ownInbox.map(message => message.id)
      if (acknowledged.length > 0) {
        await withTeamLock(teamLockKey(stateRoot, team.id), () => (
          acknowledgeMailbox(stateRoot, team.id, identity.kind === 'captain' ? CAPTAIN_KEY : identity.name, acknowledged)
        ))
      }
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_resume',
    description: 'Explicitly resume a halted team. Requires a non-empty reason. Does not recreate cancelled tasks; only still-pending work is scheduled.',
    parameters: {
      team_id: teamIdParam(),
      reason: { type: 'string', required: true, description: 'Why the team is being resumed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          team_id: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'already_running'
          ? `Team ${value.team_id} is already running.`
          : `Team ${value.team_id} resumed (${value.reason}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, args.team_id)
      const result = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        const resumed = resumeTeamState(fresh, args.reason)
        if (resumed.status === 'rejected') throw new Error(resumed.error ?? 'resume rejected')
        if (resumed.status === 'resumed') {
          fresh.halted = false
          fresh.haltedAt = undefined
          await writeTeam(stateRoot, fresh)
          appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-resumed', {
            teamId: fresh.id,
            reason: args.reason,
          })
        }
        return {
          status: resumed.status,
          team_id: fresh.id,
          reason: args.reason,
        }
      })
      if (result.status === 'resumed') await scheduler.kickTeam(workspace, team.id, captain)
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_teams_delete',
    description: 'End and archive your team: interrupts members and moves the current tasks and mailboxes out of active state for later inspection. Use when the work is done or explicitly abandoned. A same-name archive replaces its previous generation.',
    parameters: {
      team_id: teamIdParam(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          team_name: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" ended and archived.`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config)
      const team = await requireCaptainTeam(workspace, config, captain, _args.team_id)
      const members = await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        // Include previously removed members so deleting a pre-fix team also
        // retires durable catalog entries left behind by remove_member.
        const roster = fresh.members.map(member => ({ ...member }))
        for (const member of fresh.members) {
          await discardMailboxMessages(stateRoot, fresh.id, member.name, (await readUnreadMailbox(stateRoot, fresh.id, member.name)).map(message => message.id))
          if (member.status === 'removed') continue
          member.status = 'removed'
          for (const task of fresh.tasks) {
            if (task.assignee === member.name && !TERMINAL_TASK_STATUSES.includes(task.status)) invalidateTaskAttempt(task)
          }
        }
        await writeTeam(stateRoot, fresh)
        return roster
      })
      await recordRetiredMemberIds(stateRoot, members.map(member => member.id))
      await stopTeamMemberActivations(ctx, captain, members, exec.signal)
      await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await requireFreshCaptainTeam(stateRoot, team.id, captain.id)
        appendTeamEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'agent-teams/team-deleted', {
          teamId: fresh.id,
        })
        // Archive, not delete: tasks (with their dependency graph) and the
        // mailboxes stay on disk for later review and dependency rebuilds.
        await archiveTeamDir(stateRoot, fresh.id)
      })
      return { deleted: true, team_name: team.name }
    },
  }))
  return runtime
}

async function initializeProfileTeam(input: {
  ctx: Context
  config: ToolsConfig
  memberSelections: ReturnType<typeof installMemberSelectionRuntime>
  captain: Agent
  exec: ToolRunContext
  stateRoot: string
  teamName: string
  teamId: string
  profileName: string
  inlinePlan?: import('./profiles.ts').TeamProfileConfig
  description?: string
  staged: boolean
}): Promise<{ committed: true; state: TeamState }> {
  const profile = resolveTeamProfile(input.inlinePlan === undefined ? input.config.profiles : { [input.profileName]: input.inlinePlan }, input.profileName, input.config.maxMembers)
  const selections: Awaited<ReturnType<typeof resolveMemberLlmSelection>>[] = []
  for (const template of profile.members) {
    selections.push(await resolveMemberLlmSelection(input.ctx, input.captain, {
      provider: template.provider,
      model: template.model,
      defaultModel: input.config.memberModel,
      reasoningEffort: template.reasoningEffort,
      fallback: template.fallback ?? profile.fallback ?? input.config.fallback,
    }, input.exec.signal))
  }
  await validateMemberLlmSelections(input.ctx, selections, input.exec.signal)
  const now = Date.now()
  const seedToActual = new Map(profile.tasks.map((template, index) => [template.id, `t${index + 1}`] as const))
  const draft: TeamState = {
    name: input.teamName,
    id: input.teamId,
    description: input.description,
    profile: {
      name: profile.name,
      ...profile.description === undefined ? {} : { description: profile.description },
      ...profile.protocol === undefined ? {} : { protocol: profile.protocol },
      ...profile.executionPrompt === undefined ? {} : { executionPrompt: profile.executionPrompt },
      ...profile.fallback === undefined ? {} : { fallback: profile.fallback },
      taskPlanning: profile.taskPlanning,
      ...profile.sharedInScope === undefined ? {} : { sharedInScope: profile.sharedInScope },
      ...profile.progressWeights === undefined ? {} : { progressWeights: profile.progressWeights },
      ...profile.reviewPolicy === undefined ? {} : { reviewPolicy: profile.reviewPolicy },
    },
    ...profile.reviewPolicy === undefined ? {} : { reviewPolicy: profile.reviewPolicy },
    captainSessionId: input.captain.id,
    createdAt: now,
    // WP7: the profile may declare phases; tasks join them later.
    plan: {
      revision: 1,
      updatedAt: now,
      ...input.description === undefined ? {} : { goal: input.description },
      ...profile.phases === undefined
        ? {}
        : { phases: profile.phases.map((phase) => ({ ...phase, taskIds: [...phase.taskIds] })) },
    },
    ...input.staged ? { phase: 'staged' as const, planReviewState: 'awaiting_review' as const } : {},
    members: profile.members.map((template, index) => {
      const selection = selections[index]!
      return {
        id: '',
        name: template.name,
        role: template.role,
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        executionPrompt: template.executionPrompt ?? profile.executionPrompt ?? input.config.executionPrompt,
        ...selection.fallback === undefined ? {} : { fallback: selection.fallback },
        joinedAt: now,
        status: 'idle' as const,
      }
    }),
    tasks: profile.tasks.map((template, index) => ({
      id: `t${index + 1}`,
      profileSeedId: template.id,
      subject: template.subject,
      description: template.description,
      status: 'pending' as const,
      assignee: template.assignee,
      dependencies: template.dependencies.map((dependency) => seedToActual.get(dependency) ?? dependency),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    })),
    taskSeq: profile.tasks.length,
  }
  // Roster creation is durable planning only. The scheduler starts each
  // member with its first actual task once its dependencies are satisfied.
  if (input.inlinePlan !== undefined) delete draft.profile
  await createTeamDir(input.stateRoot, draft)
  return { committed: true, state: draft }
}

function parseFindings(value: unknown): ReviewFinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('findings must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`findings[${index}] must be an object`)
    }
    const raw = item as Record<string, unknown>
    if (typeof raw['id'] !== 'string' || raw['id'].trim() === '') throw new Error(`findings[${index}].id is required`)
    if (raw['severity'] !== 'low' && raw['severity'] !== 'medium' && raw['severity'] !== 'high' && raw['severity'] !== 'blocker') {
      throw new Error(`findings[${index}].severity is invalid`)
    }
    if (typeof raw['problem'] !== 'string' || raw['problem'].trim() === '') throw new Error(`findings[${index}].problem is required`)
    if (typeof raw['requiredFix'] !== 'string' || raw['requiredFix'].trim() === '') throw new Error(`findings[${index}].requiredFix is required`)
    return {
      id: raw['id'].trim(),
      severity: raw['severity'],
      problem: raw['problem'],
      requiredFix: raw['requiredFix'],
      // A blank optional file must be omitted, not persisted: durable-state
      // validation requires non-empty optional strings (issue #105 class).
      ...typeof raw['file'] === 'string' && raw['file'].trim() !== '' ? { file: raw['file'] } : {},
      ...typeof raw['line'] === 'number' ? { line: raw['line'] } : {},
      ...typeof raw['resolved'] === 'boolean' ? { resolved: raw['resolved'] } : {},
    }
  })
}

function parseAcceptanceResults(value: unknown, deferWaiverEvidence = false): AcceptanceResult[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('acceptanceResults must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`acceptanceResults[${index}] must be an object`)
    }
    const raw = item as Record<string, unknown>
    if (typeof raw['criterion'] !== 'string' || raw['criterion'].trim() === '') {
      throw new Error(`acceptanceResults[${index}].criterion is required`)
    }
    if (raw['status'] !== 'passed' && raw['status'] !== 'failed' && raw['status'] !== 'waived') {
      throw new Error(`acceptanceResults[${index}].status must be passed, failed or waived`)
    }
    const evidence = typeof raw['evidence'] === 'string' ? raw['evidence'] : undefined
    if (!deferWaiverEvidence && raw['status'] === 'waived' && (evidence === undefined || evidence.trim() === '')) {
      throw new Error(`acceptanceResults[${index}]: a waived criterion requires non-empty evidence naming the reason; a waiver without a reason is not accepted`)
    }
    return {
      criterion: raw['criterion'],
      status: raw['status'],
      ...evidence === undefined ? {} : { evidence },
    }
  })
}

function parseCommandResults(value: unknown, deferWaiverEvidence = false): CommandResult[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('commandsRun must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`commandsRun[${index}] must be an object`)
    }
    const raw = item as Record<string, unknown>
    if (typeof raw['command'] !== 'string' || raw['command'].trim() === '') {
      throw new Error(`commandsRun[${index}].command is required`)
    }
    if (raw['status'] !== 'passed' && raw['status'] !== 'failed' && raw['status'] !== 'waived') {
      throw new Error(`commandsRun[${index}].status must be passed, failed or waived`)
    }
    const evidence = typeof raw['evidence'] === 'string' ? raw['evidence'] : undefined
    if (!deferWaiverEvidence && raw['status'] === 'waived' && (evidence === undefined || evidence.trim() === '')) {
      throw new Error(`commandsRun[${index}]: a waived command requires non-empty evidence naming the reason; a waiver without a reason is not accepted`)
    }
    return {
      command: raw['command'],
      status: raw['status'],
      ...typeof raw['exitCode'] === 'number' ? { exitCode: raw['exitCode'] } : {},
      ...evidence === undefined ? {} : { evidence },
    }
  })
}

/** Parse the review-only waiver confirmation payload. */
function parseWaiverConfirmation(value: unknown): WaiverConfirmation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('waiverConfirmation must be an object')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw['taskId'] !== 'string' || raw['taskId'].trim() === '') {
    throw new Error('waiverConfirmation.taskId is required')
  }
  if (typeof raw['reason'] !== 'string' || raw['reason'].trim() === '') {
    throw new Error('waiverConfirmation.reason is required: state why the waivers are acceptable')
  }
  const waived = Array.isArray(raw['waived'])
    ? raw['waived'].filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : undefined
  return {
    taskId: raw['taskId'].trim(),
    reason: raw['reason'].trim(),
    ...waived === undefined || waived.length === 0 ? {} : { waived },
  }
}

export function applyQualityFollowUp(team: TeamState, closed: TeamTask): { created: TeamTask[]; escalated: boolean } {
  const planned = planQualityFollowUp(team, closed)
  if (planned.escalated === true) team.escalated = true
  const created: TeamTask[] = []
  const existing = [...team.tasks]
  const now = Date.now()
  const idBySubject = new Map<string, string>()
  for (const draft of planned.created) {
    team.taskSeq += 1
    const id = `t${team.taskSeq}`
    if (draft.id !== undefined) idBySubject.set(draft.id, id)
    if (draft.subject !== undefined) idBySubject.set(draft.subject, id)
    const dependencies = (draft.dependencies ?? []).map((dependency) => {
      if (team.tasks.some((item) => item.id === dependency)) return dependency
      return idBySubject.get(dependency) ?? dependency
    })
    const next: TeamTask = {
      id,
      subject: draft.subject ?? `${draft.kind}-round-${draft.round ?? 1}`,
      status: 'pending',
      assignee: draft.assignee,
      dependencies,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      kind: draft.kind,
      ...draft.round === undefined ? {} : { round: draft.round },
      ...draft.objective === undefined ? {} : { objective: draft.objective },
      ...draft.inScope === undefined ? {} : { inScope: draft.inScope },
      ...draft.outOfScope === undefined ? {} : { outOfScope: draft.outOfScope },
      ...draft.acceptance === undefined ? {} : { acceptance: draft.acceptance },
      ...draft.verify === undefined ? {} : { verify: draft.verify },
      ...draft.sourceTaskId === undefined ? {} : { sourceTaskId: draft.sourceTaskId },
      ...draft.sourceFindingIds === undefined ? {} : { sourceFindingIds: draft.sourceFindingIds },
      ...draft.reviewedTaskId === undefined ? {} : { reviewedTaskId: idBySubject.get(draft.reviewedTaskId) ?? draft.reviewedTaskId },
    }
    team.tasks.push(next)
    created.push(next)
  }
  // A staged full delivery plan may already contain downstream integration
  // work that points at the first requirements/review gate. When that gate
  // opens an automatic revision loop, move only still-pending downstream
  // edges to the new terminal gate so the approved plan can continue after
  // the repair instead of waiting forever on an intentionally failed task.
  const replacement = created.at(-1)
  if (replacement !== undefined) {
    for (const task of existing) {
      if (task.status !== 'pending' || !task.dependencies.includes(closed.id)) continue
      task.dependencies = task.dependencies.map((dependency) => (
        dependency === closed.id ? replacement.id : dependency
      ))
      task.updatedAt = now
    }
  }
  return { created, escalated: planned.escalated === true }
}

/** Build the `memberRuntime` config handed to member helpers. */
function memberRuntime(config: ToolsConfig): MemberRuntimeConfig {
  return {
    provider: config.memberProvider,
    maxDepth: config.memberMaxDepth,
    executionPrompt: config.executionPrompt,
    fallback: config.fallback,
  }
}

/**
 * Fill the evidence of `waived` results from the pinned known-delta registry
 * (WP6.3), and reject a waiver that neither carries its own reason nor matches a
 * pinned check. Runs inside the team lock, where the registry is authoritative.
 * @param deltas - the team's pinned deltas, if any.
 * @param items - parsed acceptance or command results.
 * @param text - how to read the check text out of one item.
 * @param field - field name used in the rejection message.
 * @returns the results, with pinned evidence filled in.
 */
function applyPinnedDeltaEvidence<T extends { status: string; evidence?: string }>(
  deltas: readonly KnownDelta[] | undefined,
  items: T[] | undefined,
  text: (item: T) => string,
  field: string,
): T[] | undefined {
  if (items === undefined) return undefined
  return items.map((item, index) => {
    if (item.status !== 'waived' || (item.evidence ?? '').trim() !== '') return item
    const pinned = pinnedWaiverEvidence(deltas, text(item))
    if (pinned === undefined) {
      throw new Error(
        `${field}[${String(index)}]: a waived item requires non-empty evidence naming the reason;`
        + ' a waiver without a reason is not accepted (pin a known delta if the check is red for an outside reason)',
      )
    }
    return { ...item, evidence: pinned }
  })
}

/**
 * The wire shape of the plan progress inside the status payload. The payload is
 * snake_case like the rest of the tool output, while the snapshot route keeps
 * the camelCase shape the panel consumes.
 */
function progressPayload(
  tasks: readonly TeamTask[],
  weights: 'equal' | Record<string, number> | undefined,
): {
  percent: number
  mode: string
  percent_by_kind: number
  percent_equal: number
  completed: number
  total: number
  running: number
  blocked: number
  failed: number
  waived: number
  superseded: number
  cancelled: number
} {
  const progress = planProgress(tasks, weights === undefined ? {} : { weights })
  return {
    percent: progress.percent,
    mode: progress.mode,
    percent_by_kind: progress.percentByKind,
    percent_equal: progress.percentEqual,
    completed: progress.completed,
    total: progress.total,
    running: progress.running,
    blocked: progress.blocked,
    failed: progress.failed,
    waived: progress.waived,
    superseded: progress.superseded,
    cancelled: progress.cancelled,
  }
}

/**
 * The checkbox glyph of one task status, used by the text report (WP8/S16).
 * The panel draws the same four states, so a reader can follow one language
 * across the tool output and the GUI.
 */
function taskCheckGlyph(status: string): string {
  if (status === 'completed') return '[x]'
  if (status === 'failed' || status === 'cancelled' || status === 'superseded') return '[!]'
  if (status === 'claimed' || status === 'in_progress' || status === 'awaiting_scope_review') return '[~]'
  return '[ ]'
}

/** Render the status snapshot as compact text for the model. */
function renderStatus(value: JsonValue): string {
  const listed = value as { teams?: { team_id: string; name: string; phase: string; halted: boolean; tasks: { total: number; done: number }; members: number; activeWorkers: number; role: string }[]; note?: string }
  if (Array.isArray(listed.teams)) {
    return [
      `Your teams (${String(listed.teams.length)}):`,
      ...listed.teams.map((entry) => (
        `  - ${entry.team_id} "${entry.name}" [${entry.phase}${entry.halted ? ', halted' : ''}]`
        + ` as ${entry.role}: ${String(entry.tasks.done)}/${String(entry.tasks.total)} tasks done,`
        + ` ${String(entry.members)} members, ${String(entry.activeWorkers)} working`
      )),
      ...listed.note === undefined ? [] : [listed.note],
    ].join('\n')
  }
  const team = value as {
    team_name: string
    description?: string
    profile?: { name: string; protocol?: string; task_planning?: string }
    viewer: string
    members: {
      name: string
      role: string
      provider: string
      model: string
      reasoning_effort: string
      status: string
      activity: string
      spawn_error?: string
    }[]
    tasks: { id: string; subject: string; status: string; assignee: string; dependencies: string[]; attempt: number; attempt_id: string; reassigning: boolean; seed_id?: string; output?: string; kind?: string; round?: number; verdict?: string; findings_open?: number; waived?: number; waivers_unconfirmed?: boolean; revisions?: number }[]
    progress?: { percent: number; mode: string; percent_by_kind: number; percent_equal: number; completed: number; total: number; running: number; blocked: number; failed: number; waived: number; superseded: number; cancelled: number }
    known_deltas?: { id: string; check: string; expected: string; reason: string; pinned_by: string }[]
    captain_inbox: { from: string; content: string }[]
    member_inbox?: { from: string; content: string }[]
    member_inboxes: Record<string, { count: number; latest: string }>
    mailbox_warnings: string[]
    mailbox_warning_count: number
    halted?: boolean
    escalated?: boolean
    loop_state?: string
    loop_summary?: string
    deliverable?: boolean
    coverage?: { goal_item: string; status: string; task_ids: string[] }[]
    delivery?: { ok: boolean; blockers: string[] }
  }
  const flags = [
    team.halted ? 'halted' : undefined,
    team.escalated ? 'escalated' : undefined,
    team.deliverable ? 'deliverable' : undefined,
    team.loop_state && team.loop_state !== 'running' && team.loop_state !== 'halted' && team.loop_state !== 'escalated'
      ? team.loop_state
      : undefined,
  ].filter((item): item is string => item !== undefined)
  const lines: string[] = [
    `Team "${team.team_name}"${team.description ? ` — ${team.description}` : ''}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`,
    ...team.profile === undefined ? [] : [`Profile: ${team.profile.name}${team.profile.task_planning ? ` [${team.profile.task_planning}]` : ''}${team.profile.protocol ? ` — ${team.profile.protocol}` : ''}`],
    ...team.loop_summary ? [`Loop: ${team.loop_state ?? ''} — ${team.loop_summary}`.replace(/^Loop:  — /u, 'Loop: ')] : [],
    `Viewing as: ${team.viewer}`,
    `Members (${team.members.length}):`,
    ...team.members.map((member) => {
      const route = member.provider && member.model ? ` · ${member.provider}/${member.model}` : ''
      const effort = member.reasoning_effort ? ` · reasoning ${member.reasoning_effort}` : ''
      const failure = member.spawn_error === undefined ? '' : `\n      start failed: ${member.spawn_error.slice(0, 400)}`
      return `  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}${failure}`
    }),
    // WP8/S16: one percentage before the task list, so a captain reading the
    // report sees the same number the panel shows.
    ...team.progress === undefined ? [] : [
      `Progress: ${String(team.progress.percent)}% (${String(team.progress.completed)}/${String(team.progress.total)};`
      + ` running ${String(team.progress.running)}, blocked ${String(team.progress.blocked)},`
      + ` failed ${String(team.progress.failed)}, waived ${String(team.progress.waived)})`,
    ],
    `Tasks (${team.tasks.length}):`,
    ...team.tasks.map((task) => {
      const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : ''
      const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
      const handoff = task.reassigning ? ' (reassigning)' : ''
      const seed = task.seed_id === undefined || task.seed_id === '' ? '' : ` seed ${task.seed_id}`
      const kind = task.kind ? ` ${task.kind}` : ''
      const round = task.round === undefined ? '' : ` r${task.round}`
      const verdict = task.verdict === undefined ? '' : ` verdict ${task.verdict}`
      const waived = task.waived === undefined || task.waived === 0
        ? ''
        : ` waived ${task.waived}${task.waivers_unconfirmed === true ? ' (unconfirmed — delivery blocked until a review confirms them)' : ''}`
      // WP2/S08: how many times the captain has amended this contract. A task
      // working against a revised brief must be visible as such.
      const revised = task.revisions === undefined || task.revisions === 0 ? '' : ` revised ×${task.revisions}`
      return `  - ${taskCheckGlyph(task.status)} ${task.id} [${task.status}]${kind}${round}${verdict}${waived}${revised} attempt ${task.attempt}${handoff}${seed} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${output}`
    }),
    ...team.coverage === undefined || team.coverage.length === 0 ? [] : [
      'Coverage:',
      ...team.coverage.map((row) => `  - ${row.goal_item}: ${row.status} (${row.task_ids.join(',') || 'none'})`),
    ],
    ...team.delivery === undefined ? [] : [
      `Delivery: ${team.delivery.ok ? 'ok' : `blocked (${team.delivery.blockers.join('; ')})`}`,
    ],
    // WP6.3: a pinned delta explains why a check is red here; the report names
    // them so a waiver citing one is auditable without opening team.json.
    ...(team.known_deltas ?? []).length === 0 ? [] : [
      `Known deltas (${String((team.known_deltas ?? []).length)}):`,
      ...(team.known_deltas ?? []).map((delta) => (
        `  - ${delta.id}: ${delta.check} (expected ${delta.expected}) — ${delta.reason} [${delta.pinned_by}]`
      )),
    ],
    `Captain inbox (${team.captain_inbox.length}):`,
    ...team.captain_inbox.map((message) => `  - [${message.from}] ${message.content}`),
    ...(team.member_inbox ?? []).map(message => `  - [${message.from}] ${message.content}`),
  ]
  for (const [name, inbox] of Object.entries(team.member_inboxes)) {
    lines.push(`Member inbox ${name} (${inbox.count}): latest — ${inbox.latest.slice(0, 120)}`)
  }
  if (team.mailbox_warning_count > 0) {
    lines.push(
      `Mailbox warnings (${team.mailbox_warning_count}; malformed lines were skipped; showing up to 10):`,
      ...team.mailbox_warnings.map((warning) => `  - ${warning}`),
    )
  }
  return lines.join('\n')
}
