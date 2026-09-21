#!/usr/bin/env node
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
/**
 * Offline smoke verification for dsh-agent-teams.
 *
 * Runs the pure team-logic rules, the on-disk persistence flow, and the
 * browser workbench fold (events -> workbench projection) against throwaway
 * temp state. Requires a prior `pnpm build` (lib/ present). Does not touch
 * any running DSH instance or profile.
 *
 * Usage: node scripts/verify.mjs
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artworkRevision, committedArtworkRevision } from './art-revision.mjs'
import { serveArtwork } from '../lib/artwork.js'
import { PROGRESS_KIND_WEIGHTS, planProgress, resolveProgressWeights } from '../lib/progress.js'
import { replanTeam } from '../lib/replan.js'
import { AGENT_TEAMS_EVENT_TYPES } from '../lib/event-types.js'
import { parseReplanOperation } from '../lib/index.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'
import { MEMBER_TOOL_NAMES, TEAM_TOOL_NAMES } from '../lib/tool-names.js'
import {
  CAPTAIN_KEY,
  acceptanceCriterionText,
  appendMailbox,
  createMessage,
  createTeamDir,
  findTeamsByCaptain,
  findTeamsByParticipant,
  listTeams,
  describeTeamHandles,
  isAcceptanceCriterion,
  isKnownDelta,
  isTeamTask,
  originForNewTask,
  requeueMemberTasks,
  readMailbox,
  readTeam,
  removeTeamDir,
  revisePlan,
  sanitizeKey,
  teamLockQueueKeys,
  transitionError,
  unsatisfiedDependencies,
  withTeamLock,
} from '../lib/state.js'
import {
  activityPanelExpandedForSession,
  activityPanelShouldAutoExpand,
  agentColor,
  compactModelLabel,
  COMPACT_DAG_COLUMN_GAP,
  COMPACT_DAG_NODE_HEIGHT,
  COMPACT_DAG_NODE_WIDTH,
  COMPACT_DAG_ROW_GAP,
  memberRouteLabel,
  parsePanelTeamSelection,
  parseProgressMode,
  panelSelectedTeamId,
  panelTeamTabs,
  phaseBoardLayout,
  phaseColumns,
  planProgress as planProgressView,
  taskModelLabel,
  teamIsActive,
  teamProgressSummary,
} from '../lib/client/activity-model.js'
import {
  ACTIVITY_POLL_MS,
  ACTIVITY_PROBE_MS,
  getActivityMonitorTargetsSnapshot,
  monitorAgentTeam,
  settleActivityMonitorTargets,
  startActivityPolling,
  subscribeActivityMonitorTargets,
} from '../lib/client/activity-monitor.js'
import {
  DEFAULT_PANEL_LAYOUT,
  compactPanelForBounds,
  dockPanelLayout,
  floatPanelLayout,
  movePanelLayout,
  panelMaximumHeight,
  panelUsesAutoHeight,
  parsePanelLayout,
  resizePanelLayout,
  resolvePanelGeometry,
} from '../lib/client/panel-geometry.js'
import { ACTION_ART, ACTION_SYMBOL, LEAD_ART, LEAD_SYMBOL, memberArtUrl, memberSymbolUrl, ownerSymbolUrl } from '../lib/client/artwork.js'
import { ART_REVISION } from '../lib/client/art-revision.js'
import { parseAgentTeamsCreateArgs } from '../lib/client/agent-teams-card-definition.js'
import {
  AGENT_TEAMS_LOCALE_NAMESPACE,
  en as agentTeamsEn,
  zh as agentTeamsZh,
} from '../lib/client/locales.js'
import { openAgentTeamMember } from '../lib/client/session-navigation.js'
import { steerCaptainReport } from '../lib/tools.js'
import { parseProfileInvocation, resolveTeamProfile, formatProfilesForPrompt, resolveProfileSharedInScope, resolveProfileTaskPlanning } from '../lib/profiles.js'
import { memberPersona, memberWelcome } from '../lib/members.js'
import { collectCompletedDependencyOutputs, formatDependencyOutputs, assignmentPrompt } from '../lib/scheduler.js'
import {
  installMemberSelectionRuntime,
  resolveMemberLlmSelection,
  spawnMember,
  validateMemberLlmSelections,
} from '../lib/members.js'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('dsh-agent-teams offline verification')

// Named multi-role profile rules
const demoProfiles = { ' demo ': { protocol: 'a'.repeat(300), members: [{ name: ' Implementer ', role: 'builder', model: 'm' }, { name: 'Reviewer', model: 'r' }], tasks: [{ id: 'design', subject: 'Design', assignee: 'implementer' }, { id: 'review', subject: 'Review', assignee: ' reviewer ', dependencies: ['design'] }] } }
const normalizedDemo = resolveTeamProfile(demoProfiles, 'demo', 8)
check('profile keys trim and assignees canonicalize', normalizedDemo.members[0].name === 'Implementer' && normalizedDemo.tasks[1].assignee === 'Reviewer')
check('profile tasks are stable topological order', normalizedDemo.tasks[0].id === 'design' && normalizedDemo.tasks[1].id === 'review')
check('profile invocation supports --profile=', parseProfileInvocation('--profile=demo ship it').profile === 'demo' && parseProfileInvocation('--profile=demo ship it').goal === 'ship it')
check('profile invocation leaves mid-goal profile text untouched', parseProfileInvocation('research profile=prod config').goal === 'research profile=prod config')
check('profile prompt omits empty config and truncates protocol', formatProfilesForPrompt(demoProfiles).includes('demo') && formatProfilesForPrompt(demoProfiles).length < 400)
check('seed planning remains the default', normalizedDemo.taskPlanning === 'seed')
check('fixed profile directory includes purpose when no protocol is configured', formatProfilesForPrompt({ named: { description: '  Review\n  the UI  ', members: [{ name: 'reviewer' }] } }).includes('Review the UI'))
const captainPlanned = resolveTeamProfile({
  dynamic: {
    taskPlanning: 'captain',
    members: [{ name: 'analyst', model: 'a' }, { name: 'reviewer', model: 'r' }],
    tasks: [
      { id: 'requirements', subject: 'Requirements', assignee: 'analyst' },
      { id: 'review', subject: 'Review', assignee: 'reviewer', dependencies: ['requirements'] },
    ],
  },
}, 'dynamic', 8)
check('captain planning keeps the roster and drops seed tasks', captainPlanned.taskPlanning === 'captain' && captainPlanned.members.length === 2 && captainPlanned.tasks.length === 0)
check('profile prompt marks captain planning instead of unused seed counts', formatProfilesForPrompt({ dynamic: { taskPlanning: 'captain', members: [{ name: 'solo', model: 'm' }], tasks: [{ id: 'work', subject: 'Work', assignee: 'solo' }] } }).includes('captain planning'))
const profilePersona = memberPersona({ name: 'Demo', id: 'demo', description: 'goal', profile: { name: 'demo', protocol: 'p'.repeat(600) }, captainSessionId: 'c', createdAt: 0, members: [], tasks: [], taskSeq: 0 }, { name: 'Implementer', id: 'm', role: 'builder', joinedAt: 0, status: 'idle' }, '.agent-teams')
check('member persona includes completed/failed and claimed transition rules', profilePersona.includes('status=completed') && profilePersona.includes('status=failed') && profilePersona.includes('claimed') && profilePersona.includes('in_progress'))
const welcome = memberWelcome({ name: 'Demo', id: 'demo', captainSessionId: 'c', createdAt: 0, members: [], tasks: [{ id: 't1', subject: 'x', status: 'pending', assignee: 'Implementer', dependencies: [], createdAt: 0, updatedAt: 0 }], taskSeq: 1 }, 'Implementer')
check('member welcome reports assigned pending count', welcome.includes('1 pending task(s) assigned to you') && !welcome.includes('none assigned to you yet'))
const truncated = formatDependencyOutputs([
  { id: 't1', subject: 'old', profileSeedId: 'requirements', output: 'x'.repeat(2500) },
  { id: 't2', subject: 'new', profileSeedId: 'implement', output: 'keep-me' },
])
check('dependency outputs truncate and keep the newest seed id',
  truncated.includes('[implement]') && truncated.includes('keep-me') && truncated.includes('[truncated]'))
let cycleWarned = false
const cycled = collectCompletedDependencyOutputs([
  { id: 't1', subject: 'a', status: 'completed', dependencies: ['t2'], createdAt: 0, updatedAt: 0 },
  { id: 't2', subject: 'b', status: 'completed', dependencies: ['t1'], createdAt: 0, updatedAt: 0 },
], 't2', () => { cycleWarned = true })
check('recursive dependency collection stops on cycles', cycleWarned && Array.isArray(cycled))
check('persona protocol is truncated', profilePersona.includes('p'.repeat(400)) && !profilePersona.includes('p'.repeat(401)))
const injected = 'The product interface should present the intended outcome, not reveal the reasoning process.'
const assignment = assignmentPrompt({ taskId: 't1', memberName: 'Implementer', memberId: 'm', attempt: 1, attemptId: 'a', subject: 'x', dependencyOutputs: [], executionPrompt: injected }, '.agent-teams', 'demo')
check('execution prompt is injected into persona and assignment', assignment.includes(injected) && memberPersona({ name: 'Demo', id: 'demo', description: 'goal', captainSessionId: 'c', createdAt: 0, members: [], tasks: [], taskSeq: 0 }, { name: 'Implementer', id: 'm', role: 'builder', joinedAt: 0, status: 'idle', executionPrompt: injected }, '.agent-teams').includes(injected))


// The bundle patch's `name` is the specifier Node resolves when a profile
// loads this plugin, so it must equal the published package name. A mismatch
// only surfaces after someone installs the package (the row fails to load),
// never in local link-installed development — hence this pre-publish gate.
console.log('1/8 packaging contract')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const patchName = patchText
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .find(line => /^\s*name:\s*\S/.test(line))
  ?.match(/^\s*name:\s*(.+?)\s*$/)?.[1]
  ?.replace(/^(['"])(.*)\1$/, '$2')
check(
  'cordis.patch.yml name matches the published package name',
  patchName === pkg.name,
  `patch has ${JSON.stringify(patchName)}, package.json has ${JSON.stringify(pkg.name)}`,
)
check(
  'files[] ships the bundle patch and lib',
  ['lib', 'cordis.patch.yml'].every(entry => pkg.files?.includes(entry)),
  `files = ${JSON.stringify(pkg.files)}`,
)
check(
  'scoped package publishes publicly',
  !pkg.name.startsWith('@') || pkg.publishConfig?.access === 'public',
  'scoped packages default to restricted without publishConfig.access = "public"',
)
const requiredPeers = Object.keys(pkg.peerDependencies ?? {})
  .filter(name => pkg.peerDependenciesMeta?.[name]?.optional !== true)
check(
  'shared runtime peers are optional for standalone profile installs',
  requiredPeers.length === 0,
  `required peers trigger pnpm warnings: ${JSON.stringify(requiredPeers)}`,
)
// The browser half registers itself with __ModuleLoader__ under an id the host
// resolves by package name. A stale id here fails only in the browser — the
// host half loads fine, so every server-side check still passes.
const clientBundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const registeredId = clientBundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]*)"/)?.[1]
check(
  'client bundle registers under the package name',
  registeredId === pkg.name,
  `bundle registers ${JSON.stringify(registeredId)}, package.json has ${JSON.stringify(pkg.name)}`,
)
const activityPanelCss = await readFile(new URL('../src/client/ActivityPanel.module.css', import.meta.url), 'utf8')
const activityPanelSource = await readFile(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
const stagingPlanSource = await readFile(new URL('../src/client/StagingPlanEditor.tsx', import.meta.url), 'utf8')
const clientIndexSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const agentTeamsCardCss = await readFile(new URL('../src/client/AgentTeamsCard.module.css', import.meta.url), 'utf8')
const agentTeamsCardSource = await readFile(new URL('../src/client/AgentTeamsCard.tsx', import.meta.url), 'utf8')
const artworkSource = await readFile(new URL('../src/client/artwork.ts', import.meta.url), 'utf8')
const artworkHostSource = await readFile(new URL('../src/artwork.ts', import.meta.url), 'utf8')
const hostSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const toolsSource = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8')
const gatesSource = await readFile(new URL('../src/quality-gates.ts', import.meta.url), 'utf8')
const localesSource = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
const stateSource = await readFile(new URL('../src/state.ts', import.meta.url), 'utf8')
const schedulerSource = await readFile(new URL('../src/scheduler.ts', import.meta.url), 'utf8')
const activityModelSource = await readFile(new URL('../src/client/activity-model.ts', import.meta.url), 'utf8')
const localeKeys = Object.keys(agentTeamsZh).sort()
const englishLocaleKeys = Object.keys(agentTeamsEn).sort()
const placeholders = value => [...value.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
check(
  'AgentTeams locale dictionaries have identical keys and template placeholders',
  localeKeys.length > 0
    && JSON.stringify(localeKeys) === JSON.stringify(englishLocaleKeys)
    && localeKeys.every(key => JSON.stringify(placeholders(agentTeamsZh[key]))
      === JSON.stringify(placeholders(agentTeamsEn[key]))),
)
check(
  'client uses the uiConversation event registry and registers the official locale namespace',
  AGENT_TEAMS_LOCALE_NAMESPACE === 'agentTeams'
    && clientIndexSource.includes("'uiConversation', 'slots', 'sessions', 'locale', 'modelDirectories'")
    && clientIndexSource.includes('ctx.uiConversation.events.register(agentTeamsCardDefinition)')
    && clientIndexSource.includes('ctx.locale.register(AGENT_TEAMS_LOCALE_NAMESPACE, { zh, en })')
    && clientIndexSource.match(/locale:\s*AGENT_TEAMS_LOCALE_NAMESPACE/gu)?.length === 2,
)
check(
  'slash command transcript hides the duplicate pre-message result row',
  clientIndexSource.includes('HiddenAgentTeamsCommand')
    && /name:\s*'conversation\.chat\.commandview',\s*key:\s*'agent-teams'/u.test(clientIndexSource),
)
check(
  'stop-team control lives in the team panel and requires confirmation',
  !clientIndexSource.includes("conversation.input.dock")
    && activityPanelSource.includes('className={css.teamStopButton}')
    && activityPanelSource.includes('<Modal')
    && activityPanelSource.includes('ACTIVITY_HALT_URL'),
)
check(
  'clean builds do not package the removed composer stop banner',
  !existsSync(new URL('../lib/client/TeamProgressBanner.js', import.meta.url))
    && !existsSync(new URL('../lib/types/client/TeamProgressBanner.d.ts', import.meta.url)),
)
check(
  'staged member routes use the official directory and primitive Menu instead of native route selects',
  clientIndexSource.includes('@deepseek-ai/dsh-client-ui-model-selection/client')
    && stagingPlanSource.includes('directory.store.subscribe')
    && stagingPlanSource.includes("from '@deepseek-ai/dsh-client-ui-primitives'")
    && stagingPlanSource.includes('<Menu')
    && stagingPlanSource.includes('data-plan-model-trigger')
    && !stagingPlanSource.includes('name="provider"')
    && !stagingPlanSource.includes('name="model"')
    && !stagingPlanSource.includes('name="modelRoute"')
    && !stagingPlanSource.includes('name="reasoningEffort"'),
)
check(
  'staged plan review offers continue, discard, and approve outcomes',
  stagingPlanSource.includes('data-plan-continue')
    && stagingPlanSource.includes('data-plan-discard')
    && stagingPlanSource.includes("action: 'continue'")
    && stagingPlanSource.includes("action: 'discard'")
    && hostSource.includes("if (action === 'continue')")
    && hostSource.includes("if (action === 'discard')"),
)
check(
  'review decisions control the Captain turn instead of relying on front-end state alone',
  toolsSource.includes('stagedPlanFeedbackContext')
    && toolsSource.includes('stagedPlanDiscardContext')
    && toolsSource.includes("fresh.planReviewState = 'awaiting_feedback'")
    && toolsSource.includes("captain.cancel({ kind: 'user' }, { keepInbox: true })")
    && toolsSource.includes('captain.followup(createUserMessage')
    && toolsSource.includes('captain.inject(createUserMessage')
    && toolsSource.includes('Do not create a replacement team')
    && toolsSource.includes('Do not call agent_teams_create'),
)
check(
  'continued planning uses a model-facing atomic staged-plan tool instead of state-file edits',
  toolsSource.includes("name: 'agent_teams_edit_plan'")
    && toolsSource.includes('updateStagedPlanBatch')
    && toolsSource.includes("action: 'remove_member'")
    && toolsSource.includes('none of the edits are saved')
    && hostSource.includes('agent_teams_edit_plan')
    && hostSource.includes('Never inspect or edit .agent-teams state files or plugin source code'),
)
// WP2/S08: the amendment covers the whole contract and has a documented escape
// from the post-review freeze, while the verdict that freeze produces stays out
// of the member-facing parameter enum.
{
  const amendBlock = toolsSource.slice(
    toolsSource.indexOf("name: 'agent_teams_amend_task'"),
    toolsSource.indexOf("name: 'agent_teams_send_message'"),
  )
  const updateBlock = toolsSource.slice(
    toolsSource.indexOf("name: 'agent_teams_update_task'"),
    toolsSource.indexOf("name: 'agent_teams_amend_task'"),
  )
  check(
    'amend_task exposes the whole contract plus the forced-freeze override',
    amendBlock.includes('deliverables: {')
      && amendBlock.includes('nonGoals: {')
      && amendBlock.includes('reviewedTaskId: {')
      && amendBlock.includes('subject: {')
      && amendBlock.includes('description: {')
      && amendBlock.includes('force: {')
      && amendBlock.includes('staled_reviews')
      && amendBlock.includes('amendTaskContract(fresh, task, normalizeBlankOptionalTaskFields(input), CAPTAIN_KEY, args.reason, args.force === true)')
      && amendBlock.includes('current.verdict = review.verdict'),
    `amend block is ${String(amendBlock.length)} characters`,
  )
  check(
    'the stale verdict is produced by the amendment and never offered to a member',
    updateBlock.includes("enum: ['pass', 'needs_revision', 'reject']")
      && !updateBlock.includes("'stale'")
      && gatesSource.includes("verdict: 'stale' as const")
      && gatesSource.includes('invalidatedReviews')
      && toolsSource.includes('current.verdict = review.verdict'),
  )
  check(
    'the status report shows how often a contract was amended',
    toolsSource.includes('revisions?: number')
      && toolsSource.includes('revised ×')
      && toolsSource.includes('...(task.revisions ?? []).length === 0 ? {} : { revisions: (task.revisions ?? []).length }'),
  )
  check(
    'a running team accepts dependency and assignee edits for pending and failed tasks',
    toolsSource.includes("? task.status === 'pending' && (task.attempt ?? 0) === 0")
      && toolsSource.includes(": task.status === 'pending' || task.status === 'failed'"),
  )
}
// WP3/S09: one captain-only tool replaces a lane that will not finish, and the
// reader stays compatible with every team.json written before that field existed.
{
  const supersedeBlock = toolsSource.slice(
    toolsSource.indexOf("name: 'agent_teams_supersede_task'"),
    toolsSource.indexOf("name: 'agent_teams_claim_task'"),
  )
  check(
    'supersede_task is captain-only and redirects the graph atomically',
    supersedeBlock.includes('applySupersession(fresh, replaced.id, replacementId)')
      && supersedeBlock.includes('validateCreateTask(fresh, {')
      && supersedeBlock.includes('await writeTeam(stateRoot, fresh)')
      && supersedeBlock.includes('stopTeamMemberActivations')
      && supersedeBlock.includes('await scheduler.kickTeam')
      && TEAM_TOOL_NAMES.includes('agent_teams_supersede_task')
      && !MEMBER_TOOL_NAMES.includes('agent_teams_supersede_task'),
    `team tools: ${String(TEAM_TOOL_NAMES.length)}, member tools: ${String(MEMBER_TOOL_NAMES.length)}`,
  )
  check(
    'the panel and the reader accept a superseded task, with or without its replacement link',
    isTeamTask({ id: 't1', subject: 'x', status: 'superseded', dependencies: [], createdAt: 0, updatedAt: 0 })
      && isTeamTask({ id: 't1', subject: 'x', status: 'superseded', supersededBy: 't2', dependencies: [], createdAt: 0, updatedAt: 0 })
      && !isTeamTask({ id: 't1', subject: 'x', status: 'obsolete', dependencies: [], createdAt: 0, updatedAt: 0 })
      && localesSource.includes("'task.status.superseded'")
      && activityPanelSource.includes("superseded: 'task.status.superseded'")
      && activityPanelSource.includes("if (status === 'superseded') return 'superseded'")
      && activityPanelCss.includes("[data-state='superseded']")
      && activityModelSource.includes('export function settledTask'),
  )
}
// WP4/S10: an honest undeclared path becomes a captain decision, and the shared
// profile scope keeps sibling lanes out of a false overlap.
{
  const acceptBlock = toolsSource.slice(
    toolsSource.indexOf("name: 'agent_teams_accept_paths'"),
    toolsSource.indexOf("name: 'agent_teams_amend_task'"),
  )
  check(
    'accept_paths is captain-only, additive, and completes a held lane',
    acceptBlock.includes('acceptTaskPaths(fresh, task, args.paths, CAPTAIN_KEY, args.reason, args.force === true)')
      && acceptBlock.includes("if (task.status === 'awaiting_scope_review')")
      && acceptBlock.includes('agent-teams/task-amended')
      && TEAM_TOOL_NAMES.includes('agent_teams_accept_paths')
      && !MEMBER_TOOL_NAMES.includes('agent_teams_accept_paths'),
    `team tools: ${String(TEAM_TOOL_NAMES.length)}`,
  )
  check(
    'an undeclared completion holds the task instead of failing it',
    toolsSource.includes("gate.scopeReview === undefined ? args.status : 'awaiting_scope_review'")
      && gatesSource.includes("requiredStatus: 'awaiting_scope_review' as TaskStatus")
      && gatesSource.includes('scopeReview: undeclared')
      && gatesSource.includes('is awaiting a scope decision')
      && isTeamTask({ id: 't1', subject: 'x', status: 'awaiting_scope_review', dependencies: [], createdAt: 0, updatedAt: 0 })
      && localesSource.includes("'task.status.awaitingScopeReview'")
      && activityPanelSource.includes("awaiting_scope_review: 'task.status.awaitingScopeReview'"),
  )
  const sharedProfile = resolveProfileSharedInScope({ taskPlanning: { mode: 'captain', sharedInScope: ['docs/CHANGELOG.md', 'tools/'] } })
  check(
    'the profile can declare a shared scope that sibling lanes may both touch',
    JSON.stringify(sharedProfile) === JSON.stringify(['docs/CHANGELOG.md', 'tools/'])
      && resolveProfileSharedInScope({ taskPlanning: 'captain' }) === undefined
      && resolveProfileTaskPlanning({ taskPlanning: { mode: 'captain', sharedInScope: ['docs/'] } }) === 'captain'
      && gatesSource.includes('function subtractScope(')
      && toolsSource.includes('...shared === undefined ? {} : { sharedInScope: shared }'),
    JSON.stringify(sharedProfile ?? null),
  )
}
// WP6.3: the captain pins a check that is red for an outside reason once, and a
// verification lane can then waive it without inventing its own justification.
{
  const pinBlock = toolsSource.slice(
    toolsSource.indexOf("name: 'agent_teams_pin_delta'"),
    toolsSource.indexOf("name: 'agent_teams_accept_paths'"),
  )
  check(
    'the known-delta registry is captain-only and feeds the status report',
    pinBlock.includes('pinKnownDelta(fresh.knownDeltas, {')
      && pinBlock.includes('unpinKnownDelta(fresh.knownDeltas, args.id)')
      && pinBlock.includes("'agent-teams/delta-pinned'")
      && TEAM_TOOL_NAMES.includes('agent_teams_pin_delta')
      && TEAM_TOOL_NAMES.includes('agent_teams_unpin_delta')
      && !MEMBER_TOOL_NAMES.includes('agent_teams_pin_delta')
      && !MEMBER_TOOL_NAMES.includes('agent_teams_unpin_delta')
      && toolsSource.includes('known_deltas: (team.knownDeltas ?? [])')
      && toolsSource.includes('Known deltas ('),
    `team tools: ${String(TEAM_TOOL_NAMES.length)}`,
  )
  check(
    'a pinned check supplies the evidence a waiver would otherwise have to write',
    toolsSource.includes('applyPinnedDeltaEvidence(')
      && toolsSource.includes('parseAcceptanceResults(args.acceptanceResults, true)')
      && toolsSource.includes('parseCommandResults(args.commandsRun, true)')
      && toolsSource.includes('pin a known delta if the check is red for an outside reason')
      && gatesSource.includes('export function pinnedWaiverEvidence(')
      && gatesSource.includes('pinned delta ${delta.id}')
      && stateSource.includes("value['knownDeltas'] === undefined")
      && isKnownDelta({ id: 'style-lint', check: 'pnpm run lint', expected: 'exit 0', reason: 'red on HEAD', pinnedBy: 'captain', at: 1 })
      && !isKnownDelta({ id: 'style-lint', check: '', expected: 'exit 0', reason: 'red', pinnedBy: 'captain', at: 1 }),
  )
}
check(
  'discarded and stopped teams render terminal semantics instead of pending execution copy',
  activityPanelSource.includes("const discarded = historic && team.phase === 'staged'")
    && activityPanelSource.includes("t('member.state.notCreated')")
    && activityPanelSource.includes("t('member.state.stopped')")
    && activityPanelSource.includes("'archive.discardedLabel'")
    && localesSource.includes("'task.status.notRun': '未执行'")
    && localesSource.includes("'member.state.notCreated': '未创建'"),
)
const expectedArtwork = [
  'team-lead-v2.png',
  'member-researcher-v2.png', 'member-engineer-v2.png',
  'member-qa-v2.png', 'member-designer-v2.png',
  'member-security-v2.png', 'member-docs-v2.png',
  'member-data-v2.png', 'member-operator-v2.png',
  'action-working-v2.png', 'action-thinking-v2.png',
  'action-reporting-v2.png', 'action-celebrating-v2.png',
  'action-sleeping-v2.png', 'action-sending-v2.png',
  // Standalone symbol pack for the small corner badge: the mascot art above is
  // unreadable at badge size, so both corner marks are separate drawings.
  'team-lead-symbol.png',
  'member-researcher-symbol.png', 'member-engineer-symbol.png',
  'member-qa-symbol.png', 'member-designer-symbol.png',
  'member-security-symbol.png', 'member-docs-symbol.png',
  'member-data-symbol.png', 'member-operator-symbol.png',
  'action-working-symbol.png', 'action-thinking-symbol.png',
  'action-reporting-symbol.png', 'action-celebrating-symbol.png',
  'action-sleeping-symbol.png', 'action-sending-symbol.png',
].sort()
const artworkDir = new URL('../assets/agent-teams/', import.meta.url)
// Every artwork URL carries the pack revision as `?v=<revision>` so a redrawn
// pack cannot stay behind a browser cache. The badge and avatar rules below are
// about the file the URL names, so they read the path without the query.
const artworkPath = url => String(url).split('?')[0]
const packagedArtwork = (await readdir(artworkDir)).sort()
check(
  'artwork directory contains exactly the V2 captain, eight members, and six actions',
  JSON.stringify(packagedArtwork) === JSON.stringify(expectedArtwork),
  `artwork = ${JSON.stringify(packagedArtwork)}`,
)
const artworkHeaders = await Promise.all(expectedArtwork.map(async (name) => {
  const data = await readFile(new URL(name, artworkDir))
  return {
    name,
    png: data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
  }
}))
check(
  'all V2 artwork is 256x256 8-bit RGBA PNG',
  artworkHeaders.every(image => image.png
    && image.width === 256
    && image.height === 256
    && image.bitDepth === 8
    && image.colorType === 6),
  `invalid headers = ${JSON.stringify(artworkHeaders.filter(image => !image.png
    || image.width !== 256
    || image.height !== 256
    || image.bitDepth !== 8
    || image.colorType !== 6))}`,
)
check(
  'client mapping and host allowlist reference every artwork asset',
  expectedArtwork.every(name => artworkSource.includes(name) || artworkHostSource.includes(name))
    && artworkSource.includes('member-data-v2.png')
    && artworkSource.includes('member-operator-v2.png')
    // The corner badge must resolve its symbol from the role table rather than
    // hard-coding one image per call site, otherwise the pair drifts apart.
    && artworkSource.includes("-symbol.png'")
    && artworkSource.includes('memberSymbolUrl'),
  'a packaged image is unreachable or one of the eighth-member mappings is missing',
)
const eightRoleArtwork = [
  ['Researcher', 'Researcher'],
  ['Engineer', 'Backend Engineer'],
  ['QA', 'QA Engineer'],
  ['Designer', 'UI UX Designer'],
  ['Security', 'Security Reviewer'],
  ['Docs', 'Docs Writer'],
  ['Data', 'Data Analyst'],
  ['Operator', 'Release Operator'],
].map(([name, role]) => memberArtUrl(name, role))
check(
  'canonical eight-member roster resolves to eight distinct role images',
  eightRoleArtwork.every(Boolean) && new Set(eightRoleArtwork).size === 8,
  `resolved artwork = ${JSON.stringify(eightRoleArtwork)}`,
)
// The corner badge is the surface this pair exists for. Eight roles that share
// a symbol would make two different members look identical in the panel, which
// is exactly the readability defect the symbol pack replaced.
const eightRoleSymbols = [
  ['Researcher', 'Researcher'],
  ['Engineer', 'Backend Engineer'],
  ['QA', 'QA Engineer'],
  ['Designer', 'UI UX Designer'],
  ['Security', 'Security Reviewer'],
  ['Docs', 'Docs Writer'],
  ['Data', 'Data Analyst'],
  ['Operator', 'Release Operator'],
].map(([name, role]) => memberSymbolUrl(name, role))
check(
  'canonical eight-member roster resolves to eight distinct corner symbols',
  eightRoleSymbols.every(Boolean) && new Set(eightRoleSymbols).size === 8
    && eightRoleSymbols.every(url => artworkPath(url).endsWith('-symbol.png'))
    && memberSymbolUrl('Lead', 'Team Lead') === LEAD_SYMBOL,
  `resolved symbols = ${JSON.stringify(eightRoleSymbols)}`,
)
// A member whose role text marks it as the lead (the captain's own row in the
// panel, or a member explicitly created as `lead`/`captain`) must get the lead
// symbol. The lead vocabulary has to accept the bare word too, otherwise the
// badge silently disappears for exactly the role the pack was drawn for.
check(
  'a lead-role member resolves to the lead symbol',
  memberSymbolUrl('Lead', 'Team Lead') === LEAD_SYMBOL
    && memberSymbolUrl('alice', 'lead') === LEAD_SYMBOL
    && memberSymbolUrl('bob', 'Team Leader') === LEAD_SYMBOL
    && memberSymbolUrl('carol', 'Captain') === LEAD_SYMBOL
    && memberSymbolUrl('队长', '队长') === LEAD_SYMBOL,
)
// ...but the role text decides, not the name: a member merely *called* "Lead"
// with an ordinary role keeps its own role symbol.
check(
  'an ordinary role is not mistaken for the lead by name alone',
  memberSymbolUrl('Lead', 'Backend Engineer') !== LEAD_SYMBOL
    && memberSymbolUrl('Lead', 'Backend Engineer') === memberSymbolUrl('Other', 'Backend Engineer'),
)
// The corner badge carries the live activity and nothing else. It used to draw a
// second, role mark beside the action mark; the row already names the role in
// words, so the mark was redundant clutter on a 42px portrait. The activity mark
// must still come from the symbol pack — the mascot art is a smudge at 18px, the
// defect this pack replaced — and the role mark must be gone from the avatar.
check(
  'the corner badge draws the activity mark only, from the symbol pack',
  Object.values(ACTION_SYMBOL).every(url => artworkPath(url).endsWith('-symbol.png'))
    && Object.values(ACTION_SYMBOL).every(url => !url.includes('-v2.png'))
    && !activityPanelSource.includes('ACTION_ART[')
    && activityPanelSource.includes('ACTION_SYMBOL[member.activity]')
    && !activityPanelSource.includes('css.memberSymbol')
    && !activityPanelSource.includes('css.leadSymbol')
    && !activityPanelSource.includes('LEAD_SYMBOL')
    && !activityPanelCss.includes('.memberSymbol')
    && !activityPanelCss.includes('.leadSymbol'),
  `action symbols = ${JSON.stringify(ACTION_SYMBOL)}`,
)
// The role pack stays packaged and resolvable: it is the compact mark for slots
// that cannot fit the mascot *and* the label, so the resolver is the interface
// those slots will use. Dropping it from the avatar must not drop it from the
// bundle, and it must keep answering for all nine roles plus the lead.
check(
  'the role symbol pack stays resolvable for the compact slots',
  memberSymbolUrl('Engineer', 'Backend Engineer') !== null
    && artworkPath(memberSymbolUrl('Engineer', 'Backend Engineer') ?? '').endsWith('-symbol.png')
    && artworkPath(LEAD_SYMBOL).endsWith('-symbol.png')
    && LEAD_SYMBOL.includes('?v=')
    && artworkSource.includes('memberSymbolUrl'),
  `lead symbol = ${LEAD_SYMBOL}`,
)
// The compact surfaces are where the role pack now earns its place: a DAG node
// head, the assignment line and a queue row have room for a 12px mark, not for
// the mascot or a role label. They resolve the owner through one function, so
// the captain gets the lead mark and an unclaimed task gets nothing at all.
const compactRoster = [
  { name: 'impl-a', role: 'Backend Engineer' },
  { name: 'revi', role: 'Reviewer' },
]
check(
  'compact surfaces resolve an owner through the role symbol pack',
  ownerSymbolUrl('impl-a', compactRoster) === memberSymbolUrl('impl-a', 'Backend Engineer')
    && ownerSymbolUrl('revi', compactRoster) === memberSymbolUrl('revi', 'Reviewer')
    && ownerSymbolUrl('captain', compactRoster) === LEAD_SYMBOL
    && ownerSymbolUrl('Captain', compactRoster) === LEAD_SYMBOL
    && ownerSymbolUrl('', compactRoster) === null
    && ownerSymbolUrl('unassigned', compactRoster) === null
    && ownerSymbolUrl('ghost', compactRoster) === null,
  `impl-a -> ${String(ownerSymbolUrl('impl-a', compactRoster))}, captain -> ${String(ownerSymbolUrl('captain', compactRoster))}`,
)
check(
  'the compact surfaces draw the symbol packs and keep a fallback',
  activityPanelSource.includes('ownerSymbolUrl(')
    && activityPanelSource.includes('css.compactSymbol')
    && activityPanelSource.includes('css.badgeSymbol')
    && activityPanelSource.includes('busy ? ACTION_SYMBOL.working : ACTION_SYMBOL.idle')
    && !activityPanelSource.includes('css.badgeDot')
    && activityPanelCss.includes('.compactSymbol')
    && activityPanelCss.includes('.badgeSymbol'),
  'a compact surface lost its mark, or the badge fell back to a plain dot',
)
// A DAG node head is 9.5px type beside a 5px dot: a 12px role mark there was the
// least readable spot in the panel (owner report), so the two node heads stay
// text-and-dot and the marks live only in the two surfaces that can carry them
// (the task-detail assignment line and a Queues row).
check(
  'the dependency boards keep their node heads text-only',
  (activityPanelSource.match(/css\.compactSymbol/gu) ?? []).length === 1
    && (activityPanelSource.match(/css\.dagNodeHead/gu) ?? []).length === 1
    && (activityPanelSource.match(/css\.dagNodeDot/gu) ?? []).length === 1
    && !/dagNodeHead[\s\S]{0,200}compactSymbol/u.test(activityPanelSource),
  'a DAG node head still draws a symbol, or the compact surface lost its own',
)
// The names in this pack did not change when the art was redrawn: the whale and
// the amber terminal are both `member-engineer-v2.png`. A browser that cached
// the old bytes therefore kept drawing them for the whole `cache-control`
// lifetime, and the panel looked like it had never been updated. The fix is a
// revision in the URL, so the pack content — not the deployment — decides when
// a browser refetches. These three checks are what keep the pair honest: the
// committed revision must describe the packaged bytes, a redrawn file must move
// the revision, and every URL the client builds must carry it.
const packRevision = await artworkRevision()
const committedRevision = await committedArtworkRevision()
check(
  'the committed artwork revision describes the packaged images',
  committedRevision !== undefined && committedRevision === packRevision && ART_REVISION === packRevision,
  `committed ${committedRevision ?? '(missing)'}, built ${ART_REVISION ?? '(missing)'}, pack ${packRevision}`,
)
const redrawnRevision = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-artwork-'))
  try {
    for (const name of expectedArtwork) {
      await writeFile(join(dir, name), await readFile(new URL(name, artworkDir)))
    }
    const before = await artworkRevision(dir)
    const target = join(dir, 'member-engineer-v2.png')
    const bytes = await readFile(target)
    bytes[bytes.length - 1] ^= 0xff
    await writeFile(target, bytes)
    return { before, after: await artworkRevision(dir) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})()
check(
  'a redrawn artwork file changes the revision',
  redrawnRevision.before === packRevision && redrawnRevision.after !== redrawnRevision.before,
  `copied pack ${redrawnRevision.before} -> redrawn ${redrawnRevision.after}, packaged ${packRevision}`,
)
const revisionedArtworkUrls = [
  LEAD_ART, LEAD_SYMBOL,
  ...Object.values(ACTION_ART),
  ...Object.values(ACTION_SYMBOL),
  ...eightRoleArtwork,
  ...eightRoleSymbols,
]
check(
  'every artwork URL carries the pack revision',
  revisionedArtworkUrls.every(url => typeof url === 'string'
    && url.startsWith('/plugins/dsh-agent-teams/assets/')
    && url.endsWith(`?v=${packRevision}`)
    && artworkPath(url).endsWith('.png')),
  `unrevisioned = ${JSON.stringify(revisionedArtworkUrls.filter(url => typeof url !== 'string'
    || !url.endsWith(`?v=${packRevision}`)))}`,
)
// The other half of the contract: the host route has to ignore the query the
// client now appends, and it must still resolve the file by its allowlisted
// name only. Both are exercised on the production handler, not on a copy.
const artworkRoute = async (requestUrl) => {
  const seen = { status: 0, headers: {}, body: undefined }
  await serveArtwork(fileURLToPath(artworkDir), { url: requestUrl }, {
    writeHead(status, headers) {
      seen.status = status
      seen.headers = headers ?? {}
    },
    end(body) {
      seen.body = body
    },
  })
  return seen
}
const servedWithQuery = await artworkRoute(`/plugins/dsh-agent-teams/assets/member-engineer-v2.png?v=${packRevision}`)
const servedWithoutQuery = await artworkRoute('/plugins/dsh-agent-teams/assets/member-engineer-v2.png')
check(
  'the artwork route ignores the cache-busting query',
  servedWithQuery.status === 200
    && servedWithQuery.headers['content-type'] === 'image/png'
    && servedWithQuery.headers['cache-control'] === 'public, max-age=86400'
    && Buffer.from(servedWithQuery.body).equals(Buffer.from(servedWithoutQuery.body ?? []))
    && Buffer.from(servedWithQuery.body).equals(await readFile(new URL('member-engineer-v2.png', artworkDir))),
  `status=${servedWithQuery.status} headers=${JSON.stringify(servedWithQuery.headers)}`,
)
const rejectedArtwork = [
  '/plugins/dsh-agent-teams/assets/not-packaged.png',
  '/plugins/dsh-agent-teams/assets/../package.json',
  '/plugins/dsh-agent-teams/assets/%2e%2e%2fpackage.json',
  '/plugins/dsh-agent-teams/assets/',
]
const rejectedStatuses = await Promise.all(rejectedArtwork.map(async url => (await artworkRoute(url)).status))
check(
  'the artwork route serves allowlisted names only',
  rejectedStatuses.every(status => status === 404),
  `statuses = ${JSON.stringify(rejectedStatuses)} for ${JSON.stringify(rejectedArtwork)}`,
)
check(
  'whale portraits use transparent cutouts instead of dark circular plates',
  !/#0b1d33/iu.test(`${activityPanelCss}\n${agentTeamsCardCss}`)
    && activityPanelCss.includes('object-fit: contain')
    && activityPanelCss.includes('agentTeamsUnreadPulse')
    && agentTeamsCardCss.includes('object-fit: contain'),
  'portrait CSS should preserve each transparent role silhouette and use a compact unread dot',
)
check(
  'all client surfaces consume host semantic colors without redefining the host palette',
  [activityPanelCss, agentTeamsCardCss].every(css =>
    !/--dsw-[a-z0-9-]+\s*:/.test(css)
    && !/--dsw-static-/.test(css)
    && !/--dsw-alias-(?:line-|bg-fill-|bg-module[),]|label-on-fill|state-(?:danger|warning)[),]|state-success[),])/.test(css)),
  'light-only palette bridges or undefined legacy tokens break dark mode and portaled surfaces',
)
check(
  'working member and captain states use the host semantic business color',
  activityPanelSource.includes('data-activity={member.activity}')
    && activityPanelCss.includes(".memberState[data-activity='working']")
    && /\.memberState\[data-activity='working'\][^{]*\{[^}]*color:\s*var\(--dsw-alias-state-business-primary\)/su.test(activityPanelCss),
  'the working label and glyph must follow the host business color',
)
check(
  'activity panel uses the shell overlay instead of a page-breaking body portal',
  clientIndexSource.includes("ctx.slots.inject('shell.overlay'")
    && !clientIndexSource.includes('createRoot')
    && activityPanelCss.includes('position: absolute')
    && !activityPanelCss.includes('2147483000')
    && !activityPanelCss.includes('position: fixed'),
  'a body portal or unbounded z-index can cover host modal controls',
)
check(
  'panel exposes drag, resize, dock, and fold interaction probes',
  activityPanelSource.includes('data-drag-handle')
    && activityPanelSource.includes('data-resize-edge="left"')
    && activityPanelSource.includes('data-resize-edge="corner"')
    && activityPanelSource.includes('data-control="dock"')
    && activityPanelSource.includes('data-control="collapse"')
    && activityPanelSource.includes('data-height-mode=')
    && activityPanelSource.includes("height: autoHeight ? 'auto'")
    && activityPanelCss.includes('.resizeHandle')
    && activityPanelCss.includes(".resizeHandle[data-resize-edge='left']::after")
    && activityPanelCss.includes(".resizeHandle[data-resize-edge='bottom']::after")
    && activityPanelCss.includes('.resizeHandle:hover::after')
    && activityPanelCss.includes('pointer-events: auto')
    && activityPanelCss.includes('width: 28px')
    && activityPanelCss.includes('height: 28px')
    && activityPanelCss.includes('scrollbar-width: thin')
    && !activityPanelCss.includes('scrollbar-width: none'),
  'interactive panel controls must stay visible to browser verification',
)
check(
  'staged plan editor keeps long plans compact and guards consequential actions',
  stagingPlanSource.includes('aria-expanded={open}')
    && stagingPlanSource.includes('aria-live=')
    && stagingPlanSource.includes('confirmingRemove')
    && !stagingPlanSource.includes('approvalArmed')
    && stagingPlanSource.includes('data-plan-approve')
    && stagingPlanSource.includes('data-confirming')
    && activityPanelCss.includes('.planCardHeader')
    && activityPanelCss.includes('.planFeedback')
    && activityPanelCss.includes('.planApproveRow')
    && activityPanelCss.includes('position: sticky')
    && activityPanelCss.includes('container-type: inline-size')
    && activityPanelCss.includes('@container agent-team')
    && activityPanelCss.includes('.planSectionToggle:focus-visible'),
  'plan review must expose disclosure, feedback, destructive confirmation, focus, sticky action, and container-based narrow-layout contracts',
)
check(
  'running DAG tasks reuse the animated work glyph without losing focus context',
  activityPanelSource.includes("task.state === 'running'")
    && activityPanelSource.includes('className={css.dagRunningState}')
    && activityPanelSource.includes('<WorkGlyph active />')
    && activityPanelCss.includes(".dagNode[data-state='running'][data-dimmed='true']")
    && activityPanelCss.includes('.dagRunningState {'),
  'running work should stay visible in both normal and dependency-focus states',
)
// Round 2 (owner request) compacted the member row: the long "Working on {id}"
// sentence and its `member.status.*` keys are gone, so the model now surfaces on
// the two places that survive — the detail card probe and the member badge.
check(
  'running tasks surface the assignee model on the activity card',
  activityPanelSource.includes('taskModelLabel(task, members)')
    && activityPanelSource.includes('data-task-model={model || undefined}')
    && activityPanelSource.includes('data-task-model={model}')
    && activityPanelSource.includes('data-member-model={memberModel}')
    && activityPanelSource.includes('css.taskDetailModel')
    && activityPanelSource.includes('css.memberModel')
    && activityPanelCss.includes('.taskDetailModel')
    && activityPanelCss.includes('.memberModel'),
  'the detail card must show which model a running subtask is using',
)
// Member model badge contract (inline compact pill): the render path derives
// one full member route and shows only its last segment visibly, while the
// noninteractive span keeps the full route in title, aria-label, and the
// data-member-model DOM probe. Both member variants render the one `modelBadge`
// value, so the attributes are asserted where it is defined and its placement is
// asserted in each variant: after the role mark, before the state word.
const memberMapStart = activityPanelSource.indexOf('team.members.map((member) => {')
const memberMapSection = activityPanelSource.slice(
  memberMapStart,
  activityPanelSource.indexOf('</div>}', memberMapStart),
)
const modelBadgeAt = memberMapSection.indexOf('const modelBadge = ')
const modelBadgeSection = modelBadgeAt === -1 ? '' : memberMapSection.slice(modelBadgeAt, memberMapSection.indexOf('const portrait', modelBadgeAt))
const badgeCompactAt = memberMapSection.indexOf('{compact ? (')
const badgeElseAt = badgeCompactAt === -1 ? -1 : memberMapSection.indexOf(') : (', badgeCompactAt)
const badgeRowEnd = memberMapSection.indexOf('</button>', badgeElseAt)
const badgeCompactBranch = badgeCompactAt === -1 || badgeElseAt === -1 ? '' : memberMapSection.slice(badgeCompactAt, badgeElseAt)
const badgeLargeBranch = badgeElseAt === -1 ? '' : memberMapSection.slice(badgeElseAt, badgeRowEnd)
const badgeOrder = (branch, markers) => {
  const at = markers.map((marker) => branch.indexOf(marker))
  return at.every((value, index) => value !== -1 && (index === 0 || value > at[index - 1]))
}
check(
  'member model badge renders compact text inline with full-route metadata',
  modelBadgeSection.includes('compactModelLabel(memberModel)')
    && modelBadgeSection.includes('<span className={css.memberModel}')
    && modelBadgeSection.includes('data-member-model={memberModel}')
    && modelBadgeSection.includes('title={memberModel}')
    && modelBadgeSection.includes('aria-label={memberModel}')
    && modelBadgeSection.includes('role="img"')
    && badgeCompactBranch.includes('{modelBadge}')
    && badgeLargeBranch.includes('{modelBadge}')
    && badgeOrder(badgeCompactBranch, ['css.memberRoleIcon', '{modelBadge}', 'css.memberStateIcon'])
    && badgeOrder(badgeLargeBranch, ['css.memberRole}', '{modelBadge}', '{stateWord}']),
  'the badge must be a noninteractive role=img span carrying the full route in title/aria-label/data-member-model, drawn after the role mark and before the state word in both variants',
)
// Stylesheet contract: a `css.<name>` a component renders must exist in the sheet
// that component imports. A deleted rule leaves `className={undefined}` behind,
// which React renders silently — no type error, no missing-render failure — so a
// stylesheet that drifted away from its components is invisible without this.
const panelCssSelectors = new Set([...activityPanelCss.matchAll(/\.([A-Za-z][\w-]*)/gu)].map((match) => match[1]))
const panelCssUses = new Set([...(activityPanelSource + stagingPlanSource).matchAll(/css\.([A-Za-z]\w*)/gu)].map((match) => match[1]))
const undefinedPanelClasses = [...panelCssUses].filter((name) => !panelCssSelectors.has(name)).sort()
check(
  'every style class the panel renders exists in its stylesheet',
  undefinedPanelClasses.length === 0,
  `class name(s) rendered without a rule: ${undefinedPanelClasses.join(', ')}`,
)
check(
  'the old separate third-line member model span and locale key are removed',
  !activityPanelSource.includes("t('member.model'")
    && !localesSource.includes("'member.model'"),
  'the previous standalone model row and its orphaned locale key must not remain',
)
const memberModelCssStart = activityPanelCss.indexOf('.memberModel {')
const memberModelCssBlock = activityPanelCss.slice(
  memberModelCssStart,
  activityPanelCss.indexOf('}', memberModelCssStart) + 1,
)
check(
  'member model badge is a compact neutral inline pill that truncates without overflowing',
  memberModelCssBlock.includes('display: inline-flex')
    && memberModelCssBlock.includes('border-radius: 999px')
    && memberModelCssBlock.includes('background: var(--dsw-alias-button-ghost-active-fill)')
    && memberModelCssBlock.includes('max-width: 132px')
    && memberModelCssBlock.includes('min-width: 0')
    && memberModelCssBlock.includes('overflow: hidden')
    && memberModelCssBlock.includes('text-overflow: ellipsis')
    && memberModelCssBlock.includes('white-space: nowrap'),
  'the .memberModel pill needs bounded shrinkable width, ellipsis, and neutral fill so long routes never overflow the panel',
)
check(
  'activity polling combines card demand with current-session cold discovery',
  activityPanelSource.includes('if (current === undefined) return')
    && activityPanelSource.includes('startActivityPolling(currentTargets, { discoverySessionId: current })')
    && agentTeamsCardSource.includes('monitorAgentTeam(owner, data.teamId)')
    && !agentTeamsCardSource.includes('setInterval(')
    && !agentTeamsCardSource.includes('fetch('),
  'the global panel must recover cardless sessions without duplicate card pollers',
)

console.log('2/8 pure rules')
check("sanitizeKey('My Team!') -> 'my-team'", sanitizeKey('My Team!') === 'my-team')
// #15: an ASCII-only whitelist folded every non-Latin name onto one constant,
// so distinct members shared a mailbox file and the second one was rejected as
// a duplicate. Keys must stay distinct for distinct names, in any script.
check("CJK names survive folding", sanitizeKey('研究员') === '研究员')
check(
  'distinct non-Latin names stay distinct',
  sanitizeKey('研究员') !== sanitizeKey('工程师')
    && sanitizeKey('データ分析') !== sanitizeKey('Данные'),
)
check(
  'names with no letters or digits get distinct keys, not a shared constant',
  sanitizeKey('!!!') !== sanitizeKey('🐳') && sanitizeKey('🐳') !== '',
)
check('folding is deterministic', sanitizeKey('🐳') === sanitizeKey('🐳'))
check(
  'long names stay inside the filesystem name limit',
  Buffer.byteLength(`${sanitizeKey('研'.repeat(300))}.jsonl`) < 255,
)
check(
  'long names sharing a prefix stay distinct',
  sanitizeKey(`${'研'.repeat(60)}a`) !== sanitizeKey(`${'研'.repeat(60)}b`),
)
check(
  'keys stay a single safe path segment',
  !/[\\/:*?"<>|]/.test(sanitizeKey('a/b\\c:d*e?f"g<h>i|j')) && !sanitizeKey('../../etc').includes('.'),
)
check('pending -> claimed allowed', transitionError('pending', 'claimed') === undefined)
check('pending -> in_progress denied', transitionError('pending', 'in_progress') !== undefined)
check('in_progress -> completed allowed', transitionError('in_progress', 'completed') === undefined)
check('completed -> in_progress denied', transitionError('completed', 'in_progress') !== undefined)
check('same status is a no-op', transitionError('failed', 'failed') === undefined)

console.log('3/8 dependency gating')
const tasks = [
  { id: 't1', status: 'completed' },
  { id: 't2', status: 'pending' },
  { id: 't3', status: 'failed' },
]
check('all-done deps satisfied', unsatisfiedDependencies(tasks, ['t1']).length === 0)
check('pending dep blocks', unsatisfiedDependencies(tasks, ['t2']).length === 1)
check('failed dep blocks too', unsatisfiedDependencies(tasks, ['t3']).length === 1)

console.log('4/8 on-disk team flow (temp dir)')
const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-verify-'))
try {
  const team = {
    name: 'Verify Team',
    id: sanitizeKey('Verify Team'),
    description: 'smoke',
    captainSessionId: 'sess-captain',
    createdAt: Date.now(),
    members: [
      { id: 'sess-member', name: 'alice', joinedAt: Date.now(), status: 'idle' },
      { id: 'sess-removed', name: 'former', joinedAt: Date.now(), status: 'removed' },
    ],
    tasks: [],
    taskSeq: 0,
  }
  await createTeamDir(stateRoot, team)

  const reread = await readTeam(stateRoot, team.id)
  check('team.json round-trips', reread?.id === team.id && reread.captainSessionId === 'sess-captain')

  await writeFile(join(stateRoot, team.id, 'team.json'), `\uFEFF${JSON.stringify(team, null, 2)}`, 'utf8')
  check('team.json accepts a UTF-8 BOM', (await readTeam(stateRoot, team.id))?.id === team.id)

  const dirty = {
    ...team,
    id: 'dirty-profile',
    profile: { name: '' },
    tasks: [{
      id: 't1',
      subject: 'legacy',
      status: 'pending',
      dependencies: [],
      profileSeedId: '   ',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
    taskSeq: 1,
  }
  await mkdir(join(stateRoot, dirty.id, 'inbox'), { recursive: true })
  await writeFile(join(stateRoot, dirty.id, 'team.json'), JSON.stringify(dirty, null, 2), 'utf8')
  const recovered = await readTeam(stateRoot, dirty.id)
  check('cold-resume ignores dirty optional profile and seed id',
    recovered?.id === dirty.id && recovered.profile === undefined && recovered.tasks[0]?.profileSeedId === undefined)
  await removeTeamDir(stateRoot, dirty.id)

  // Regression for #105: a task persisted with model-materialized blank
  // optional fields (e.g. reviewedTaskId:"") used to brick the whole team on
  // reload. The durable boundary must normalize blanks to omitted instead,
  // while keeping non-blank optional values intact.
  const dirtyQuality = {
    ...team,
    id: 'dirty-quality-fields',
    tasks: [
      {
        id: 't1',
        subject: 'Review impl',
        kind: 'review',
        status: 'pending',
        dependencies: [],
        reviewedTaskId: 't2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 't2',
        subject: 'Repair with blanks',
        kind: 'repair',
        status: 'pending',
        dependencies: [],
        sourceTaskId: 't1',
        sourceFindingIds: [''],
        reviewedTaskId: '',
        objective: '',
        inScope: ['', 'src/repair.ts'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    taskSeq: 2,
  }
  await mkdir(join(stateRoot, dirtyQuality.id, 'inbox'), { recursive: true })
  await writeFile(join(stateRoot, dirtyQuality.id, 'team.json'), JSON.stringify(dirtyQuality, null, 2), 'utf8')
  const recoveredQuality = await readTeam(stateRoot, dirtyQuality.id)
  const repairedTask = recoveredQuality?.tasks.find((item) => item.id === 't2')
  check('cold-resume recovers blank optional quality fields (#105)',
    recoveredQuality?.id === dirtyQuality.id
      && repairedTask?.reviewedTaskId === undefined
      && repairedTask?.objective === undefined
      && repairedTask?.sourceFindingIds === undefined
      && JSON.stringify(repairedTask?.inScope) === JSON.stringify(['src/repair.ts']))
  check('cold-resume keeps non-blank optional quality fields (#105)',
    recoveredQuality?.tasks.find((item) => item.id === 't1')?.reviewedTaskId === 't2')
  await removeTeamDir(stateRoot, dirtyQuality.id)

  // WP1: the new optional result statuses and criterion shapes must survive
  // team.json round trips, and an OLD team.json that lacks them must still
  // load. `waived`, `hasWaivers`, `waiverConfirmation` and the object form of
  // `acceptance` are all optional on read.
  const waivedTeam = {
    ...team,
    id: 'waived-round-trip',
    tasks: [
      {
        id: 't1',
        subject: 'Implement the parser',
        kind: 'implementation',
        status: 'completed',
        dependencies: [],
        objective: 'Ship the parser',
        inScope: ['src/parser.ts'],
        acceptance: [
          'parser accepts empty input',
          { text: 'no new ui_smoke failure versus baseline', mode: 'no_regression', baseline: '059e5ae' },
        ],
        verify: ['pnpm test', 'ui_smoke'],
        changedPaths: ['src/parser.ts'],
        acceptanceResults: [
          { criterion: 'parser accepts empty input', status: 'passed', evidence: 'unit test added' },
          {
            criterion: 'no new ui_smoke failure versus baseline',
            status: 'waived',
            evidence: 'ui_smoke is red on HEAD 059e5ae before this lane and identical after',
          },
        ],
        commandsRun: [
          { command: 'pnpm test', status: 'passed', exitCode: 0 },
          { command: 'ui_smoke', status: 'waived', evidence: 'pre-existing failure at fxplayer.py:15593' },
        ],
        hasWaivers: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 't2',
        subject: 'Review the implementation',
        kind: 'review',
        status: 'completed',
        dependencies: ['t1'],
        verdict: 'pass',
        reviewedTaskId: 't1',
        waiverConfirmation: {
          taskId: 't1',
          reason: 'the failure is identical at baseline 059e5ae and outside this lane',
          waived: ['no new ui_smoke failure versus baseline'],
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    taskSeq: 2,
  }
  await mkdir(join(stateRoot, waivedTeam.id, 'inbox'), { recursive: true })
  await writeFile(join(stateRoot, waivedTeam.id, 'team.json'), JSON.stringify(waivedTeam, null, 2), 'utf8')
  const recoveredWaived = await readTeam(stateRoot, waivedTeam.id)
  const waivedTask = recoveredWaived?.tasks.find((item) => item.id === 't1')
  check('waived acceptanceResults and commandsRun survive a team.json round trip',
    waivedTask?.acceptanceResults?.[1]?.status === 'waived'
      && waivedTask?.acceptanceResults?.[1]?.evidence?.includes('059e5ae')
      && waivedTask?.commandsRun?.[1]?.status === 'waived'
      && waivedTask?.hasWaivers === true)
  check('a criterion object in acceptance survives a team.json round trip',
    waivedTask?.acceptance?.[1]?.mode === 'no_regression'
      && waivedTask?.acceptance?.[1]?.baseline === '059e5ae'
      && waivedTask?.acceptance?.[0] === 'parser accepts empty input')
  check('waiverConfirmation survives a team.json round trip',
    recoveredWaived?.tasks.find((item) => item.id === 't2')?.waiverConfirmation?.taskId === 't1')
  check('legacy string criteria still read',
    isAcceptanceCriterion(waivedTask?.acceptance?.[0]) === true
      && acceptanceCriterionText(waivedTask?.acceptance?.[0]) === 'parser accepts empty input')
  await removeTeamDir(stateRoot, waivedTeam.id)

  // A malformed waiver (no evidence) must not be silently repaired: the whole
  // record is rejected, exactly like a malformed verdict.
  const badWaiver = {
    ...team,
    id: 'bad-waiver',
    tasks: [{
      id: 't1',
      subject: 'Implement',
      kind: 'implementation',
      status: 'completed',
      dependencies: [],
      objective: 'Ship it',
      inScope: ['src/parser.ts'],
      acceptance: ['parser accepts empty input'],
      verify: ['pnpm test'],
      acceptanceResults: [{ criterion: 'parser accepts empty input', status: 'waived' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
    taskSeq: 1,
  }
  await mkdir(join(stateRoot, badWaiver.id, 'inbox'), { recursive: true })
  await writeFile(join(stateRoot, badWaiver.id, 'team.json'), JSON.stringify(badWaiver, null, 2), 'utf8')
  let badWaiverRejected = false
  try { await readTeam(stateRoot, badWaiver.id) }
  catch (error) { badWaiverRejected = /invalid AgentTeams state/.test(String(error)) }
  check('a waiver without evidence is rejected at the durable boundary', badWaiverRejected)
  await removeTeamDir(stateRoot, badWaiver.id)

  // Recovery only removes blank strings. Other malformed values must still
  // fail durable validation rather than silently erasing contract/scope data.
  for (const [field, values] of [
    ['acceptance', [123, 'real criterion']],
    ['outOfScope', [{ path: 'src/private/' }]],
    ['sourceFindingIds', [null]],
  ]) {
    const malformed = {
      ...dirtyQuality,
      id: `malformed-${field.toLowerCase()}`,
      tasks: [{ ...dirtyQuality.tasks[1], [field]: values }],
    }
    await createTeamDir(stateRoot, malformed)
    let rejected = false
    try { await readTeam(stateRoot, malformed.id) }
    catch (error) { rejected = /invalid AgentTeams state/.test(String(error)) }
    check(`cold-resume rejects non-string ${field} items`, rejected)
    await removeTeamDir(stateRoot, malformed.id)
  }

  // WP11 phase 1: the finders return every match, because a captain may lead
  // several teams; addressing happens by team_id.
  const found = await findTeamsByCaptain(stateRoot, 'sess-captain')
  check('findTeamsByCaptain finds the team', found.map(team => team.id).join(',') === team.id)
  check('findTeamsByCaptain ignores other captains', (await findTeamsByCaptain(stateRoot, 'sess-other')).length === 0)
  check('findTeamsByParticipant finds the captain', (await findTeamsByParticipant(stateRoot, 'sess-captain')).map(team => team.id).join(',') === team.id)
  check('findTeamsByParticipant finds an active member', (await findTeamsByParticipant(stateRoot, 'sess-member')).map(team => team.id).join(',') === team.id)
  check('findTeamsByParticipant rejects a removed member', (await findTeamsByParticipant(stateRoot, 'sess-removed')).length === 0)
  check('listTeams returns every readable team oldest first',
    (await listTeams(stateRoot)).map(team => team.id).join(',') === team.id
      && (await listTeams(join(stateRoot, 'missing-root'))).length === 0)
  check('describeTeamHandles names id and team for the missing-team_id error',
    describeTeamHandles([{ id: 't1', name: 'Alpha' }]) === 't1 (Alpha)'
      && describeTeamHandles([]).includes('agent_teams_create'))

  const escapedContent = String.raw`save to notes\foo.md`
  const message = createMessage('alice', CAPTAIN_KEY, escapedContent)
  await withTeamLock(team.id, async () => {
    await appendMailbox(stateRoot, team.id, CAPTAIN_KEY, message)
  })
  const second = createMessage('bob', CAPTAIN_KEY, 'valid after BOM')
  const mailboxFile = join(stateRoot, team.id, 'inbox', `${CAPTAIN_KEY}.jsonl`)
  await writeFile(
    mailboxFile,
    `\uFEFF${JSON.stringify(second)}\n${String.raw`{"broken":"notes\q.md"}`}\n{}\n`,
    { encoding: 'utf8', flag: 'a' },
  )
  const malformedLines = []
  const inbox = await readMailbox(
    stateRoot,
    team.id,
    CAPTAIN_KEY,
    (lineNumber) => malformedLines.push(lineNumber),
  )
  check('mailbox append/read preserves backslashes', inbox[0]?.content === escapedContent)
  check('mailbox accepts BOM-prefixed JSONL records', inbox[1]?.content === second.content)
  check('mailbox skips malformed JSON and malformed shapes', inbox.length === 2 && malformedLines.join(',') === '3,4')
  check('missing mailbox reads empty', (await readMailbox(stateRoot, team.id, 'nobody')).length === 0)

  // The per-team lock queue must stay serial, hand off to later waiters, and
  // must not leak one resolved promise chain per key after the last waiter.
  const serialKey = 'lock-cleanup:serial'
  const order = []
  let inside = 0
  let maxInside = 0
  await Promise.all(Array.from({ length: 25 }, (_, index) => withTeamLock(serialKey, async () => {
    inside += 1
    maxInside = Math.max(maxInside, inside)
    order.push(index)
    await new Promise((resolve) => setTimeout(resolve, index % 3 === 0 ? 5 : 1))
    inside -= 1
  })))
  check('withTeamLock keeps same-key workers strictly serial and ordered',
    maxInside === 1 && order.join(',') === Array.from({ length: 25 }, (_, index) => index).join(','))
  check('withTeamLock queue entry drains after the last waiter settles',
    !teamLockQueueKeys().includes(serialKey))

  const handoffKey = 'lock-cleanup:handoff'
  let releaseHold
  const heldGate = new Promise((resolve) => { releaseHold = resolve })
  let successorEntered = false
  const hold = withTeamLock(handoffKey, async () => { await heldGate })
  const successor = withTeamLock(handoffKey, async () => { successorEntered = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('withTeamLock keeps its queue entry while the lock is held or handed off',
    teamLockQueueKeys().includes(handoffKey))
  releaseHold()
  await Promise.all([hold, successor])
  check('withTeamLock wakes the queued successor and drops the key afterwards',
    successorEntered && !teamLockQueueKeys().includes(handoffKey))

  const duplicateCaptain = { ...team, id: 'duplicate-captain', members: [] }
  await createTeamDir(stateRoot, duplicateCaptain)
  // WP11 phase 1 replaced "ambiguous, refuse" with "list them and address one by
  // team_id": a captain may legitimately lead two teams in one workspace.
  const withTwoTeams = await findTeamsByCaptain(stateRoot, 'sess-captain')
  check('a captain may lead two teams without an ambiguous failure',
    withTwoTeams.length === 2
      && [team.id, duplicateCaptain.id].every(id => withTwoTeams.some(candidate => candidate.id === id))
      && withTwoTeams.every((candidate, index) => index === 0
        || (withTwoTeams[index - 1]?.createdAt ?? 0) <= candidate.createdAt))
  check('the team list names both teams for the missing-team_id error',
    describeTeamHandles(withTwoTeams).includes(team.id) && describeTeamHandles(withTwoTeams).includes(duplicateCaptain.id))
  await removeTeamDir(stateRoot, duplicateCaptain.id)

  const duplicateMember = { ...team, id: 'duplicate-member', captainSessionId: 'sess-other-captain' }
  await createTeamDir(stateRoot, duplicateMember)
  const memberOfTwo = await findTeamsByParticipant(stateRoot, 'sess-member')
  check('a session may belong to two teams and both are listed', memberOfTwo.length === 2)
  await removeTeamDir(stateRoot, duplicateMember.id)

  const invalidId = 'invalid-shape'
  await mkdir(join(stateRoot, invalidId), { recursive: true })
  await writeFile(join(stateRoot, invalidId, 'team.json'), '{}', 'utf8')
  let invalidShapeRejected = false
  try {
    await readTeam(stateRoot, invalidId)
  } catch {
    invalidShapeRejected = true
  }
  check('invalid team.json shape is rejected at the durable boundary', invalidShapeRejected)
  await removeTeamDir(stateRoot, invalidId)

  await removeTeamDir(stateRoot, team.id)
  check('removeTeamDir removes the team', await readTeam(stateRoot, team.id) === undefined)

  // Archive keeps the team data for post-delete review.
  const archiveTeam = { ...team, id: sanitizeKey('Archive Team') }
  await createTeamDir(stateRoot, archiveTeam)
  const { archiveTeamDir, readArchivedTeam, listArchivedTeamIds } = await import('../lib/state.js')
  await archiveTeamDir(stateRoot, archiveTeam.id)
  check('archive moves the team out of live scan', await readTeam(stateRoot, archiveTeam.id) === undefined)
  check('archive keeps team.json readable', (await readArchivedTeam(stateRoot, archiveTeam.id))?.id === archiveTeam.id)
  check('archive lists the team id', (await listArchivedTeamIds(stateRoot)).includes(archiveTeam.id))
  check('archive dir skips live readTeam', await readTeam(stateRoot, 'archive') === undefined)
} finally {
  await rm(stateRoot, { recursive: true, force: true })
}

console.log('5/8 host visual-state functions (activity panel)')
const { taskVisualState, taskDepthsById } = await import('../lib/state.js')
const vtasks = [
  { id: 't1', subject: 'a', status: 'completed', assignee: 'alice', dependencies: [], createdAt: 0, updatedAt: 0 },
  { id: 't2', subject: 'b', status: 'pending', assignee: 'bob', dependencies: ['t1'], createdAt: 0, updatedAt: 0 },
  { id: 't3', subject: 'c', status: 'in_progress', assignee: 'bob', dependencies: ['t2'], createdAt: 0, updatedAt: 0 },
  { id: 't4', subject: 'd', status: 'pending', assignee: 'alice', dependencies: ['t9'], createdAt: 0, updatedAt: 0 },
]
check('completed -> completed visual state', taskVisualState('completed', [], vtasks) === 'completed')
check('failed -> failed visual state', taskVisualState('failed', [], vtasks) === 'failed')
check('cancelled -> cancelled visual state', taskVisualState('cancelled', [], vtasks) === 'cancelled')
check('in_progress -> running visual state', taskVisualState('in_progress', [], vtasks) === 'running')
check('pending with completed dep -> open', taskVisualState('pending', ['t1'], vtasks) === 'open')
check('pending with open dep -> blocked', taskVisualState('pending', ['t2'], vtasks) === 'blocked')
check('missing dependency is ignored (not blocked)', taskVisualState('pending', ['t9'], vtasks) === 'open')
const depths = taskDepthsById(vtasks)
check('t1 depth 0', depths.get('t1') === 0)
check('t2 depth 1 (longest path)', depths.get('t2') === 1)
check('t3 depth 2', depths.get('t3') === 2)
check('missing dep contributes no depth', depths.get('t4') === 0)

console.log('6/8 client panel projections')
const liveTeam = {
  captainSessionId: 'captain-1',
  members: [{ name: 'analyst', status: 'working', activity: 'working', currentTask: 't1' }],
  tasks: [{ id: 't1', subject: 'Clarify requirements', status: 'in_progress' }],
}
// WP11 phase 2: the panel is driven by a switcher, so selection is a pure model
// decision: one tab per live team, the stored choice while it exists, otherwise
// the first team — and a halted team stays selectable instead of disappearing.
const switchTeams = [
  { teamId: 'alpha', name: 'Alpha', phase: 'running', captainSessionId: 'captain-1', members: liveTeam.members, tasks: liveTeam.tasks },
  { teamId: 'beta', name: 'Beta', phase: 'running', captainSessionId: 'captain-1', halted: true, members: [], tasks: [] },
]
check('the panel switcher offers one tab per live team with its own counters',
  panelTeamTabs(switchTeams).length === 2
    && panelTeamTabs(switchTeams)[0]?.working === 1
    && panelTeamTabs(switchTeams)[0]?.total === 1
    && panelTeamTabs(switchTeams)[1]?.halted === true
    && panelTeamTabs(switchTeams)[1]?.total === 0)
check('the panel selection follows the stored team while it exists',
  panelSelectedTeamId(switchTeams, 'beta') === 'beta'
    && panelSelectedTeamId(switchTeams, 'gone') === 'alpha'
    && panelSelectedTeamId([], 'alpha') === null)
check('a stored panel selection is parsed defensively',
  parsePanelTeamSelection(' beta ') === 'beta' && parsePanelTeamSelection('') === null) 
check('active team with working members stays visible', teamIsActive(liveTeam) === true)
check('planning roster with no tasks still shows the banner', teamIsActive({
  members: [{ name: 'analyst', status: 'idle', activity: 'idle' }],
  tasks: [],
}) === true)
check('halted team is not active', teamIsActive({ ...liveTeam, halted: true }) === false)
check('staged team is not presented as actively executing', teamIsActive({ ...liveTeam, phase: 'staged' }) === false)
check('settled failed/completed team is not waiting to be scheduled', teamIsActive({
  members: [{ name: 'analyst', status: 'idle', activity: 'idle' }],
  tasks: [
    { id: 't1', status: 'completed' },
    { id: 't2', status: 'failed' },
  ],
}) === false)
check('progress summary prefers running task titles', teamProgressSummary(liveTeam, '、').detail === 'Clarify requirements')
check(
  'task model labels prefer the snapshot field and fall back to the assignee route',
  memberRouteLabel({ provider: 'openai', model: 'gpt-5.6-sol' }) === 'openai/gpt-5.6-sol'
    && memberRouteLabel({ model: 'grok-4.6' }) === 'grok-4.6'
    && compactModelLabel('openai/gpt-5.6-sol') === 'gpt-5.6-sol'
    && taskModelLabel({ assignee: 'analyst', model: 'openai/gpt-5.6-sol' }, []) === 'openai/gpt-5.6-sol'
    && taskModelLabel({ assignee: 'analyst' }, [{ name: 'analyst', provider: 'grok', model: 'grok-4.5' }]) === 'grok/grok-4.5'
    && taskModelLabel({ assignee: 'analyst' }, []) === '',
)
check(
  'existing member route helpers retain expanded fallback regression coverage',
  memberRouteLabel({ provider: 'openai', model: 'gpt-5.6-sol' }) === 'openai/gpt-5.6-sol'
    && compactModelLabel('openai/gpt-5.6-sol') === 'gpt-5.6-sol'
    && memberRouteLabel({ model: 'grok-4.6' }) === 'grok-4.6'
    && compactModelLabel('grok-4.6') === 'grok-4.6'
    && memberRouteLabel({}) === ''
    && memberRouteLabel(undefined) === ''
    && compactModelLabel('') === ''
    && compactModelLabel('   ') === ''
    && memberRouteLabel({ provider: ' openai ', model: ' gpt-5.6-sol ' }) === 'openai/gpt-5.6-sol'
    && memberRouteLabel({ provider: ' ', model: ' gpt-5.6-sol ' }) === 'gpt-5.6-sol'
    && compactModelLabel(' openai/gpt-5.6-sol ') === 'gpt-5.6-sol'
    && memberRouteLabel({ provider: 'openai/org', model: 'gpt-5.6-sol' }) === 'openai/org/gpt-5.6-sol'
    && compactModelLabel('openai/org/gpt-5.6-sol') === 'gpt-5.6-sol',
)
console.log('6b/8 phase, agent and queue projections (WP10)')

// The material-layers run from AGENT_TEAMS_FEEDBACK.md: six lanes behind one
// failed t5, plus a migration task that depends on all of them. Reproduced as a
// projection fixture so the three read-only views can be asserted without React.
const laneTask = (id, dependencies, assignee, status, extra = {}) => ({
  id,
  subject: `lane ${id}`,
  status,
  assignee,
  dependencies,
  depth: dependencies.length === 0 ? 0 : 1,
  state: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : dependencies.length === 0 ? 'open' : 'blocked',
  ...extra,
})
const laneTasks = [
  laneTask('t1', [], 'analyst', 'completed'),
  laneTask('t2', ['t1'], 'implementer', 'completed'),
  laneTask('t3', ['t1'], 'lane-a', 'completed'),
  laneTask('t4', ['t1'], 'lane-b', 'completed'),
  laneTask('t5', ['t1'], 'lane-c', 'failed'),
  laneTask('t6', ['t1'], 'lane-d', 'pending'),
  laneTask('t7', ['t1'], 'lane-e', 'pending'),
  laneTask('t8', ['t1'], 'lane-f', 'pending'),
  laneTask('t9', ['t1'], 'lane-g', 'pending'),
  laneTask('t10', ['t5'], 'migrator', 'pending'),
  laneTask('t11', ['t3', 't4', 't5'], 'migrator', 'pending'),
]
const laneMembers = [
  { id: 'm1', name: 'implementer', activity: 'idle', status: 'idle', done: 1, total: 1 },
  { id: 'm2', name: 'lane-a', activity: 'idle', status: 'idle', done: 1, total: 1 },
  { id: 'm3', name: 'lane-b', activity: 'idle', status: 'idle', done: 1, total: 1 },
  { id: 'm4', name: 'lane-c', activity: 'idle', status: 'idle', done: 0, total: 1 },
  { id: 'm5', name: 'lane-d', activity: 'idle', status: 'idle', done: 0, total: 1 },
  { id: 'm6', name: 'lane-e', activity: 'idle', status: 'idle', done: 0, total: 1 },
  { id: 'm7', name: 'lane-f', activity: 'idle', status: 'idle', done: 0, total: 1 },
  { id: 'm8', name: 'lane-g', activity: 'idle', status: 'idle', done: 0, total: 1 },
  { id: 'm9', name: 'migrator', activity: 'idle', status: 'idle', done: 0, total: 2 },
]

check('phase columns on an empty plan are empty', phaseColumns([]).length === 0)
{
  const auto = phaseColumns(laneTasks)
  check(
    'phase columns follow the DAG levels',
    auto.length === 3
      && auto.map(column => column.phaseId).join(',') === 'level-0,level-1,level-2'
      && auto[1]?.tasks.length === 8
      && auto[2]?.tasks.map(task => task.id).join(',') === 't10,t11',
  )
  const manual = phaseColumns(laneTasks, [
    { id: 'E0', title: 'Recon', taskIds: ['t1', 't2'] },
    { id: 'E1', title: 'Lanes', taskIds: ['t3', 't4', 't5'] },
    { id: 'E2', title: 'Migration', taskIds: ['t10', 't11'] },
  ])
  check(
    'manual phases take precedence over the DAG levels',
    manual.map(column => column.phaseId).join(',') === 'E0,E1,E2,unphased'
      && manual[1]?.title === 'Lanes'
      && manual[3]?.tasks.map(task => task.id).join(',') === 't6,t7,t8,t9',
  )
  check(
    'manual phases keep the DAG levels inside the unphased column',
    phaseColumns(laneTasks, [
      { id: 'E0', title: 'Recon', taskIds: ['t1', 't2'] },
      { id: 'E1', title: 'Lanes', taskIds: ['t3', 't4', 't5'] },
    ]).map(column => column.phaseId).join(',') === 'E0,E1,unphased',
  )
  // Regression (found in round 2): a plan that declares a column for every task
  // left `rest` empty, so the manual columns were discarded and the board came
  // out empty — the one shape a max-effort plan actually has.
  const declared = [
    { id: 'E0', title: 'Recon', taskIds: ['t1', 't2'] },
    { id: 'E1', title: 'Lanes', taskIds: ['t3', 't4', 't5'] },
    { id: 'E2', title: 'Repair', taskIds: ['t6', 't7', 't8', 't9'] },
    { id: 'E3', title: 'Migration', taskIds: ['t10', 't11'] },
  ]
  const fullyDeclared = phaseColumns(laneTasks, declared)
  check(
    'declared phases that cover every task are kept without an unphased column',
    fullyDeclared.map(column => column.phaseId).join(',') === 'E0,E1,E2,E3'
      && fullyDeclared[2]?.tasks.map(task => task.id).join(',') === 't6,t7,t8,t9'
      && fullyDeclared.flatMap(column => column.tasks).length === laneTasks.length,
  )
  const declaredBoard = phaseBoardLayout(laneTasks, declared)
  check(
    'a fully declared plan lays out every task it declares',
    declaredBoard.columns.length === 4
      && declaredBoard.nodes.length === laneTasks.length
      && declaredBoard.width > 0
      && declaredBoard.height > 0,
    `nodes=${declaredBoard.nodes.length} columns=${declaredBoard.columns.length} width=${declaredBoard.width}`,
  )
}
// The queues view and the swimlane projection are gone (owner decision,
// 2026-09-20 round 2): the phase board is the only graph view, so their checks and
// their model functions were removed with them rather than left testing dead code.
check(
  'agent colours are stable per name, shared by the surviving view and distinct across the roster',
  agentColor('lane-a') === agentColor('lane-a')
    && agentColor('lane-a') !== agentColor('lane-b')
    && agentColor('') === agentColor(''),
)
{
  const board = phaseBoardLayout(laneTasks, [
    { id: 'E0', title: 'Recon', taskIds: ['t1', 't2'] },
    { id: 'E1', title: 'Lanes', taskIds: ['t3', 't4', 't5'] },
  ])
  check(
    'phase columns advance by the width the previous column needed',
    board.columns.length === 3
      // E0 holds the t1 → t2 chain, so it is two nodes wide; E1 starts after it.
      && board.columns[0]?.width === 2 * COMPACT_DAG_NODE_WIDTH + 26
      && board.columns[1]?.x === board.columns[0].width + 26
      && board.nodes.find(node => node.task.id === 't2')?.x === COMPACT_DAG_NODE_WIDTH + 26
      && board.nodes.find(node => node.task.id === 't4')?.x === board.columns[1]?.x,
  )
  check(
    'phase board draws an edge per dependency that landed on the board',
    board.edges.some(edge => edge.from === 't1' && edge.to === 't2' && edge.path.startsWith('M92 15C'))
      && board.edges.some(edge => edge.from === 't5' && edge.to === 't10'),
  )
  check(
    'phase board height follows the busiest column and its width the sum of the columns',
    board.height === 6 * COMPACT_DAG_NODE_HEIGHT + 5 * COMPACT_DAG_ROW_GAP
      && board.width === board.columns.reduce((sum, column) => sum + column.width, 0) + 2 * 26,
  )
}
// Owner request (2026-09-20, round 2): inside a phase, sequential work reads as a
// line, parallel work keeps its own row, and the column stretches to its longest
// chain — which is what makes a separate tree view unnecessary.
{
  const chained = phaseBoardLayout([
    { id: 'a', subject: 'one', status: 'completed', state: 'completed', assignee: 'x', dependencies: [], depth: 0 },
    { id: 'b', subject: 'two', status: 'pending', state: 'open', assignee: 'x', dependencies: ['a'], depth: 1 },
    { id: 'c', subject: 'three', status: 'pending', state: 'open', assignee: 'y', dependencies: ['a'], depth: 1 },
    { id: 'd', subject: 'four', status: 'pending', state: 'open', assignee: 'y', dependencies: ['b', 'c'], depth: 2 },
  ], [{ id: 'E0', title: 'One phase', taskIds: ['a', 'b', 'c', 'd'] }])
  const at = (id) => chained.nodes.find((node) => node.task.id === id)
  const step = COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP
  check(
    'sequential work inside one phase lines up in a row',
    at('a')?.y === at('b')?.y
      && at('b')?.x === step
      && at('a')?.y === at('d')?.y
      && at('d')?.x === 2 * step,
    JSON.stringify(chained.nodes.map((node) => [node.task.id, node.x, node.y])),
  )
  check(
    'parallel work in the same phase takes its own row',
    at('c')?.x === at('b')?.x
      && at('c')?.y === COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP
      && at('c')?.y !== at('b')?.y,
  )
  check(
    'a phase column stretches to the length of its longest chain',
    chained.columns.length === 1
      && chained.columns[0]?.width === 3 * COMPACT_DAG_NODE_WIDTH + 2 * COMPACT_DAG_COLUMN_GAP
      && chained.width === chained.columns[0]?.width
      && chained.height === 2 * COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP,
  )
  const chainEdges = chained.edges.filter((edge) => at(edge.from)?.y === at(edge.to)?.y)
  check(
    'a chain edge is a short forward curve inside the row',
    chained.edges.length === 4
      && chainEdges.length === 2
      && chainEdges.every((edge) => {
        const from = at(edge.from)
        const to = at(edge.to)
        return from !== undefined && to !== undefined
          && to.x - from.x === step
          && edge.path.startsWith(`M${String(from.x + COMPACT_DAG_NODE_WIDTH)} ${String(from.y + COMPACT_DAG_NODE_HEIGHT / 2)}C`)
      }),
    JSON.stringify(chained.edges.map((edge) => edge.path)),
  )
}
// Regression (found in the field, 2026-09-20): the chain walk visited every
// dependency *path*, and a layered plan multiplies paths by the layer width per
// layer. A declared phase of 48 tasks in 12 layers cost 7.5 s per render and 56
// tasks in 14 layers cost 130 s — the browser tab froze while loading the panel,
// which is what took the owner's web profile down after 0.2.2 was installed. The
// depth is memoised now; this fixture is the shape that exposed it, with a budget the
// old recursion cannot come near (it needs minutes) plus the layout it must produce.
{
  const layered = (layers, width) => {
    const tasks = []
    let previous = []
    let seq = 0
    for (let layer = 0; layer < layers; layer += 1) {
      const current = []
      for (let index = 0; index < width; index += 1) {
        seq += 1
        const id = `t${String(seq)}`
        current.push(id)
        tasks.push({
          id,
          subject: `lane ${id}`,
          status: 'pending',
          state: 'open',
          assignee: 'worker',
          dependencies: [...previous],
          depth: layer,
        })
      }
      previous = current
    }
    return tasks
  }
  const dense = layered(12, 4)
  const startedAt = Date.now()
  const denseLayout = phaseBoardLayout(dense, [{ id: 'E0', title: 'One dense phase', taskIds: dense.map(task => task.id) }])
  const denseElapsed = Date.now() - startedAt
  check(
    'a dense declared phase lays out without walking every dependency path',
    denseLayout.nodes.length === dense.length
      && denseLayout.columns[0]?.width === 12 * COMPACT_DAG_NODE_WIDTH + 11 * COMPACT_DAG_COLUMN_GAP
      && denseLayout.height === 4 * COMPACT_DAG_NODE_HEIGHT + 3 * COMPACT_DAG_ROW_GAP
      // The budget is generous on purpose: memoised this takes about a millisecond.
      && denseElapsed < 1000,
    `${String(denseElapsed)} ms for ${String(dense.length)} tasks in 12 layers`,
  )
}
// Owner request (2026-09-20, round 3): the phases section collapses like the
// members list and the checklist — same chevron header, same two words, open by
// default, and the board body is only rendered while it is open.
{
  const toggleAt = activityPanelSource.indexOf('data-phases-toggle')
  const boardAt = activityPanelSource.indexOf('<PhaseBoard')
  check(
    'the phases section collapses like the members list and the checklist',
    toggleAt !== -1
      && activityPanelSource.includes('className={css.phasesToggle}')
      && activityPanelSource.includes('aria-expanded={phasesOpen}')
      && toggleAt < boardAt
      && activityPanelSource.includes("t('phase.toggle', { count:")
      && activityPanelSource.includes("t(phasesOpen ? 'phase.collapse' : 'phase.expand')")
      && /phasesOpen\s*&&\s*\(?\s*<PhaseBoard/u.test(activityPanelSource)
      && /\.membersToggle,\s*\n?\.phasesToggle/u.test(activityPanelCss)
      && ['phase.toggle', 'phase.collapse', 'phase.expand'].every((key) => localesSource.includes(`'${key}'`))
      && Object.hasOwn(agentTeamsEn, 'phase.toggle')
      && Object.hasOwn(agentTeamsZh, 'phase.toggle'),
    `toggle=${String(toggleAt)} board=${String(boardAt)}`,
  )
}
// Owner request (2026-09-20): work in the members tree is shown by a
// full-node-height animated plaque — three dots wide — instead of the compact
// six-dot mark, which read as a decoration rather than as a state of the node.
{
  const rowOpen = activityPanelSource.indexOf('className={css.memberRow}')
  const rowClose = activityPanelSource.indexOf('</button>', rowOpen)
  const barAt = activityPanelSource.indexOf('<WorkBar active=', rowOpen)
  const glyphInRow = activityPanelSource.indexOf('css.workGlyph', rowOpen)
  check(
    'the members tree shows work as a full-height animated plaque',
    activityPanelSource.includes('function WorkBar')
      && activityPanelSource.includes('data-work-bar={active}')
      && barAt > rowOpen && barAt < rowClose
      && (glyphInRow === -1 || glyphInRow > rowClose)
      && activityPanelCss.includes('.workBar')
      && activityPanelCss.includes('.workBarDot')
      && /\.memberRow > \.workBar \{[^}]*align-self: stretch/u.test(activityPanelCss)
      && activityPanelCss.includes('@keyframes agentTeamsBar')
      && /\.memberRow \{[^}]*display: flex/u.test(activityPanelCss),
    `row=${String(rowOpen)} bar=${String(barAt)} glyph=${String(glyphInRow)} close=${String(rowClose)}`,
  )
  check(
    'the plaque keeps its dots round and its wave readable',
    /\.workBarDot \{[^}]*border-radius: 50%/u.test(activityPanelCss)
      && /\.workBarDot \{[^}]*width: 3px/u.test(activityPanelCss)
      && /\.workBar\[data-active='true'\] \.workBarDot \{/u.test(activityPanelCss)
      && activityPanelSource.includes('animationDelay: `${String(row * 0.12)}s`'),
  )
  // Owner request (2026-09-20, round 3): the five rows were sized for the old
  // two-line member row; a one-line node needs about three, so the plaque is
  // compacted vertically while the wave and the idle slot stay as they are.
  const barOpen = activityPanelSource.indexOf('function WorkBar')
  const barBody = activityPanelSource.slice(barOpen, activityPanelSource.indexOf('function CollapsedBadge', barOpen))
  check(
    'the work plaque is three dot rows tall',
    barOpen !== -1
      && barBody.includes('const rows = [0, 1, 2]')
      && !barBody.includes('[0, 1, 2, 3, 4]')
      && barBody.includes('const columns = [0, 1, 2]')
      && /\.workBar \{[^}]*justify-content: space-between/u.test(activityPanelCss)
      && /\.workBar \{[^}]*min-height: 22px/u.test(activityPanelCss),
    `rows=${/const rows = \[([^\]]*)\]/u.exec(barBody)?.[1] ?? '?'}`,
  )
  // Owner request (2026-09-20, round 3): the compact icon line is what a member
  // looks like *collapsed* into a tray, not the default. The default node is the
  // large one (portrait, role words, status sentence, labelled task chips) and a
  // per-member control folds one member — and only that member — into the tray.
  const rowButtonAt = activityPanelSource.indexOf('className={css.memberRow}')
  const compactAt = activityPanelSource.indexOf('{compact ? (', rowButtonAt)
  const elseAt = compactAt === -1 ? -1 : activityPanelSource.indexOf(') : (', compactAt)
  const compactBranch = compactAt === -1 || elseAt === -1 ? '' : activityPanelSource.slice(compactAt, elseAt)
  const largeBranch = elseAt === -1 ? '' : activityPanelSource.slice(elseAt, activityPanelSource.indexOf('</button>', elseAt))
  const collapseAt = activityPanelSource.indexOf('data-member-collapse')
  check(
    'a member node is large by default and folds into the compact tray on demand',
    collapseAt !== -1
      // A sibling *before* the row button: a button may not contain a button, and
      // the row's own click navigates to the member session.
      && collapseAt < rowButtonAt
      && activityPanelSource.includes('aria-expanded={!compact}')
      && activityPanelSource.includes('data-compact={compact}')
      && /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/u.test(activityPanelSource)
      && activityPanelSource.includes("t(compact ? 'member.expandRow' : 'member.collapseRow')")
      && compactBranch.includes('css.memberRoleIcon')
      && compactBranch.includes('css.memberStateIcon')
      && !compactBranch.includes('css.memberStatusLine')
      && largeBranch.includes('css.memberStatusLine')
      && largeBranch.includes('css.memberRole')
      && largeBranch.includes('css.assignmentLabel')
      && !largeBranch.includes('css.memberRoleIcon')
      && /\.memberRow\[data-compact='false'\] \{[^}]*display: grid/u.test(activityPanelCss)
      && /\.memberRow\[data-compact='false'\] > \.memberAvatar \{[^}]*max-height: 76px/u.test(activityPanelCss)
      && /\.memberRow\[data-compact='true'\] \.memberAvatar \.memberArt \{[^}]*width: 24px/u.test(activityPanelCss)
      && /\.memberStateIcon \.stateArt \{[^}]*position: static/u.test(activityPanelCss)
      && activityPanelCss.includes('.memberCollapse')
      && ['member.collapseRow', 'member.expandRow'].every((key) => localesSource.includes(`'${key}'`)),
    `collapse=${String(collapseAt)} row=${String(rowButtonAt)} compact=${String(compactAt)} else=${String(elseAt)}`,
  )
  check(
    'the compact tray row is one icon line that ends in the work plaque',
    compactBranch !== ''
      && ['{portrait}', 'css.memberRoleIcon', 'css.memberInfo', '{modelBadge}', 'css.memberCount', 'css.assignmentLine', '<WorkBar active=']
        .map((marker) => compactBranch.indexOf(marker))
        .every((at, index, all) => at !== -1 && (index === 0 || at > all[index - 1]))
      && !compactBranch.includes('css.assignmentLabel'),
  )
}
// Owner request (2026-09-20, round 2): a cancelled node is painted in a very pale
// scarlet hatch — settled history, not an alarm — and the panel keeps a single
// graph view: the tree and the queues section are gone with their model code.
// Field regression (2026-09-20): the shell's additive overlay does not isolate a
// plugin's render exception, so a defect in this panel unmounted the host's tree and
// left the reader with a blank app — the plugin has to fence itself off.
check(
  'a panel fault cannot take the shell down',
  activityPanelSource.includes('export class PanelErrorBoundary')
    && activityPanelSource.includes('static getDerivedStateFromError')
    && activityPanelSource.includes("t('panel.error', { error: this.state.error })")
    && activityPanelSource.includes('data-agent-teams-error')
    && clientIndexSource.includes('<PanelErrorBoundary t={t}>')
    && clientIndexSource.includes('<PanelErrorBoundary t={props.t}>')
    && activityPanelCss.includes('.panelError')
    && localesSource.includes("'panel.error'"),
)
check(
  'a cancelled node is a pale hatched card, not an alarm',  /\.dagNode\[data-state='cancelled'\] \{[^}]*background-color: color-mix\(in srgb, #f2b8b5/u.test(activityPanelCss)
    && /\.dagNode\[data-state='cancelled'\] \{[^}]*repeating-linear-gradient\(\s*45deg/u.test(activityPanelCss)
    && !/\.dagNode\[data-state='cancelled'\] \{[^}]*state-error-primary/u.test(activityPanelCss),
)
check(
  'the panel keeps the phase board as its only graph view',
  activityPanelSource.includes('data-phase-board')
    && !activityPanelSource.includes('DependencyMap')
    && !activityPanelSource.includes('QueueView')
    && !activityPanelSource.includes('ViewSwitcher')
    && !activityPanelCss.includes('.viewSwitcher')
    && !activityPanelCss.includes('.queueRow')
    && !localesSource.includes("'view.")
    && !localesSource.includes("'queue.")
    && !activityModelSource.includes('export function queueOverview')
    && !activityModelSource.includes('export function agentSwimlanes')
    && !activityModelSource.includes('export function compactDagLayout')
    && !activityModelSource.includes('export function taskStages')
    && !activityModelSource.includes('export function relatedTaskIds')
    && !activityModelSource.includes('export type ActivityViewMode')
    && !activityModelSource.includes('ACTIVITY_VIEW_STORAGE_KEY'),
)

// The phase titles and the board are one coordinate system, so they must share
// one scroller. Two scrollers let the header row drift away from its own columns
// — the defect the owner hit — and the header cells have to sit at the very same
// `x` the layout gave that column's nodes.
{
  const scrollAt = activityPanelSource.indexOf('css.phaseBoardScroll')
  const headerAt = activityPanelSource.indexOf('css.phaseHeaderRow')
  const canvasAt = activityPanelSource.indexOf('data-layout="phases"')
  check(
    'phase headers and the board share one scroller',
    scrollAt !== -1
      && scrollAt < headerAt
      && headerAt < canvasAt
      && activityPanelSource.includes('style={{ left: column.x, width: column.width }}')
      && !activityPanelSource.includes('css.phaseColumns')
      && !activityPanelCss.includes('.phaseColumns')
      && activityPanelCss.includes('.phaseBoardScroll'),
    `scroll=${scrollAt} header=${headerAt} canvas=${canvasAt}`,
  )
}

const panelBounds = { width: 1440, height: 900, anchorRight: 1440 }
const dockedPanel = resolvePanelGeometry(DEFAULT_PANEL_LAYOUT, panelBounds)
check('docked panel follows the shell anchor and retains an available-height ceiling',
  dockedPanel.mode === 'docked'
    && dockedPanel.x === 1034
    && dockedPanel.y === 64
    && dockedPanel.width === 388
    && dockedPanel.height === 788
    && dockedPanel.heightMode === 'auto'
    && panelUsesAutoHeight(dockedPanel, panelBounds)
    && panelMaximumHeight(dockedPanel, panelBounds) === 788)
const floatingPanel = floatPanelLayout(dockedPanel, panelBounds)
const movedPanel = movePanelLayout(floatingPanel, 999, 999, panelBounds)
check('floating panel movement clamps every edge inside the shell',
  movedPanel.mode === 'floating' && movedPanel.x === 1040 && movedPanel.y === 100)
const widerDockedPanel = resizePanelLayout(dockedPanel, 'left', -120, 0, panelBounds)
check('docked left-edge resize preserves the right anchor',
  widerDockedPanel.width === 508 && widerDockedPanel.x === 914)
const narrowerFloatingPanel = resizePanelLayout(floatingPanel, 'left', 200, 0, panelBounds)
check('floating left-edge resize preserves the opposite edge at minimum width',
  narrowerFloatingPanel.width === 320 && narrowerFloatingPanel.x === 1102)
const cornerPanel = resizePanelLayout({ ...floatingPanel, x: 400, y: 200, width: 388, height: 500 }, 'corner', 1200, 1200, panelBounds)
check('floating corner resize preserves its top-left anchor at shell limits',
  cornerPanel.x === 400 && cornerPanel.y === 200
    && cornerPanel.width === 640 && cornerPanel.height === 688
    && cornerPanel.heightMode === 'manual'
    && !panelUsesAutoHeight(cornerPanel, panelBounds))
const bottomPanel = resizePanelLayout({ ...floatingPanel, x: 400, y: 200, width: 388, height: 500 }, 'bottom', 0, 1200, panelBounds)
check('floating bottom resize preserves its top edge at the shell limit',
  bottomPanel.y === 200 && bottomPanel.height === 688
    && bottomPanel.heightMode === 'manual')
const redockedPanel = dockPanelLayout({ ...floatingPanel, width: 472, x: 120, y: 100, heightMode: 'manual' }, panelBounds)
check('dock toggle preserves width while restoring shell alignment and content-fit height',
  redockedPanel.x === 950 && redockedPanel.width === 472 && redockedPanel.heightMode === 'auto')
const compactBounds = { width: 900, height: 700, anchorRight: 900 }
const compactPanel = resolvePanelGeometry(floatingPanel, compactBounds)
check('compact shell disables free geometry and uses a balanced inset',
  compactPanelForBounds(compactBounds)
    && compactPanel.x === 12 && compactPanel.y === 12
    && compactPanel.width === 876 && compactPanel.height === 676
    && panelUsesAutoHeight({ ...compactPanel, heightMode: 'manual' }, compactBounds)
    && panelMaximumHeight(compactPanel, compactBounds) === 676)
check('persisted panel state rejects corrupt or partial values',
  parsePanelLayout('{"mode":"floating","x":1}').mode === 'docked'
    && parsePanelLayout('not-json').mode === 'docked')
const migratedPanel = parsePanelLayout('{"mode":"floating","x":120,"y":80,"width":420,"height":600}')
const manualPanel = parsePanelLayout('{"mode":"floating","x":120,"y":80,"width":420,"height":600,"heightMode":"manual"}')
const legacyDockedManualPanel = parsePanelLayout('{"mode":"docked","x":120,"y":80,"width":420,"height":600,"heightMode":"manual"}')
check('persisted panel height migrates to auto but preserves explicit manual sizing',
  migratedPanel.heightMode === 'auto'
    && panelUsesAutoHeight(migratedPanel, panelBounds)
    && manualPanel.heightMode === 'manual'
    && !panelUsesAutoHeight(manualPanel, panelBounds)
    && legacyDockedManualPanel.heightMode === 'auto')
check(
  'expanded activity panel belongs only to its current session',
  activityPanelExpandedForSession(true, 'session-a', 'session-a')
    && !activityPanelExpandedForSession(true, 'session-a', 'session-b')
    && !activityPanelExpandedForSession(true, 'session-a', undefined),
)
check(
  'restored live activity stays collapsed when a conversation is reopened',
  !activityPanelShouldAutoExpand({
    alreadyAutoOpened: false,
    pageSettled: true,
    restoreComplete: true,
    previousLiveTeamIds: new Set(['restored-team']),
    currentLiveTeamIds: ['restored-team'],
  }),
)
check(
  'archived-only conversation restore never auto-expands the activity panel',
  !activityPanelShouldAutoExpand({
    alreadyAutoOpened: false,
    pageSettled: true,
    restoreComplete: true,
    previousLiveTeamIds: new Set(),
    currentLiveTeamIds: [],
  }),
)
check(
  'a new live team appearing after restore still auto-expands once',
  activityPanelShouldAutoExpand({
    alreadyAutoOpened: false,
    pageSettled: true,
    restoreComplete: true,
    previousLiveTeamIds: new Set(),
    currentLiveTeamIds: ['new-team'],
  }) && !activityPanelShouldAutoExpand({
    alreadyAutoOpened: true,
    pageSettled: true,
    restoreComplete: true,
    previousLiveTeamIds: new Set(),
    currentLiveTeamIds: ['new-team'],
  }),
)
let monitorNotifications = 0
const unsubscribeMonitor = subscribeActivityMonitorTargets(() => { monitorNotifications += 1 })
const releaseMonitorOne = monitorAgentTeam('verify-session', 'verify-team')
const releaseMonitorTwo = monitorAgentTeam('verify-session', 'verify-team')
const registeredMonitor = getActivityMonitorTargetsSnapshot()[0]
check(
  'activity monitor coalesces duplicate cards into one shared target',
  getActivityMonitorTargetsSnapshot().length === 1
    && registeredMonitor?.sessionId === 'verify-session'
    && registeredMonitor.teamId === 'verify-team',
)
releaseMonitorOne()
check('one card cleanup keeps another card monitoring', getActivityMonitorTargetsSnapshot().length === 1)
if (registeredMonitor !== undefined) settleActivityMonitorTargets(new Set([registeredMonitor.key]))
check('archived targets retire from polling', getActivityMonitorTargetsSnapshot().length === 0)
releaseMonitorTwo()
unsubscribeMonitor()
check('activity monitor publishes lifecycle changes without duplicate-card churn', monitorNotifications === 2)

let dormantFetches = 0
let dormantSchedules = 0
const dormantPoller = startActivityPolling([], {
  fetchState: async () => {
    dormantFetches += 1
    return { ok: true, json: async () => ({ teams: [] }) }
  },
  schedule: () => {
    dormantSchedules += 1
    return 0
  },
})
await dormantPoller.firstTick
dormantPoller.stop()
check(
  'no monitor targets create no request and no timer',
  dormantFetches === 0 && dormantSchedules === 0,
)

const discoveryUrls = []
const discoveryIntervals = []
let scheduledDiscoveryTick
const discoveryPoller = startActivityPolling([], {
  discoverySessionId: 'cold-captain',
  fetchState: async (url) => {
    discoveryUrls.push(url)
    return { ok: true, json: async () => ({ teams: [] }) }
  },
  schedule: (callback, intervalMs) => {
    scheduledDiscoveryTick = callback
    discoveryIntervals.push(intervalMs)
    return 'discovery-timer'
  },
  cancel: () => {},
  publishSnapshots: () => {},
})
await discoveryPoller.firstTick
scheduledDiscoveryTick?.()
await new Promise((resolve) => setImmediate(resolve))
discoveryPoller.stop()
check(
  'a cardless cold session restores live and archive once, then probes at the discovery cadence',
  discoveryUrls.length === 3
    && discoveryUrls[0] === '/plugins/dsh-agent-teams/state'
    && discoveryUrls[1]?.endsWith('?archived=1')
    && discoveryUrls[2] === '/plugins/dsh-agent-teams/state'
    && discoveryIntervals.length === 1
    && discoveryIntervals[0] === ACTIVITY_PROBE_MS,
)

// Regression (GitHub #57): a team created AFTER the cold-start discovery pass
// (e.g. a run_code-wrapped agent_teams_create) must be discovered without a
// manual reload. The controller keeps probing while its discovery session owns
// no team yet, so a later team is published — and once found, the probe
// upgrades to the live cadence so the panel stays fresh.
const latePublished = []
const lateUrls = []
const lateIntervals = []
let lateLiveTeams = []
let lateTick = () => {}
const latePoller = startActivityPolling([], {
  discoverySessionId: 'cold-captain',
  fetchState: async (url) => {
    lateUrls.push(url)
    if (url === '/plugins/dsh-agent-teams/state') {
      return { ok: true, json: async () => ({ teams: lateLiveTeams }) }
    }
    return { ok: true, json: async () => ({ teams: [] }) }
  },
  schedule: (callback, intervalMs) => {
    lateTick = callback
    lateIntervals.push(intervalMs)
    return 'late-timer'
  },
  cancel: () => {},
  publishSnapshots: (update) => { latePublished.push(update) },
})
await latePoller.firstTick
lateTick()
await new Promise((resolve) => setImmediate(resolve))
check(
  'a cardless session keeps probing at the discovery cadence after an empty first pass',
  lateUrls.length === 3
    && lateIntervals.length === 1
    && lateIntervals[0] === ACTIVITY_PROBE_MS,
)
lateLiveTeams = [{
  workspace: '',
  teamId: 'post-discovery-team',
  name: 'Post Discovery Team',
  captainSessionId: 'cold-captain',
  members: [],
  tasks: [],
  messageCount: 0,
  captainInbox: [],
}]
lateTick()
await new Promise((resolve) => setImmediate(resolve))
latePoller.stop()
check(
  'a team created after the discovery pass is picked up without a reload and upgrades to the live cadence',
  lateUrls.length === 4
    && latePublished.some((update) => update.teams?.some((team) => team.teamId === 'post-discovery-team'))
    && lateIntervals.length === 2
    && lateIntervals[1] === ACTIVITY_POLL_MS,
)

// Explicit card targets are demanded work: they start at the live cadence and
// are never downgraded to the low-frequency probe.
const cardIntervals = []
const cardPoller = startActivityPolling([{
  key: 'card-target',
  sessionId: 'card-session',
  teamId: 'card-team',
}], {
  fetchState: async () => ({ ok: true, json: async () => ({ teams: [] }) }),
  schedule: (_callback, intervalMs) => {
    cardIntervals.push(intervalMs)
    return 'card-timer'
  },
  cancel: () => {},
  publishSnapshots: () => {},
})
await cardPoller.firstTick
cardPoller.stop()
check(
  'explicit card targets poll at the live cadence from the start',
  cardIntervals.length === 1 && cardIntervals[0] === ACTIVITY_POLL_MS,
)

const pollTarget = { key: 'poll-target', sessionId: 'poll-session', teamId: 'poll-team' }
let resolveSlowLive
const slowLive = new Promise((resolve) => { resolveSlowLive = resolve })
const slowFetchSignals = []
let slowFetchCount = 0
let scheduledTick
let cancelledTimer = false
let latePublications = 0
const slowPoller = startActivityPolling([pollTarget], {
  fetchState: async (_url, init) => {
    slowFetchCount += 1
    slowFetchSignals.push(init.signal)
    return slowLive
  },
  schedule: (callback) => {
    scheduledTick = callback
    return 'slow-timer'
  },
  cancel: (timer) => { cancelledTimer = timer === 'slow-timer' },
  publishSnapshots: () => { latePublications += 1 },
})
scheduledTick?.()
scheduledTick?.()
await Promise.resolve()
check('a slow state request never overlaps the next interval', slowFetchCount === 1)
slowPoller.stop()
check(
  'stopping activity polling clears its timer and aborts the in-flight request',
  cancelledTimer && slowFetchSignals[0]?.aborted === true,
)
resolveSlowLive?.({ ok: true, json: async () => ({ teams: [] }) })
await slowPoller.firstTick
check('a late response after stop cannot publish snapshots', latePublications === 0)

const fallbackUrls = []
const settledFallbackKeys = []
let fallbackResponseIndex = 0
const fallbackResponses = [
  { ok: true, json: async () => ({ teams: [] }) },
  { ok: true, json: async () => ({ teams: [] }) },
]
const fallbackPoller = startActivityPolling([pollTarget], {
  fetchState: async (url) => {
    fallbackUrls.push(url)
    return fallbackResponses[fallbackResponseIndex++]
  },
  schedule: () => 'fallback-timer',
  cancel: () => {},
  publishSnapshots: () => {},
  settleTargets: (keys) => { settledFallbackKeys.push(...keys) },
})
await fallbackPoller.firstTick
fallbackPoller.stop()
check(
  'a live miss checks archive once and retires even an orphaned legacy card',
  fallbackUrls.length === 2
    && fallbackUrls[1]?.endsWith('?archived=1')
    && settledFallbackKeys.length === 1
    && settledFallbackKeys[0] === pollTarget.key,
)
const navigationCalls = []
const addressedNavigation = await openAgentTeamMember({
  open: (id) => { navigationCalls.push(['open', id]) },
  refreshSubagents: async (id) => { navigationCalls.push(['refresh', id]) },
  subagentAddress: () => undefined,
  openSubagent: (address) => { navigationCalls.push(['openSubagent', address]) },
}, 'captain-session', 'member-session')
check(
  'rc.8 member navigation refreshes the parent catalog and opens an addressed continuable child',
  addressedNavigation === 'subagent'
    && navigationCalls[0]?.[0] === 'refresh'
    && navigationCalls[1]?.[0] === 'openSubagent'
    && navigationCalls[1]?.[1]?.parentSessionId === 'captain-session'
    && navigationCalls[1]?.[1]?.childSessionId === 'member-session'
    && navigationCalls[1]?.[1]?.mode === 'continuable',
)
const legacyNavigationCalls = []
const legacyNavigation = await openAgentTeamMember({
  open: (id) => { legacyNavigationCalls.push(id) },
}, 'captain-session', 'member-session')
check(
  'pre-rc.8 member navigation keeps the ordinary session fallback',
  legacyNavigation === 'session' && legacyNavigationCalls[0] === 'member-session',
)
const panelNavigationCalls = []
await openAgentTeamMember({
  open() { throw new Error('expected addressed navigation') },
  refreshSubagents: async () => {},
  openSubagent: () => panelNavigationCalls.push('member'),
}, 'captain-session', 'member-session', {
  beginNavigation: () => new AbortController().signal,
  selectPanel: id => panelNavigationCalls.push(id),
})
check('0.1.5 member navigation selects the Conversation after opening its transcript',
  JSON.stringify(panelNavigationCalls) === JSON.stringify(['member', null]))
const supersededNavigation = new AbortController()
const cancelledNavigation = await openAgentTeamMember({
  open() { throw new Error('cancelled navigation must not open a Session') },
  refreshSubagents: async () => { supersededNavigation.abort() },
  openSubagent() { throw new Error('cancelled refresh must not steal the current Session') },
}, 'captain-session', 'member-session', {
  beginNavigation: () => supersededNavigation.signal,
  selectPanel() { throw new Error('cancelled navigation must not change main panel') },
})
check('0.1.5 superseded catalog refresh cannot steal navigation', cancelledNavigation === 'cancelled')
check(
  'agent team cards derive a stable id from the standard create tool call',
  JSON.stringify(parseAgentTeamsCreateArgs('{"name":" Repo Review 2W! "}'))
    === JSON.stringify({ teamId: 'repo-review-2w', name: 'Repo Review 2W!' }),
)
check('malformed create tool arguments do not create a card', parseAgentTeamsCreateArgs('{bad') === undefined)

const captainDeliveries = []
const captainSteered = steerCaptainReport(
  { steer: message => captainDeliveries.push(message) },
  'alice',
  'finished t1',
)
check(
  'member report delivery calls the live captain steer API',
  captainSteered
    && captainDeliveries.length === 1
    && captainDeliveries[0]?.content[0]?.type === 'text'
    && captainDeliveries[0]?.content[0]?.text === 'AgentTeams message from member alice:\n\nfinished t1',
)
check(
  'failed live captain delivery falls back to the durable mailbox',
  steerCaptainReport({ steer: () => { throw new Error('offline') } }, 'alice', 'finished t1') === false,
)

console.log('6c/8 plan progress and the task checklist (WP8)')
const progressPlan = [
  { id: 't1', status: 'completed', kind: 'work', dependencies: [] },
  { id: 't2', status: 'completed', kind: 'implementation', dependencies: [] },
  { id: 't3', status: 'in_progress', kind: 'implementation', dependencies: [] },
  { id: 't4', status: 'failed', kind: 'review', dependencies: [], reviewedTaskId: 't3' },
  { id: 't5', status: 'superseded', kind: 'work', dependencies: [] },
  { id: 't6', status: 'cancelled', kind: 'work', dependencies: [] },
  { id: 't7', status: 'completed', kind: 'repair', dependencies: [], sourceTaskId: 't1', hasWaivers: true },
  { id: 't8', status: 'pending', kind: 'verification', dependencies: ['t3'] },
]
{
  const defaults = resolveProgressWeights(undefined)
  check(
    'progress weights default to the kind table',
    defaults.mode === 'byKind'
      && defaults.byKind.implementation === 3
      && defaults.byKind.repair === 2
      && defaults.byKind.work === 1
      && defaults.byKind.review === 1
      && PROGRESS_KIND_WEIGHTS.verification === 1,
  )
  check(
    'a profile may ask for the equal mode',
    resolveProgressWeights('equal').mode === 'equal'
      && resolveProgressWeights('equal').byKind.implementation === 3,
  )
  check(
    'a per-kind weight table overrides single kinds only',
    resolveProgressWeights({ review: 5 }).mode === 'byKind'
      && resolveProgressWeights({ review: 5 }).byKind.review === 5
      && resolveProgressWeights({ review: 5 }).byKind.implementation === 3,
  )
  const rejectedWeights = []
  for (const bad of ['fast', { review: 0 }, { review: -2 }, { review: 'high' }, 7]) {
    try {
      resolveProgressWeights(bad)
      rejectedWeights.push(`accepted ${JSON.stringify(bad)}`)
    } catch (error) {
      if (!/taskPlanning\.weights/.test(String(error))) rejectedWeights.push(`unnamed ${JSON.stringify(bad)}`)
    }
  }
  check('an invalid weight table is rejected with the key that owns it', rejectedWeights.length === 0)

  check(
    'an empty plan is zero percent with no phases',
    (() => {
      const empty = planProgress([])
      return empty.percent === 0 && empty.percentByKind === 0 && empty.percentEqual === 0
        && empty.total === 0 && empty.completed === 0 && empty.byPhase.length === 0
    })(),
  )
  check(
    'cancelled and superseded work leaves the denominator',
    (() => {
      const dead = planProgress([
        { id: 't1', status: 'cancelled', kind: 'implementation', dependencies: [] },
        { id: 't2', status: 'cancelled', kind: 'work', dependencies: [] },
        { id: 't3', status: 'superseded', kind: 'implementation', dependencies: [] },
      ])
      return dead.percentByKind === 0 && dead.percentEqual === 0
        && dead.total === 3 && dead.cancelled === 2 && dead.superseded === 1
        && dead.completed === 0
    })(),
  )
  const progressPlan = [
    { id: 't1', status: 'completed', kind: 'work', dependencies: [] },
    { id: 't2', status: 'completed', kind: 'implementation', dependencies: [] },
    { id: 't3', status: 'in_progress', kind: 'implementation', dependencies: [] },
    { id: 't4', status: 'failed', kind: 'review', dependencies: [] },
    { id: 't5', status: 'superseded', kind: 'work', dependencies: [] },
    { id: 't6', status: 'cancelled', kind: 'work', dependencies: [] },
    { id: 't7', status: 'completed', kind: 'repair', dependencies: [], hasWaivers: true },
    { id: 't8', status: 'pending', kind: 'verification', dependencies: ['t3'] },
  ]
  const mixed = planProgress(progressPlan)
  check(
    'byKind and equal weigh the same plan differently',
    mixed.percentByKind === 55 && mixed.percentEqual === 50 && mixed.percent === 55 && mixed.mode === 'byKind',
  )
  check(
    'progress counts every bucket the panel legend needs',
    mixed.total === 8 && mixed.completed === 3 && mixed.running === 1 && mixed.blocked === 1
      && mixed.failed === 1 && mixed.superseded === 1 && mixed.cancelled === 1 && mixed.waived === 1,
  )
  check(
    'per-phase rows follow the DAG levels',
    mixed.byPhase.length === 2
      && mixed.byPhase[0]?.phaseId === 'level-0'
      && mixed.byPhase[0]?.completed === 3
      && mixed.byPhase[0]?.total === 7
      && mixed.byPhase[0]?.percentByKind === 60
      && mixed.byPhase[0]?.percentEqual === 60
      && mixed.byPhase[1]?.phaseId === 'level-1'
      && mixed.byPhase[1]?.total === 1
      && mixed.byPhase[1]?.percentByKind === 0,
  )
  check(
    'declared phases win over the DAG levels',
    (() => {
      const declared = planProgress(progressPlan, {
        phases: [{ id: 'E1', title: 'Recon', taskIds: ['t1', 't2'] }],
      })
      return declared.byPhase.length === 2
        && declared.byPhase[0]?.phaseId === 'E1'
        && declared.byPhase[0]?.title === 'Recon'
        && declared.byPhase[0]?.percentByKind === 100
        && declared.byPhase[0]?.percentEqual === 100
        && declared.byPhase[1]?.phaseId === 'unphased'
        && declared.byPhase[1]?.total === 6
    })(),
  )
  check(
    'the equal mode is a request, not a rewrite of the table',
    planProgress(progressPlan, { weights: 'equal' }).percentEqual === 50
      && planProgress(progressPlan, { weights: 'equal' }).percent === 50
      && planProgress(progressPlan, { weights: 'equal' }).mode === 'equal',
  )
  // Round 3 (owner request): one bar, three colours — the original plan, what the
  // captain added while it ran, and what arrived after the plan had settled. The
  // attribution is recorded on the task at creation, so it cannot shuffle later.
  check(
    'progress splits the plan into the three stretches of its life',
    (() => {
      const segments = planProgress([
        { id: 't1', status: 'completed', kind: 'work', dependencies: [], origin: 'plan' },
        { id: 't2', status: 'pending', kind: 'work', dependencies: [], origin: 'plan' },
        { id: 't3', status: 'completed', kind: 'work', dependencies: [], origin: 'added' },
        { id: 't4', status: 'completed', kind: 'work', dependencies: [], origin: 'followup' },
        // A task with no origin is plan work: state written before round 3 keeps working.
        { id: 't5', status: 'pending', kind: 'work', dependencies: [] },
      ]).segments
      return segments.length === 3
        && segments.map(segment => segment.origin).join(',') === 'plan,added,followup'
        && segments[0]?.completed === 1 && segments[0]?.total === 3
        && segments[1]?.completed === 1 && segments[1]?.total === 1
        && segments[2]?.completed === 1 && segments[2]?.total === 1
        && segments[2]?.percent === 100
    })(),
  )
  check(
    'a task added before the plan settles is "added", after it settles "followup"',
    originForNewTask({ tasks: [{ origin: 'plan', status: 'pending' }] }) === 'added'
      && originForNewTask({ tasks: [{ origin: 'plan', status: 'completed' }] }) === 'followup'
      && originForNewTask({ tasks: [{ status: 'completed' }] }) === 'followup'
      && originForNewTask({ tasks: [{ origin: 'added', status: 'pending' }] }) === 'added'
      && originForNewTask({ tasks: [] }) === 'added',
  )
  check(
    'the panel draws three coloured zones and names them',
    activityPanelSource.includes('data-progress-segments')
      && activityPanelSource.includes('data-origin={segment.origin}')
      && activityPanelSource.includes('t(`progress.segment.${segment.origin}`)')
      && activityPanelSource.includes('data-progress-segment-legend')
      && activityPanelCss.includes(".progressSegment[data-origin='added']")
      && activityPanelCss.includes(".progressSegment[data-origin='followup']")
      && activityPanelCss.includes('.progressSegmentLegend')
      && ['progress.segment.plan', 'progress.segment.added', 'progress.segment.followup', 'progress.segment.title']
        .every((key) => localesSource.includes(`'${key}'`)),
  )
  check(
    'a repaired failure leaves the denominator and its repair carries the weight',
    (() => {
      const repaired = planProgress([
        { id: 't1', status: 'completed', kind: 'implementation', dependencies: [] },
        { id: 't2', status: 'failed', kind: 'review', dependencies: ['t1'], reviewedTaskId: 't1' },
        { id: 't3', status: 'completed', kind: 'repair', dependencies: ['t1'], sourceTaskId: 't1' },
      ])
      return repaired.percentByKind === 100 && repaired.percentEqual === 100
        && repaired.failed === 0 && repaired.repaired === 1 && repaired.completed === 2
    })(),
  )
  check(
    'an unrepaired failure still holds the plan back',
    (() => {
      const red = planProgress([
        { id: 't1', status: 'completed', kind: 'implementation', dependencies: [] },
        { id: 't2', status: 'failed', kind: 'review', dependencies: ['t1'], reviewedTaskId: 't1' },
      ])
      return red.percentByKind === 75 && red.percentEqual === 50 && red.failed === 1 && red.repaired === 0
    })(),
  )
  check(
    'a profile resolves its weights into the frozen team snapshot',
    resolveTeamProfile({
      weighted: {
        members: [{ name: 'a', role: 'engineer' }],
        taskPlanning: { mode: 'captain', weights: { implementation: 4 } },
      },
    }, 'weighted', 4).progressWeights?.implementation === 4
      && resolveTeamProfile({
        even: { members: [{ name: 'a', role: 'engineer' }], taskPlanning: { weights: 'equal' } },
      }, 'even', 4).progressWeights === 'equal'
      && resolveTeamProfile({
        plain: { members: [{ name: 'a', role: 'engineer' }], taskPlanning: 'captain' },
      }, 'plain', 4).progressWeights === undefined,
  )
  const badWeightValues = ['fast', { review: -1 }, { review: 'high' }, {}]
  check(
    'a bad weight table fails create with the key that owns it',
    badWeightValues.every((weights) => {
      try {
        resolveTeamProfile({ bad: { members: [{ name: 'a', role: 'engineer' }], taskPlanning: { weights } } }, 'bad', 4)
        return false
      } catch (error) {
        return /taskPlanning\.weights/.test(String(error))
      }
    }),
  )
}

{
  const progressRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-progress-'))
  try {
    const progressTeam = {
      name: 'Progress Team',
      id: 'progress-team',
      description: 'wp8',
      captainSessionId: 'sess-progress',
      createdAt: Date.now(),
      members: [],
      tasks: progressPlan.map((task, index) => ({
        ...task,
        subject: `lane ${index + 1}`,
        createdAt: index,
        updatedAt: index,
      })),
      taskSeq: progressPlan.length,
      profile: { name: 'progress-profile', progressWeights: 'equal' },
    }
    await createTeamDir(progressRoot, progressTeam)
    const progressSnapshot = await assembleTeamSnapshot(
      { logger: { warn() {} } },
      progressRoot,
      'verify-workspace',
      progressTeam,
      { historic: true },
    )
    check(
      'the snapshot carries both numbers and the profile default',
      progressSnapshot.progress.percentByKind === 55
        && progressSnapshot.progress.percentEqual === 50
        && progressSnapshot.progress.percent === 50
        && progressSnapshot.progress.mode === 'equal'
        && progressSnapshot.progress.byPhase.length === 2,
    )
    const byKindSnapshot = await assembleTeamSnapshot(
      { logger: { warn() {} } },
      progressRoot,
      'verify-workspace',
      { ...progressTeam, profile: undefined },
      { historic: true },
    )
    check(
      'a team without weights keeps the kind table',
      byKindSnapshot.progress.mode === 'byKind'
        && byKindSnapshot.progress.percentByKind === 55
        && byKindSnapshot.progress.percent === 55,
    )
    const phasedSnapshot = await assembleTeamSnapshot(
      { logger: { warn() {} } },
      progressRoot,
      'verify-workspace',
      {
        ...progressTeam,
        profile: undefined,
        plan: {
          revision: 7,
          updatedAt: 5,
          goal: 'phased plan',
          phases: [{ id: 'E0', title: 'Recon', taskIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'] }],
        },
      },
      { historic: true },
    )
    check(
      'the snapshot carries the plan revision and its declared phases',
      phasedSnapshot.plan?.revision === 7
        && phasedSnapshot.plan?.goal === 'phased plan'
        && phasedSnapshot.plan?.phases.map(phase => phase.id).join(',') === 'E0'
        && phasedSnapshot.progress.byPhase[0]?.phaseId === 'E0'
        && phasedSnapshot.progress.byPhase[0]?.title === 'Recon'
        && phasedSnapshot.progress.byPhase[1]?.phaseId === 'unphased',
    )
  } finally {
    await rm(progressRoot, { recursive: true, force: true })
  }
}

{
  const snapshotTeam = {
    teamId: 'progress-team',
    name: 'Progress Team',
    phase: 'running',
    captainSessionId: 'sess-progress',
    members: [],
    tasks: progressPlan,
    messageCount: 0,
    captainInbox: [],
    progress: {
      mode: 'byKind',
      percent: 55,
      percentByKind: 55,
      percentEqual: 50,
      completed: 3,
      total: 8,
      running: 1,
      blocked: 1,
      failed: 1,
      waived: 1,
      superseded: 1,
      cancelled: 1,
      byPhase: [
        { phaseId: 'level-0', completed: 3, total: 7, percentByKind: 60, percentEqual: 60 },
        { phaseId: 'level-1', completed: 0, total: 1, percentByKind: 0, percentEqual: 0 },
      ],
    },
  }
  const view = planProgressView(snapshotTeam, 'equal')
  check(
    'the panel selector switches the snapshot number, not the math',
    view.mode === 'equal' && view.percent === 50 && view.percentByKind === 55 && view.percentEqual === 50
      && view.completed === 3 && view.total === 8
      // Owner decision (2026-09-20, round 2): the row-per-phase block read as a
      // wall of bars, so the view carries no per-phase roll-up any more. The
      // snapshot keeps publishing `byPhase`; no panel row renders it.
      && !('phases' in view),
  )
  const fallback = planProgressView({ ...snapshotTeam, progress: undefined }, 'byKind')
  check(
    'a card without a snapshot payload falls back to the equal count it can compute',
    fallback.percent === 50 && fallback.mode === 'equal' && !('phases' in fallback),
  )
  check(
    'a stored progress-mode preference is parsed and an unknown one is ignored',
    parseProgressMode('equal') === 'equal' && parseProgressMode('byKind') === 'byKind'
      && parseProgressMode('weighted') === null && parseProgressMode(null) === null,
  )
  check(
    'both locales carry the percent, mode and checklist keys, and no per-phase key',
    ['progress.percent', 'progress.mode.byKind', 'progress.mode.equal',
      'checklist.title', 'checklist.collapse', 'checklist.expand', 'checklist.empty', 'checklist.waivers',
      'checklist.supersededBy'].every((key) => localesSource.includes(`'${key}'`))
      && !localesSource.includes("'progress.phase'"),
  )
  check(
    'the panel renders the percent bar and the checklist, without a row per phase',
    activityPanelSource.includes('function TaskChecklist')
      && activityPanelSource.includes('data-task-checklist')
      && activityPanelSource.includes('data-checklist-row')
      && activityPanelSource.includes('taskCheckGlyph')
      && activityPanelSource.includes('progressPercent')
      && activityPanelSource.includes('data-progress-bar')
      && activityModelSource.includes('export function planProgress')
      && activityModelSource.includes('PROGRESS_MODE_STORAGE_KEY')
      && activityPanelCss.includes('.checklistRow')
      && activityPanelCss.includes('.progressBar')
      && !activityPanelSource.includes('css.progressPhaseRow')
      && !activityPanelSource.includes('data-progress-phases')
      && !activityPanelCss.includes('.progressPhaseRow')
      && !activityPanelCss.includes('.progressPhases'),
  )
  check(
    'the conversation card carries a mini percent bar',
    agentTeamsCardSource.includes('data-card-progress')
      && agentTeamsCardSource.includes('planProgress')
      && agentTeamsCardCss.includes('.cardProgress'),
  )
}

console.log('6d/8 replan a live team (WP7/S17)')
{
  const replanFixture = () => ({
    name: 'Replan Team',
    id: 'replan-team',
    description: 'wp7',
    captainSessionId: 'sess-captain',
    createdAt: 1,
    members: [
      { id: 'sess-worker', name: 'worker', role: 'implementer', joinedAt: 1, status: 'idle', provider: 'p', model: 'm' },
      { id: 'sess-reviewer', name: 'reviewer', role: 'reviewer', joinedAt: 1, status: 'idle', provider: 'p', model: 'm' },
    ],
    tasks: [
      { id: 't1', subject: 'first lane', status: 'completed', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1 },
      { id: 't2', subject: 'second lane', status: 'pending', dependencies: ['t1'], attempt: 0, kind: 'work', assignee: 'worker', createdAt: 2, updatedAt: 2 },
    ],
    taskSeq: 2,
    plan: { revision: 3, updatedAt: 1 },
  })
  const failureOf = (fn) => {
    try {
      fn()
      return ''
    } catch (error) {
      return String(error instanceof Error ? error.message : error)
    }
  }
  /** Run something that is expected to succeed, and keep its error as a value. */
  const attempt = (fn) => {
    try {
      return { value: fn() }
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) }
    }
  }

  check(
    'an empty replan batch is refused',
    /at least one replan operation/.test(failureOf(() => replanTeam(replanFixture(), [], { reason: 'nothing' }))),
  )

  const added = replanTeam(replanFixture(), [{
    action: 'add_task',
    subject: 'third lane',
    assignee: 'worker',
    kind: 'implementation',
    objective: 'Ship the third lane',
    inScope: ['src/third.ts'],
    acceptance: ['the third lane works'],
    verify: ['node scripts/verify.mjs'],
  }], { reason: 'the review asked for a third lane' })
  check(
    'replan adds a contracted task and bumps the plan revision',
    added.team.tasks.length === 3
      && added.team.tasks[2]?.id === 't3'
      && added.team.tasks[2]?.kind === 'implementation'
      && added.team.tasks[2]?.status === 'pending'
      && added.result.added.join(',') === 't3'
      && added.result.revision === 4
      && added.team.plan?.revision === 4
      && added.result.changes[0]?.action === 'add_task'
      && added.result.changes[0]?.taskId === 't3',
  )
  check(
    'a new replan task still passes the quality contract',
    /objective/.test(failureOf(() => replanTeam(replanFixture(), [{
      action: 'add_task',
      subject: 'implementation without a contract',
      kind: 'implementation',
      acceptance: ['done'],
      inScope: ['src/a.ts'],
      verify: ['pnpm test'],
    }], { reason: 'bad lane' }))),
  )

  // Round 3 (owner request): a phase closes only after the captain accepted its
  // tasks, and a closed phase then takes no new work. A phase is the captain's own
  // bookkeeping, so the transfer is one more operation of the replan batch.
  {
    const phased = () => ({
      ...replanFixture(),
      tasks: [
        { id: 't1', subject: 'recon', status: 'completed', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1 },
        { id: 't2', subject: 'build', status: 'pending', dependencies: ['t1'], attempt: 0, kind: 'work', assignee: 'worker', createdAt: 2, updatedAt: 2 },
      ],
      plan: {
        revision: 3,
        updatedAt: 1,
        phases: [{ id: 'E0', title: 'Recon', taskIds: ['t1'] }, { id: 'E1', title: 'Build', taskIds: ['t2'] }],
      },
    })
    const closed = replanTeam(phased(), [{ action: 'close_phase', phase_id: 'E0' }], { reason: 'recon accepted', now: 500 })
    check(
      'a phase closes once every task in it is settled',
      closed.team.plan?.phases?.[0]?.closed === true
        && closed.team.plan?.phases?.[0]?.closedAt === 500
        && closed.team.plan?.phases?.[1]?.closed === undefined
        && closed.result.changes[0]?.action === 'close_phase'
        && closed.result.changes[0]?.taskId === undefined
        && closed.result.revision === 4,
    )
    check(
      'closing a phase with open work is refused and names the tasks',
      /phase "E1" still has 1 open task\(s\): t2 \(pending\)/.test(
        failureOf(() => replanTeam(phased(), [{ action: 'close_phase', phase_id: 'E1' }], { reason: 'too early' })),
      ),
    )
    check(
      'closing an unknown or already closed phase is refused',
      /unknown phase "E9"/.test(failureOf(() => replanTeam(phased(), [{ action: 'close_phase', phase_id: 'E9' }], { reason: 'typo' })))
        && /already closed/.test(failureOf(() => replanTeam(
          replanTeam(phased(), [{ action: 'close_phase', phase_id: 'E0' }], { reason: 'recon accepted' }).team,
          [{ action: 'close_phase', phase_id: 'E0' }],
          { reason: 'again' },
        ))),
    )
    const closedPhased = replanTeam(phased(), [{ action: 'close_phase', phase_id: 'E0' }], { reason: 'recon accepted', now: 500 }).team
    // Round 3: the task records the stretch it was born into, so the three progress
    // segments stay put even after the plan is repaired or reopened.
    check(
      'a replanned task records the stretch that created it',
      replanTeam(phased(), [{ action: 'add_task', subject: 'lane while running' }], { reason: 'more' })
        .team.tasks.at(-1)?.origin === 'added'
        && replanTeam({
          ...phased(),
          tasks: [{ id: 't1', subject: 'recon', status: 'completed', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1, origin: 'plan' }],
        }, [{ action: 'add_task', subject: 'lane after the plan' }], { reason: 'user asked' })
          .team.tasks.at(-1)?.origin === 'followup',
    )
    check(
      'a closed phase refuses new work and points at a new phase',
      /phase "E0" is closed and takes no new work/.test(failureOf(() => replanTeam(closedPhased, [{
        action: 'add_task',
        subject: 'late lane',
        phase_id: 'E0',
      }], { reason: 'more work' })))
        && /phase "E0" is closed/.test(failureOf(() => replanTeam(closedPhased, [{
          action: 'move_phase',
          task_id: 't2',
          phase_id: 'E0',
        }], { reason: 'move it back' })))
        // The way forward the refusal names: a brand-new phase is open.
        && replanTeam(closedPhased, [{
          action: 'move_phase',
          task_id: 't2',
          phase_id: 'E2',
          title: 'Follow-up',
        }], { reason: 'new phase' }).team.plan?.phases?.find((phase) => phase.id === 'E2')?.closed === undefined,
    )
    const snapshot = await assembleTeamSnapshot(
      { logger: { warn() {} } },
      '.agent-teams-verify-closed-phase',
      'verify-workspace',
      closedPhased,
      { historic: true },
    )
    check(
      'the snapshot publishes closed phases and their tasks',
      snapshot.plan?.phases?.[0]?.closed === true
        && snapshot.plan?.phases?.[0]?.closedAt === 500
        && snapshot.plan?.phases?.[1]?.closed === undefined
        && snapshot.plan?.phases?.[0]?.taskIds.join(',') === 't1',
      JSON.stringify(snapshot.plan?.phases),
    )
    check(
      'the panel marks a closed column and never targets it in the plan editor',
      activityPanelSource.includes('data-closed={column.closed === true}')
        && activityPanelSource.includes("t('phase.closed')")
        && activityPanelSource.includes('disabled={phase.closed === true}')
        && activityPanelCss.includes(".phaseColumn[data-closed='true']")
        && activityPanelCss.includes('.phaseClosedMark')
        && activityModelSource.includes('readonly closed?: boolean')
        && localesSource.includes("'phase.closed'"),
    )
    // `agent_teams_create_task` is the other door work comes through, so it carries
    // the same refusal (source-level, the way the other tool contracts are checked).
    const createTaskBlock = toolsSource.slice(
      toolsSource.indexOf("name: 'agent_teams_create_task'"),
      toolsSource.indexOf("name: 'agent_teams_update_task'"),
    )
    check(
      'create_task refuses to place work in a closed phase',
      createTaskBlock.includes('if (phase.closed === true) {')
        && createTaskBlock.includes('is closed and takes no new work')
        && createTaskBlock.includes('declare a new phase instead'),
      `create_task block is ${String(createTaskBlock.length)} characters`,
    )
  }

  // Φ1 feedback F3 (dx9 run): `remove_member frame` answered
  // `requeued tasks: t89, t93, t102, …` where six of the eight had been **superseded**
  // long before — the pool then made them look claimable, an idle member claimed one
  // and put a second writer on a file a live lane was editing.
  {
    const memberTasks = () => ({
      ...replanFixture(),
      members: [{ id: 'sess-frame', name: 'frame', role: 'implementer', joinedAt: 1, status: 'idle', provider: 'p', model: 'm' }],
      tasks: [
        { id: 't1', subject: 'live pending', status: 'pending', dependencies: [], attempt: 0, kind: 'work', assignee: 'frame', createdAt: 1, updatedAt: 1 },
        { id: 't2', subject: 'live claimed', status: 'claimed', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', attemptId: 'a1', createdAt: 2, updatedAt: 2 },
        { id: 't3', subject: 'live in progress', status: 'in_progress', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', attemptId: 'a2', createdAt: 3, updatedAt: 3 },
        { id: 't4', subject: 'held for scope review', status: 'awaiting_scope_review', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', attemptId: 'a3', createdAt: 4, updatedAt: 4 },
        { id: 't5', subject: 'finished lane', status: 'completed', dependencies: [], attempt: 2, kind: 'work', assignee: 'frame', createdAt: 5, updatedAt: 5 },
        { id: 't6', subject: 'red lane', status: 'failed', dependencies: [], attempt: 2, kind: 'work', assignee: 'frame', createdAt: 6, updatedAt: 6 },
        { id: 't7', subject: 'cancelled lane', status: 'cancelled', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', createdAt: 7, updatedAt: 7 },
        { id: 't8', subject: 'superseded lane', status: 'superseded', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', supersededBy: 't9', createdAt: 8, updatedAt: 8 },
      ],
      taskSeq: 9,
    })
    const removalTeam = memberTasks()
    const requeued = requeueMemberTasks(removalTeam, 'frame')
    check(
      'a member removal requeues only the work that still needs an owner',
      requeued.join(',') === 't1,t2,t3,t4'
        && removalTeam.tasks[0]?.status === 'pending'
        && removalTeam.tasks[1]?.status === 'pending'
        && removalTeam.tasks[2]?.status === 'pending'
        && removalTeam.tasks[3]?.status === 'pending'
        // History keeps both its status and its record of the member who did the work.
        && removalTeam.tasks[4]?.status === 'completed'
        && removalTeam.tasks[5]?.status === 'failed'
        && removalTeam.tasks[6]?.status === 'cancelled'
        && removalTeam.tasks[7]?.status === 'superseded'
        && removalTeam.tasks[7]?.supersededBy === 't9',
      `requeued ${requeued.join(',')}`,
    )
    check(
      'a dead lane never becomes claimable work again',
      // The transition table is the claim gate: a superseded or cancelled task has no
      // legal path to `claimed`, so the pool listing it was the only way it could run.
      transitionError('superseded', 'claimed') !== undefined
        && transitionError('cancelled', 'claimed') !== undefined
        && transitionError('completed', 'claimed') !== undefined
        // And the ready-work filter only ever offers a `pending` task.
        && /task\.status === 'pending'/.test(schedulerSource),
    )
  }
  // Φ1 feedback F1 (dx9 run, 183 tasks): a member session that had to be replaced
  // (remove_member + add_member, the plugin's own route) left its name on the tasks it
  // had already completed, and the whole-plan validation then refused *every* replan
  // batch with `task "t5" assignee "frame" is not an active member`. The team lost
  // cancel_task, move_phase, close_phase and every multi-task repair for good, because
  // a terminal task cannot be reassigned and a removed name cannot be re-added.
  {
    const withRemovedOwner = () => ({
      ...replanFixture(),
      members: [{ id: 'sess-worker', name: 'worker', role: 'implementer', joinedAt: 1, status: 'idle', provider: 'p', model: 'm' }],
      tasks: [
        // History: a lane this removed member finished. It can never run again.
        { id: 't1', subject: 'lane of a replaced session', status: 'completed', dependencies: [], attempt: 2, kind: 'work', assignee: 'frame', createdAt: 1, updatedAt: 9 },
        { id: 't2', subject: 'live lane', status: 'pending', dependencies: ['t1'], attempt: 0, kind: 'work', assignee: 'worker', createdAt: 2, updatedAt: 2 },
        { id: 't3', subject: 'pooled stale lane', status: 'superseded', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', createdAt: 3, updatedAt: 9 },
        // A removal leaves a red lane untouched (Φ1/F3), so it keeps the replaced
        // name — the batch must still work, and only a retry has to name an owner.
        { id: 't9', subject: 'red lane of a replaced session', status: 'failed', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', createdAt: 9, updatedAt: 9 },
      ],
      taskSeq: 9,
    })
    const repaired = attempt(() => replanTeam(withRemovedOwner(), [
      { action: 'update_task', task_id: 't2', dependencies: [] },
    ], { reason: 'unblock the live lane' }))
    check(
      'a completed task keeps its replaced owner without blocking a replan batch',
      repaired.error === undefined
        && repaired.value?.team.tasks[0]?.assignee === 'frame'
        && repaired.value?.team.tasks[0]?.status === 'completed'
        && repaired.value?.team.tasks[1]?.dependencies.join(',') === ''
        // The red lane of the same replaced session is history too: it keeps its owner
        // and its status, and it does not stand in the way of the batch.
        && repaired.value?.team.tasks[3]?.assignee === 'frame'
        && repaired.value?.team.tasks[3]?.status === 'failed',
      repaired.error ?? `status=${String(repaired.value?.team.tasks[0]?.status)}`,
    )
    const cancelledOrphanLane = attempt(() => replanTeam(withRemovedOwner(), [{ action: 'cancel_task', task_id: 't2' }], { reason: 'cut it' }))
    check(
      'the batch tools a healthy team needs still work with a replaced owner on history',
      cancelledOrphanLane.error === undefined && cancelledOrphanLane.value?.team.tasks[1]?.status === 'cancelled',
      cancelledOrphanLane.error ?? '',
    )
    // The rule still bites where it must: a live lane has no owner.
    check(
      'a live lane whose owner is gone is still refused',
      /task "t4" assignee "frame" is not an active member/.test(failureOf(() => replanTeam({
        ...withRemovedOwner(),
        tasks: [
          ...withRemovedOwner().tasks,
          { id: 't4', subject: 'dispatchable but orphaned', status: 'pending', dependencies: [], attempt: 0, kind: 'work', assignee: 'frame', createdAt: 4, updatedAt: 4 },
        ],
        taskSeq: 4,
      }, [{ action: 'update_task', task_id: 't2', dependencies: [] }], { reason: 'x' }))),
    )
    // A failed lane can be retried, and a retry makes it dispatchable again — so the
    // retry has to name an owner instead of writing a task nobody can claim.
    const failedOrphan = () => ({
      ...withRemovedOwner(),
      tasks: [
        withRemovedOwner().tasks[0],
        { id: 't2', subject: 'red lane of a replaced session', status: 'failed', dependencies: [], attempt: 1, kind: 'work', assignee: 'frame', createdAt: 2, updatedAt: 5 },
      ],
    })
    const retriedOrphan = attempt(() => replanTeam(failedOrphan(), [
      { action: 'update_task', task_id: 't2', retry: true },
    ], { reason: 'repair and retry' }))
    const retriedWithOwner = attempt(() => replanTeam(failedOrphan(), [
      { action: 'update_task', task_id: 't2', retry: true, assignee: 'worker' },
    ], { reason: 'repair and retry' }))
    check(
      'retrying a lane whose owner was removed demands a new owner',
      retriedOrphan.error !== undefined
        && /has no active owner/.test(retriedOrphan.error)
        && retriedWithOwner.value?.team.tasks[1]?.status === 'pending'
        && retriedWithOwner.value?.team.tasks[1]?.assignee === 'worker',
      retriedOrphan.error ?? 'the retry was accepted without an owner',
    )
  }

  const beforeAtomicity = JSON.stringify(replanFixture())
  const atomicError = failureOf(() => replanTeam(replanFixture(), [
    { action: 'update_task', task_id: 't2', subject: 'edited subject that must not persist' },
    { action: 'update_task', task_id: 't2', dependencies: ['t404'] },
  ], { reason: 'half-valid batch' }))
  check(
    'one invalid operation leaves the whole batch unapplied',
    /t404/.test(atomicError) && JSON.stringify(replanFixture()) === beforeAtomicity,
  )

  const edited = replanTeam(replanFixture(), [
    { action: 'update_task', task_id: 't2', subject: 'second lane (retargeted)', dependencies: ['t1'] },
  ], { reason: 'sharpen the lane' })
  check(
    'replan edits a pending task without touching the rest',
    edited.team.tasks[1]?.subject === 'second lane (retargeted)'
      && edited.result.rebound.join(',') === 't2'
      && edited.team.tasks[0]?.subject === 'first lane'
      && edited.result.revision === 4,
  )
  check(
    'replan refuses a dependency cycle before writing',
    /cycle/.test(failureOf(() => replanTeam({
      ...replanFixture(),
      tasks: [
        { id: 't1', subject: 'first lane', status: 'completed', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1 },
        { id: 't2', subject: 'second lane', status: 'pending', dependencies: ['t1'], attempt: 0, kind: 'work', createdAt: 2, updatedAt: 2 },
        { id: 't3', subject: 'third lane', status: 'pending', dependencies: ['t2'], attempt: 0, kind: 'work', createdAt: 3, updatedAt: 3 },
      ],
      taskSeq: 3,
    }, [{ action: 'update_task', task_id: 't2', dependencies: ['t3'] }], { reason: 'build a cycle' }))),
  )

  const liveFixture = () => ({
    ...replanFixture(),
    members: [{ id: 'sess-worker', name: 'worker', role: 'implementer', joinedAt: 1, status: 'working' }],
    tasks: [
      { id: 't1', subject: 'first lane', status: 'completed', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1 },
      {
        id: 't2',
        subject: 'second lane',
        status: 'in_progress',
        dependencies: ['t1'],
        attempt: 1,
        attemptId: 'attempt-live',
        kind: 'work',
        assignee: 'worker',
        createdAt: 2,
        updatedAt: 2,
      },
    ],
  })
  check(
    'a live attempt refuses an edit without invalidate',
    /invalidate/.test(failureOf(() => replanTeam(liveFixture(), [
      { action: 'update_task', task_id: 't2', subject: 'silent retarget' },
    ], { reason: 'retarget a running lane' }))),
  )
  const invalidated = replanTeam(liveFixture(), [
    { action: 'update_task', task_id: 't2', subject: 'second lane (replanned)', invalidate: true },
  ], { reason: 'the lane was pointed at the wrong contract' })
  check(
    'replan invalidates a live attempt and frees its member',
    invalidated.team.tasks[1]?.status === 'pending'
      && invalidated.team.tasks[1]?.attemptId === undefined
      && invalidated.team.tasks[1]?.subject === 'second lane (replanned)'
      && invalidated.result.invalidated.join(',') === 't2'
      && invalidated.result.changes[0]?.invalidation?.memberName === 'worker'
      && invalidated.team.members[0]?.status === 'idle'
      && invalidated.team.members[0]?.id === 'sess-worker',
  )

  const failedFixture = () => ({
    ...replanFixture(),
    memberStatus: undefined,
    tasks: [
      { id: 't1', subject: 'first lane', status: 'completed', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1 },
      {
        id: 't2',
        subject: 'red lane',
        status: 'failed',
        dependencies: ['t1'],
        attempt: 1,
        kind: 'implementation',
        assignee: 'worker',
        objective: 'the original objective',
        inScope: ['src/red.ts'],
        acceptance: ['the original criterion'],
        verify: ['pnpm test'],
        output: 'lane is red',
        createdAt: 2,
        updatedAt: 2,
      },
      { id: 't3', subject: 'downstream lane', status: 'pending', dependencies: ['t2'], attempt: 0, kind: 'work', createdAt: 3, updatedAt: 3 },
    ],
    taskSeq: 3,
    members: [{ id: 'sess-worker', name: 'worker', role: 'implementer', joinedAt: 1, status: 'idle' }],
  })
  const superseded = replanTeam(failedFixture(), [{
    action: 'supersede_task',
    task_id: 't2',
    subject: 'red lane (replacement)',
    assignee: 'worker',
    kind: 'work',
  }], { reason: 'the lane is red and the contract was wrong' })
  check(
    'replan supersedes a red lane and redirects its dependents',
    superseded.team.tasks.find(task => task.id === 't2')?.status === 'superseded'
      && superseded.team.tasks.find(task => task.id === 't2')?.supersededBy === 't4'
      && superseded.team.tasks.find(task => task.id === 't3')?.dependencies.join(',') === 't4'
      && superseded.result.added.join(',') === 't4'
      && superseded.result.removed.join(',') === 't2'
      && superseded.result.rebound.join(',') === 't3',
  )
  const cancelled = replanTeam(replanFixture(), [
    { action: 'cancel_task', task_id: 't2', reason: 'the user dropped this lane' },
  ], { reason: 'drop a lane the user no longer wants' })
  check(
    'replan cancels a pending lane without deleting it',
    cancelled.team.tasks[1]?.status === 'cancelled'
      && cancelled.team.tasks.length === 2
      && cancelled.result.changes[0]?.action === 'cancel_task',
  )

  const scopeFixture = () => ({
    ...replanFixture(),
    tasks: [
      {
        id: 't1',
        subject: 'scope lane',
        status: 'awaiting_scope_review',
        dependencies: [],
        attempt: 1,
        attemptId: 'attempt-scope',
        kind: 'implementation',
        assignee: 'worker',
        objective: 'Ship the parser fix',
        inScope: ['src/parser.ts'],
        acceptance: ['the parser fix works'],
        verify: ['pnpm test'],
        changedPaths: ['src/parser-helper.ts'],
        acceptanceResults: [{ criterion: 'the parser fix works', status: 'passed' }],
        commandsRun: [{ command: 'pnpm test', status: 'passed' }],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    taskSeq: 1,
  })
  const accepted = replanTeam(scopeFixture(), [
    { action: 'accept_paths', task_id: 't1', paths: ['src/parser-helper.ts'] },
  ], { reason: 'the helper belongs to the lane' })
  check(
    'replan accepts the paths of a held lane in the same batch',
    accepted.team.tasks[0]?.inScope?.includes('src/parser-helper.ts') === true
      && accepted.result.changes[0]?.action === 'accept_paths',
  )
  check(
    'replan refuses paths that are not workspace-relative',
    /workspace-relative/.test(failureOf(() => replanTeam(scopeFixture(), [
      { action: 'accept_paths', task_id: 't1', paths: ['/etc/passwd'] },
    ], { reason: 'bad path' }))),
  )

  // The shipped WP2 rule wins over the WP7 status table's "amend_task force on a
  // completed task": a completed contract stays immutable, and the post-hoc
  // repair for a finished lane is `accept_paths` (which is why force exists there).
  const completedAmend = failureOf(() => replanTeam({
    ...replanFixture(),
    tasks: [
      { id: 't1', subject: 'done lane', status: 'completed', dependencies: [], attempt: 1, kind: 'implementation', objective: 'old objective', inScope: ['src/a.ts'], acceptance: ['old'], createdAt: 1, updatedAt: 1 },
    ],
    taskSeq: 1,
  }, [{
    action: 'amend_task',
    task_id: 't1',
    objective: 'new objective',
    force: true,
  }], { reason: 'the objective was wrong' }))
  check(
    'replan refuses to rewrite a completed contract even with force',
    /terminal|immutable/.test(completedAmend),
    completedAmend,
  )
  const completedPaths = replanTeam({
    ...replanFixture(),
    tasks: [
      { id: 't1', subject: 'done lane', status: 'completed', dependencies: [], attempt: 1, kind: 'implementation', objective: 'ship it', inScope: ['src/a.ts'], acceptance: ['works'], createdAt: 1, updatedAt: 1 },
    ],
    taskSeq: 1,
  }, [{ action: 'accept_paths', task_id: 't1', paths: ['src/b.ts'] }], { reason: 'the second file belongs to the lane' })
  check(
    'replan widens the scope of a completed lane post-hoc',
    completedPaths.team.tasks[0]?.inScope?.includes('src/b.ts') === true
      && completedPaths.result.changes[0]?.action === 'accept_paths',
  )

  const retried = replanTeam(failedFixture(), [
    { action: 'amend_task', task_id: 't2', objective: 'the repaired objective' },
    { action: 'update_task', task_id: 't2', retry: true },
    { action: 'add_task', subject: 'the follow-up the review asked for', assignee: 'worker' },
  ], { reason: 'the review asked for a repaired lane and one follow-up' })
  check(
    'one batch repairs a wrong contract, retries the lane and adds the follow-up',
    retried.team.tasks.find(task => task.id === 't2')?.status === 'pending'
      && retried.team.tasks.find(task => task.id === 't2')?.objective === 'the repaired objective'
      && retried.result.added.join(',') === 't4'
      && retried.result.rebound.includes('t2')
      && retried.result.changes.map(change => change.action).join(',') === 'amend_task,update_task,add_task'
      && retried.team.plan?.revision === 4,
  )
  check(
    'a cancelled lane cannot be revived by retry',
    /cancelled/.test(failureOf(() => replanTeam({
      ...replanFixture(),
      tasks: [{ id: 't1', subject: 'dropped lane', status: 'cancelled', dependencies: [], attempt: 1, kind: 'work', createdAt: 1, updatedAt: 1 }],
      taskSeq: 1,
    }, [{ action: 'update_task', task_id: 't1', retry: true }], { reason: 'revive it' }))),
  )

  const phased = replanTeam({
    ...replanFixture(),
    plan: { revision: 1, updatedAt: 1, phases: [{ id: 'E0', title: 'Recon', taskIds: ['t1'] }] },
  }, [
    { action: 'move_phase', task_id: 't2', phase_id: 'E1', title: 'Lanes' },
    { action: 'move_phase', task_id: 't1', phase_id: '' },
  ], { reason: 'declare the phases the plan really uses' })
  check(
    'replan moves tasks between phases and creates a missing one',
    phased.team.plan?.phases?.map(phase => `${phase.id}:${phase.taskIds.join('|')}`).join(',') === 'E0:,E1:t2'
      && phased.result.changes.length === 2,
  )
  check(
    'moving a task into an undeclared phase is refused',
    /unknown phase/.test(failureOf(() => replanTeam(replanFixture(), [
      { action: 'move_phase', task_id: 't2', phase_id: 'E9' },
    ], { reason: 'typo' }))),
  )

  const planRevision = replanFixture()
  const firstRevision = revisePlan(planRevision)
  const secondRevision = revisePlan(planRevision)
  check(
    'the plan revision is a monotone counter with a timestamp',
    firstRevision === 4 && secondRevision === 5
      && planRevision.plan?.revision === 5
      && typeof planRevision.plan?.updatedAt === 'number'
      && planRevision.plan.updatedAt > 0,
  )
  check(
    'the plan-revised event is part of the event set',
    AGENT_TEAMS_EVENT_TYPES.includes('agent-teams/plan-revised'),
  )
  check(
    'the replan tool is registered and takes the batch reason',
    TEAM_TOOL_NAMES.length === 19
      && TEAM_TOOL_NAMES.includes('agent_teams_replan')
      && toolsSource.includes('agent_teams_replan')
      && toolsSource.includes("'agent-teams/plan-revised'")
      && toolsSource.includes('invalidationDetails')
      && /replan/i.test(hostSource),
  )
  check(
    'the Web plan route accepts the replan action through the shared runtime',
    hostSource.includes("action === 'replan'")
      && hostSource.includes('parseReplanOperation')
      && hostSource.includes('replanLiveTeam')
      && (() => {
        const mapped = parseReplanOperation({
          action: 'update_task',
          taskId: 't2',
          subject: 'retargeted',
          phaseId: 'E1',
          invalidate: true,
          retry: true,
        }, 0)
        return mapped.task_id === 't2' && mapped.subject === 'retargeted' && mapped.phase_id === 'E1'
          && mapped.invalidate === true && mapped.retry === true
      })()
      && failureOf(() => parseReplanOperation({ taskId: 't2' }, 1)) === 'operations[1].action is required',
  )
  check(
    'the panel ships the running-mode replan editor',
    activityPanelSource.includes('function RunningPlanEditor')
      && activityPanelSource.includes('data-replan-editor')
      && activityPanelSource.includes('data-replan-apply')
      && activityPanelSource.includes('data-replan-invalidate')
      && activityPanelSource.includes("action: 'replan'")
      && activityPanelSource.includes('ACTIVITY_PLAN_URL')
      && activityPanelCss.includes('.replanRow')
      && activityPanelCss.includes('.replanApply')
      && localesSource.includes("'replan.apply'")
      && localesSource.includes("'replan.invalidate'")
      && localesSource.includes("'replan.reason'"),
  )
  check(
    'declared phases drive the phase board and the checklist order',
    activityPanelSource.includes('function declaredPhasesOf')
      && activityPanelSource.includes('manualPhases={manualPhases}')
      && activityPanelSource.includes('phaseColumns(tasks, manualPhases)')
      && activityPanelSource.includes('phaseBoardLayout(tasks, manualPhases)'),
  )
  // WP11 phase 3: every guard is a configured number resolved in one place, and
  // the status report shows who holds a slot and how much waits.
  check(
    'the WP11 limits are configured keys with one resolver',
    toolsSource.includes('MAX_TEAMS_PER_SESSION')
      && toolsSource.includes('function resolveTeamLimits')
      && toolsSource.includes('function limitsPayload')
      && toolsSource.includes('function slotSummaryOf')
      && /maxTeamsPerSession\?\.?\s*\?\?|maxTeamsPerSession \?\?/.test(toolsSource)
      && hostSource.includes('maxTeamsPerWorkspace: z.natural().min(1)')
      && hostSource.includes('maxTeamsPerSession: z.natural().min(1)')
      && hostSource.includes('maxTeamsPerWorkspace === undefined ? {} : { maxTeamsPerWorkspace: config.maxTeamsPerWorkspace }'),
  )
  check(
    'the status report carries the slot summary in both modes',
    toolsSource.includes('slots: summary.working.map((slot) => slot.member)')
      && toolsSource.includes('queued: summary.queued')
      && toolsSource.includes('slots: slotSummaryOf(team, resolveTeamLimits(config))')
      && toolsSource.includes('Slots: ${String(team.slots.team_workers)}')
      && toolsSource.includes('Limits: ${String(team.limits.max_teams_per_workspace)}')
      && toolsSource.includes('} queued`'),
  )
}

console.log('7/8 member model selection and continuation restore')
const captain = {
  id: 'captain-session',
  options: { provider: 'birth-provider', model: 'birth-model' },
  session: {
    requestHeader: () => ({
      config: {
        provider: 'captain-provider',
        model: 'captain-model',
        reasoningEffort: 'max',
      },
    }),
  },
}
const resolvedCalls = []
const routeDefaultEfforts = new Map([
  ['captain-provider/captain-model', 'high'],
  ['captain-provider/configured-member-model', 'medium'],
  ['other-provider/other-model', 'low'],
])
const selectionContext = {
  llm: {
    resolveCallConfig: async (config) => {
      resolvedCalls.push(config)
      const route = `${config.provider}/${config.model}`
      if (route !== 'captain-provider/captain-model' && config.reasoningEffort === 'max') {
        const error = new Error(`provider/model route ${route} does not support reasoning effort "max"`)
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      const defaultEffort = routeDefaultEfforts.get(route)
      return config.reasoningEffort !== undefined || defaultEffort === undefined
        ? config
        : { ...config, reasoningEffort: defaultEffort }
    },
  },
}
const inheritedSelection = await resolveMemberLlmSelection(selectionContext, captain, {})
check(
  'ordinary member snapshots the captain current route and effort',
  inheritedSelection.provider === 'captain-provider'
    && inheritedSelection.model === 'captain-model'
    && inheritedSelection.reasoningEffort === 'max',
)
const overriddenSelection = await resolveMemberLlmSelection(selectionContext, captain, {
  provider: 'other-provider',
  model: 'other-model',
})
check(
  'cross-provider route uses the target model default instead of captain effort',
  overriddenSelection.provider === 'other-provider'
    && overriddenSelection.model === 'other-model'
    && overriddenSelection.reasoningEffort === 'low'
    && resolvedCalls.at(-1)?.reasoningEffort === undefined,
)
const defaultedSelection = await resolveMemberLlmSelection(selectionContext, captain, {
  defaultModel: 'configured-member-model',
})
check(
  'plugin memberModel route uses that target model default effort',
  defaultedSelection.provider === 'captain-provider'
    && defaultedSelection.model === 'configured-member-model'
    && defaultedSelection.reasoningEffort === 'medium'
    && resolvedCalls.at(-1)?.reasoningEffort === undefined,
)
const explicitEffortSelection = await resolveMemberLlmSelection(selectionContext, captain, {
  provider: 'other-provider',
  model: 'other-model',
  reasoningEffort: 'high',
})
check(
  'explicit member effort overrides cross-provider target default',
  explicitEffortSelection.reasoningEffort === 'high'
    && resolvedCalls.at(-1)?.reasoningEffort === 'high',
)
const forcedDefaultSelection = await resolveMemberLlmSelection(selectionContext, captain, {
  reasoningEffort: 'default',
})
check(
  'default sentinel opts out of same-route captain effort inheritance',
  forcedDefaultSelection.provider === 'captain-provider'
    && forcedDefaultSelection.model === 'captain-model'
    && forcedDefaultSelection.reasoningEffort === 'high'
    && resolvedCalls.at(-1)?.reasoningEffort === undefined,
)
let providerWithoutModelRejected = false
try {
  await resolveMemberLlmSelection(selectionContext, captain, { provider: 'other-provider' })
} catch {
  providerWithoutModelRejected = true
}
check('explicit provider without model is rejected', providerWithoutModelRejected)
let emptyEffortRejected = false
try {
  await resolveMemberLlmSelection(selectionContext, captain, { reasoningEffort: '  ' })
} catch {
  emptyEffortRejected = true
}
check('empty explicit reasoning effort is rejected', emptyEffortRejected)

let catalogCalls = 0
await validateMemberLlmSelections({
  llm: {
    async listModels(provider) {
      catalogCalls += 1
      return [{ provider, id: 'known-model', name: 'Known model' }]
    },
  },
}, [
  { provider: 'known-provider', model: 'known-model' },
  { provider: 'known-provider', model: 'known-model' },
])
check('approval model preflight caches one catalog lookup per provider', catalogCalls === 1)
let unknownCatalogModelRejected = false
try {
  await validateMemberLlmSelections({
    llm: {
      async listModels(provider) {
        return [{ provider, id: 'known-model', name: 'Known model' }]
      },
    },
  }, [{ provider: 'known-provider', model: 'typo-model' }])
} catch (error) {
  unknownCatalogModelRejected = /unknown member model.*typo-model/i.test(String(error?.message ?? error))
}
check('approval model preflight rejects an unlisted typo before spawn', unknownCatalogModelRejected)

let startSpec
const spawnMemberRecord = {
  id: '',
  name: 'backend',
  role: 'engineer',
  provider: overriddenSelection.provider,
  model: overriddenSelection.model,
  reasoningEffort: overriddenSelection.reasoningEffort,
  joinedAt: Date.now(),
  status: 'idle',
}
const spawnTeam = {
  name: 'Spawn Verify',
  id: 'spawn-verify',
  captainSessionId: captain.id,
  createdAt: Date.now(),
  members: [],
  tasks: [],
  taskSeq: 0,
}
await spawnMember(
  {
    subagents: {
      getProvider: () => ({
        prepareContinuable: () => undefined,
        capabilities: { persona: true, toolFilter: true },
      }),
      list: () => ['spawn'],
      startContinuable: async (spec) => {
        startSpec = spec
        return { childId: 'spawned-member', messageId: 'welcome-message' }
      },
    },
  },
  { provider: 'spawn', maxDepth: 1 },
  {
    withPending: async (_parentId, _label, _selection, operation) => operation(),
  },
  overriddenSelection,
  captain,
  spawnTeam,
  spawnMemberRecord,
  '.agent-teams',
  new AbortController().signal,
)
check(
  '#20: spawn receives the resolved per-member provider and model',
  startSpec?.request?.agentOptions?.provider === 'other-provider'
    && startSpec?.request?.agentOptions?.model === 'other-model'
    && spawnMemberRecord.id === 'spawned-member',
)

function descriptorEvent(label, agentProvider = 'descriptor-provider', agentModel = 'descriptor-model') {
  return {
    type: 'subagent/descriptor',
    data: {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label,
      agentProvider,
      agentModel,
    },
  }
}

function fakeChildContext({ label, parentSessionId, cwd, agentProvider, agentModel }) {
  const listeners = new Map()
  return {
    listeners,
    context: {
      agent: {
        session: {
          header: { parentSession: parentSessionId, cwd, seedLength: 0 },
          events: [descriptorEvent(label, agentProvider, agentModel)],
        },
      },
      on(name, listener) {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    },
  }
}

async function routedConfig(child) {
  const assemble = child.listeners.get('system-prompt/assemble')
  const request = child.listeners.get('agent/request')
  await assemble({}, {}, async () => ({ variables: {} }))
  return request({}, async () => ({
    provider: 'unselected-provider',
    model: 'unselected-model',
    reasoningEffort: 'low',
  }))
}

let setupMemberSelection
const selectionRuntime = installMemberSelectionRuntime({
  subagents: {
    registerContinuableSetup: (setup) => {
      setupMemberSelection = setup
      return () => undefined
    },
  },
}, '.agent-teams')
const freshChild = fakeChildContext({
  label: 'agent-teams:fresh-team:backend',
  parentSessionId: 'captain-session',
  cwd: process.cwd(),
})
let disposeFresh
await selectionRuntime.withPending(
  'captain-session',
  'agent-teams:fresh-team:backend',
  overriddenSelection,
  async () => {
    disposeFresh = setupMemberSelection(freshChild.context)
  },
)
const freshRoute = await routedConfig(freshChild)
check(
  'fresh child request receives the resolved reasoning effort',
  freshRoute.provider === 'other-provider'
    && freshRoute.model === 'other-model'
    && freshRoute.reasoningEffort === 'low',
)
disposeFresh()

const restoreWorkspace = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-selection-'))
try {
  const restoreStateRoot = join(restoreWorkspace, '.agent-teams')
  await createTeamDir(restoreStateRoot, {
    name: 'Restore Team',
    id: 'restore-team',
    captainSessionId: 'captain-session',
    createdAt: Date.now(),
    members: [{
      id: 'cold-member',
      name: 'reviewer',
      provider: 'cold-provider',
      model: 'cold-model',
      reasoningEffort: 'high',
      joinedAt: Date.now(),
      status: 'idle',
    }],
    tasks: [],
    taskSeq: 0,
  })
  const coldChild = fakeChildContext({
    label: 'agent-teams:restore-team:reviewer',
    parentSessionId: 'captain-session',
    cwd: restoreWorkspace,
    agentProvider: 'cold-provider',
    agentModel: 'cold-model',
  })
  const disposeCold = setupMemberSelection(coldChild.context)
  const coldRoute = await routedConfig(coldChild)
  check(
    'cold-resumed child restores provider, model, and reasoning from team.json',
    coldRoute.provider === 'cold-provider'
      && coldRoute.model === 'cold-model'
      && coldRoute.reasoningEffort === 'high',
  )
  disposeCold()
} finally {
  await rm(restoreWorkspace, { recursive: true, force: true })
}

console.log('8/8 state-file atomic write hardening (Windows EPERM fallback)')
// The durable state files (team.json, mailboxes, retired index) are replaced
// through `atomicWriteText` = write-temp + rename. On Windows a rename over an
// existing target throws EPERM while another process holds it open without
// FILE_SHARE_DELETE; the hardened path retries the rename a few times and then
// degrades to a direct overwrite (content-equivalent because the temp file was
// fully written). These checks pin that behavior through the injectable seam
// and, on Windows, against a real cross-process handle lock.
const atomicStateRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-teams-atomic-'))
try {
  const {
    replaceFileAtomicOrDirect,
    writeTeam,
  } = await import('../lib/state.js')
  const epermError = () => Object.assign(
    new Error("EPERM: operation not permitted, rename '.../team.json.tmp' -> '.../team.json'"),
    { code: 'EPERM' },
  )

  let renameCalls = 0
  let fallbackWrites = 0
  let fallbackRemovals = 0
  let fallbackContent = ''
  const fallbackTarget = join(atomicStateRoot, 'forced', 'team.json')
  await replaceFileAtomicOrDirect('forced.tmp', fallbackTarget, '{"fallback":1}', {
    rename: async () => { renameCalls += 1; throw epermError() },
    writeFile: async (_file, content) => { fallbackWrites += 1; fallbackContent = content },
    remove: async () => { fallbackRemovals += 1 },
  }, { retryDelayMs: 1 })
  check(
    'persistent EPERM exhausts the rename retries (1 initial + 3 retries)',
    renameCalls === 4,
    `renameCalls = ${renameCalls}`,
  )
  check(
    'persistent EPERM falls back to a direct overwrite of the target',
    fallbackWrites === 1 && fallbackContent === '{"fallback":1}',
    `fallbackWrites = ${fallbackWrites}`,
  )
  check('the temp file is removed after the fallback write', fallbackRemovals === 1)

  let transientCalls = 0
  let transientWrites = 0
  await replaceFileAtomicOrDirect('transient.tmp', join(atomicStateRoot, 'transient', 'team.json'), '{"retried":2}', {
    rename: async () => {
      transientCalls += 1
      if (transientCalls <= 2) throw epermError()
    },
    writeFile: async (file, content) => { transientWrites += 1; await writeFile(file, content) },
    remove: async () => undefined,
  }, { retryDelayMs: 1 })
  check(
    'a transient EPERM recovers via rename retries without the fallback',
    transientCalls === 3 && transientWrites === 0,
    `renameCalls = ${transientCalls}, fallbackWrites = ${transientWrites}`,
  )

  let aggregateThrown = false
  let dualRemovals = 0
  try {
    await replaceFileAtomicOrDirect('dual.tmp', join(atomicStateRoot, 'dual', 'team.json'), 'x', {
      rename: async () => { throw epermError() },
      writeFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
      remove: async () => { dualRemovals += 1 },
    }, { retryDelayMs: 1 })
  } catch (error) {
    aggregateThrown = error instanceof AggregateError
  }
  check('failure of both the atomic and the direct path raises AggregateError', aggregateThrown)
  check('the temp file is removed even after a dual failure', dualRemovals === 1)

  if (process.platform === 'win32') {
    // Real cross-process lock: hold team.json with FileShare.ReadWrite (no
    // FILE_SHARE_DELETE) from a child .NET handle, then verify the public
    // write path still persists through the direct-write fallback.
    const lockedTeam = {
      name: 'Locked Team',
      id: 'locked-team',
      captainSessionId: 'sess-lock',
      createdAt: Date.now(),
      members: [],
      tasks: [],
      taskSeq: 0,
    }
    await createTeamDir(atomicStateRoot, lockedTeam)
    const lockedJson = join(atomicStateRoot, lockedTeam.id, 'team.json')
    const { spawn } = await import('node:child_process')
    const holder = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$f = '${lockedJson.replaceAll("'", "''")}';
         $s = [System.IO.File]::Open($f, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite);
         [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush();
         Start-Sleep -Seconds 45; $s.Dispose()`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const held = await new Promise((resolve, reject) => {
      let buffer = ''
      const onData = (chunk) => {
        buffer += chunk.toString()
        if (buffer.includes('HELD')) { cleanup(); resolve(true) }
      }
      const onExit = () => { cleanup(); reject(new Error('lock holder exited before arming')) }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('timed out waiting for the lock holder'))
      }, 15_000)
      function cleanup() {
        clearTimeout(timer)
        holder.stdout.off('data', onData)
        holder.off('exit', onExit)
      }
      holder.stdout.on('data', onData)
      holder.on('exit', onExit)
    })
    try {
      if (held) {
        lockedTeam.members.push({ id: 'sess-new', name: 'member', joinedAt: Date.now(), status: 'idle' })
        await writeTeam(atomicStateRoot, lockedTeam)
        const persisted = JSON.parse(await readFile(lockedJson, 'utf8'))
        const leftovers = (await readdir(join(atomicStateRoot, lockedTeam.id))).filter(name => name.endsWith('.tmp'))
        check(
          'writeTeam survives a real Windows lock without FILE_SHARE_DELETE',
          persisted.members.length === 1 && leftovers.length === 0,
          `members = ${persisted.members.length}, tmp leftovers = ${leftovers.join(', ') || 'none'}`,
        )
      }
      // Archive moves the whole team directory with `rename(source, target)`.
      // The same Windows delete-sharing EPERM applies when a file below the
      // directory is momentarily locked, so it retries the rename. Release
      // the real lock only after observing the first OS rename rejection;
      // PowerShell startup/scheduling must not race a 150 ms retry budget.
      const { archiveTeamDir } = await import('../lib/state.js')
      const transientTeam = {
        name: 'Transient Lock Team',
        id: 'transient-lock',
        captainSessionId: 'sess-transient',
        createdAt: Date.now(),
        members: [],
        tasks: [],
        taskSeq: 0,
      }
      await createTeamDir(atomicStateRoot, transientTeam)
      const transientJson = join(atomicStateRoot, transientTeam.id, 'team.json')
      const transientSource = join(atomicStateRoot, transientTeam.id)
      const flasher = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `$f = '${transientJson.replaceAll("'", "''")}';
           $s = [System.IO.File]::Open($f, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite);
           [Console]::Out.WriteLine('HELD_T'); [Console]::Out.Flush();
           [void][Console]::In.ReadLine(); $s.Dispose();
           [Console]::Out.WriteLine('RELEASED_T'); [Console]::Out.Flush()`],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      )
      const waitForMarker = (marker, trigger = () => {}) => new Promise((resolve, reject) => {
        let buffer = ''
        const onData = (chunk) => {
          buffer += chunk.toString()
          if (buffer.includes(marker)) { cleanup(); resolve(true) }
        }
        const onError = (error) => { cleanup(); reject(error) }
        const onExit = () => { cleanup(); reject(new Error(`transient holder exited before ${marker}`)) }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`timed out waiting for transient lock marker ${marker}`))
        }, 10_000)
        function cleanup() {
          clearTimeout(timer)
          flasher.stdout.off('data', onData)
          flasher.off('exit', onExit)
          flasher.off('error', onError)
          flasher.stdin.off('error', onError)
        }
        flasher.stdout.on('data', onData)
        flasher.on('exit', onExit)
        flasher.on('error', onError)
        flasher.stdin.on('error', onError)
        trigger()
      })
      const fsPromises = (await import('node:fs/promises')).default
      const { syncBuiltinESMExports } = await import('node:module')
      const originalRename = fsPromises.rename
      let archiveRenameCalls = 0
      let observedLockRejection = false
      try {
        const flashed = await waitForMarker('HELD_T')
        // Delegate every attempt to the real filesystem. Only coordinate
        // release after the first actual sharing violation, then rethrow that
        // same error so archiveTeamDir itself must perform the retry.
        fsPromises.rename = async (from, to) => {
          if (from !== transientSource) return originalRename(from, to)
          archiveRenameCalls += 1
          try {
            return await originalRename(from, to)
          } catch (error) {
            if (!observedLockRejection && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
              observedLockRejection = true
              await waitForMarker('RELEASED_T', () => flasher.stdin.end('release\n'))
            }
            throw error
          }
        }
        syncBuiltinESMExports()
        await archiveTeamDir(atomicStateRoot, transientTeam.id)
        const archived = await readFile(join(atomicStateRoot, 'archive', transientTeam.id, 'team.json'), 'utf8')
        check(
          'archiveTeamDir survives a transient Windows directory lock via rename retries',
          flashed && observedLockRejection && archiveRenameCalls >= 2
            && JSON.parse(archived).id === transientTeam.id,
          `observed real lock = ${observedLockRejection}, rename attempts = ${archiveRenameCalls}`,
        )
      } catch (error) {
        check(
          'archiveTeamDir survives a transient Windows directory lock via rename retries',
          false,
          String(error),
        )
      } finally {
        fsPromises.rename = originalRename
        syncBuiltinESMExports()
        flasher.kill()
        if (flasher.exitCode === null && flasher.signalCode === null) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 5_000)
            flasher.once('exit', () => { clearTimeout(timer); resolve() })
          })
        }
      }
    } finally {
      holder.kill()
      if (holder.exitCode === null && holder.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5_000)
          holder.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
    }
  } else {
    check('real Windows lock integration skipped on this platform', true)
  }
} finally {
  await rm(atomicStateRoot, { recursive: true, force: true }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await rm(atomicStateRoot, { recursive: true, force: true })
  })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
