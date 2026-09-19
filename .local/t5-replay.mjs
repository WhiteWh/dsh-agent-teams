#!/usr/bin/env node
/**
 * t5 replay for the release gate (AGENT_TEAMS_FEEDBACK.md sections 1-3).
 *
 * The incident: lane `npr-a` = t5. Two of its acceptance criteria pointed at
 * checks that are RED ON HEAD for an external reason. The honest implementer
 * refused to write "passed"; the gate demanded every criterion passed, so t5 was
 * forced `failed`; `failed` was terminal, so c1/c2/verify/review stayed
 * `pending` forever and the captain had to cancel 5 tasks and create 7.
 *
 * This script drives the REAL compiled tools (`registerAgentTeamsTools`) over a
 * throwaway workspace and records:
 *   - the exact rejection a false "passed" still gets,
 *   - that ONE waived resubmission is accepted and records `hasWaivers`,
 *   - that Delivery stays blocked with "t5 has unconfirmed waivers",
 *   - that the reviewer's explicit `waiverConfirmation` clears it,
 *   - how many calls the recovery took (the claim under test: one submission).
 *
 * Run: cmd /c ".local\pnpm.cmd exec node .local\t5-replay.mjs"
 *
 * State machine note: `claimed -> completed` is not a transition. A member sends
 * `in_progress` and then its terminal status, so this replay does the same.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { canDeclareDelivery, readTeam } from '../lib/state.js'

const PASS = '  PASS  '
const INFO = '  ..    '
const TEAM = 'Material Layers'
const TEAM_ID = 'material-layers'
let failures = 0

function log(text) {
  console.log(text)
}

function check(label, value, detail = '') {
  if (value) log(`${PASS}${label}${detail === '' ? '' : ` -- ${detail}`}`)
  else {
    failures += 1
    log(`  FAIL  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  }
}

function packageVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 't5-replay-'))
  const stateRoot = join(workspace, '.agent-teams')
  const definitions = new Map()
  const liveAgents = new Map()
  const children = []
  let childSeq = 0

  const mkAgent = (id) => ({
    id,
    status: 'idle',
    options: { provider: 'fake', model: 'fake-model' },
    session: {
      header: { cwd: workspace, seedLength: 0 },
      events: [],
      append() {},
      requestHeader() { return { config: { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' } } },
    },
    followup() {},
    steer() {},
    cancel() {},
    inject() {},
    whenIdle() { return Promise.resolve() },
  })
  const captain = mkAgent('captain-session')
  liveAgents.set(captain.id, captain)

  const ctx = {
    effect(setup) { return setup() },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    on() { return () => {} },
    agents: { get(id) { return liveAgents.get(id) } },
    llm: { async resolveCallConfig(config) { return config }, async listModels() { return [] } },
    subagents: {
      registerContinuableSetup() { return () => {} },
      getProvider(name) {
        return name === 'spawn'
          ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }
          : undefined
      },
      list() { return ['spawn'] },
      async startContinuable(spec) {
        const id = `member-session-${++childSeq}`
        liveAgents.set(id, mkAgent(id))
        children.push({ id, label: spec.label })
        return { childId: id, messageId: `welcome-${childSeq}` }
      },
      async listChildren() { return children },
      async listDescendants() { return children },
      async followup() { return `message-${childSeq}` },
      interrupt() {},
      async drainContinuableChildren(_parent, ids) { for (const id of ids) liveAgents.delete(id) },
    },
    logger: { debug() {}, warn() {} },
  }

  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams',
    memberProvider: 'spawn',
    memberMaxDepth: 1,
    maxMembers: 8,
    profiles: {},
  })

  /**
   * Run a mutating tool whose write must be observed deterministically.
   *
   * Every mutating tool kicks the scheduler *after* its write and without
   * awaiting it, so a background kick can keep working the team while this
   * replay reads it. Aborting the signal right after the call keeps the durable
   * write and turns the post-write kick into a no-op.
   */
  const settle = async (name, args, subject = captain) => {
    const controller = new AbortController()
    const definition = definitions.get(name)
    if (!definition) throw new Error(`missing tool ${name}`)
    const result = await definition.execute(args, { agent: subject, signal: controller.signal })
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 5))
    return result
  }

  /** Member-level call: members never kick the scheduler themselves. */
  const memberCall = (name, args, member) => {
    const definition = definitions.get(name)
    if (!definition) throw new Error(`missing tool ${name}`)
    return definition.execute(args, { agent: member, signal: new AbortController().signal })
  }

  const taskOf = async (taskId) => (await readTeam(stateRoot, TEAM_ID)).tasks.find(task => task.id === taskId)
  const blockers = async () => canDeclareDelivery(await readTeam(stateRoot, TEAM_ID)).blockers

  // The spawner labels children `agent-teams:<team>:<member>`; match the suffix.
  const findChild = (memberName) => children.find(child => (
    child.label === memberName || child.label.endsWith(`:${memberName}`)
  ))

  /** Start a member session by handing it one `kind=work` task and finishing it. */
  const startMember = async (memberName) => {
    const spawn = await settle('agent_teams_create_task', { subject: `start ${memberName}`, assignee: memberName })
    const child = findChild(memberName)
    if (child === undefined) throw new Error(`member "${memberName}" did not start from a claimable task`)
    const member = liveAgents.get(child.id)
    const claimed = await memberCall('agent_teams_claim_task', { task_id: spawn.task_id }, member)
    await memberCall('agent_teams_update_task', {
      task_id: spawn.task_id,
      attempt_id: claimed.attempt_id,
      status: 'in_progress',
    }, member)
    await memberCall('agent_teams_update_task', {
      task_id: spawn.task_id,
      attempt_id: claimed.attempt_id,
      status: 'completed',
      output: 'member session started',
    }, member)
    return member
  }

  log(`t5 replay -- AgentTeams ${packageVersion()} on DeepSeek Harness 0.1.5-rc.1`)
  log(`workspace: ${workspace}`)
  log('')
  log('SCENARIO (AGENT_TEAMS_FEEDBACK.md section 2): lane npr-a is t5; two of its')
  log('acceptance criteria point at checks that are already red on HEAD for an')
  log('external reason (terrain_fork_check._TNH, ui_smoke -> fxplayer.py:15593).')
  log('')

  try {
    // -- roster -------------------------------------------------------------
    await settle('agent_teams_create', { name: TEAM, description: 't5 replay' })
    await settle('agent_teams_add_member', { name: 'npr-a', role: 'implementer' })
    await settle('agent_teams_add_member', { name: 'reviewer', role: 'correctness-reviewer' })
    const nprA = await startMember('npr-a')
    const reviewer = await startMember('reviewer')
    const roster = (await readTeam(stateRoot, TEAM_ID)).members.map(member => member.name)
    log(`${INFO}roster: ${roster.join(', ')} (npr-a and reviewer sessions started)`)
    log('')

    // -- the failing contract ----------------------------------------------
    const t5 = await settle('agent_teams_create_task', {
      subject: 'npr-a: terrain fork + UI smoke lane',
      kind: 'implementation',
      assignee: 'npr-a',
      objective: 'Land the np-r-a lane and verify it against HEAD',
      inScope: ['panels.py', 'upscalepanel.py'],
      acceptance: [
        'terrain_fork_check._TNH reports no new failure',
        'ui_smoke shows no new failure at fxplayer.py:15593',
      ],
      verify: ['python -m pytest tests/terrain_fork_check.py', 'python -m ui_smoke'],
      coverageOf: ['land npr-a'],
    })
    log(`${INFO}t5 = ${t5.task_id} (kind implementation, assignee npr-a)`)
    log(`${INFO}criterion 1: terrain_fork_check._TNH reports no new failure`)
    log(`${INFO}criterion 2: ui_smoke shows no new failure at fxplayer.py:15593`)
    log('')

    let claim = await memberCall('agent_teams_claim_task', { task_id: t5.task_id }, nprA)
    log(`${INFO}${t5.task_id} claimed by npr-a (attempt ${claim.attempt})`)
    log('')

    // -- a false "passed" is still refused ---------------------------------
    log('STEP 1 -- the honest member reports what it actually measured.')
    // The member works the task first: `claimed -> completed` is not a state
    // transition, so a worker always reports `in_progress` before its result.
    await memberCall('agent_teams_update_task', {
      task_id: t5.task_id,
      attempt_id: claim.attempt_id,
      status: 'in_progress',
    }, nprA)

    let rawFailure = ''
    try {
      await memberCall('agent_teams_update_task', {
        task_id: t5.task_id,
        attempt_id: claim.attempt_id,
        status: 'completed',
        changedPaths: ['panels.py', 'upscalepanel.py'],
        acceptanceResults: [
          { criterion: 'terrain_fork_check._TNH reports no new failure', status: 'passed', evidence: 'identical at baseline' },
          { criterion: 'ui_smoke shows no new failure at fxplayer.py:15593', status: 'passed', evidence: 'identical at baseline' },
        ],
        // What the member actually measured: both checks are red on HEAD.
        commandsRun: [
          { command: 'python -m pytest tests/terrain_fork_check.py', status: 'failed', exitCode: 1 },
          { command: 'python -m ui_smoke', status: 'failed', exitCode: 1 },
        ],
      }, nprA)
    } catch (error) {
      rawFailure = error.message
    }
    log(`${INFO}writing "passed" against a red measurement is refused:`)
    log(`${INFO}  ${rawFailure}`)
    check(
      'l1-false-pass-is-still-refused',
      /verify failure must fail the task/i.test(rawFailure),
      rawFailure.slice(0, 150),
    )

    const failed = await settle('agent_teams_update_task', {
      task_id: t5.task_id,
      attempt_id: claim.attempt_id,
      status: 'failed',
      output: 'Lane work is complete; terrain_fork_check._TNH and ui_smoke are red on HEAD before this lane.',
    }, nprA)
    log(`${INFO}${failed.task_id} -> ${failed.status} (the pre-0.1.21 dead end: terminal, descendants stranded)`)
    log('')

    // -- ONE waived submission resolves it ---------------------------------
    log('STEP 2 -- the same member resolves t5 with ONE waived submission.')
    const recovery = []
    const reassign = await settle('agent_teams_reassign_task', {
      task_id: t5.task_id,
      assignee: 'npr-a',
      reason: 'retry with waivers for the two externally red checks',
    }, captain)
    recovery.push('reassign_task')
    log(`${INFO}reassign_task -> attempt ${reassign.attempt}, status ${reassign.status}`)

    claim = await memberCall('agent_teams_claim_task', { task_id: t5.task_id }, nprA)
    await memberCall('agent_teams_update_task', {
      task_id: t5.task_id,
      attempt_id: claim.attempt_id,
      status: 'in_progress',
    }, nprA)
    const waived = await memberCall('agent_teams_update_task', {
      task_id: t5.task_id,
      attempt_id: claim.attempt_id,
      status: 'completed',
      output: 'Lane complete. Both checks are red on HEAD 059e5ae for reasons outside this lane; reported as waived.',
      changedPaths: ['panels.py', 'upscalepanel.py'],
      acceptanceResults: [
        {
          criterion: 'terrain_fork_check._TNH reports no new failure',
          status: 'waived',
          evidence: 'red on HEAD 059e5ae before this lane (terrain_fork_check._TNH); byte-identical after',
        },
        {
          criterion: 'ui_smoke shows no new failure at fxplayer.py:15593',
          status: 'waived',
          evidence: 'red on HEAD 059e5ae before this lane (fxplayer.py:15593); byte-identical after',
        },
      ],
      commandsRun: [
        { command: 'python -m pytest tests/terrain_fork_check.py', status: 'waived', evidence: 'pre-existing failure, identical to baseline 059e5ae' },
        { command: 'python -m ui_smoke', status: 'waived', evidence: 'pre-existing failure at fxplayer.py:15593, identical to baseline' },
      ],
    }, nprA)
    recovery.push('update_task(waived x2)')
    log(`${INFO}update_task -> ${waived.task_id} ${waived.status}`)
    check('l2-one-waived-submission-is-accepted', waived.status === 'completed')

    const persisted = await taskOf(t5.task_id)
    check(
      'l3-task-records-hasWaivers-and-evidence',
      persisted?.hasWaivers === true
        && persisted.acceptanceResults.every(result => result.status === 'waived' && result.evidence.trim() !== ''),
      `hasWaivers=${String(persisted?.hasWaivers)}`,
    )

    const blocked = await blockers()
    log(`${INFO}Delivery after the waiver: ${blocked.length === 0 ? 'ok' : `blocked (${blocked.join('; ')})`}`)
    check(
      'l4-delivery-blocked-until-a-review-confirms',
      blocked.includes(`${t5.task_id} has unconfirmed waivers`),
      JSON.stringify(blocked),
    )
    log('')

    // -- descendants are not stranded --------------------------------------
    // c1 depends on t5 and is kind=work, so no member is dispatched to it: the
    // point here is that a dependent of t5 is dispatchable at all.
    const c1 = await settle('agent_teams_create_task', {
      subject: 'c1',
      kind: 'work',
      dependencies: [t5.task_id],
      description: 'downstream lane in the material-layers plan',
    })
    const c1State = await taskOf(c1.task_id)
    const c1Dependency = await taskOf(t5.task_id)
    log(`${INFO}descendant ${c1.task_id} created after t5 completed: status ${c1State?.status}`)
    // The t5 incident left every dependent of a failed task `pending` forever
    // (the dependency could never complete). With t5 completed, the dependent's
    // dependency is satisfied and the scheduler picks it up.
    check(
      'l5-descendants-are-not-stranded',
      c1Dependency?.status === 'completed'
        && (c1State?.status === 'claimed' || c1State?.status === 'in_progress'),
      `t5=${c1Dependency?.status}, descendant=${c1State?.status}`,
    )
    log('')

    // -- the review confirms the waivers -----------------------------------
    // The downstream lane is closed first so the only remaining blocker can be
    // the waiver itself: this check is about the waiver gate, not the whole plan.
    log('STEP 3 -- the reviewer confirms the waivers explicitly.')
    const downstreamAssignee = (await taskOf(c1.task_id))?.assignee
    if (downstreamAssignee !== undefined && downstreamAssignee !== '') {
      const takeover = await settle('agent_teams_reassign_task', {
        task_id: c1.task_id,
        assignee: 'captain',
        reason: 'replay scope: close the downstream lane before the waiver check',
      }, captain)
      await settle('agent_teams_update_task', {
        task_id: c1.task_id,
        status: 'completed',
        output: 'downstream lane closed by the replay',
      }, captain)
      log(`${INFO}downstream ${c1.task_id} was taken over (attempt ${takeover.attempt}) and completed`)
    } else {
      await settle('agent_teams_update_task', {
        task_id: c1.task_id,
        status: 'cancelled',
        output: 'replay scope: the downstream lane is not part of the waiver check',
      }, captain)
      log(`${INFO}downstream ${c1.task_id} cancelled (unassigned in this replay)`)
    }
    const review = await settle('agent_teams_create_task', {
      subject: 'review t5',
      kind: 'review',
      assignee: 'reviewer',
      dependencies: [t5.task_id],
      reviewedTaskId: t5.task_id,
      objective: 'Review the npr-a lane and judge the two waivers',
      acceptance: ['the waivers are acceptable', 'no blocker or high findings'],
    })
    const reviewClaim = await memberCall('agent_teams_claim_task', { task_id: review.task_id }, reviewer)
    await memberCall('agent_teams_update_task', {
      task_id: review.task_id,
      attempt_id: reviewClaim.attempt_id,
      status: 'in_progress',
    }, reviewer)
    await memberCall('agent_teams_update_task', {
      task_id: review.task_id,
      attempt_id: reviewClaim.attempt_id,
      status: 'completed',
      verdict: 'pass',
      output: 'Lane work verified; both waived criteria are identical to baseline 059e5ae and outside this lane.',
      waiverConfirmation: {
        taskId: t5.task_id,
        reason: 'both checks are red on HEAD 059e5ae before this lane and byte-identical after it',
        waived: [
          'terrain_fork_check._TNH reports no new failure',
          'ui_smoke shows no new failure at fxplayer.py:15593',
        ],
      },
    }, reviewer)

    const confirmedBlockers = await blockers()
    log(`${INFO}Delivery after the review confirmation: ${confirmedBlockers.length === 0 ? 'ok' : `blocked (${confirmedBlockers.join('; ')})`}`)
    check(
      'l6-delivery-ok-once-the-review-confirms',
      confirmedBlockers.length === 0,
      JSON.stringify(confirmedBlockers),
    )
    log('')
    log(`RESULT: t5's failure was resolved with ${recovery.length} call(s): ${recovery.join(' -> ')}.`)
    log('        Before 0.1.21 this situation cost 5 cancels + 7 creates (feedback section 1).')
    check(
      'l7-recovery-is-one-waived-resubmission',
      recovery.includes('update_task(waived x2)') && recovery.length <= 3,
      recovery.join(' -> '),
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }

  log('')
  if (failures > 0) {
    log(`t5 replay: ${failures} check(s) FAILED`)
    process.exitCode = 1
  } else {
    log('t5 replay: all checks passed')
  }
}

await main()
