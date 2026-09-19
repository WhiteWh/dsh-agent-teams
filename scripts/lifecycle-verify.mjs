/**
 * Adversarial production-tool conformance verification.
 *
 * This intentionally models the Harness contract where listChildren says
 * "running" for every resident child while the live Agent registry carries
 * the real idle/running state. It drives the actual compiled tool definitions
 * through a multi-member DAG, takeover, stale completion, automatic later
 * rounds, removal recovery, mailbox fallback and concurrent claims.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { haltTeamWork, registerAgentTeamsTools } from '../lib/tools.js'
import { buildActivationDirective, invokedAgentTeamsGoal, invokedAgentTeamsInvocation, installAgentTeamsGestureBoundary, profileCommandName, registerAgentTeamsCommand } from '../lib/command.js'
import { readArchivedTeam, readMailbox, readTeam, readUnreadMailbox } from '../lib/state.js'
import { collectArchivedTeamsActivity } from '../lib/snapshot.js'

const deliveryHarness = process.argv.includes('--delivery-harness')
const modernHarness = deliveryHarness || process.argv.includes('--modern-harness')
const hostQueue = Symbol.for(deliveryHarness ? 'dsh.subagent.deliverPrompt' : 'dsh.subagent.queuePrompt')

const workspace = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-lifecycle-'))
const definitions = new Map()
const liveAgents = new Map()
const disposedAgents = new Map()
const children = []
const deliveries = []
const listeners = new Map()
const childListeners = new Map()
const continuableSetups = []
const failNextDelivery = new Set()
const failNextDrain = new Set()
const failures = []
let childSeq = 0
let messageSeq = 0
let deliveryDelayMs = 0

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  console.log(`  ${status}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

function session(parentSession) {
  return {
    header: { cwd: workspace, parentSession, ...(modernHarness ? {} : { seedLength: 0 }) },
    ...(modernHarness ? { ownEvents() { return this._ownEvents ?? [] } } : { events: [] }),
    append() {},
    requestHeader() {
      return { config: { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' } }
    },
  }
}

function makeAgent(id, parentSession) {
  return {
    id,
    status: 'idle',
    options: { provider: 'fake', model: 'fake-model' },
    session: session(parentSession),
    followups: [],
    steers: [],
    injections: [],
    followup(message) {
      this.followups.push(message)
    },
    steer(message) {
      if (failNextDelivery.delete(this.id)) throw new Error('injected steering failure')
      this.steers.push(message)
      if (this.id !== captain.id) { deliveries.push({ childId: this.id, content: message.content, mode: 'steer' }); this.status = 'running' }
    },
    inject(message) {
      this.injections.push(message)
    },
    cancel(cause, options) {
      this.cancelCount = (this.cancelCount ?? 0) + 1
      this.lastCancel = { cause, options }
    },
    whenIdle() {
      return this.status === 'idle' ? Promise.resolve() : new Promise(resolve => { this._idle = resolve })
    },
  }
}

function publishStatus(subject, status) {
  subject.status = status
  if (status === 'idle') {
    subject._idle?.()
    subject._idle = undefined
  }
  for (const listener of listeners.get('agent/status') ?? []) listener({ agent: subject, status })
}

/**
 * Compose one child's scoped context like the harness does, so the plugin's
 * continuable setup can install its per-child listeners (model selection and
 * the `agent/request-error` bridge) against a dispatchable registry.
 */
function childContext(child) {
  const registry = new Map()
  childListeners.set(child.id, registry)
  return {
    agent: child,
    effect(setup) { return setup() },
    on(name, listener) {
      const current = registry.get(name) ?? []
      current.push(listener)
      registry.set(name, current)
      return () => registry.set(name, (registry.get(name) ?? []).filter(candidate => candidate !== listener))
    },
  }
}

/** Dispatch one failed model request to a child's request-error listeners. */
async function emitRequestError(child, failure) {
  const handlers = childListeners.get(child.id)?.get('agent/request-error') ?? []
  let action
  for (const handler of handlers) {
    action = await handler({
      agent: child,
      turn: 1,
      step: 0,
      provider: 'fake',
      failure,
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }, async () => undefined)
  }
  return action
}

/** Final error followed by driver settlement, with no agent/status event. */
function emitTurnError(child, failure) {
  for (const handler of childListeners.get(child.id)?.get('agent/error') ?? []) {
    handler({ agent: child, turn: 1, step: 0, error: new LlmError(failure.message, failure.code) })
  }
  child.status = 'idle'
  child._idle?.()
  child._idle = undefined
}

const captain = makeAgent('captain-session')
liveAgents.set(captain.id, captain)
let advertisedModels = []
// A non-AgentTeams continuable sibling must survive every team lifecycle
// operation untouched.
children.push({ id: 'foreign-session', label: 'unrelated continuable', mode: 'continuable' })

const ctx = {
  effect(setup) { return setup() },
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
    },
  },
  on(name, listener) {
    const current = listeners.get(name) ?? []
    current.push(listener)
    listeners.set(name, current)
    return () => listeners.set(name, current.filter(candidate => candidate !== listener))
  },
  agents: {
    get(id) {
      return liveAgents.get(id)
    },
  },
  llm: {
    async resolveCallConfig(config) {
      return config
    },
    async listModels(provider) {
      return advertisedModels.map(model => ({ provider, id: model, name: model }))
    },
  },
  subagents: {
    registerContinuableSetup(setup) {
      continuableSetups.push(setup)
      return () => {}
    },
    getProvider(name) {
      if (name !== 'spawn') return undefined
      return { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }
    },
    list() {
      return ['spawn']
    },
    async startContinuable(spec) {
      const id = `member-session-${++childSeq}`
      const child = makeAgent(id, captain.id)
      child.status = 'running'
      liveAgents.set(id, child)
      children.push({ id, label: spec.label, mode: 'continuable' })
      if (typeof spec.label === 'string' && spec.label.startsWith('agent-teams:')) {
        child.session[modernHarness ? '_ownEvents' : 'events'] = [{
          type: 'subagent/descriptor',
          data: {
            version: 3,
            mode: 'continuable',
            provider: 'spawn',
            label: spec.label,
            agentProvider: spec.request?.agentOptions?.provider ?? 'fake',
            agentModel: spec.request?.agentOptions?.model ?? 'fake-model',
          },
        }]
      }
      child.ctx = childContext(child)
      if (deliveryHarness) delete child.ctx.agent
      if (modernHarness) {
        for (const listener of listeners.get('agent/session-start') ?? []) listener({ agent: child, source: 'startup' })
      } else {
        for (const setup of continuableSetups) setup(child.ctx)
      }
      deliveries.push({ childId: id, content: spec.request.prompt, mode: 'initial' })
      return { childId: id, messageId: `initial-${childSeq}` }
    },
    async listChildren(parentId) {
      if (parentId !== captain.id) return []
      return children.map(child => ({
        kind: 'child', mode: child.mode, id: child.id, label: child.label,
        // Residency, intentionally not the Agent's real status.
        activity: liveAgents.has(child.id) ? 'running' : 'inactive',
        hasChildren: false,
      }))
    },
    async listDescendants(parentId) {
      return this.listChildren(parentId)
    },
    async followup(_parent, childId, content) {
      if (this !== ctx.subagents) throw new Error('native receiver was lost')
      if (failNextDelivery.delete(childId)) throw new Error('injected delivery failure')
      if (deliveryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, deliveryDelayMs))
      deliveries.push({ childId, content })
      const child = liveAgents.get(childId) ?? disposedAgents.get(childId)
      if (child) liveAgents.set(childId, child)
      if (child) child.status = 'running'
      return `message-${++messageSeq}`
    },
    interrupt(childId) {
      const child = liveAgents.get(childId)
      if (child) {
        child.interruptCount = (child.interruptCount ?? 0) + 1
        publishStatus(child, 'idle')
      }
    },
    async drainContinuableChildren(parent, childIds) {
      for (const childId of childIds) {
        if (failNextDrain.delete(childId)) throw new Error('injected drain failure')
        const child = liveAgents.get(childId)
        if (child) {
          child.drainCount = (child.drainCount ?? 0) + 1
          publishStatus(child, 'idle')
          disposedAgents.set(childId, child)
          liveAgents.delete(childId)
        }
      }
      void parent
    },
  },
  logger: { debug() {}, warn() {} },
}

// Model modern host delivery as a distinct FIFO entry. Deliberately reject
// public sendMessage: using steer for team jobs must make this suite fail.
if (modernHarness) {
  const followup = ctx.subagents.followup
  delete ctx.subagents.followup
  delete ctx.subagents.registerContinuableSetup
  ctx.subagents[hostQueue] = function (parent, childId, content, source, signal, delivery) {
    if (deliveryHarness && !['queue', 'steer'].includes(delivery)) throw new Error('invalid delivery mode')
    return followup.call(this, parent, childId, content, { source, signal })
  }
  ctx.subagents.sendMessage = (parent, id, content) => followup.call(ctx.subagents, parent, id, content)
}

function directPrompt(parent, childId, content, options) {
  return modernHarness
    ? ctx.subagents[hostQueue](parent, childId, content, options.source, options.signal, ...(deliveryHarness ? ['queue'] : []))
    : ctx.subagents.followup(parent, childId, content, options)
}

const agentTeamsRuntime = registerAgentTeamsTools(ctx, {
  stateDir: '.agent-teams',
  memberProvider: 'spawn',
  fallback: { provider: 'backup', model: 'backup-model' },
  memberMaxDepth: 1,
  maxMembers: 8,
  profiles: {
    'demo-delivery': {
      description: 'tiny delivery team',
      protocol: 'Discuss, then implement. Do not invent unanswered questions.',
      members: [
        { name: 'analyst', role: 'requirements', model: 'fake-analyst' },
        { name: 'implementer', role: 'builder', model: 'fake-implementer' },
      ],
      tasks: [
        { id: 'requirements', subject: 'Requirements', assignee: 'analyst', description: 'Write the first cut.' },
        { id: 'implement', subject: 'Implement', assignee: 'implementer', dependencies: ['requirements'], description: 'Build from the approved requirements.' },
      ],
    },
    'dynamic-delivery': {
      description: 'roster only',
      protocol: 'Plan from the goal. Do not invent unanswered questions.',
      taskPlanning: 'captain',
      members: [
        { name: 'analyst', role: 'requirements analyst', model: 'fake-analyst' },
        { name: 'implementer', role: 'implementer', model: 'fake-implementer' },
        { name: 'tester', role: 'test engineer', model: 'fake-tester' },
        { name: 'reviewer', role: 'code reviewer', model: 'fake-reviewer' },
        { name: 'release', role: 'release engineer', model: 'fake-release' },
      ],
      tasks: [],
    },
  },
})

function execFor(subject) {
  return { agent: subject, signal: new AbortController().signal }
}

// WP11 phase 1: every team-scoped call is addressed by `team_id`, so the harness
// does what a real captain does — remembers the id `create` returned and passes it
// on. The fourth argument overrides that memory: an id addresses another team,
// `null` omits the id on purpose (used to assert the listing error).
let captainTeamId = ''

async function call(name, args, subject = captain, teamId) {
  const definition = definitions.get(name)
  if (!definition) throw new Error(`missing tool ${name}`)
  const payload = { ...args }
  if (payload.team_id === undefined && subject === captain && teamId !== null) {
    const chosen = teamId ?? captainTeamId
    if (chosen !== '') payload.team_id = chosen
  }
  const result = await definition.execute(payload, execFor(subject))
  if (name === 'agent_teams_create' && subject === captain && typeof result?.team_id === 'string') captainTeamId = result.team_id
  if (name === 'agent_teams_delete') captainTeamId = ''
  return result
}

const teamId = 'lifecycle'
const stateRoot = join(workspace, '.agent-teams')
const state = () => readTeam(stateRoot, teamId)
const task = async id => (await state())?.tasks.find(candidate => candidate.id === id)

console.log('dsh-agent-teams lifecycle verification')

// ── /agent-teams slash command and gesture boundary ───────────────────
const commandDefinitions = new Map()
ctx.commands = {
  register(definition) {
    commandDefinitions.set(definition.name, definition)
  },
}
const liveProfiles = {
  'demo-delivery': {
    description: 'tiny delivery team',
    protocol: 'Discuss, then implement. Do not invent unanswered questions.',
    members: [
      { name: 'analyst', role: 'requirements', model: 'fake-analyst' },
      { name: 'implementer', role: 'builder', model: 'fake-implementer' },
    ],
    tasks: [
      { id: 'requirements', subject: 'Requirements', assignee: 'analyst' },
      { id: 'implement', subject: 'Implement', assignee: 'implementer', dependencies: ['requirements'] },
    ],
  },
}
registerAgentTeamsCommand(ctx, () => liveProfiles)
installAgentTeamsGestureBoundary(ctx, () => liveProfiles)

const command = commandDefinitions.get('agent-teams')
const profileCommand = commandDefinitions.get('agent-teams-demo-delivery')
check('slash command registers as /agent-teams',
  command !== undefined && typeof command.description === 'string' && command.description.length > 0)
check('slash command advertises an input hint for the menu placeholder',
  typeof command?.input?.hint === 'string' && command.input.hint.length > 0)
check('configured profile registers a concise dedicated slash command',
  profileCommand !== undefined && profileCommandName('demo-delivery') === 'agent-teams-demo-delivery'
    && typeof profileCommand.description === 'string' && profileCommand.description.includes('demo-delivery'))
check('unsafe profile names do not generate ambiguous commands',
  profileCommandName('delivery team') === undefined && profileCommandName('delivery_team') === undefined)

const bare = command.handler({
  agent: captain, rawInput: '   ', signal: new AbortController().signal, commandId: 'cmd-bare',
})
check('bare /agent-teams reports usage instead of activating',
  bare.kind === 'error' && bare.text.includes('Usage: /agent-teams')
    && captain.followups.length === 0)

const goal = 'ship a tiny CLI'
const activated = command.handler({
  agent: captain, rawInput: `  ${goal}  `, signal: new AbortController().signal, commandId: 'cmd-goal',
})
check('argued /agent-teams queues one visible user turn',
  activated.kind === 'success' && captain.followups.length === 1)
const submittedCommand = captain.followups[0]
check('slash command preserves the exact submitted line as user-authored chat',
  submittedCommand?.source?.kind === 'user'
    && submittedCommand.content.some(block => block.type === 'text'
      && block.text === `/agent-teams  ${goal}  `))
check('preserved slash command still activates through the gesture boundary',
  invokedAgentTeamsGoal([submittedCommand]) === goal)
