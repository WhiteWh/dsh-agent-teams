/**
 * AgentTeams for DeepSeek Harness.
 *
 * A host-plane plugin that registers the `agent_teams_*` tools and one usage
 * agent-scoped usage section. Each session keeps a stable tool set and core
 * instructions. Existing business tools cover the complete team lifecycle.
 * After installation any session can
 * run multi-agent teamwork through natural language (e.g. "use AgentTeams to research X"):
 * the model creates a team (it becomes the captain), spawns members as
 * durable continuable subagents, breaks the goal into tasks with
 * dependencies, wakes members with messages, relays reports, and collects
 * results.
 *
 * Installation (bundle): `dsh plugin --profile <name> add @nanmicoder/dsh-agent-teams`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry and the
 * usage section into the global system prompt, so the plugin needs no realm.
 *
 * @module dsh-agent-teams
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Declaration merges make ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  haltTeamWork,
  stagedPlanApprovedContext,
  registerAgentTeamsTools,
  type StagedPlanMutation,
  type ToolsConfig,
} from './tools.ts'
import { installAgentTeamsGestureBoundary, registerAgentTeamsCommand } from './command.ts'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'
import { serveArtwork } from './artwork.ts'
import { findTeamsByCaptain } from './state.ts'
import { formatProfilesForPrompt, type TeamProfileConfig } from './profiles.ts'
import { installTeamCapabilities } from './capabilities.ts'
import { TEAM_TOOL_NAMES } from './tool-names.ts'

import { authenticatedWebRoutes, readJsonRequest, RequestBodyError, type BrowserRequestGate, type WebRouteHost } from './web-routes.ts'

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export const name = '@nanmicoder/dsh-agent-teams'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `.agent-teams`).
   */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
  memberProvider?: string
  /** Optional model override applied to every member. */
  memberModel?: string
  /** Prompt injected into member personas and automatic task assignments. */
  executionPrompt?: string
  /** Plugin-wide fallback route for unavailable member models. */
  fallback?: import('./profiles.ts').TeamModelFallbackConfig
  /** Member delegation depth cap (default `0`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Team size cap in members (default `8`). */
  maxMembers?: number
  /**
   * Members of one team that may work at the same time (WP11 phase 2, default
   * `4`). The upstream `maxConcurrentWorkers` mechanics: a fuse on concurrent
   * work, not a limit on the roster.
   */
  maxWorkersPerTeam?: number
  /** Members that may work at once across every live team of the workspace (default `8`). */
  maxConcurrentWorkersGlobal?: number
  /** Live teams one workspace may hold (WP11 phase 3, default `4`). */
  maxTeamsPerWorkspace?: number
  /** Live teams one captain session may lead (WP11 phase 3, default `8`). */
  maxTeamsPerSession?: number
  /** Named multi-role team profiles. */
  profiles?: Record<string, TeamProfileConfig>
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /**
   * Register the deterministic `/agent-teams` activation surfaces (the
   * closed-namespace slash command and the plain-text gesture boundary).
   * Disable to keep the natural-language trigger as the only entry point.
   */
  slashCommand?: boolean
}

