// Local one-shot: why did the cap-fence scenario's add_member not spawn?
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { readTeam } from '../lib/state.js'

const workspace = await mkdtemp(join(tmpdir(), 'dsh-cap-debug-'))
try {
  const defs = new Map()
  const agents = new Map()
  const spawns = []
  let seq = 0
  const captain = {
    id: 'captain-cap',
    status: 'idle',
    options: { provider: 'fake', model: 'fake-model' },
    session: {
      header: { cwd: workspace, seedLength: 0 },
      events: [],
      append() {},
      requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
    },
    followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() { return Promise.resolve() },
  }
  agents.set(captain.id, captain)
  const ctx = {
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
        const id = `child-${++seq}`
        agents.set(id, {
          id, status: 'idle', options: { provider: 'fake', model: 'fake-model' }, session: captain.session,
          followup() {}, steers: [], steer(message) { this.steers.push(message); this.status = 'running' },
          inject() {}, cancel() {}, whenIdle() { return Promise.resolve() },
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
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 4, maxWorkersPerTeam: 1, profiles: {},
  })
  const call = async (name, args) => defs.get(name).execute({ ...args }, { agent: captain, signal: new AbortController().signal })
  const created = await call('agent_teams_create', { name: 'Cap Debug', description: 'debug' })
  console.log('create →', JSON.stringify(created))
  const teamId = created.team_id
  const member = await call('agent_teams_add_member', { team_id: teamId, name: 'stale', role: 'implementer' })
  console.log('add_member →', JSON.stringify(member))
  console.log('spawns:', spawns.length)
  const team = await readTeam(join(workspace, '.agent-teams'), teamId)
  console.log('phase:', team?.phase, 'members:', JSON.stringify(team?.members.map(m => ({ name: m.name, status: m.status, id: m.id }))))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