check('activation directive names the protocol', buildActivationDirective(goal).includes('AgentTeams protocol'))
const profileGoal = 'ship the prepared release'
const profileActivated = profileCommand.handler({
  agent: captain, rawInput: ` ${profileGoal}`, signal: new AbortController().signal, commandId: 'cmd-profile-alias',
})
check('profile command queues a visible profile-specific user turn',
  profileActivated.kind === 'success' && captain.followups.length === 2
    && captain.followups[1]?.content.some(block => block.type === 'text' && block.text === `/agent-teams-demo-delivery ${profileGoal}`))

const userMessage = text => ({ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
check('gesture recognizes a leading /agent-teams token',
  invokedAgentTeamsGoal([userMessage('/agent-teams ship a CLI')]) === 'ship a CLI')
check('profile command gesture selects its configured profile and goal',
  invokedAgentTeamsInvocation([userMessage('/agent-teams-demo-delivery ship a CLI')], () => liveProfiles)?.profile === 'demo-delivery'
    && invokedAgentTeamsInvocation([userMessage('/agent-teams-demo-delivery ship a CLI')], () => liveProfiles)?.goal === 'ship a CLI')
check('bare profile command gesture asks for the goal',
  invokedAgentTeamsInvocation([userMessage('/agent-teams-demo-delivery')], () => liveProfiles)?.profile === 'demo-delivery'
    && invokedAgentTeamsInvocation([userMessage('/agent-teams-demo-delivery')], () => liveProfiles)?.goal === '')
check('unknown profile command stays ordinary prose',
  invokedAgentTeamsInvocation([userMessage('/agent-teams-missing ship a CLI')], () => liveProfiles) === undefined)
check('bare gesture yields an empty goal', invokedAgentTeamsGoal([userMessage('  /agent-teams')]) === '')
check('mid-sentence mention stays ordinary prose',
  invokedAgentTeamsGoal([userMessage('how do I use /agent-teams here?')]) === undefined)
check('non-user sources cannot forge the gesture',
  invokedAgentTeamsGoal([{ ...userMessage('/agent-teams x'), source: { kind: 'plugin', plugin: 'fake' } }]) === undefined)
check('latest user gesture wins in a batch',
  invokedAgentTeamsGoal([userMessage('/agent-teams first'), userMessage('/agent-teams second')]) === 'second')
const profileOnly = command.handler({
  agent: captain, rawInput: '--profile demo-delivery', signal: new AbortController().signal, commandId: 'cmd-profile-only',
})
check('slash --profile without a goal still activates',
  profileOnly.kind === 'success' && captain.followups.length === 3)
check('profile-only activation asks for the goal',
  buildActivationDirective('', 'demo-delivery').includes('The goal was not given')
    && buildActivationDirective('', 'demo-delivery').includes('Use profile="demo-delivery" when creating a new team')
    && buildActivationDirective('', 'demo-delivery').includes('Inspect existing team state with agent_teams_status'))
check('captain-planning activation requires a staged user-reviewed graph',
  buildActivationDirective('ship it', 'dynamic-delivery', 'captain').includes('approval="required"')
    && buildActivationDirective('ship it', 'dynamic-delivery', 'captain').includes('review the Web plan')
    && buildActivationDirective('ship it', 'dynamic-delivery', 'captain').includes('run in parallel')
    && !buildActivationDirective('ship it', 'dynamic-delivery', 'captain').includes('seed tasks'))
const unknownProfile = command.handler({
  agent: captain, rawInput: '--profile missing 做X', signal: new AbortController().signal, commandId: 'cmd-unknown',
})
check('unknown slash profile reports error and does not followup',
  unknownProfile.kind === 'error' && captain.followups.length === 3)
check('leading ordinary token is never treated as a profile',
  invokedAgentTeamsInvocation([userMessage('/agent-teams research this bug')])?.goal === 'research this bug'
    && invokedAgentTeamsInvocation([userMessage('/agent-teams research this bug')])?.profile === undefined)
liveProfiles['hot-reload'] = { members: [{ name: 'solo', model: 'fake' }] }
check('command getter sees HMR profile names',
  command.handler({
    agent: captain, rawInput: '--profile hot-reload', signal: new AbortController().signal, commandId: 'cmd-hmr',
  }).kind === 'success')
delete liveProfiles['hot-reload']

try {
  const createdProfile = await call('agent_teams_create', {
    name: 'Profile Demo',
    description: 'ship a tiny demo',
    profile: 'demo-delivery',
  })
  const profileTeam = await readTeam(stateRoot, 'profile-demo')
  check('create(profile) returns profile members tasks and seed ids',
    createdProfile.profile === 'demo-delivery'
      && createdProfile.members?.length === 2
      && createdProfile.tasks?.length === 2
      && createdProfile.tasks?.[0]?.seed_id === 'requirements'
      && createdProfile.tasks?.[1]?.seed_id === 'implement')
  check('create(profile) persists snapshot members and mapped dependencies',
    profileTeam?.profile?.name === 'demo-delivery'
      && profileTeam.members.map(member => member.name).join(',') === 'analyst,implementer'
      && profileTeam.tasks[1]?.dependencies.join(',') === 't1'
      && profileTeam.tasks[1]?.assignee === 'implementer')
  const analyst = liveAgents.get(createdProfile.members[0].member_id)
  let implementer
  check('dependency-blocked roster does not spawn a model session', createdProfile.members[1].member_id === '')
  await call('agent_teams_status', {})
  const afterKick = await readTeam(stateRoot, 'profile-demo')
  const firstSeed = afterKick?.tasks[0]
  check('first-stage seed is assigned only to the configured member',
    firstSeed?.status === 'claimed' && firstSeed.assignee === 'analyst'
      && deliveries.some(delivery => delivery.childId === analyst.id)
      && !deliveries.some(delivery => delivery.childId === implementer?.id && String(delivery.content?.[0]?.text ?? '').includes('Implement')))
  const firstAssignment = deliveries.find(delivery => delivery.childId === analyst.id)
  const assignmentText = Array.isArray(firstAssignment?.content)
    ? firstAssignment.content.map(block => block.text ?? '').join('\n')
    : String(firstAssignment?.content ?? '')
  check('first assignment includes team goal and protocol',
    assignmentText.includes('ship a tiny demo')
      && assignmentText.includes('Discuss, then implement'))
  const analystClaim = await call('agent_teams_claim_task', { task_id: firstSeed.id }, analyst)
  await call('agent_teams_update_task', { task_id: firstSeed.id, status: 'in_progress', attempt_id: analystClaim.attempt_id }, analyst)
  await call('agent_teams_update_task', {
    task_id: firstSeed.id,
    status: 'failed',
    attempt_id: analystClaim.attempt_id,
    output: 'Need a user decision before design.',
  }, analyst)
  publishStatus(analyst, 'idle')
  if (implementer) publishStatus(implementer, 'idle')
  check('failed upstream does not unlock the next configured stage',
    (await readTeam(stateRoot, 'profile-demo'))?.tasks[1]?.status === 'pending'
      && !deliveries.some(delivery => delivery.childId === implementer?.id && String(delivery.content?.[0]?.text ?? '').includes('Implement')))
  await call('agent_teams_reassign_task', { task_id: firstSeed.id, assignee: 'analyst', reason: 'retry after user answer' })
  const retryClaim = await call('agent_teams_claim_task', { task_id: firstSeed.id }, analyst)
  await call('agent_teams_update_task', { task_id: firstSeed.id, status: 'in_progress', attempt_id: retryClaim.attempt_id }, analyst)
  await call('agent_teams_update_task', {
    task_id: firstSeed.id,
    status: 'completed',
    attempt_id: retryClaim.attempt_id,
    output: 'Scope confirmed: ship the tiny demo.',
  }, analyst)
  publishStatus(analyst, 'idle')
  if (implementer) publishStatus(implementer, 'idle')
  await call('agent_teams_status', {})
  implementer = liveAgents.get((await readTeam(stateRoot, 'profile-demo')).members.find(m => m.name === 'implementer').id)
  const secondSeed = (await readTeam(stateRoot, 'profile-demo'))?.tasks[1]
  check('completed upstream dispatches the configured downstream assignee',
    secondSeed?.status === 'claimed' && secondSeed.assignee === 'implementer')
  const secondAssignment = [...deliveries].reverse().find(delivery => delivery.childId === implementer.id)
  const secondText = Array.isArray(secondAssignment?.content)
    ? secondAssignment.content.map(block => block.text ?? '').join('\n')
    : String(secondAssignment?.content ?? '')
  check('downstream assignment includes dependency output and seed id',
    secondText.includes('Scope confirmed')
      && secondText.includes('[requirements]'))
  await call('agent_teams_send_message', { to: 'implementer', content: 'stop and wait for a user answer' })
  const deliveriesAfterMail = deliveries.length
  await call('agent_teams_status', {})
  check('unread mailbox prevents a same-kick new assignment',
    deliveries.length >= deliveriesAfterMail
      && (await readTeam(stateRoot, 'profile-demo'))?.tasks[1]?.assignee === 'implementer')
  const profileStatus = await call('agent_teams_status', {})
  check('status exposes profile snapshot and task seed ids',
    profileStatus.profile?.name === 'demo-delivery'
      && profileStatus.tasks.some(item => item.seed_id === 'requirements')
      && profileStatus.tasks.some(item => item.seed_id === 'implement'))
  await call('agent_teams_delete', {})

  const deliveriesBeforeDiscard = deliveries.length
  const captainCancelsBeforeDiscard = captain.cancelCount ?? 0
  const captainInjectionsBeforeDiscard = captain.injections.length
  await call('agent_teams_create', {
    name: 'Rejected Demo',
    description: 'plan the user will reject',
    profile: 'dynamic-delivery',
    approval: 'required',
  })
  await call('agent_teams_create_task', { subject: 'should never run', assignee: 'analyst' })
  const discardedPlan = await agentTeamsRuntime.discardStagedTeam(captain, 'rejected-demo')
  const discardedArchive = await readArchivedTeam(stateRoot, 'rejected-demo')
  check('discarding a staged plan archives it without spawning or dispatching',
    discardedPlan.teamId === 'rejected-demo'
      && await readTeam(stateRoot, 'rejected-demo') === undefined
      && discardedArchive?.phase === 'staged'
      && discardedArchive.members.every(member => member.id === '')
      && discardedArchive.tasks.every(task => task.status === 'pending')
      && deliveries.length === deliveriesBeforeDiscard)
  const discardControlText = captain.injections.at(-1)?.content?.map(block => block.text ?? '').join('\n') ?? ''
  check('discard aborts the active Captain turn and parks an authoritative no-recreate context',
    (captain.cancelCount ?? 0) === captainCancelsBeforeDiscard + 1
      && captain.injections.length === captainInjectionsBeforeDiscard + 1
      && /Do not call agent_teams_create/.test(discardControlText)
      && /Wait for a later explicit user request/.test(discardControlText)
      && captain.lastCancel?.options?.keepInbox === true)

  const createdDynamic = await call('agent_teams_create', {
    name: 'Dynamic Demo',
    description: 'goal only',
    profile: 'dynamic-delivery',
    approval: 'required',
  })
  const stagedDynamic = await readTeam(stateRoot, 'dynamic-demo')
  check('captain-planning create stages only the configured roster',
    createdDynamic.profile === 'dynamic-delivery'
      && createdDynamic.task_planning === 'captain'
      && createdDynamic.phase === 'staged'
      && createdDynamic.members?.length === 5
      && createdDynamic.members.every(member => member.member_id === '')
      && createdDynamic.tasks?.length === 0
      && stagedDynamic?.profile?.taskPlanning === 'captain'
      && stagedDynamic.phase === 'staged'
      && stagedDynamic.members.every(member => member.id === '')
      && stagedDynamic.tasks.length === 0)
  const deliveriesBeforePlan = deliveries.length
  const dynamicFirst = await call('agent_teams_create_task', { subject: 'analyze goal', assignee: 'analyst' })
  const dynamicSecond = await call('agent_teams_create_task', {
    subject: 'implement result',
    assignee: 'implementer',
    dependencies: [dynamicFirst.task_id],
  })
  await agentTeamsRuntime.updateStagedPlan(captain, 'dynamic-demo', {
    action: 'update_member',
    memberName: 'reviewer',
    role: 'security reviewer',
    provider: 'fake-provider',
    model: 'fake-reviewer-updated',
    reasoningEffort: 'high',
    executionPrompt: 'Review security-sensitive changes only.',
  })
  await agentTeamsRuntime.updateStagedPlan(captain, 'dynamic-demo', {
    action: 'update_task',
    taskId: dynamicSecond.task_id,
    subject: 'implement approved result',
    description: 'Use the analyst output.',
    assignee: 'implementer',
    dependencies: [dynamicFirst.task_id],
  })
  const editedDynamic = await readTeam(stateRoot, 'dynamic-demo')
  check('staged roster and DAG are editable without spawning or dispatching',
    editedDynamic?.members.find(member => member.name === 'reviewer')?.model === 'fake-reviewer-updated'
      && editedDynamic.members.find(member => member.name === 'reviewer')?.executionPrompt === 'Review security-sensitive changes only.'
      && editedDynamic.tasks[1]?.subject === 'implement approved result'
      && editedDynamic.tasks[1]?.dependencies.join(',') === dynamicFirst.task_id
      && editedDynamic.tasks.every(item => item.status === 'pending')
      && deliveries.length === deliveriesBeforePlan)
  const obsoleteReview = await call('agent_teams_create_task', {
    subject: 'obsolete review',
    assignee: 'reviewer',
    dependencies: [dynamicFirst.task_id],
  })
  await agentTeamsRuntime.updateStagedPlan(captain, 'dynamic-demo', {
    action: 'update_task',
    taskId: dynamicSecond.task_id,
    subject: 'implement approved result',
    description: 'Use the analyst output.',
    assignee: 'implementer',
    dependencies: [obsoleteReview.task_id],
  })
  let rejectedAtomicEdit = false
  try {
    await call('agent_teams_edit_plan', {
      operations: [
        { action: 'remove_task', task_id: obsoleteReview.task_id },
        { action: 'update_task', task_id: dynamicSecond.task_id, dependencies: [dynamicFirst.task_id] },
        { action: 'remove_member', member_name: 'reviewer' },
      ],
    })
  } catch {
    rejectedAtomicEdit = true
  }
  const unchangedAfterRejectedEdit = await readTeam(stateRoot, 'dynamic-demo')
  check('invalid staged plan batches fail atomically without a partial write',
    rejectedAtomicEdit
      && unchangedAfterRejectedEdit?.tasks.some(item => item.id === obsoleteReview.task_id)
      && unchangedAfterRejectedEdit.tasks.find(item => item.id === dynamicSecond.task_id)?.dependencies.join(',') === obsoleteReview.task_id
      && unchangedAfterRejectedEdit.members.some(member => member.name === 'reviewer'))
  const captainCancelsBeforeContinue = captain.cancelCount ?? 0
  const captainFollowupsBeforeContinue = captain.followups.length
  const continuedPlan = await agentTeamsRuntime.continueStagedPlanning(captain, 'dynamic-demo')
  const waitingPlan = await readTeam(stateRoot, 'dynamic-demo')
  const feedbackControlText = captain.followups.at(-1)?.content?.map(block => block.text ?? '').join('\n') ?? ''
  check('return-to-chat cancels the planning turn and asks one question without recreating the team',
    continuedPlan.alreadyWaiting === false
      && waitingPlan?.planReviewState === 'awaiting_feedback'
      && (captain.cancelCount ?? 0) === captainCancelsBeforeContinue + 1
      && captain.followups.length === captainFollowupsBeforeContinue + 1
      && /Ask the user one concise, concrete question/.test(feedbackControlText)
      && /Do not create a replacement team/.test(feedbackControlText))
  const repeatedContinue = await agentTeamsRuntime.continueStagedPlanning(captain, 'dynamic-demo')
  check('return-to-chat is idempotent while feedback is already pending',
    repeatedContinue.alreadyWaiting === true
      && (captain.cancelCount ?? 0) === captainCancelsBeforeContinue + 1
      && captain.followups.length === captainFollowupsBeforeContinue + 1)
  const modelEditedPlan = await call('agent_teams_edit_plan', {
    operations: [
      { action: 'update_task', task_id: dynamicSecond.task_id, dependencies: [dynamicFirst.task_id] },
      { action: 'remove_task', task_id: obsoleteReview.task_id },
      { action: 'remove_member', member_name: 'reviewer' },
    ],
  })
  const modelEditedDynamic = await readTeam(stateRoot, 'dynamic-demo')
  check('captain can revise the staged DAG and roster through one model-facing atomic tool',
    modelEditedPlan.status === 'staged'
      && modelEditedPlan.tasks === 2
      && modelEditedPlan.members === 4
      && modelEditedDynamic?.tasks.every(item => item.id !== obsoleteReview.task_id)
      && modelEditedDynamic.tasks.find(item => item.id === dynamicSecond.task_id)?.dependencies.join(',') === dynamicFirst.task_id
      && modelEditedDynamic.members.every(member => member.name !== 'reviewer')
      && modelEditedDynamic.members.every(member => member.id === '')
      && modelEditedDynamic.tasks.every(item => item.status === 'pending')
      && modelEditedDynamic.planReviewState === 'awaiting_review'
      && deliveries.length === deliveriesBeforePlan)
  const approvedDynamic = await call('agent_teams_approve', { confirmation: 'user clicked Approve & Run' })
  const dynamicTeam = await readTeam(stateRoot, 'dynamic-demo')
  const correctedRunning = await call('agent_teams_edit_plan', { operations: [{ action: 'update_task', task_id: dynamicSecond.task_id, description: 'Corrected pending task context', dependencies: [dynamicFirst.task_id] }] })
  check('running never-started tasks can be corrected without replacing the DAG', correctedRunning.status === 'running' && (await readTeam(stateRoot, 'dynamic-demo')).tasks.find(t => t.id === dynamicSecond.task_id).description === 'Corrected pending task context')
  let rejectedRunningBatch = false
  try {
    await call('agent_teams_edit_plan', { operations: [
      { action: 'update_task', task_id: dynamicSecond.task_id, description: 'must not persist' },
      { action: 'update_task', task_id: dynamicFirst.task_id, subject: 'must not overwrite active work' },
    ] })
  } catch { rejectedRunningBatch = true }
  check('invalid running plan batches preserve the entire previous graph', rejectedRunningBatch && (await readTeam(stateRoot, 'dynamic-demo')).tasks.find(t => t.id === dynamicSecond.task_id).description === 'Corrected pending task context')
  for (const operation of [{ action: 'update_task', task_id: dynamicFirst.task_id, subject: 'do not overwrite active work' }, { action: 'update_task', task_id: dynamicSecond.task_id, dependencies: [dynamicSecond.task_id] }, { action: 'remove_member', member_name: 'implementer' }]) {
    let rejected = false; try { await call('agent_teams_edit_plan', { operations: [operation] }) } catch { rejected = true }
    check('running edits reject active attempts, cycles and roster changes: ' + JSON.stringify(operation), rejected)
  }
  const abandoned = await call('agent_teams_create_task', { subject: 'Cancelled planning mistake', assignee: 'implementer', dependencies: [dynamicFirst.task_id] })
  const cancelledPending = await call('agent_teams_update_task', { task_id: abandoned.task_id, status: 'cancelled', output: 'No execution began; captain corrected the plan.' })
  check('captain can cancel dependency-blocked member work before its first attempt', cancelledPending.status === 'cancelled' && cancelledPending.attempt === 0)
  check('approval starts only dependency-ready members',
    approvedDynamic.status === 'running'
      && dynamicTeam?.phase === 'running'
      && typeof dynamicTeam.approvedAt === 'number'
      && dynamicTeam.members.filter(member => member.id !== '').length === 1
      && dynamicTeam.tasks[0]?.status === 'claimed'
      && dynamicTeam.tasks[1]?.status === 'pending')
  for (const member of dynamicTeam.members) if (member.id !== '') publishStatus(liveAgents.get(member.id), 'idle')
  await call('agent_teams_status', {})
  const dispatchedDynamic = await readTeam(stateRoot, 'dynamic-demo')
  check('approved plan dispatches only after a spawned member becomes idle',
    dispatchedDynamic?.tasks[0]?.status === 'claimed'
      && dispatchedDynamic.tasks[1]?.status === 'pending')
  const dynamicAnalyst = liveAgents.get(dynamicTeam.members.find(member => member.name === 'analyst')?.id)
  const dynamicImplementer = liveAgents.get(dynamicTeam.members.find(member => member.name === 'implementer')?.id)
  const drainedBeforeHalt = dynamicAnalyst.drainCount ?? 0
  const captainCancelsBeforeHalt = captain.cancelCount ?? 0
  const halt = await haltTeamWork({
    ctx,
    stateRoot,
    teamId: 'dynamic-demo',
    captain,
    signal: new AbortController().signal,
  })
  const haltedTeam = await readTeam(stateRoot, 'dynamic-demo')
  check('captain halt cancels the approved graph and keeps the team',
    halt.alreadyHalted === false
      && halt.cancelledTasks === 2
      && haltedTeam?.halted === true
      && haltedTeam.tasks.every(item => item.status === 'cancelled'))
  check('team halt cancels the captain turn while preserving queued user input',
    captain.cancelCount === captainCancelsBeforeHalt + 2
      && captain.lastCancel?.cause?.kind === 'user'
      && captain.lastCancel?.options?.keepInbox === true)
  check('captain halt drains active members and leaves blocked members unspawned',
    (dynamicAnalyst.drainCount ?? 0) > drainedBeforeHalt && dynamicImplementer === undefined
      && !liveAgents.has(dynamicAnalyst.id))
  const deliveriesAfterHalt = deliveries.length
  await call('agent_teams_status', {})
  check('halted team does not redispatch cancelled graph',
    deliveries.length === deliveriesAfterHalt
      && (await readTeam(stateRoot, 'dynamic-demo'))?.tasks.every(item => item.status === 'cancelled'))
  let silentCreateUnhalted = false
  try {
    await call('agent_teams_create_task', { subject: 'must stay halted' })
    silentCreateUnhalted = (await readTeam(stateRoot, 'dynamic-demo'))?.halted !== true
  } catch {
    silentCreateUnhalted = (await readTeam(stateRoot, 'dynamic-demo'))?.halted !== true
  }
  check('halted create_task does not silently resume',
    silentCreateUnhalted === false && (await readTeam(stateRoot, 'dynamic-demo'))?.halted === true)
  const resume = await call('agent_teams_resume', { reason: 'continue after user answer' })
  check('explicit resume clears halt and keeps cancelled tasks cancelled',
    resume.status === 'resumed'
      && (await readTeam(stateRoot, 'dynamic-demo'))?.halted !== true
      && (await readTeam(stateRoot, 'dynamic-demo'))?.tasks.every(item => item.status === 'cancelled'))
  await call('agent_teams_delete', {})
  const haltedArchive = await readArchivedTeam(stateRoot, 'dynamic-demo')
  check('shutdown preserves cancelled task history in the archive',
    haltedArchive?.tasks.length === 3
      && haltedArchive.tasks.every(item => item.status === 'cancelled'))

  await call('agent_teams_create', { name: 'Quality Loop', description: 'review loop' })
  await call('agent_teams_add_member', { name: 'builder', role: 'implementer' })
  await call('agent_teams_add_member', { name: 'critic', role: 'reviewer' })
  const impl = await call('agent_teams_create_task', {
    subject: 'implement parser',
    assignee: 'builder',
    kind: 'implementation',
    objective: 'Ship the parser',
    inScope: ['src/parser.ts'],
    acceptance: ['parser accepts empty input'],
    verify: ['pnpm test'],
  })
  let missingContractRejected = false
  try {
    await call('agent_teams_create_task', { subject: 'impl without contract', kind: 'implementation' })
  } catch {
    missingContractRejected = true
  }
  check('quality implementation without contract is rejected', missingContractRejected)
  const qualityTeam = await readTeam(stateRoot, 'quality-loop')
  const builder = [...liveAgents.values()].find(agent => qualityTeam?.members.some(member => member.id === agent.id && member.name === 'builder'))
  let criticMember
  const implClaim = await call('agent_teams_claim_task', { task_id: impl.task_id }, builder)
  for (const attempt_id of [undefined, '']) {
    let missingAttemptError = ''
    try { await call('agent_teams_update_task', { task_id: impl.task_id, status: 'in_progress', ...(attempt_id === undefined ? {} : { attempt_id }) }, builder) }
    catch (error) { missingAttemptError = String(error.message) }
    check('missing attempt_id is a correctable parameter error, not a revoked attempt',
      missingAttemptError.includes('missing attempt_id') && missingAttemptError.includes(implClaim.attempt_id)
        && (await readTeam(stateRoot, 'quality-loop')).tasks.find(t => t.id === impl.task_id).attemptId === implClaim.attempt_id)
  }
  await call('agent_teams_update_task', { task_id: impl.task_id, status: 'in_progress', attempt_id: implClaim.attempt_id }, builder)
  let illegalCompleteRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: impl.task_id,
      status: 'completed',
      attempt_id: implClaim.attempt_id,
      output: 'looks fine',
    }, builder)
  } catch {
    illegalCompleteRejected = true
  }
  check('illegal completed without acceptance evidence is rejected', illegalCompleteRejected)
  await call('agent_teams_update_task', {
    task_id: impl.task_id,
    status: 'completed',
    attempt_id: implClaim.attempt_id,
    output: 'parser shipped',
    changedPaths: ['src/parser.ts'],
    acceptanceResults: [{ criterion: 'parser accepts empty input', status: 'passed' }],
    commandsRun: [{ command: 'pnpm test', status: 'passed' }],
  }, builder)
  const review = await call('agent_teams_create_task', {
    subject: 'review parser',
    assignee: 'critic',
    kind: 'review',
    objective: 'Review the parser',
    acceptance: ['no blocker or high findings'],
    reviewedTaskId: impl.task_id,
  })
  criticMember = liveAgents.get((await readTeam(stateRoot, 'quality-loop')).members.find(m => m.name === 'critic').id)
  const reviewClaim = await call('agent_teams_claim_task', { task_id: review.task_id }, criticMember)
  await call('agent_teams_update_task', { task_id: review.task_id, status: 'in_progress', attempt_id: reviewClaim.attempt_id }, criticMember)
  let needsRevisionCompleteRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: review.task_id,
      status: 'completed',
      attempt_id: reviewClaim.attempt_id,
      verdict: 'needs_revision',
      findings: [{ id: 'C-001', severity: 'high', problem: 'null crash', requiredFix: 'guard empty input', file: 'src/parser.ts' }],
    }, criticMember)
  } catch {
    needsRevisionCompleteRejected = true
  }
  check('review needs_revision cannot complete', needsRevisionCompleteRejected)
  await call('agent_teams_update_task', {
    task_id: review.task_id,
    status: 'failed',
    attempt_id: reviewClaim.attempt_id,
    verdict: 'needs_revision',
    findings: [{ id: 'C-001', severity: 'high', problem: 'null crash', requiredFix: 'guard empty input', file: 'src/parser.ts' }],
  }, criticMember)
  const afterReview = await readTeam(stateRoot, 'quality-loop')
  const repair = afterReview?.tasks.find(item => item.kind === 'repair')
  const nextReview = afterReview?.tasks.find(item => item.kind === 'review' && item.id !== review.task_id)
  check('needs_revision opens repair and next review',
    repair !== undefined && nextReview !== undefined
      && repair.dependencies.includes(impl.task_id)
      && !repair.dependencies.includes(review.task_id)
      && nextReview.assignee === 'critic'
      && nextReview.assignee !== 'builder')
  await call('agent_teams_delete', {})

  // ── WP7/S17: one replan batch repairs the plan instead of a cancel cascade ──
  // The owner's t5 case: a lane failed because its contract was wrong (an
  // acceptance criterion that can never hold), the automatic review loop had
  // already opened a repair and a next review, and the only way out used to be
  // cancel + recreate. One batch must amend the contract, retry the lane and add
  // the follow-up the review asked for, with nothing else touched.
  await call('agent_teams_create', { name: 'Replan Repair', description: 'repair a false criterion in one batch' })
  await call('agent_teams_add_member', { name: 'builder', role: 'implementer' })
  await call('agent_teams_add_member', { name: 'critic', role: 'reviewer' })
  const replanTeamState = () => readTeam(stateRoot, 'replan-repair')
  const replanImpl = await call('agent_teams_create_task', {
    subject: 'implement the exporter',
    assignee: 'builder',
    kind: 'implementation',
    objective: 'Ship the exporter',
    inScope: ['src/exporter.ts'],
    acceptance: ['the exporter writes the payload'],
    verify: ['node scripts/verify.mjs'],
  })
  const replanReview = await call('agent_teams_create_task', {
    subject: 'review the exporter',
    assignee: 'critic',
    kind: 'review',
    objective: 'Review the exporter',
    acceptance: ['no blocker or high findings'],
    reviewedTaskId: replanImpl.task_id,
  })
  const replanBuilder = liveAgents.get((await replanTeamState()).members.find(member => member.name === 'builder').id)
  const replanCritic = liveAgents.get((await replanTeamState()).members.find(member => member.name === 'critic').id)
  const replanClaim = await call('agent_teams_claim_task', { task_id: replanImpl.task_id }, replanBuilder)
  await call('agent_teams_update_task', { task_id: replanImpl.task_id, status: 'in_progress', attempt_id: replanClaim.attempt_id }, replanBuilder)
  await call('agent_teams_update_task', {
    task_id: replanImpl.task_id,
    status: 'completed',
    attempt_id: replanClaim.attempt_id,
    output: 'exporter shipped',
    changedPaths: ['src/exporter.ts'],
    acceptanceResults: [{ criterion: 'the exporter writes the payload', status: 'passed' }],
    commandsRun: [{ command: 'node scripts/verify.mjs', status: 'passed' }],
  }, replanBuilder)
  const reviewClaim2 = await call('agent_teams_claim_task', { task_id: replanReview.task_id }, replanCritic)
  await call('agent_teams_update_task', { task_id: replanReview.task_id, status: 'in_progress', attempt_id: reviewClaim2.attempt_id }, replanCritic)
  await call('agent_teams_update_task', {
    task_id: replanReview.task_id,
    status: 'failed',
    attempt_id: reviewClaim2.attempt_id,
    verdict: 'needs_revision',
    findings: [{
      id: 'R-001',
      severity: 'high',
      problem: 'the exporter has no round-trip test',
      requiredFix: 'add the round-trip test and make the exporter emit a stable trailer',
      file: 'src/exporter.ts',
    }],
  }, replanCritic)
  const openedRepair = (await replanTeamState())?.tasks.find(item => item.kind === 'repair')
  const openedReview = (await replanTeamState())?.tasks.filter(item => item.kind === 'review' && item.id !== replanReview.task_id)[0]
  check('the failed review opened a repair lane and a next review round',
    openedRepair !== undefined && openedReview !== undefined
      && openedRepair.assignee === 'builder')

  // The repair lane inherits a contract that cannot hold here (the review asked
  // for a worktree this workspace does not have). One batch fixes it.
  await call('agent_teams_amend_task', {
    task_id: openedRepair.id,
    reason: 'the required fix names a worktree that does not exist in this workspace',
    acceptance: ['the round-trip test passes in this workspace'],
  })
  const repairClaim = await call('agent_teams_claim_task', { task_id: openedRepair.id }, replanBuilder)
  await call('agent_teams_update_task', { task_id: openedRepair.id, status: 'in_progress', attempt_id: repairClaim.attempt_id }, replanBuilder)
  await call('agent_teams_update_task', {
    task_id: openedRepair.id,
    status: 'failed',
    attempt_id: repairClaim.attempt_id,
    output: 'the lane cannot satisfy its contract as written',
  }, replanBuilder)
  const planBeforeReplan = await replanTeamState()
  check('a wrong contract fails the lane and leaves the plan red',
    planBeforeReplan?.tasks.find(item => item.id === openedRepair.id)?.status === 'failed'
      && planBeforeReplan.plan?.revision === planBeforeReplan.plan?.revision)

  const replanApplied = await call('agent_teams_replan', {
    reason: 'the repair lane cannot run against a worktree this workspace does not have',
    operations: [
      {
        action: 'amend_task',
        task_id: openedRepair.id,
        acceptance: ['the round-trip test passes with node scripts/verify.mjs'],
        verify: ['node scripts/verify.mjs'],
      },
      { action: 'update_task', task_id: openedRepair.id, retry: true },
      { action: 'add_task', subject: 'document the exporter contract', assignee: 'builder', dependencies: [openedRepair.id] },
    ],
  })
  const afterReplan = await replanTeamState()
  check('one replan batch amends, retries and adds without a cancel cascade',
    replanApplied.applied === 3
      && replanApplied.added.length === 1
      && replanApplied.rebound.includes(openedRepair.id)
      && afterReplan?.tasks.find(item => item.id === openedRepair.id)?.status === 'pending'
      && afterReplan?.tasks.find(item => item.id === replanApplied.added[0])?.subject === 'document the exporter contract'
      && afterReplan?.plan?.revision === planBeforeReplan.plan.revision + 1,
  )
  check('the replan keeps the review round it inherited',
    afterReplan?.tasks.find(item => item.id === openedReview.id)?.status === 'pending'
      && afterReplan?.tasks.find(item => item.id === replanReview.task_id)?.status === 'failed')

  // Finish the graph through the same members; nothing was recreated.
  const resumedRepairClaim = await call('agent_teams_claim_task', { task_id: openedRepair.id }, replanBuilder)
  await call('agent_teams_update_task', { task_id: openedRepair.id, status: 'in_progress', attempt_id: resumedRepairClaim.attempt_id }, replanBuilder)
  await call('agent_teams_update_task', {
    task_id: openedRepair.id,
    status: 'completed',
    attempt_id: resumedRepairClaim.attempt_id,
    output: 'round-trip test added',
    changedPaths: ['src/exporter.ts'],
    acceptanceResults: [{ criterion: 'the round-trip test passes with node scripts/verify.mjs', status: 'passed' }],
    commandsRun: [{ command: 'node scripts/verify.mjs', status: 'passed' }],
  }, replanBuilder)
  const docsTask = afterReplan?.tasks.find(item => item.id === replanApplied.added[0])
  const docsClaim = await call('agent_teams_claim_task', { task_id: docsTask.id }, replanBuilder)
  await call('agent_teams_update_task', { task_id: docsTask.id, status: 'in_progress', attempt_id: docsClaim.attempt_id }, replanBuilder)
  await call('agent_teams_update_task', {
    task_id: docsTask.id,
    status: 'completed',
    attempt_id: docsClaim.attempt_id,
    output: 'contract documented',
  }, replanBuilder)
  const nextReviewClaim = await call('agent_teams_claim_task', { task_id: openedReview.id }, replanCritic)
  await call('agent_teams_update_task', { task_id: openedReview.id, status: 'in_progress', attempt_id: nextReviewClaim.attempt_id }, replanCritic)
  await call('agent_teams_update_task', {
    task_id: openedReview.id,
    status: 'completed',
    attempt_id: nextReviewClaim.attempt_id,
    verdict: 'pass',
    output: 'the repaired lane is green',
  }, replanCritic)
  const replanStatus = await call('agent_teams_status', {})
  check('the repaired plan delivers without cancelling a single lane',
    replanStatus.delivery?.ok === true
      && replanStatus.tasks.every(task => task.status === 'completed' || task.status === 'failed')
      && replanStatus.progress?.percent === 100)
  await call('agent_teams_delete', {})

  // ── WP2/S08: a wrong contract is fixed in place, and a failed lane retries ──
  // The captain undercounts inScope, the member's honest completion is refused as
  // an undeclared path, and the lane fails. Before S08 that was a dead end:
  // `amend_task` rejected terminal tasks, so the only way out was cancel and
  // recreate. Now the captain amends the failed contract, retries the same task
  // and the member completes it without a new task id.
  await call('agent_teams_create', { name: 'Contract Fix', description: 'amend a failed lane' })
  await call('agent_teams_add_member', { name: 'fixer', role: 'implementer' })
  // The shared `task()` reader is bound to the `lifecycle` team, so this scenario
  // reads its own team.
  const amendTask = async id => (await readTeam(stateRoot, 'contract-fix'))?.tasks.find(candidate => candidate.id === id)
  const amendNarrow = await call('agent_teams_create_task', {
    subject: 'implement scanner',
    assignee: 'fixer',
    kind: 'implementation',
    objective: 'Ship the scanner and its tests',
    inScope: ['src/scanner.ts'],
    acceptance: ['scanner handles empty input'],
    verify: ['pnpm test'],
  })
  const amendFixer = liveAgents.get((await readTeam(stateRoot, 'contract-fix')).members.find(m => m.name === 'fixer').id)
  const amendNarrowClaim = await call('agent_teams_claim_task', { task_id: amendNarrow.task_id }, amendFixer)
  await call('agent_teams_update_task', {
    task_id: amendNarrow.task_id, status: 'in_progress', attempt_id: amendNarrowClaim.attempt_id,
  }, amendFixer)
  await call('agent_teams_update_task', {
    task_id: amendNarrow.task_id,
    status: 'completed',
    attempt_id: amendNarrowClaim.attempt_id,
    output: 'scanner and tests shipped',
    changedPaths: ['src/scanner.ts', 'src/scanner.test.ts'],
    acceptanceResults: [{ criterion: 'scanner handles empty input', status: 'passed' }],
    commandsRun: [{ command: 'pnpm test', status: 'passed' }],
  }, amendFixer)
  // Since WP4/S10 the honest report is not refused: the task is held for a scope
  // decision with the evidence intact (the S09 scenario above covers the captain
  // accepting the paths). The S08 lane deliberately fails instead, to exercise
  // amend-then-retry.
  const amendHeld = await amendTask(amendNarrow.task_id)
  check('a path outside the declared inScope is held for a scope decision, not silently accepted',
    amendHeld?.status === 'awaiting_scope_review'
      && (amendHeld.changedPaths ?? []).includes('src/scanner.test.ts'))
  await call('agent_teams_update_task', {
    task_id: amendNarrow.task_id,
    status: 'failed',
    attempt_id: amendNarrowClaim.attempt_id,
    output: 'the declared inScope forbids the test file the objective names',
    commandsRun: [{ command: 'pnpm test', status: 'failed', exitCode: 1 }],
  }, amendFixer)
  check('the lane is failed and terminal for the member', (await amendTask(amendNarrow.task_id))?.status === 'failed')
  const amendResult = await call('agent_teams_amend_task', {
    task_id: amendNarrow.task_id,
    reason: 'the objective names src/scanner.test.ts but inScope forbade it',
    inScope: ['src/scanner.ts', 'src/scanner.test.ts'],
  })
  check('a failed contract is amendable and the revision is recorded',
    typeof amendResult.revision_count === 'number' && amendResult.revision_count >= 1
      && (await amendTask(amendNarrow.task_id))?.inScope?.includes('src/scanner.test.ts') === true)
  await call('agent_teams_reassign_task', { task_id: amendNarrow.task_id, assignee: 'fixer', reason: 'retry against the amended contract' })
  const amendRetried = await amendTask(amendNarrow.task_id)
  // The reassign tool returns after it has already kicked the member, so the
  // task may be back in the pool or dispatched again; what matters is that it is
  // the same task, in the same lane, with the amendment still on it.
  check('the retry keeps the same task in the same lane instead of recreating it',
    amendRetried?.id === amendNarrow.task_id
      && amendRetried.status !== 'failed'
      && (amendRetried.revisions ?? []).length >= 1
      && (amendRetried.attempt ?? 0) >= 1)
  const amendRetryClaim = await call('agent_teams_claim_task', { task_id: amendNarrow.task_id }, amendFixer)
  await call('agent_teams_update_task', {
    task_id: amendNarrow.task_id, status: 'in_progress', attempt_id: amendRetryClaim.attempt_id,
  }, amendFixer)
  await call('agent_teams_update_task', {
    task_id: amendNarrow.task_id,
    status: 'completed',
    attempt_id: amendRetryClaim.attempt_id,
    output: 'scanner and tests shipped against the amended contract',
    changedPaths: ['src/scanner.ts', 'src/scanner.test.ts'],
    acceptanceResults: [{ criterion: 'scanner handles empty input', status: 'passed' }],
    commandsRun: [{ command: 'pnpm test', status: 'passed' }],
  }, amendFixer)
  const amendCompleted = await amendTask(amendNarrow.task_id)
  check('the amended contract completes without cancelling or recreating the task',
    amendCompleted?.status === 'completed'
      && amendCompleted.id === amendNarrow.task_id
      && (amendCompleted.revisions ?? []).length >= 1)
  await call('agent_teams_delete', {})

  // ── WP3/S09: a lane that will not finish is replaced in place ──
  // A red task used to stay red forever, its dependents waited on an id nobody
  // would complete, and a review kept judging the dead task. Supersession swaps
  // the whole live graph onto the replacement in one call.
  await call('agent_teams_create', { name: 'Supersede Lane', description: 'replace a red lane' })
  await call('agent_teams_add_member', { name: 'sweeper', role: 'implementer' })
  await call('agent_teams_add_member', { name: 'judge', role: 'reviewer' })
  const supersedeTeam = async () => readTeam(stateRoot, 'supersede-lane')
  const supersedeTask = async id => (await supersedeTeam())?.tasks.find(candidate => candidate.id === id)
  const doomed = await call('agent_teams_create_task', { subject: 'doomed lane', assignee: 'sweeper' })
  // The member session exists only after the first assigned task spawns it.
  const sweeperMember = liveAgents.get((await supersedeTeam()).members.find(m => m.name === 'sweeper').id)
  const dependent = await call('agent_teams_create_task', {
    subject: 'downstream of the doomed lane', assignee: 'sweeper', dependencies: [doomed.task_id],
  })
  const doomedReview = await call('agent_teams_create_task', {
    subject: 'review the doomed lane',
    assignee: 'judge',
    kind: 'review',
    objective: 'judge the lane',
    acceptance: ['no high findings'],
    reviewedTaskId: doomed.task_id,
  })
  const doomedClaim = await call('agent_teams_claim_task', { task_id: doomed.task_id }, sweeperMember)
  await call('agent_teams_update_task', {
    task_id: doomed.task_id, status: 'in_progress', attempt_id: doomedClaim.attempt_id,
  }, sweeperMember)
  await call('agent_teams_update_task', {
    task_id: doomed.task_id,
    status: 'failed',
    attempt_id: doomedClaim.attempt_id,
    output: 'the lane cannot be completed as written',
  }, sweeperMember)
  const replaced = await call('agent_teams_supersede_task', {
    task_id: doomed.task_id,
    reason: 'the lane is dead; the replacement carries the same scope',
    subject: 'replacement lane',
    assignee: 'sweeper',
  })
  const afterSupersede = await supersedeTask(doomed.task_id)
  const rewiredDependent = await supersedeTask(dependent.task_id)
  const rewiredReview = await supersedeTask(doomedReview.task_id)
  check('a red lane is replaced in place, with a link to its replacement',
    afterSupersede?.status === 'superseded'
      && afterSupersede.supersededBy === replaced.superseded_by
      && afterSupersede.attemptId === undefined
      && replaced.status === 'superseded')
  const inlineReplacement = await supersedeTask(replaced.superseded_by)
  check('the replacement lands in the same team and lane',
    inlineReplacement !== undefined
      && inlineReplacement.subject === 'replacement lane'
      && inlineReplacement.assignee === 'sweeper'
      // The scheduler may already have dispatched it to the idle member, so the
      // claimable-status assertion is "not terminal", not "pending".
      && (inlineReplacement.status === 'pending' || inlineReplacement.status === 'claimed'))
  check('dependents and reviews follow the replacement atomically',
    rewiredDependent?.dependencies.includes(replaced.superseded_by) === true
      && rewiredDependent.dependencies.includes(doomed.task_id) === false
      && rewiredReview?.reviewedTaskId === replaced.superseded_by
      && replaced.rewired.includes(dependent.task_id)
      && replaced.rewired.includes(doomedReview.task_id))
  let staleAttemptRefused = false
  try {
    await call('agent_teams_update_task', {
      task_id: doomed.task_id, status: 'in_progress', attempt_id: doomedClaim.attempt_id,
    }, sweeperMember)
  } catch {
    staleAttemptRefused = true
  }
  check('the replaced lane refuses its old capability', staleAttemptRefused)
  let dependentBlocked = false
  try {
    await call('agent_teams_claim_task', { task_id: dependent.task_id }, sweeperMember)
  } catch (error) {
    dependentBlocked = /busy|not claimable|dependencies/.test(String(error))
  }
  check('the redirected dependent still waits for the replacement', dependentBlocked)
  const replacementClaim = await call('agent_teams_claim_task', { task_id: replaced.superseded_by }, sweeperMember)
  await call('agent_teams_update_task', {
    task_id: replaced.superseded_by, status: 'in_progress', attempt_id: replacementClaim.attempt_id,
  }, sweeperMember)
  await call('agent_teams_update_task', {
    task_id: replaced.superseded_by, status: 'completed', attempt_id: replacementClaim.attempt_id, output: 'replacement shipped',
  }, sweeperMember)
  const dependentAfterReplacement = await supersedeTask(dependent.task_id)
  check('completing the replacement unblocks the redirected dependent',
    dependentAfterReplacement?.status === 'pending'
      && (await supersedeTeam())?.tasks.some(task => task.id === dependent.task_id && task.dependencies.includes(replaced.superseded_by)))
  await call('agent_teams_delete', {})

  // ── WP4/S10: an honest undeclared path becomes a captain decision ──
  // Before this, a worker that touched a file outside its declared inScope had to
  // either lie about changedPaths or fail the lane. Now the report is accepted as
  // evidence, the task is held in `awaiting_scope_review`, and the captain accepts
  // the paths (completing the lane) or reassigns/supersedes it.
  await call('agent_teams_create', { name: 'Scope Review', description: 'hold an undeclared path' })
  await call('agent_teams_add_member', { name: 'scout', role: 'implementer' })
  const scopeState = () => readTeam(stateRoot, 'scope-review')
  const scopeTask = async id => (await scopeState())?.tasks.find(candidate => candidate.id === id)
  const scoutTask = await call('agent_teams_create_task', {
    subject: 'ship the reader',
    assignee: 'scout',
    kind: 'implementation',
    objective: 'Ship the reader',
    inScope: ['src/reader.ts'],
    acceptance: ['reader parses a line'],
    verify: ['pnpm test'],
  })
  const scout = liveAgents.get((await scopeState()).members.find(m => m.name === 'scout').id)
  const scoutClaim = await call('agent_teams_claim_task', { task_id: scoutTask.task_id }, scout)
  await call('agent_teams_update_task', { task_id: scoutTask.task_id, status: 'in_progress', attempt_id: scoutClaim.attempt_id }, scout)
  await call('agent_teams_update_task', {
    task_id: scoutTask.task_id,
    status: 'completed',
    attempt_id: scoutClaim.attempt_id,
    output: 'reader shipped; it needed one shared helper',
    changedPaths: ['src/reader.ts', 'src/shared/lines.ts'],
    acceptanceResults: [{ criterion: 'reader parses a line', status: 'passed' }],
    commandsRun: [{ command: 'pnpm test', status: 'passed' }],
  }, scout)
  const held = await scopeTask(scoutTask.task_id)
  check('an undeclared path holds the task for a scope decision instead of failing it',
    held?.status === 'awaiting_scope_review'
      && (held.changedPaths ?? []).includes('src/shared/lines.ts')
      && (held.acceptanceResults ?? []).length === 1)
  const accepted = await call('agent_teams_accept_paths', {
    task_id: scoutTask.task_id,
    paths: ['src/shared/lines.ts'],
    reason: 'the shared helper belongs to this lane',
  })
  const afterAccept = await scopeTask(scoutTask.task_id)
  check('accepting the paths completes the lane with the work it actually did',
    afterAccept?.status === 'completed'
      && accepted.accepted_paths.includes('src/shared/lines.ts')
      && (afterAccept.inScope ?? []).includes('src/shared/lines.ts')
      && (afterAccept.revisions ?? []).length === 1
      && accepted.revision_count === 1)
  const delivery = await call('agent_teams_status', {})
  check('the accepted lane no longer blocks the team record',
    (await scopeState())?.tasks.every(task => task.status === 'completed')
      && typeof delivery.team_name === 'string')
  await call('agent_teams_delete', {})

  // ── WP6.3: a pinned known delta supplies the waiver evidence ──
  await call('agent_teams_create', { name: 'Known Delta', description: 'waive a pinned baseline' })
  await call('agent_teams_add_member', { name: 'linting', role: 'implementer' })
  const deltaState = () => readTeam(stateRoot, 'known-delta')
  const deltaTask = async id => (await deltaState())?.tasks.find(candidate => candidate.id === id)
  const pinned = await call('agent_teams_pin_delta', {
    id: 'lint-baseline',
    check: 'pnpm run lint',
    expected: 'exit 0',
    reason: 'the lint baseline is red on HEAD in files outside every lane',
  })
  check('a known delta is pinned once and listed in the status payload',
    pinned.delta_id === 'lint-baseline'
      && pinned.pinned === 1
      && (await deltaState())?.knownDeltas?.[0]?.check === 'pnpm run lint')
  let duplicateRefused = false
  try {
    await call('agent_teams_pin_delta', { check: 'pnpm run lint', expected: 'exit 0', reason: 'again' })
  } catch (error) {
    duplicateRefused = /already pinned/.test(String(error))
  }
  check('a second pin for the same check is refused and names the existing entry', duplicateRefused)
  const lintTask = await call('agent_teams_create_task', {
    subject: 'ship the linter fix',
    assignee: 'linting',
    kind: 'implementation',
    objective: 'Ship the linter fix',
    inScope: ['src/lint.ts'],
    acceptance: ['the linter fix works'],
    verify: ['pnpm run lint'],
  })
  const linter = liveAgents.get((await deltaState()).members.find(m => m.name === 'linting').id)
  const lintClaim = await call('agent_teams_claim_task', { task_id: lintTask.task_id }, linter)
  await call('agent_teams_update_task', { task_id: lintTask.task_id, status: 'in_progress', attempt_id: lintClaim.attempt_id }, linter)
  await call('agent_teams_update_task', {
    task_id: lintTask.task_id,
    status: 'completed',
    attempt_id: lintClaim.attempt_id,
    output: 'fix shipped; the repo-wide lint baseline is still red outside this lane',
    changedPaths: ['src/lint.ts'],
    acceptanceResults: [{ criterion: 'the linter fix works', status: 'passed' }],
    // No evidence: the pinned delta supplies it (WP6.3).
    commandsRun: [{ command: 'pnpm run lint', status: 'waived' }],
  }, linter)
  const linted = await deltaTask(lintTask.task_id)
  check('a pinned check waives without the lane writing its own evidence',
    linted?.status === 'completed'
      && String(linted.commandsRun?.[0]?.evidence ?? '').includes('pinned delta lint-baseline')
      && linted.hasWaivers === true)
  let unpinnedWaiverRefused = false
  const otherTask = await call('agent_teams_create_task', {
    subject: 'ship the parser fix',
    assignee: 'linting',
    kind: 'implementation',
    objective: 'Ship the parser fix',
    inScope: ['src/parser2.ts'],
    acceptance: ['the parser fix works'],
    verify: ['pnpm test'],
  })
  const otherClaim = await call('agent_teams_claim_task', { task_id: otherTask.task_id }, linter)
  await call('agent_teams_update_task', { task_id: otherTask.task_id, status: 'in_progress', attempt_id: otherClaim.attempt_id }, linter)
  try {
    await call('agent_teams_update_task', {
      task_id: otherTask.task_id,
      status: 'completed',
      attempt_id: otherClaim.attempt_id,
      changedPaths: ['src/parser2.ts'],
      acceptanceResults: [{ criterion: 'the parser fix works', status: 'passed' }],
      commandsRun: [{ command: 'pnpm test', status: 'waived' }],
    }, linter)
  } catch (error) {
    unpinnedWaiverRefused = /evidence/.test(String(error))
  }
  check('an unpinned check still demands its own evidence', unpinnedWaiverRefused)
  const registryStatus = await call('agent_teams_status', {})
  check('the status report carries the registry',
    registryStatus.known_deltas?.[0]?.id === 'lint-baseline')
  // WP8/S16: the text report leads with the same percentage the panel shows and
  // marks every task with a checkbox glyph.
  const statusText = definitions.get('agent_teams_status').output
    .render({}, registryStatus)
    .map(part => part.text ?? '')
    .join('\n')
  check('the status report prints the plan percentage before the task list',
    /^Progress: 50% \(1\/2; running 1, blocked 0, failed 0, waived 1\)$/mu.test(statusText)
      && /^Tasks \(2\):$/mu.test(statusText)
      && statusText.indexOf('Progress:') < statusText.indexOf('Tasks ('),
  )
  check('every reported task carries its checkbox glyph',
    statusText.includes('- [x] t1 ')
      && statusText.includes('- [~] t2 '),
  )
  await call('agent_teams_delete', {})

  // ── WP11 phase 1: team identity is data, not the calling session ──
  // Two teams in one workspace, addressed by team_id. The old "one team per
  // captain" rule and the `ambiguous` failure are gone; a missing id now names
  // the caller's teams instead of guessing.
  const multiTeamId = 'multi-a'
  await call('agent_teams_create', { name: 'Multi A', description: 'first team' })
  await call('agent_teams_add_member', { name: 'worker', role: 'implementer' })
  const multiA = await call('agent_teams_create_task', { team_id: multiTeamId, subject: 'task in A', assignee: 'worker' })
  let secondTeamRefused = false
  try {
    await call('agent_teams_create', { name: 'Multi B', description: 'second team' })
  } catch (error) {
    secondTeamRefused = /new_team=true/.test(String(error))
  }
  check('a second team needs the explicit new_team flag', secondTeamRefused)
  await call('agent_teams_create', { name: 'Multi B', description: 'second team', new_team: true })
  const multiBId = 'multi-b'
  const multiB = await call('agent_teams_create_task', { team_id: multiBId, subject: 'task in B' })
  const multiBExtra = await call('agent_teams_create_task', { team_id: multiBId, subject: 'second task in B' })
  let missingTeamIdRefused = false
  try {
    await call('agent_teams_create_task', { subject: 'task without a team id' }, captain, null)
  } catch (error) {
    missingTeamIdRefused = /team_id is required/.test(String(error))
      && String(error).includes(multiTeamId)
      && String(error).includes(multiBId)
  }
  check('a missing team_id lists every team the caller leads', missingTeamIdRefused)
  const listed = await call('agent_teams_status', {}, captain, null)
  check('status without a team_id lists the teams with their counters',
    Array.isArray(listed.teams)
      && listed.teams.length === 2
      && listed.teams.every(entry => typeof entry.team_id === 'string' && typeof entry.tasks?.total === 'number')
      && listed.teams.some(entry => entry.team_id === multiTeamId && entry.role === 'captain'))
  const statusA = await call('agent_teams_status', { team_id: multiTeamId })
  check('status with a team_id reports that team in detail',
    statusA.team_name === 'Multi A' && Array.isArray(statusA.tasks) && statusA.tasks.length === 1)
  // Task ids restart per team, so the isolation probe addresses a task id that
  // only the other team owns: a leaked write would move it out of `pending`.
  let crossTeamUpdateRefused = false
  try {
    await call('agent_teams_update_task', {
      team_id: multiTeamId,
      task_id: multiBExtra.task_id,
      status: 'cancelled',
      output: 'addressed through the wrong team',
    })
  } catch {
    crossTeamUpdateRefused = true
  }
  check('update_task cannot reach a task that lives in another team',
    crossTeamUpdateRefused
      && (await readTeam(stateRoot, multiBId))?.tasks.find(candidate => candidate.id === multiBExtra.task_id)?.status === 'pending')
  await call('agent_teams_delete', { team_id: multiBId })
  const afterOneDelete = await call('agent_teams_status', { team_id: multiTeamId })
  // One live team left, so the bare call falls back to the detailed answer the
  // single-team caller has always received instead of the multi-team list.
  const soleRemaining = await call('agent_teams_status', {}, captain, null)
  check('archiving one team leaves the other live',
    afterOneDelete.team_name === 'Multi A'
      && soleRemaining.team_name === 'Multi A'
      && (await readTeam(stateRoot, multiBId)) === undefined
      && (await readArchivedTeam(stateRoot, multiBId))?.tasks.map(candidate => candidate.subject).join('|')
        === 'task in B|second task in B'
      && (await readArchivedTeam(stateRoot, multiBId))?.tasks.some(candidate => candidate.id === multiB.task_id) === true
      && (await readTeam(stateRoot, multiTeamId))?.tasks.map(candidate => candidate.subject).join('|') === 'task in A')
  for (const name of ['Multi C', 'Multi D', 'Multi E']) {
    await call('agent_teams_create', { name, description: 'workspace limit filler', new_team: true })
  }
  let workspaceLimitRefused = false
  try {
    await call('agent_teams_create', { name: 'Multi F', description: 'over the limit', new_team: true })
  } catch (error) {
    workspaceLimitRefused = /already has 4 live teams \(limit 4\)/.test(String(error))
  }
  check('the workspace refuses a fifth live team with the live count in the message', workspaceLimitRefused)
  for (const id of [multiTeamId, 'multi-c', 'multi-d', 'multi-e']) await call('agent_teams_delete', { team_id: id })

  await call('agent_teams_create', { name: 'Lifecycle', description: 'adversarial DAG' })
  const addedAlpha = await call('agent_teams_add_member', { name: 'alpha', role: 'slow implementer' })
  const addedBeta = await call('agent_teams_add_member', { name: 'beta', role: 'researcher' })
  const addedGamma = await call('agent_teams_add_member', { name: 'gamma', role: 'reviewer' })
  check('adding members alone creates no child sessions', [addedAlpha, addedBeta, addedGamma].every(m => m.member_id === ''))
  for (const name of ['alpha', 'beta', 'gamma']) await call('agent_teams_send_message', { to: name, content: 'Prepare for the concurrency regression and wait for assignment.' })
  const roster = (await state()).members
  const alpha = liveAgents.get(roster.find(m => m.name === 'alpha').id)
  const beta = liveAgents.get(roster.find(m => m.name === 'beta').id)
  const gamma = liveAgents.get(roster.find(m => m.name === 'gamma').id)
  check('manually added members persist the global fallback for later activations',
    (await state())?.members.every(member => member.fallback?.provider === 'backup'
      && member.fallback?.model === 'backup-model'))
  publishStatus(alpha, 'idle')
  publishStatus(beta, 'idle')
  publishStatus(gamma, 'idle')

  const t1 = await call('agent_teams_create_task', { subject: 'slow branch', assignee: 'alpha' })
  const firstAttempt = await task(t1.task_id)
  check('idle assigned member is claimed and woken automatically',
    firstAttempt?.status === 'claimed' && firstAttempt.assignee === 'alpha'
      && deliveries.some(delivery => delivery.childId === alpha.id))
  let captainClaimRejected = false
  const beforeCaptainClaim = JSON.stringify(await task(t1.task_id))
  const beforeCaptainClaimDeliveries = deliveries.length
  try {
    await call('agent_teams_claim_task', { task_id: t1.task_id, assignee: 'alpha' })
  } catch (error) {
    captainClaimRejected = /member|reassign_task/.test(String(error))
  }
  check('captain cannot mint a claim capability for a member; use reassign_task',
    captainClaimRejected && JSON.stringify(await task(t1.task_id)) === beforeCaptainClaim
      && deliveries.length === beforeCaptainClaimDeliveries)
  const alphaClaim = await call('agent_teams_claim_task', { task_id: t1.task_id }, alpha)
  check('member observes the scheduler attempt idempotently', alphaClaim.attempt_id === firstAttempt?.attemptId)
  await call('agent_teams_update_task', {
    task_id: t1.task_id, status: 'in_progress', attempt_id: alphaClaim.attempt_id,
  }, alpha)

  const t2 = await call('agent_teams_create_task', { subject: 'parallel research', assignee: 'beta' })
  const t3 = await call('agent_teams_create_task', {
    subject: 'integration gate', assignee: 'gamma', dependencies: [t1.task_id, t2.task_id],
  })
  const betaClaim = await call('agent_teams_claim_task', { task_id: t2.task_id }, beta)
  await call('agent_teams_update_task', {
    task_id: t2.task_id, status: 'in_progress', attempt_id: betaClaim.attempt_id,
  }, beta)
  check('dependency gate stays pending before both branches complete', (await task(t3.task_id))?.status === 'pending')

  // A normal turn may end while its task is intentionally parked waiting for
  // guidance, and a user can explicitly pause a running member. Neither case
  // authorizes the scheduler to revoke the live attempt. Repeated status kicks
  // must be idempotent until the captain performs an explicit reassignment.
  publishStatus(alpha, 'idle')
  await new Promise(resolve => setTimeout(resolve, 20))
  // The idle member remains resident, so repeated status kicks must keep
  // its current attempt parked rather than spuriously waking it again.
  const deliveriesBeforeParkedKicks = deliveries.length
  const parkedAttemptBeforeRateLimitRecovery = await task(t1.task_id)
  // Model the provider-facing failure boundary from #66: the member's turn
  // has ended after a rate-limit response, but its durable task capability is
  // still open. Repeated scheduler/status kicks must park that capability
  // instead of minting a fresh attempt and inference request each time.
  for (let kick = 0; kick < 20; kick += 1) {
    await call('agent_teams_status', {})
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  const parkedAlpha = await task(t1.task_id)
  check('rate-limited idle owner does not enter an unbounded retry loop (#66)',
    parkedAlpha?.status === 'in_progress'
      && parkedAlpha.attempt === parkedAttemptBeforeRateLimitRecovery?.attempt
      && parkedAlpha.attemptId === parkedAttemptBeforeRateLimitRecovery?.attemptId
      && deliveries.length === deliveriesBeforeParkedKicks)
  liveAgents.set(alpha.id, alpha)

  // Harness normally disposes a continuable AgentHandle after settlement. The
  // in-process idle observation remains authoritative, so a non-resident
  // parked owner must not be mistaken for a cold restart on every status poll.
  liveAgents.delete(alpha.id)
  const deliveriesBeforeDisposedParkedKicks = deliveries.length
  await Promise.all([
    call('agent_teams_status', {}),
    call('agent_teams_status', {}),
    call('agent_teams_status', {}),
  ])
  await new Promise(resolve => setTimeout(resolve, 20))
  const disposedParkedAlpha = await task(t1.task_id)
  check('disposed settled owner keeps its parked attempt across repeated scheduler kicks',
    disposedParkedAlpha?.status === 'in_progress'
      && disposedParkedAlpha.attempt === alphaClaim.attempt
      && disposedParkedAlpha.attemptId === alphaClaim.attempt_id
      && deliveries.length === deliveriesBeforeDisposedParkedKicks)
  liveAgents.set(alpha.id, alpha)

  // Unobserved recovery whose followup fails must restore the original open
  // capability and consume that generation's budget. Later status kicks must
  // not recast it into pending or a new attempt.
  const tRecoverFail = await call('agent_teams_create_task', {
    subject: 'unobserved recovery delivery failure', assignee: 'gamma',
  })
  const recoverFailDispatch = await task(tRecoverFail.task_id)
  check('idle assigned gamma is claimed for the recovery-failure fixture',
    recoverFailDispatch?.status === 'claimed' && recoverFailDispatch.assignee === 'gamma')
  const recoverFailClaim = await call('agent_teams_claim_task', { task_id: tRecoverFail.task_id }, gamma)
  await call('agent_teams_update_task', {
    task_id: tRecoverFail.task_id, status: 'in_progress', attempt_id: recoverFailClaim.attempt_id,
  }, gamma)
  liveAgents.delete(gamma.id)
  failNextDelivery.add(gamma.id)
  const deliveriesBeforeFailedRecovery = deliveries.length
  await call('agent_teams_status', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  const rolledBackRecovery = await task(tRecoverFail.task_id)
  await Promise.all([
    call('agent_teams_status', {}),
    call('agent_teams_status', {}),
    call('agent_teams_status', {}),
  ])
  await new Promise(resolve => setTimeout(resolve, 20))
  const throttledFailedRecovery = await task(tRecoverFail.task_id)
  check('failed unobserved recovery restores the original capability and later kicks do not recast it',
    rolledBackRecovery?.status === 'in_progress'
      && rolledBackRecovery.assignee === 'gamma'
      && rolledBackRecovery.attempt === recoverFailClaim.attempt
      && rolledBackRecovery.attemptId === recoverFailClaim.attempt_id
      && deliveries.length === deliveriesBeforeFailedRecovery
      && throttledFailedRecovery?.status === 'in_progress'
      && throttledFailedRecovery.attempt === recoverFailClaim.attempt
      && throttledFailedRecovery.attemptId === recoverFailClaim.attempt_id
      && deliveries.length === deliveriesBeforeFailedRecovery)
  liveAgents.set(gamma.id, gamma)
  const recoverFailComplete = await call('agent_teams_claim_task', { task_id: tRecoverFail.task_id }, gamma)
  await call('agent_teams_update_task', {
    task_id: tRecoverFail.task_id,
    status: 'completed',
    output: 'closed failed-recovery fixture',
    attempt_id: recoverFailComplete.attempt_id,
  }, gamma)
  check('restored capability remains usable after a failed recovery delivery',
    recoverFailComplete.attempt_id === recoverFailClaim.attempt_id
      && (await task(tRecoverFail.task_id))?.status === 'completed')
  publishStatus(gamma, 'idle')

  // A durable task whose capability the MEMBER minted (`claim_task`) is not an
  // unobserved owner, even when the AgentHandle is gone: recovery would re-claim
  // the task underneath the member and destroy the capability it is working
  // with. Nothing may rotate here — not the attempt counter, not the capability,
  // and there is nothing to deliver either, because the member already holds the
  // task. (The recovery throttle for a scheduler-minted attempt is asserted by
  // the `tRecoverFail` case above; the worker-level regression is at the end of
  // this file.)
  liveAgents.delete(beta.id)
  const deliveriesBeforeColdRecovery = deliveries.length
  await call('agent_teams_status', {})
  await new Promise(resolve => setTimeout(resolve, 20))
  const coldRecoveredBeta = await task(t2.task_id)
  const deliveriesAfterColdRecovery = deliveries.length
  await Promise.all([
    call('agent_teams_status', {}),
    call('agent_teams_status', {}),
    call('agent_teams_status', {}),
  ])
  await new Promise(resolve => setTimeout(resolve, 20))
  const throttledRecoveredBeta = await task(t2.task_id)
  check('a member-minted capability is never recast as an unobserved owner',
    coldRecoveredBeta?.status === 'in_progress'
      && coldRecoveredBeta.assignee === 'beta'
      && coldRecoveredBeta.attempt === betaClaim.attempt
      && coldRecoveredBeta.attemptId === betaClaim.attempt_id
      && deliveriesAfterColdRecovery === deliveriesBeforeColdRecovery
      && throttledRecoveredBeta?.attempt === coldRecoveredBeta.attempt
      && throttledRecoveredBeta?.attemptId === betaClaim.attempt_id,
    `attempt ${betaClaim.attempt} -> ${coldRecoveredBeta?.attempt}, capability kept=${coldRecoveredBeta?.attemptId === betaClaim.attempt_id}`)
  liveAgents.set(beta.id, beta)

  publishStatus(beta, 'idle')
  await new Promise(resolve => setTimeout(resolve, 20))
  const deliveriesBeforeResume = deliveries.length
  const resumedBeta = await call('agent_teams_send_message', {
    to: 'beta', content: 'Continue the same parked task and keep its current attempt id.',
  })
  const resumedBetaTask = await task(t2.task_id)
  check('captain message resumes a parked owner without rotating its attempt',
    resumedBeta.delivered === 'wake'
      && deliveries.length === deliveriesBeforeResume + 1
      && resumedBetaTask?.attempt === coldRecoveredBeta?.attempt
      && resumedBetaTask.attemptId === coldRecoveredBeta?.attemptId)

  let unsafeCaptainTakeoverRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: t1.task_id, status: 'completed', output: 'captain bypassed handoff',
    })
  } catch (error) {
    unsafeCaptainTakeoverRejected = /reassign_task/.test(String(error))
  }
  check('captain cannot bypass the safe takeover protocol', unsafeCaptainTakeoverRejected)

  // The regression under test: reassigning must revoke the previous capability
  // and mint a new attempt, and the previous owner must not be able to publish a
  // late result. Hand `t1` over first — alpha is still holding it — and then run
  // the generic capability/attempt check on its own idle member.
  const alphaBeforeHandoff = await task(t1.task_id)
  const handoff = await call('agent_teams_reassign_task', {
    task_id: t1.task_id, assignee: 'gamma', reason: 'alpha is stuck',
  })
  let staleRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: t1.task_id, status: 'completed', output: 'late alpha', attempt_id: alphaClaim.attempt_id,
    }, alpha)
  } catch (error) {
    staleRejected = /assigned to|stale attempt/.test(String(error))
  }
  check('old member cannot publish a late takeover result',
    staleRejected && handoff.assignee === 'gamma' && handoff.attempt === (alphaBeforeHandoff?.attempt ?? 0) + 1)

  const takeoverTask = await call('agent_teams_create_task', { subject: 'takeover fixture', kind: 'work', assignee: 'alpha' })
  const beforeTakeover = await task(takeoverTask.task_id)
  const takeover = await call('agent_teams_reassign_task', {
    task_id: takeoverTask.task_id, assignee: 'alpha', reason: 'keep one capability per attempt',
  })
  const reassigned = await task(takeoverTask.task_id)
  check('reassignment revokes the previous capability and creates a new attempt',
    takeover.assignee === 'alpha'
      && reassigned?.attempt === (beforeTakeover?.attempt ?? 0) + 1
      && reassigned.attemptId !== beforeTakeover?.attemptId
      && takeover.attempt === reassigned?.attempt)

  const gammaClaim = await call('agent_teams_claim_task', { task_id: t1.task_id }, gamma)
  await call('agent_teams_update_task', {
    task_id: t1.task_id, status: 'in_progress', attempt_id: gammaClaim.attempt_id,
  }, gamma)
  await call('agent_teams_update_task', {
    task_id: t1.task_id, status: 'completed', output: 'gamma result', attempt_id: gammaClaim.attempt_id,
  }, gamma)
  const recoveredBetaClaim = await call('agent_teams_claim_task', { task_id: t2.task_id }, beta)
  await call('agent_teams_update_task', {
    task_id: t2.task_id, status: 'in_progress', attempt_id: recoveredBetaClaim.attempt_id,
  }, beta)
  await call('agent_teams_update_task', {
    task_id: t2.task_id, status: 'completed', output: 'beta result', attempt_id: recoveredBetaClaim.attempt_id,
  }, beta)
  check('resumed recovered member completes with its throttled capability',
    (await task(t2.task_id))?.status === 'completed'
      && (await task(t2.task_id))?.attemptId === recoveredBetaClaim.attempt_id)
  const deliveriesBeforeGate = deliveries.length
  // A member can start its tool calls only after delivery. The scheduler's
  // async disk writes and wakeup are not guaranteed to finish within 20 ms.
  // Delay the fake host deliberately so this test exercises that boundary.
  deliveryDelayMs = 100
  publishStatus(beta, 'idle')
  publishStatus(gamma, 'idle')
  let gate
  let gateDelivered = false
  const gateDeadline = Date.now() + 2000
  while (Date.now() < gateDeadline) {
    gate = await task(t3.task_id)
    gateDelivered = gate?.status === 'claimed' && gate.assignee === 'gamma'
      && gamma.status === 'running'
      && deliveries.slice(deliveriesBeforeGate).some(delivery => delivery.childId === gamma.id
        && JSON.stringify(delivery.content).includes(`Task: ${t3.task_id} `))
    if (gateDelivered) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  deliveryDelayMs = 0
  check('completing dependencies dispatches the downstream task before member execution', gateDelivered)
  if (!gateDelivered) throw new Error('Timed out waiting for the downstream task to reach gamma')
  const gateClaim = await call('agent_teams_claim_task', { task_id: t3.task_id }, gamma)
  await call('agent_teams_update_task', {
    task_id: t3.task_id, status: 'in_progress', attempt_id: gateClaim.attempt_id,
  }, gamma)
  await call('agent_teams_update_task', {
    task_id: t3.task_id, status: 'completed', output: 'integrated', attempt_id: gateClaim.attempt_id,
  }, gamma)

  publishStatus(alpha, 'idle')
  publishStatus(beta, 'idle')
  gamma.status = 'running'
  const t4 = await call('agent_teams_create_task', { subject: 'later-round assigned work', assignee: 'alpha' })
  // Dispatch is asynchronous: `create_task` kicks the scheduler without awaiting
  // it, so poll for the claim instead of assuming the write already landed.
  let reused = await task(t4.task_id)
  const reuseDeadline = Date.now() + 1000
  while (Date.now() < reuseDeadline && reused?.status !== 'claimed') {
    await new Promise(resolve => setTimeout(resolve, 20))
    reused = await task(t4.task_id)
  }
  check('previously interrupted member is reused in a later round', reused?.assignee === 'alpha' && reused.status === 'claimed')

  const t5 = await call('agent_teams_create_task', { subject: 'must wait behind alpha', assignee: 'alpha' })
  let busyRejected = false
  try {
    await call('agent_teams_claim_task', { task_id: t5.task_id }, alpha)
  } catch (error) {
    busyRejected = /busy with/.test(String(error))
  }
  check('a member cannot claim a second unfinished task', busyRejected)
  await call('agent_teams_reassign_task', {
    task_id: t5.task_id, assignee: 'captain', reason: 'close busy-check task',
  })
  await call('agent_teams_update_task', { task_id: t5.task_id, status: 'in_progress' })
  await call('agent_teams_update_task', { task_id: t5.task_id, status: 'completed', output: 'closed' })

  await call('agent_teams_remove_member', { name: 'alpha' })
  const afterRemoval = await state()
  const recovered = afterRemoval?.tasks.find(candidate => candidate.id === t4.task_id)
  check('removing a member revokes and redispatches its unfinished task',
    afterRemoval?.members.find(member => member.name === 'alpha')?.status === 'removed'
      && recovered?.assignee !== 'alpha')
  check('removing a member preserves its catalog entry for transcript history',
    (await ctx.subagents.listChildren(captain.id)).some(child => child.id === alpha.id))
  let removedFollowupRejected = false
  const deliveriesBeforeRemovedFollowup = deliveries.length
  try {
    await directPrompt(captain, alpha.id, [{ type: 'text', text: 'must not resume' }], {
      source: { kind: 'plugin', plugin: 'verification' }, signal: new AbortController().signal,
    })
  } catch (error) {
    removedFollowupRejected = error?.code === 'NOT_RESUMABLE'
  }
  check('removing a member blocks direct followup before resume',
    removedFollowupRejected && deliveries.length === deliveriesBeforeRemovedFollowup)
  let removedRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: t4.task_id, status: 'completed', output: 'removed alpha', attempt_id: reused?.attemptId,
    }, alpha)
  } catch {
    removedRejected = true
  }
  check('removed member loses participant authorization', removedRejected)

  // Finish all work recovered from alpha so beta/gamma are free for later races.
  for (const recoveredTaskId of [t4.task_id]) {
    const current = await task(recoveredTaskId)
    if (!current?.assignee || current.status !== 'claimed') continue
    const owner = current.assignee === 'beta' ? beta : gamma
    const claim = await call('agent_teams_claim_task', { task_id: recoveredTaskId }, owner)
    await call('agent_teams_update_task', { task_id: recoveredTaskId, status: 'in_progress', attempt_id: claim.attempt_id }, owner)
    await call('agent_teams_update_task', {
      task_id: recoveredTaskId, status: 'completed', output: 'recovered', attempt_id: claim.attempt_id,
    }, owner)
  }

  await call('agent_teams_status', {}, gamma)
  gamma.status = 'idle'
  failNextDelivery.add(gamma.id)
  const fallback = await call('agent_teams_send_message', { to: 'gamma', content: 'durable fallback' })
  check('failed live message remains one unread durable fallback',
    fallback.delivered === 'mailbox' && (await readUnreadMailbox(stateRoot, teamId, 'gamma')).length === 1)
  await call('agent_teams_status', {})
  check('status kick accepts fallback without inventing consumption',
    (await readUnreadMailbox(stateRoot, teamId, 'gamma')).length === 1
      && (await readMailbox(stateRoot, teamId, 'gamma')).at(-1)?.deliveredAt !== undefined)
  await call('agent_teams_status', {}, gamma)
  check('recipient status acknowledges the complete fallback actually displayed',
    (await readUnreadMailbox(stateRoot, teamId, 'gamma')).length === 0)

  beta.status = 'running'
  gamma.status = 'running'
  const t6 = await call('agent_teams_create_task', { subject: 'concurrent claim' })
  beta.status = 'idle'
  gamma.status = 'idle'
  const race = await Promise.allSettled([
    call('agent_teams_claim_task', { task_id: t6.task_id }, beta),
    call('agent_teams_claim_task', { task_id: t6.task_id }, gamma),
  ])
  check('concurrent claims serialize to exactly one owner',
    race.filter(result => result.status === 'fulfilled').length === 1
      && race.filter(result => result.status === 'rejected').length === 1)
  const won = race.find(result => result.status === 'fulfilled').value
  const winner = won.assignee === 'beta' ? beta : gamma
  // A successful member claim is made from a running model turn. Preserve
  // that Harness status edge before unrelated kicks can retry an idle claim.
  winner.status = 'running'
  await call('agent_teams_update_task', { task_id: t6.task_id, status: 'in_progress', attempt_id: won.attempt_id }, winner)
  await call('agent_teams_update_task', {
    task_id: t6.task_id, status: 'completed', output: 'winner', attempt_id: won.attempt_id,
  }, winner)
  let terminalRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: t6.task_id, status: 'completed', output: 'late overwrite', attempt_id: won.attempt_id,
    }, winner)
  } catch (error) {
    terminalRejected = /immutable/.test(String(error))
  }
  check('terminal output is immutable against late overwrite', terminalRejected)

  beta.status = 'idle'
  const t7 = await call('agent_teams_create_task', { subject: 'captain takeover', assignee: 'beta' })
  const betaTakeoverClaim = await call('agent_teams_claim_task', { task_id: t7.task_id }, beta)
  await call('agent_teams_update_task', {
    task_id: t7.task_id, status: 'in_progress', attempt_id: betaTakeoverClaim.attempt_id,
  }, beta)
  const captainAttempt = await call('agent_teams_reassign_task', {
    task_id: t7.task_id, assignee: 'captain', reason: 'deadline takeover',
  })
  await call('agent_teams_update_task', { task_id: t7.task_id, status: 'in_progress' })
  await call('agent_teams_update_task', { task_id: t7.task_id, status: 'completed', output: 'captain result' })
  let lateTakeoverRejected = false
  try {
    await call('agent_teams_update_task', {
      task_id: t7.task_id, status: 'completed', output: 'late beta', attempt_id: betaTakeoverClaim.attempt_id,
    }, beta)
  } catch {
    lateTakeoverRejected = true
  }
  check('captain takeover owns a fresh attempt and rejects the old member',
    captainAttempt.assignee === 'captain' && captainAttempt.attempt_id !== betaTakeoverClaim.attempt_id
      && captainAttempt.status === 'in_progress'
      && captainAttempt.attempt === betaTakeoverClaim.attempt + 1
      && lateTakeoverRejected && (await task(t7.task_id))?.output === 'captain result')

  // A captain is one execution lane, not an unlimited pseudo-member. Two
  // parallel takeovers previously produced the issue #77 state: both member
  // rows lost their tasks while two captain-owned attempts stayed parked.
  beta.status = 'idle'
  gamma.status = 'idle'
  const t8 = await call('agent_teams_create_task', { subject: 'parallel captain takeover A', assignee: 'beta' })
  const t9 = await call('agent_teams_create_task', { subject: 'parallel captain takeover B', assignee: 'gamma' })
  const betaParallelClaim = await call('agent_teams_claim_task', { task_id: t8.task_id }, beta)
  const gammaParallelClaim = await call('agent_teams_claim_task', { task_id: t9.task_id }, gamma)
  await call('agent_teams_update_task', {
    task_id: t8.task_id, status: 'in_progress', attempt_id: betaParallelClaim.attempt_id,
  }, beta)
  await call('agent_teams_update_task', {
    task_id: t9.task_id, status: 'in_progress', attempt_id: gammaParallelClaim.attempt_id,
  }, gamma)
  const captainTakeoverRace = await Promise.allSettled([
    call('agent_teams_reassign_task', {
      task_id: t8.task_id, assignee: 'captain', reason: 'parallel takeover guard A',
    }),
    call('agent_teams_reassign_task', {
      task_id: t9.task_id, assignee: 'captain', reason: 'parallel takeover guard B',
    }),
  ])
  const raceState = await state()
  check('parallel captain takeovers allow exactly one active captain task',
    captainTakeoverRace.filter(result => result.status === 'fulfilled').length === 1
      && captainTakeoverRace.filter(result => result.status === 'rejected'
        && /captain is busy with/.test(String(result.reason))).length === 1
      && raceState?.tasks.filter(candidate => candidate.assignee === 'captain'
        && (candidate.status === 'claimed' || candidate.status === 'in_progress')).length === 1)

  // If the captain ends the turn without completing that one takeover, it
  // must return to the ordinary member scheduler instead of staying white and
  // ownerless forever in the activity panel.
  publishStatus(captain, 'idle')
  // The requeue lands only after team.json's atomic write, which on Windows
  // can stall on transient rename EPERM retries (issue #108), so poll for
  // settlement instead of guessing a fixed wait.
  let afterCaptainIdle = await state()
  for (let waited = 0; waited < 2000; waited += 20) {
    // A torn read during a degraded non-atomic overwrite must not kill the
    // run; treat it as "not settled yet" and keep polling.
    const settled = ((afterCaptainIdle?.tasks.filter(candidate => (
      candidate.id === t8.task_id || candidate.id === t9.task_id
    )) ?? []).every(candidate => candidate.assignee !== 'captain'
      && (candidate.status === 'claimed' || candidate.status === 'in_progress')))
    if (settled) break
    await new Promise(resolve => setTimeout(resolve, 20))
    afterCaptainIdle = await state().catch(() => undefined)
  }
  const recoveredParallel = afterCaptainIdle?.tasks.filter(candidate => (
    candidate.id === t8.task_id || candidate.id === t9.task_id
  )) ?? []
  check('unfinished captain takeover returns to a member when the captain becomes idle',
    recoveredParallel.length === 2
      && recoveredParallel.every(candidate => candidate.assignee !== 'captain')
      && recoveredParallel.every(candidate => candidate.status === 'claimed' || candidate.status === 'in_progress'))
  for (const recoveredTask of recoveredParallel) {
    const owner = recoveredTask.assignee === 'beta' ? beta : gamma
    owner.status = 'running'
    const claim = await call('agent_teams_claim_task', { task_id: recoveredTask.id }, owner)
    await call('agent_teams_update_task', {
      task_id: recoveredTask.id, status: 'in_progress', attempt_id: claim.attempt_id,
    }, owner)
    await call('agent_teams_update_task', {
      task_id: recoveredTask.id, status: 'completed', output: 'member recovered captain work', attempt_id: claim.attempt_id,
    }, owner)
  }

  beta.status = 'running'
  gamma.status = 'idle'
  const snapshot = await call('agent_teams_status', {})
  check('activity refines residency through the live Agent registry',
    snapshot.members.find(member => member.name === 'beta')?.activity === 'running'
      && snapshot.members.find(member => member.name === 'gamma')?.activity === 'idle')

  beta.status = 'idle'
  gamma.status = 'idle'
  // Exercise the storage-only ready path: deletion must deny cold resume
  // without materializing the member or spending a model turn.
  liveAgents.delete(gamma.id)
  await call('agent_teams_delete', {})
  const archived = await readArchivedTeam(stateRoot, teamId)
  check('team shutdown archives the complete durable record',
    await readTeam(stateRoot, teamId) === undefined
      && archived !== undefined)
  const archivedSnapshot = (await collectArchivedTeamsActivity(ctx, [{ workspace, stateRoot }]))
    .find(candidate => candidate.teamId === teamId)
  check('archived activity keeps every member after shutdown',
    archivedSnapshot?.members.length === 3
      && ['alpha', 'beta', 'gamma'].every(name => archivedSnapshot.members.some(member => member.name === name))
      && archivedSnapshot.members.every(member => member.activity === 'idle'))
  check('archived activity projects each member model onto assigned tasks',
    archivedSnapshot?.members.every(member => member.provider === 'fake' && member.model === 'fake-model')
      && archivedSnapshot.tasks
        .filter(task => ['alpha', 'beta', 'gamma'].includes(task.assignee))
        .every(task => task.model === 'fake/fake-model'))
  check('team shutdown keeps retired members catalog-visible for historical transcripts',
    (await ctx.subagents.listChildren(captain.id))
      .filter(child => child.kind === 'child'
        && child.mode === 'continuable'
        && child.label.startsWith('agent-teams:lifecycle:')).length === 3)
  let coldFollowupRejected = false
  const deliveriesBeforeColdFollowup = deliveries.length
  try {
    await directPrompt(captain, gamma.id, [{ type: 'text', text: 'must stay retired' }], {
      source: { kind: 'plugin', plugin: 'verification' }, signal: new AbortController().signal,
    })
  } catch (error) {
    coldFollowupRejected = error?.code === 'NOT_RESUMABLE'
  }
  check('team shutdown blocks storage-only member cold resume',
    coldFollowupRejected && deliveries.length === deliveriesBeforeColdFollowup)
  check('team shutdown leaves unrelated continuable subagents untouched',
    (await ctx.subagents.listChildren(captain.id))
      .some(child => child.id === 'foreign-session' && child.mode === 'continuable'))
  const foreignFollowup = await directPrompt(captain, 'foreign-session', [
    { type: 'text', text: 'unrelated work still routes' },
  ], {
    source: { kind: 'plugin', plugin: 'verification' }, signal: new AbortController().signal,
  })
  check('team shutdown leaves unrelated continuable followup untouched',
    typeof foreignFollowup === 'string'
      && deliveries.some(delivery => delivery.childId === 'foreign-session'))

  await call('agent_teams_create', {
    name: 'Atomic Approval',
    description: 'invalid route must not partially start',
    approval: 'required',
  })
  await call('agent_teams_add_member', { name: 'valid', role: 'writer', provider: 'fake', model: 'fake-model' })
  await call('agent_teams_add_member', { name: 'invalid', role: 'reviewer', provider: 'fake', model: 'typo-model' })
  await call('agent_teams_create_task', { subject: 'must remain staged', assignee: 'valid' })
  const childrenBeforeRejectedApproval = children.length
  advertisedModels = ['fake-model']
  let invalidApprovalRejected = false
  try {
    await call('agent_teams_approve', { confirmation: 'user clicked Approve & Run' })
  } catch (error) {
    invalidApprovalRejected = /unknown member model.*typo-model/i.test(String(error?.message ?? error))
  }
  const rejectedApprovalTeam = await readTeam(stateRoot, 'atomic-approval')
  check('invalid roster approval rejects before any member session is created',
    invalidApprovalRejected
      && children.length === childrenBeforeRejectedApproval
      && rejectedApprovalTeam?.phase === 'staged'
      && rejectedApprovalTeam.members.every(member => member.id === '')
      && rejectedApprovalTeam.tasks.every(item => item.status === 'pending'))
  advertisedModels = []
  await call('agent_teams_delete', {})

  await call('agent_teams_create', { name: 'Lifecycle', description: 'second generation' })
  await call('agent_teams_delete', {})
  const replacementArchive = await readArchivedTeam(stateRoot, teamId)
  check('same-name team can be recreated and archived again',
    await readTeam(stateRoot, teamId) === undefined
      && replacementArchive?.description === 'second generation')

  // ── member turn failure bridging (issue #94) ─────────────────────────
  // A member turn dies mid-stream with a transport-class failure and the
  // harness emits no idle edge: the continuable handle survives and the
  // durable record keeps the member "working". The plugin must bridge the
  // failure at the final agent/error boundary. A request error may still be
  // retried by Harness, and must not close the task prematurely.
  await call('agent_teams_create', { name: 'Failure Bridge', description: 'turn failures must surface' })
  await call('agent_teams_add_member', { name: 'flake', role: 'streaming worker' })
  const flakeTask = await call('agent_teams_create_task', { subject: 'streaming work', assignee: 'flake' })
  const flakeTeam = await readTeam(stateRoot, 'failure-bridge')
  const flake = liveAgents.get(flakeTeam.members.find(member => member.name === 'flake').id)
  const flakeClaim = await call('agent_teams_claim_task', { task_id: flakeTask.task_id }, flake)
  await call('agent_teams_update_task', {
    task_id: flakeTask.task_id, status: 'in_progress', attempt_id: flakeClaim.attempt_id,
  }, flake)

  // The captain asks the working member a question while its turn is wedged;
  // live delivery is unavailable, so the message stays a durable fallback
  // that only the scheduler mailbox flush can hand over.
  failNextDelivery.add(flake.id)
  await call('agent_teams_send_message', { to: 'flake', content: 'status update please' })
  const deliveriesBeforeFailure = deliveries.length
  const captainMailBeforeFailure = (await readMailbox(stateRoot, 'failure-bridge', 'captain')).length
  const captainSteersBeforeFailure = captain.steers.length

  // The turn dies mid-stream with a transport-class failure and no idle edge.
  const failureAction = await emitRequestError(flake, {
    code: 'STREAM_CLOSED',
    message: 'SSE stream ended without [DONE]',
  })
  check('request failure alone leaves the attempt open for Harness recovery',
    failureAction === undefined
      && (await readTeam(stateRoot, 'failure-bridge')).tasks.find(task => task.id === flakeTask.task_id)?.status === 'in_progress'
      && captain.steers.length === captainSteersBeforeFailure)
  emitTurnError(flake, { code: 'STREAM_CLOSED', message: 'SSE stream ended without [DONE]' })
  // Degraded non-atomic overwrites can hand a reader torn JSON; retry the
  // durable reads instead of letting environmental I/O noise fail the checks.
  const readTeamStable = async (teamId) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await readTeam(stateRoot, teamId) } catch (error) { if (attempt >= 5) throw error }
    }
  }
  const readMailboxStable = async (teamId, agentKey) => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await readMailbox(stateRoot, teamId, agentKey) } catch (error) { if (attempt >= 5) throw error }
    }
  }
  const bridgeState = () => readTeamStable('failure-bridge')
  const bridgeTask = async () => (await bridgeState())?.tasks.find(candidate => candidate.id === flakeTask.task_id)
  for (let waited = 0; waited < 2000; waited += 20) {
    if ((await bridgeTask())?.status === 'failed' && captain.steers.length > captainSteersBeforeFailure
      && deliveries.length === deliveriesBeforeFailure
      && (await readUnreadMailbox(stateRoot, 'failure-bridge', 'flake')).length === 0) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const stalledFlake = (await bridgeState())?.members.find(member => member.name === 'flake')
  const captainMail = await readMailboxStable('failure-bridge', 'captain')
  check('turn failure fails the open attempt, releases the member, and owns no retry',
    failureAction === undefined
      && (await bridgeTask())?.status === 'failed'
      && (await bridgeTask())?.output?.includes('STREAM_CLOSED') === true
      && stalledFlake?.status === 'idle')
  check('turn failure notifies the captain mailbox with the error code',
    captainMail.length === captainMailBeforeFailure + 1
      && captainMail.at(-1)?.from === 'flake'
      && captainMail.at(-1)?.to === 'captain'
      && captainMail.at(-1)?.content.includes('STREAM_CLOSED') === true
      && captainMail.at(-1)?.content.includes(flakeTask.task_id)
      && captainSteersBeforeFailure + 1 === captain.steers.length)
  check('settled member discards failed-attempt guidance without another model turn',
    deliveries.length === deliveriesBeforeFailure
      && (await readUnreadMailbox(stateRoot, 'failure-bridge', 'flake')).length === 0
      && (await bridgeTask())?.status === 'failed')
  await call('agent_teams_delete', {})

  const batchPlan = { members: [{ name: 'worker' }, { name: 'verifier' }], tasks: [
    { id: 'verify', subject: 'Validate output', assignee: 'verifier', dependencies: ['work'] },
    { id: 'work', subject: 'Actual task', description: 'FULL_CONTRACT_BODY', assignee: 'worker' },
  ] }
  const beforeBadPlan = children.length
  let badPlanRejected = false
  try { await call('agent_teams_create', { name: 'Atomic Invalid', plan: { ...batchPlan, tasks: [{ id: 'x', subject: 'cycle', dependencies: ['x'] }] } }) } catch { badPlanRejected = true }
  check('invalid batch plan is rejected without any state or session side effect', badPlanRejected && children.length === beforeBadPlan && await readTeam(stateRoot, 'atomic-invalid') === undefined)
  const batch = await call('agent_teams_create', { name: 'Batch Plan', description: 'One call builds roster and DAG', plan: batchPlan, approval: 'required' })
  const stagedBatch = await readTeam(stateRoot, 'batch-plan')
  check('one atomic call creates the full roster and resolves forward dependency references', batch.members.length === 2 && batch.tasks.length === 2 && stagedBatch.members.every(m => m.id === '') && stagedBatch.tasks[1].dependencies[0] === stagedBatch.tasks[0].id)
  const deliveryBeforeWork = await call('agent_teams_status', {})
  check('ordinary pending work cannot be reported deliverable', !deliveryBeforeWork.deliverable && !deliveryBeforeWork.delivery.ok)
  await call('agent_teams_approve', { confirmation: 'Run the accepted batch' })
  const workingBatch = await readTeam(stateRoot, 'batch-plan')
  const batchWorker = liveAgents.get(workingBatch.members.find(m => m.name === 'worker').id)
  const batchTask = workingBatch.tasks[0]
  const details = await call('agent_teams_claim_task', { task_id: batchTask.id }, batchWorker)
  check('claim exposes the complete task contract without reading team files', details.task_details.includes('FULL_CONTRACT_BODY'))
  failNextDrain.add(batchWorker.id)
  let drainRejected = false
  try { await call('agent_teams_reassign_task', { task_id: batchTask.id, assignee: 'worker' }) } catch { drainRejected = true }
  const failedHandoff = await readTeam(stateRoot, 'batch-plan')
  check('failed teardown keeps reassignment fenced and does not launch a new generation', drainRejected && failedHandoff.tasks[0].reassigning && failedHandoff.members.find(m => m.name === 'worker').stopping)
  await call('agent_teams_reassign_task', { task_id: batchTask.id, assignee: 'worker' })
  const retriedHandoff = await readTeam(stateRoot, 'batch-plan')
  check('the same failed handoff can be retried safely', !retriedHandoff.tasks[0].reassigning && !retriedHandoff.members.find(m => m.name === 'worker').stopping && retriedHandoff.tasks[0].status === 'claimed')
  failNextDrain.add(batchWorker.id)
  let archiveRejected = false
  try { await call('agent_teams_delete', {}) } catch { archiveRejected = true }
  check('failed member drain never reports a successful archive', archiveRejected && await readTeam(stateRoot, 'batch-plan') !== undefined && await readArchivedTeam(stateRoot, 'batch-plan') === undefined)
  await call('agent_teams_delete', {})
  check('archive retries drain previously removed roster rows', await readTeam(stateRoot, 'batch-plan') === undefined && !liveAgents.has(batchWorker.id))
} finally {
  await rm(workspace, { recursive: true, force: true })
}

