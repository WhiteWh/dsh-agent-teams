/**
 * Multi-team panel and scheduler checks (WP11 phase 2, step S18).
 *
 * The panel used to stack every live team of the current session into one long
 * column; with several teams that is unreadable, and with two teams it was easy
 * to read one team's DAG as the other's. Phase 2 gives the panel a switcher (one
 * team at a time, its own DAG, members, progress and slices) and the scheduler a
 * workspace-wide sweep with per-team and global worker caps.
 *
 * Run with `node scripts/multi-team-panel-tdd.mjs`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  PANEL_TEAM_STORAGE_KEY,
  panelSelectedTeamId,
  panelTeamTabs,
  parsePanelTeamSelection,
} from '../lib/client/activity-model.js'

const activityPanelSource = await readFile(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
const activityPanelCss = await readFile(new URL('../src/client/ActivityPanel.module.css', import.meta.url), 'utf8')
const activityModelSource = await readFile(new URL('../src/client/activity-model.ts', import.meta.url), 'utf8')
const schedulerSource = await readFile(new URL('../src/scheduler.ts', import.meta.url), 'utf8')
const localesSource = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

const failures = []
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  console.log(`  ${status}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

console.log('dsh-agent-teams multi-team panel checks (WP11 phase 2)')

/** One live team fixture: only the fields the switcher reads. */
const team = (teamId, name, overrides = {}) => ({
  teamId,
  name,
  phase: 'running',
  captainSessionId: 'sess-1',
  members: [],
  tasks: [],
  ...overrides,
})

{
  const teams = [
    team('alpha', 'Alpha', {
      members: [{ id: 'm1', name: 'worker', status: 'working', activity: 'working' }],
      tasks: [
        { id: 't1', subject: 'a1', status: 'completed', state: 'completed', dependencies: [], depth: 0 },
        { id: 't2', subject: 'a2', status: 'in_progress', state: 'running', dependencies: ['t1'], depth: 1 },
      ],
    }),
    team('beta', 'Beta', {
      members: [{ id: 'm2', name: 'other', status: 'idle', activity: 'idle' }],
      tasks: [{ id: 't1', subject: 'b1', status: 'pending', state: 'open', dependencies: [], depth: 0 }],
    }),
  ]
  const tabs = panelTeamTabs(teams)
  check(
    'the switcher lists one tab per live team with its own counters',
    tabs.length === 2
      && tabs.map(tab => tab.teamId).join(',') === 'alpha,beta'
      && tabs[0]?.working === 1 && tabs[0]?.done === 1 && tabs[0]?.total === 2
      && tabs[1]?.working === 0 && tabs[1]?.done === 0 && tabs[1]?.total === 1,
  )
  check(
    'two teams with identical task ids stay separate tabs',
    tabs[0]?.teamId !== tabs[1]?.teamId
      && tabs[0]?.name === 'Alpha' && tabs[1]?.name === 'Beta'
      && new Set(tabs.map(tab => tab.teamId)).size === 2,
  )

  const halted = [...teams, team('gamma', 'Gamma', { halted: true })]
  const haltedTabs = panelTeamTabs(halted)
  check(
    'a halted team keeps its tab and is marked stopped',
    haltedTabs.length === 3
      && haltedTabs[2]?.teamId === 'gamma'
      && haltedTabs[2]?.halted === true
      && haltedTabs[0]?.halted === false,
  )

  check(
    'the stored selection wins while that team still exists',
    panelSelectedTeamId(teams, 'beta') === 'beta'
      && panelSelectedTeamId(teams, 'alpha') === 'alpha',
  )
  check(
    'a stale selection falls back to the first live team',
    panelSelectedTeamId(teams, 'gone') === 'alpha'
      && panelSelectedTeamId(teams, null) === 'alpha'
      && panelSelectedTeamId([], 'alpha') === null,
  )
  check(
    'a halted team stays selectable once the reader picked it',
    panelSelectedTeamId(halted, 'gamma') === 'gamma',
  )
  check(
    'the stored selection is parsed defensively',
    parsePanelTeamSelection('beta') === 'beta'
      && parsePanelTeamSelection('  beta  ') === 'beta'
      && parsePanelTeamSelection('') === null
      && parsePanelTeamSelection(null) === null
      && parsePanelTeamSelection(undefined) === null,
  )
  check(
    'the selection key is versioned and stable',
    PANEL_TEAM_STORAGE_KEY === 'dsh-agent-teams:activity-panel:team:v1',
  )
}

{
  check(
    'the panel switches teams instead of stacking every live team',
    activityPanelSource.includes('function TeamSwitcher')
      && activityPanelSource.includes('data-team-switcher')
      && activityPanelSource.includes('data-team-tab')
      && activityPanelSource.includes('panelSelectedTeamId')
      && activityPanelSource.includes('PANEL_TEAM_STORAGE_KEY')
      && activityPanelSource.includes('selectedTeam'),
  )
  check(
    'only the selected team renders its DAG, members and progress',
    /const selectedTeam = useMemo\(/.test(activityPanelSource)
      && activityPanelSource.includes('{selectedTeam !== undefined && (')
      && !activityPanelSource.includes('visibleTeams.map((team) => (')
      && !activityPanelSource.includes('liveCaptainTeam'),
  )
  check(
    'the switcher is styled and localized',
    activityPanelCss.includes('.teamSwitcher')
      && activityPanelCss.includes('.teamTab')
      && localesSource.includes("'teams.switcher'")
      && localesSource.includes("'teams.tab'"),
  )
  check(
    'the retired single-team selector is gone from the model',
    !activityModelSource.includes('export function liveCaptainTeam')
      && activityModelSource.includes('export function panelTeamTabs'),
  )
}

{
  check(
    'the scheduler exposes a workspace-wide sweep with both caps',
    schedulerSource.includes('sweepAll')
      && schedulerSource.includes('MAX_WORKERS_PER_TEAM')
      && schedulerSource.includes('MAX_CONCURRENT_WORKERS_GLOBAL')
      && schedulerSource.includes('workingCount'),
  )
  check(
    'a swept team is skipped while staged or halted',
    /sweepAll[\s\S]{0,1200}team\.halted === true[\s\S]{0,400}phase === 'staged'/.test(schedulerSource)
      || /sweepAll[\s\S]{0,1200}phase === 'staged'[\s\S]{0,400}halted === true/.test(schedulerSource),
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} multi-team panel check(s) FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall multi-team panel checks passed')
assert.ok(true)