// `z.object()` has an implicit `{}` default in Schemastery.  Fallback routes
// are optional, so model absence explicitly; otherwise a missing route is
// validated as an empty object and fails on the required provider/model keys.
const fallbackRouteConfig = z.union([
  z.object({ provider: z.string().required(), model: z.string().required() }),
  z.const(undefined),
])

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.agent-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  executionPrompt: z.string(),
  fallback: fallbackRouteConfig,
  profiles: z.dict(z.object({
    description: z.string(),
    protocol: z.string(),
    executionPrompt: z.string(),
    fallback: fallbackRouteConfig,
    members: z.array(z.object({
      name: z.string().required(),
      role: z.string(),
      provider: z.string(),
      model: z.string(),
      reasoning_effort: z.string(),
      executionPrompt: z.string(),
      fallback: fallbackRouteConfig,
    })).min(1).required(),
    taskPlanning: z.union([z.const('captain'), z.const('seed')]),
    reviewPolicy: z.object({
      requirementsMinRounds: z.natural().min(1),
      requirementsMaxRounds: z.natural().min(1),
      codeMaxRounds: z.natural().min(1),
      maxRepairAttempts: z.natural().min(1),
      requiredReviewers: z.array(z.string()),
      allowWaivers: z.boolean(),
    }),
    tasks: z.array(z.object({
      id: z.string().required(),
      subject: z.string().required(),
      description: z.string(),
      assignee: z.string(),
      dependencies: z.array(z.string()),
    })),
  })).default({}),
  memberMaxDepth: z.natural().default(0),
  maxMembers: z.natural().min(1).default(8),
  // WP11 phase 2 caps; phase 3 moves them onto the profile. Absent means the
  // documented defaults (4 per team, 8 across the workspace).
  maxWorkersPerTeam: z.natural().min(1),
  maxConcurrentWorkersGlobal: z.natural().min(1),
  // WP11 phase 3 team limits; absent means 4 per workspace and 8 per session.
  maxTeamsPerWorkspace: z.natural().min(1),
  maxTeamsPerSession: z.natural().min(1),
  promptSectionOrder: z.natural().default(117),
  slashCommand: z.boolean().default(true),
})

/**
 * Map one camelCase Web operation into a replan operation (WP7).
 *
 * The browser editor cannot send a readonly TS type, so this is the one place
 * that turns an untrusted JSON body into the batch shape the shared applier
 * validates. Unknown keys are ignored on purpose: the applier rejects anything
 * that matters, and a stray field must not break an otherwise valid batch.
 */