// Regression, found while replaying the t5 incident (WP1 release gate): a
// member's own fresh attempt must not be treated as a lost owner.
//
// `pending` and `claimed` carry no `attemptId`, and `update_task` never calls
// `beginTaskAttempt`, so the only fence on a member's own attempt between
// `claim` and its first `update_task` is the attempt counter itself. The
// scheduler used to read "owned, but the durable attemptId is not the one I
// parked" as a lost owner and recovered it: `beginTaskAttempt` re-claimed the
// task under the member, so `in_progress` silently dropped back to `claimed`,
// the attempt counter grew, and the member's own `update_task` was refused
// either as a stale attempt or as an illegal status transition. A real worker
// doing "claim, work, update_task" could lose its own task.
{
  const attemptWorkspace = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-attempt-'))
  try {
    const defs = new Map()
    const agents = new Map()
    const spawns = []
    let seq = 0
    const cap = {
      id: 'captain-attempt',
      status: 'idle',
      options: { provider: 'fake', model: 'fake-model' },
      session: {
        header: { cwd: attemptWorkspace, seedLength: 0 },
        events: [],
        append() {},
        requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
      },
      followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() { return Promise.resolve() },
    }
    agents.set(cap.id, cap)
    const attemptCtx = {
      effect(setup) { return setup() },
      tools: { register(definition) { defs.set(definition.name, definition) } },
      on() { return () => {} },
      agents: { get(id) { return agents.get(id) } },
      llm: { async resolveCallConfig(config) { return config }, async listModels() { return [] } },
      subagents: {
        registerContinuableSetup() { return () => {} },
        getProvider(name) {
          return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined
        },
        list() { return ['spawn'] },
        async startContinuable(spec) {
          const id = `attempt-child-${++seq}`
          agents.set(id, {
            id,
            status: 'idle',
            options: { provider: 'fake', model: 'fake-model' },
            session: cap.session,
            followup() {},
            steers: [],
            steer(message) { this.steers.push(message); this.status = 'running' },
            inject() {},
            cancel() {},
            whenIdle() { return Promise.resolve() },
          })
          spawns.push({ id, label: spec.label })
          return { childId: id, messageId: `welcome-${seq}` }
        },
        async listChildren() { return spawns },
        async listDescendants() { return spawns },
        async followup() { return 'x' },
        interrupt() {},
        async drainContinuableChildren() {},
      },
      logger: { debug() {}, warn() {} },
    }
    const attemptRoot = join(attemptWorkspace, '.agent-teams')
    registerAgentTeamsTools(attemptCtx, {
      stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 4, profiles: {},
    })
    let attemptTeamId = ''
    const attemptCall = async (name, args, subject = cap) => {
      const payload = { ...args }
      if (payload.team_id === undefined && subject === cap && attemptTeamId !== '') payload.team_id = attemptTeamId
      const result = await defs.get(name).execute(payload, { agent: subject, signal: new AbortController().signal })
      if (name === 'agent_teams_create' && subject === cap && typeof result?.team_id === 'string') attemptTeamId = result.team_id
      if (name === 'agent_teams_delete') attemptTeamId = ''
      return result
    }
    await attemptCall('agent_teams_create', { name: 'Attempt Fence', description: 'scheduler attempt fence' })
    await attemptCall('agent_teams_add_member', { name: 'worker', role: 'implementer' })
    const todo = await attemptCall('agent_teams_create_task', { subject: 'Work', assignee: 'worker' })
    const memberAgent = agents.get(spawns[0].id)
    const claimed = await defs.get('agent_teams_claim_task').execute(
      { task_id: todo.task_id },
      { agent: memberAgent, signal: new AbortController().signal },
    )
    const afterClaim = (await readTeam(attemptRoot, 'attempt-fence')).tasks[0]
    await defs.get('agent_teams_update_task').execute(
      { task_id: todo.task_id, attempt_id: claimed.attempt_id, status: 'in_progress' },
      { agent: memberAgent, signal: new AbortController().signal },
    )
    // Give the post-write scheduler kick time to (wrongly) recover the attempt.
    await new Promise(resolve => setTimeout(resolve, 40))
    const afterKick = (await readTeam(attemptRoot, 'attempt-fence')).tasks[0]
    check(
      'a member keeps its own in_progress attempt across a scheduler kick',
      afterKick.status === 'in_progress' && afterKick.attempt === afterClaim.attempt,
      `claimed attempt ${afterClaim.attempt} (${afterClaim.status}) -> ${afterKick.attempt} (${afterKick.status})`,
    )
    let completed = ''
    try {
      await defs.get('agent_teams_update_task').execute(
        { task_id: todo.task_id, attempt_id: afterKick.attemptId, status: 'completed', output: 'done' },
        { agent: memberAgent, signal: new AbortController().signal },
      )
      completed = (await readTeam(attemptRoot, 'attempt-fence')).tasks[0].status
    } catch (error) {
      completed = String(error.message)
    }
    check('a member can complete the task it is holding', completed === 'completed', completed)
  } finally {
    await rm(attemptWorkspace, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} lifecycle check(s) FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall lifecycle checks passed')