export function parseReplanOperation(entry: unknown, index: number): import('./replan.ts').ReplanOperation {
  const label = `operations[${String(index)}]`
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${label} must be an object`)
  }
  const raw = entry as Record<string, unknown>
  const action = typeof raw['action'] === 'string' ? raw['action'] : ''
  if (action === '') throw new Error(`${label}.action is required`)
  const strings = (value: unknown): string[] | undefined => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
  const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
  return {
    action: action as import('./replan.ts').ReplanAction,
    ...text(raw['taskId']) === undefined ? {} : { task_id: text(raw['taskId']) },
    ...text(raw['subject']) === undefined ? {} : { subject: text(raw['subject']) },
    ...text(raw['description']) === undefined ? {} : { description: text(raw['description']) },
    ...text(raw['assignee']) === undefined ? {} : { assignee: text(raw['assignee']) },
    ...strings(raw['dependencies']) === undefined ? {} : { dependencies: strings(raw['dependencies']) },
    ...text(raw['kind']) === undefined ? {} : { kind: text(raw['kind']) as import('./types.ts').TaskKind },
    ...typeof raw['round'] === 'number' ? { round: raw['round'] } : {},
    ...text(raw['objective']) === undefined ? {} : { objective: text(raw['objective']) },
    ...strings(raw['inScope']) === undefined ? {} : { inScope: strings(raw['inScope']) },
    ...strings(raw['outOfScope']) === undefined ? {} : { outOfScope: strings(raw['outOfScope']) },
    ...strings(raw['acceptance']) === undefined ? {} : { acceptance: strings(raw['acceptance']) },
    ...strings(raw['verify']) === undefined ? {} : { verify: strings(raw['verify']) },
    ...strings(raw['deliverables']) === undefined ? {} : { deliverables: strings(raw['deliverables']) },
    ...strings(raw['nonGoals']) === undefined ? {} : { nonGoals: strings(raw['nonGoals']) },
    ...text(raw['reviewedTaskId']) === undefined ? {} : { reviewedTaskId: text(raw['reviewedTaskId']) },
    ...text(raw['sourceTaskId']) === undefined ? {} : { sourceTaskId: text(raw['sourceTaskId']) },
    ...strings(raw['sourceFindingIds']) === undefined ? {} : { sourceFindingIds: strings(raw['sourceFindingIds']) },
    ...strings(raw['coverageOf']) === undefined ? {} : { coverageOf: strings(raw['coverageOf']) },
    ...text(raw['replacementTaskId']) === undefined ? {} : { replacement_task_id: text(raw['replacementTaskId']) },
    ...strings(raw['paths']) === undefined ? {} : { paths: strings(raw['paths']) },
    ...text(raw['phaseId']) === undefined ? {} : { phase_id: text(raw['phaseId']) },
    ...text(raw['title']) === undefined ? {} : { title: text(raw['title']) },
    ...text(raw['reason']) === undefined ? {} : { reason: text(raw['reason']) },
    ...raw['force'] === true ? { force: true } : {},
    ...raw['invalidate'] === true ? { invalidate: true } : {},
    ...raw['retry'] === true ? { retry: true } : {},
  }
}

/** The model-facing usage policy: when and how to drive AgentTeams. */export function usageSectionText(toolNames: string, profilesText = ''): string {
  return `AgentTeams captain protocol:
1. Team identity is the \`team_id\` every team-scoped tool takes. Remember the id \`agent_teams_create\` returns; if you are unsure, call \`agent_teams_status\` with no argument to list your teams (id, name, phase, tasks, members, active workers). A missing \`team_id\` is an error naming your teams, and you may lead several teams at once. Inspect current team state when needed, using agent_teams_status. Continue existing work without duplicating its roster/tasks. Create a team only when the user asks for one — a second team needs \`new_team: true\` and an explicit request — with the user's goal as description and approval="required"; automatic approval requires an explicit request to run immediately. Staged plans never spawn or schedule work.
2. Add each needed role once; members inherit your model route unless another is requested/needed. A requested profile goes to create({profile}); it supplies its roster. Seed profiles also supply tasks; captain-planning profiles require your DAG. Do not duplicate either.
3. Build the complete smallest useful DAG while staged. For an ordinary research/audit plan, pass the roster and dependency graph together in create({plan:{members,tasks}}) to avoid repeated setup rounds. Every task needs a subject; pass kind and assignee explicitly when the plan specifies them. Titles, descriptions and member roles do not set these fields. Dependencies represent prerequisites. Give every required contributor a task or explicit message. Present the plan and end your turn for review; never approve in that planning turn. Approve only after a later explicit user approval or the Web action.
4. Respect Web approve/return/discard control messages. On return, ask what to change before editing; after the answer, use one atomic agent_teams_edit_plan batch (edit downstream references before removals), summarize and await review again. Never inspect or edit .agent-teams state files or plugin source code to revise plans. Discard does not authorize a replacement.
5. The scheduler dispatches ready tasks after approval. Delegate; do not duplicate slow work or send messages merely to start a stage. Handle reports/user work, then yield when waiting is all that remains: reports wake you automatically. Use status after a delivery or user request, never busy-poll or wait for unassigned members.
6. Tasks carry attempt_id capabilities. Use the current attempt_id; stale means ownership changed. Pause members only on explicit request; later guidance via send_message continues that same attempt. Retry, transfer or take over through reassign_task first; it revokes the old attempt and waits for quiescence. Prefer a member. Captain implementation/review takeover requires a user request. Every takeover is one ready task at a time, finished in this turn; never yield with captain-owned work open.
7. In a running team, repair the plan instead of cancelling and recreating it: one atomic \`agent_teams_replan\` batch (add_task, update_task, supersede_task, cancel_task, accept_paths, amend_task, move_phase) under one reason. Correct never-started pending tasks with edit_plan update_task; a task a member currently holds needs replan's invalidate=true, which revokes the attempt, stops that member and leaves it a mailbox note. When a gate refused because the contract or the scope was wrong, prefer amend_task / accept_paths / supersede_task over cancel + create. Quality kinds (requirements, implementation, verification, review, repair, integration) require objective + acceptance; implementation/repair also require inScope + verify. Derive paths/commands from the workspace/profile, never assume src/ or pnpm test. Review/requirements complete only with verdict=pass; needs_revision/reject fail with findings. Never approve your own implementation or ask for a deliberate failure. When a quality contract itself is wrong (a verify command that cannot pass, an inScope that forbids the file the objective requires), fix it with agent_teams_amend_task (captain-only, non-terminal tasks only, frozen after a passing review, every amendment recorded in the task's revisions ledger) instead of letting the worker dead-lock or game the gate. A completed contract stays immutable: the post-hoc repair for a finished lane is accept_paths, not a rewrite of history.
8. When full quality mode is requested: requirements → implementation → verification → review → integration. Plan the entire DAG while staged, including implementation before requirements finishes and integration depending on review round 1. Failed review automatically adds repair + next review and rewires pending downstream gates. Do not recreate this loop, omit integration or depend on a failed task. Review acceptance judges the latest implementation. Do not put smoke-test scripts into task instructions.
9. Halted means the user stopped work (including the captain turn). Resume only on a later explicit user request with a reason, via agent_teams_resume or create_task({resume:true,resumeReason}); creating tasks alone never resumes. Escalated means the review loop hit its limit, not a halt. Deployment requires explicit user confirmation.
10. Wait for all required tasks to be terminal and members idle/ready, present results, then delete/archive unless the user wants to continue. Never discard unfinished work without authorization.
Tools: ${toolNames}${profilesText === '' ? '' : `\n\n${profilesText}`}`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ToolsConfig = {
    stateDir: config.stateDir ?? '.agent-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.memberModel,
    executionPrompt: config.executionPrompt,
    fallback: config.fallback,
    memberMaxDepth: config.memberMaxDepth ?? 0,
    maxMembers: config.maxMembers ?? 8,
    ...config.maxWorkersPerTeam === undefined ? {} : { maxWorkersPerTeam: config.maxWorkersPerTeam },
    ...config.maxConcurrentWorkersGlobal === undefined ? {} : { maxConcurrentWorkersGlobal: config.maxConcurrentWorkersGlobal },
    ...config.maxTeamsPerWorkspace === undefined ? {} : { maxTeamsPerWorkspace: config.maxTeamsPerWorkspace },
    ...config.maxTeamsPerSession === undefined ? {} : { maxTeamsPerSession: config.maxTeamsPerSession },
    profiles: config.profiles ?? {},
  }

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  const agentTeamsRuntime = registerAgentTeamsTools(ctx, {
    ...resolved,
    // WP11 phase 2: the scheduler's sweep walks every workspace the host knows.
    // The probe is lazy because the registry can arrive after this mount (the
    // Loader activates services concurrently), exactly like the Web surface above.
    workspaces: () => {
      const registry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
      return registry === undefined ? [] : registry.list().map((workspace) => workspace.path)
    },
  })
  installTeamCapabilities(ctx, {
    stateDir: resolved.stateDir,
    isPendingMember: agentTeamsRuntime.isPendingMember,
    order: config.promptSectionOrder,
    // Keep the bounded profile directory available without extra tool calls.
    // installTeamCapabilities snapshots this once; no business state rewrites it.
    captainPrompt: () => usageSectionText(TEAM_TOOL_NAMES.join(', '), formatProfilesForPrompt(config.profiles)),
  })

  // Deterministic activation surfaces: the closed-namespace `/agent-teams`
  // host command (surfaces in the Web GUI slash menu via the Harness
  // ui-commands client) and the plain-text gesture boundary for surfaces
  // without command adjudication (headless CLI). Both default on; a profile
  // can disable them to keep the natural-language trigger exclusive.
  //
  // `commands` is registered lazily (not a required inject): it ships in the
  // base bundle of every standard profile, but a minimal composition that
  // omits the command registry keeps the plugin fully functional — the fiber
  // never pends on it and simply never gains the slash command.
  if (config.slashCommand ?? true) {
    ctx.inject(['commands'], (commandCtx) => {
      registerAgentTeamsCommand(commandCtx, () => config.profiles ?? {})
    })
    installAgentTeamsGestureBoundary(ctx, () => config.profiles ?? {})
  }

  // The activity panel data/artwork routes need the Web server and the
  // workspace registry, which headless profiles do not mount; under
  // concurrent activation they may also bind after this plugin. Register the
  // routes lazily: try now, then on each service binding event. In a webless
  // profile the plugin stays tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const rawWebServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
    if (rawWebServer === undefined || workspaceRegistry === undefined) return
    const webServer = authenticatedWebRoutes(rawWebServer, () => ctx.get('connection') as BrowserRequestGate | undefined)
    webRegistered = true

    // Activity panel data route: the browser floater polls this for team
    // snapshots (disk truth + live subagent activity). Mirrors the Claude
    // Code desktop watcher's server-side snapshot pattern.
    ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-teams/state',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const roots = workspaceRegistry.list().map((workspace) => ({
        workspace: workspace.title,
        stateRoot: join(workspace.path, resolved.stateDir),
      }))
      // ?archived=1 serves teams moved to archive/ (post-delete review).
      const snapshots = url.searchParams.get('archived') === '1'
        ? await collectArchivedTeamsActivity(ctx, roots)
        : await collectTeamsActivity(ctx, roots)
      const body = JSON.stringify({ teams: snapshots })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'agent-teams: activity route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/halt',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        const teamId = typeof payload.teamId === 'string' ? payload.teamId.trim() : ''
        if (sessionId === '' || teamId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId and teamId are required' }))
          return
        }
        const captain = ctx.agents.get(sessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'captain session is not attached' }))
          return
        }
        const workspace = captain.session.header.cwd ?? process.cwd()
        const stateRoot = join(workspace, resolved.stateDir)
        const team = (await findTeamsByCaptain(stateRoot, captain.id)).find((candidate) => candidate.id === teamId)
        if (team === undefined || team.id !== teamId) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'team not found for this captain' }))
          return
        }
        try {
          const result = await haltTeamWork({
            ctx,
            stateRoot,
            teamId,
            captain,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: halt failed for ${teamId}: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'failed to stop the team' }))
        }
      },
    }), 'agent-teams: halt route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/plan',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : ''
        const teamId = typeof payload['teamId'] === 'string' ? payload['teamId'].trim() : ''
        const action = typeof payload['action'] === 'string' ? payload['action'] : ''
        if (sessionId === '' || teamId === '' || action === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId, teamId, and action are required' }))
          return
        }
        const captain = ctx.agents.get(sessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'captain session is not attached' }))
          return
        }
        const workspace = captain.session.header.cwd ?? process.cwd()
        const stateRoot = join(workspace, resolved.stateDir)
        const team = (await findTeamsByCaptain(stateRoot, captain.id)).find((candidate) => candidate.id === teamId)
        if (team === undefined || team.id !== teamId) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'team not found for this captain' }))
          return
        }
        try {
          if (action === 'approve') {
            const approved = await agentTeamsRuntime.approveStagedTeam(captain, teamId)
            // The browser receives the HTTP result, so the model needs its own
            // control message. steer wakes an idle captain or joins its next
            // step; the tool approve path already returns to the model itself.
            try {
              captain.steer(createUserMessage({
                content: [{ type: 'text', text: stagedPlanApprovedContext(team.name) }],
                source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
              }))
            } catch (error) {
              // Approval is already committed. Do not report a failed approval
              // and invite a retry that could duplicate the user's action.
              ctx.logger.warn(`agent-teams: approval notification failed for ${teamId}: ${String(error)}`)
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'running', ...approved }))
            return
          }
          if (action === 'continue') {
            const continued = await agentTeamsRuntime.continueStagedPlanning(captain, teamId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'staged', review: 'awaiting_feedback', ...continued }))
            return
          }
          if (action === 'discard') {
            const discarded = await agentTeamsRuntime.discardStagedTeam(captain, teamId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'archived', ...discarded }))
            return
          }
          if (action === 'replan') {
            // WP7/S17: the running-mode plan editor sends the same batch shape the
            // `agent_teams_replan` tool takes, so both paths share one validator,
            // one writer, one event and one wake-up.
            const reason = typeof payload['reason'] === 'string' ? payload['reason'].trim() : ''
            if (reason === '') throw new Error('reason is required for a replan')
            if (!Array.isArray(payload['operations']) || payload['operations'].length === 0) {
              throw new Error('operations are required for a replan')
            }
            const operations = payload['operations'].map((entry, index) => parseReplanOperation(entry, index))
            const revised = await agentTeamsRuntime.replanLiveTeam(captain, teamId, operations, reason)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, revision: revised.revision, applied: revised.applied, changes: revised.changes }))
            return
          }
          const dependencies = Array.isArray(payload['dependencies'])
            ? payload['dependencies'].filter((item): item is string => typeof item === 'string')
            : []
          let mutation: StagedPlanMutation
          if (action === 'update_member') {
            if (typeof payload['memberName'] !== 'string'
              || typeof payload['provider'] !== 'string'
              || typeof payload['model'] !== 'string') throw new Error('memberName, provider, and model are required')
            mutation = {
              action,
              memberName: payload['memberName'],
              provider: payload['provider'],
              model: payload['model'],
              ...typeof payload['role'] === 'string' || payload['role'] === null ? { role: payload['role'] as string | null } : {},
              ...typeof payload['reasoningEffort'] === 'string' || payload['reasoningEffort'] === null
                ? { reasoningEffort: payload['reasoningEffort'] as string | null }
                : {},
              ...typeof payload['executionPrompt'] === 'string' || payload['executionPrompt'] === null
                ? { executionPrompt: payload['executionPrompt'] as string | null }
                : {},
            }
          } else if (action === 'update_task') {
            if (typeof payload['taskId'] !== 'string' || typeof payload['subject'] !== 'string') {
              throw new Error('taskId and subject are required')
            }
            mutation = {
              action,
              taskId: payload['taskId'],
              subject: payload['subject'],
              dependencies,
              ...typeof payload['description'] === 'string' || payload['description'] === null
                ? { description: payload['description'] as string | null }
                : {},
              ...typeof payload['assignee'] === 'string' || payload['assignee'] === null
                ? { assignee: payload['assignee'] as string | null }
                : {},
            }
          } else if (action === 'add_task') {
            if (typeof payload['subject'] !== 'string') throw new Error('subject is required')
            mutation = {
              action,
              subject: payload['subject'],
              dependencies,
              ...typeof payload['description'] === 'string' || payload['description'] === null
                ? { description: payload['description'] as string | null }
                : {},
              ...typeof payload['assignee'] === 'string' || payload['assignee'] === null
                ? { assignee: payload['assignee'] as string | null }
                : {},
            }
          } else if (action === 'remove_task') {
            if (typeof payload['taskId'] !== 'string') throw new Error('taskId is required')
            mutation = { action, taskId: payload['taskId'] }
          } else {
            throw new Error(`unknown plan action "${action}"`)
          }
          const updated = await agentTeamsRuntime.updateStagedPlan(captain, teamId, mutation)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, phase: updated.phase, members: updated.members.length, tasks: updated.tasks.length }))
        } catch (error: unknown) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'plan operation failed' }))
        }
      },
    }), 'agent-teams: plan route')

  // Amber terminal mascot artwork plus the symbol packs: serve the packaged
  // role/action images to the activity panel. An explicit allowlist guards the
  // route (no path traversal); the images ship with the bundle (files:
  // assets/). The `-symbol` files are the standalone marks drawn in the small
  // corner badge, where the mascot art is too dense to read. The client appends
  // `?v=<pack revision>` to every URL, so this handler reads the path only and
  // a redrawn pack is a URL the browser has never cached.
  const artDir = fileURLToPath(new URL('../assets/agent-teams/', import.meta.url))
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/plugins/dsh-agent-teams/assets',
    handler: (req, res) => serveArtwork(artDir, req, res, message => ctx.logger.warn(message)),
  }), 'agent-teams: artwork route')
}

  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(name as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
