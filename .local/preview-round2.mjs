/**
 * Round 2 preview (local helper, never packaged): render the compact member line
 * and the phase board with the real built stylesheet, the real artwork and the
 * real layout function, so the owner's requests can be looked at before release.
 *
 *   .local\pnpm.cmd build && node .local\preview-round2.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { phaseBoardLayout, COMPACT_DAG_NODE_WIDTH, COMPACT_DAG_NODE_HEIGHT } from '../lib/client/activity-model.js'

const bundle = readFileSync('lib/client.js', 'utf8')
const names = ['memberBlock', 'memberBranch', 'memberRow', 'memberAvatar', 'memberArt', 'memberInitial',
  'memberRoleIcon', 'memberInfo', 'memberLine', 'memberName', 'memberModel', 'memberStateIcon', 'stateArt',
  'memberState', 'memberCount', 'assignmentLine', 'assignmentTasks', 'assignmentChip', 'taskEmpty',
  'workBar', 'workBarRow', 'workBarDot', 'delegationTree',
  'phaseBoardViewport', 'phaseBoardScroll', 'phaseHeaderRow', 'phaseColumn', 'phaseColumnHead',
  'phaseColumnCount', 'dagCanvas', 'dagEdges', 'dagNode', 'dagNodeHead', 'dagNodeDot', 'dagNodeLabel',
  'phaseHint']
const classes = {}
for (const name of names) {
  const match = new RegExp(`\\.(_[A-Za-z0-9]+_${name})\\b`).exec(bundle)
  if (match === null) throw new Error(`class not found in bundle: ${name}`)
  classes[name] = match[1]
}
console.log('board classes:', classes.dagNode, classes.phaseColumn)
console.log('member classes:', classes.memberRow, classes.memberStateIcon, classes.workBar)

// The stylesheet payload the bundle ships, so the render uses shipped CSS.
const cssStart = bundle.indexOf('._')
const marker = /\._[A-Za-z0-9]+_[A-Za-z]+\{/u.exec(bundle.slice(cssStart))
if (marker === null) throw new Error('css payload not found')
const start = cssStart + marker.index
let depth = 0
let end = start
for (let i = start; i < bundle.length; i += 1) {
  const ch = bundle[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0 && bundle.slice(i, i + 2) === '}\n') { end = i + 1; break }
  }
}
const css = bundle.slice(start, end)

// Phase fixture: E0 holds a sequential chain (t1 -> t2 -> t4), E1 holds a chain
// beside a parallel lane, and one cancelled lane shows the new hatched card.
const tasks = [
  { id: 't1', subject: 'Requirements', status: 'completed', state: 'completed', assignee: 'analyst', dependencies: [], depth: 0 },
  { id: 't2', subject: 'Implementation', status: 'in_progress', state: 'running', assignee: 'impl-c1', dependencies: ['t1'], depth: 1 },
  { id: 't4', subject: 'Verification', status: 'pending', state: 'blocked', assignee: 'verifier', dependencies: ['t2'], depth: 2 },
  { id: 't3', subject: 'Review round 1', status: 'failed', state: 'failed', assignee: 'reviewer', dependencies: ['t2'], depth: 2 },
  { id: 't5', subject: 'Lane B documentation', status: 'cancelled', state: 'cancelled', assignee: 'impl-b', dependencies: ['t2'], depth: 2 },
  { id: 't6', subject: 'Follow-up repair', status: 'pending', state: 'blocked', assignee: 'verifier', dependencies: ['t3', 't5'], depth: 3 },
]
const phases = [
  { id: 'p1', title: 'Phase 1 — analysis', taskIds: ['t1', 't2', 't3', 't4'] },
  { id: 'p2', title: 'Phase 2 — repair', taskIds: ['t5', 't6'] },
]
const layout = phaseBoardLayout(tasks, phases)
console.log('layout:', JSON.stringify({
  size: [layout.width, layout.height],
  columns: layout.columns.map((column) => [column.phaseId, column.x, column.width, column.taskIds.join('+')]),
  nodes: layout.nodes.map((node) => [node.task.id, node.x, node.y]),
}))

const dot = (row) => [0, 1, 2].map(() => `<span class="${classes.workBarDot}" style="animation-delay:${(row * 0.12).toFixed(2)}s"></span>`).join('')
const plaque = (active) => `<span class="${classes.workBar}" data-active="${active}" data-work-bar="${active}">${[0, 1, 2]
  .map((row) => `<span class="${classes.workBarRow}">${dot(row)}</span>`).join('')}</span>`

const art = 'file:///D:/OwlCats/AI_Tools/dsh-agent-teams/assets/agent-teams/'
const member = ({ name, role, model, action, activity, state, count, chips, active }) => `
<div class="${classes.memberBlock}" data-activity="${activity}">
  <span class="${classes.memberBranch}" aria-hidden><span></span></span>
  <button type="button" class="${classes.memberRow}" data-activity="${activity}">
    <span class="${classes.memberAvatar}"><img class="${classes.memberArt}" src="${art}member-engineer-v2.png" alt=""></span>
    <img class="${classes.memberRoleIcon}" src="${art}member-engineer-symbol.png" alt="" aria-hidden title="${role}">
    <span class="${classes.memberInfo}"><span class="${classes.memberLine}">
      <span class="${classes.memberName}" title="${name} · ${role}">${name}</span>
      <span class="${classes.memberModel}" role="img" data-member-model="${model}" title="${model}" aria-label="${model}">${model.split('/').pop()}</span>
      <span class="${classes.memberStateIcon}" data-activity="${activity}">
        <img class="${classes.stateArt}" data-activity="${activity}" src="${art}${action}-symbol.png" alt="" aria-hidden>
        <span class="${classes.memberState}">${state}</span>
      </span>
    </span></span>
    <span class="${classes.memberCount}">${count}</span>
    <span class="${classes.assignmentLine}"><span class="${classes.assignmentTasks}">${chips.length === 0
      ? `<span class="${classes.taskEmpty}">Unassigned</span>`
      : chips.map(([id, chipState, extra]) => `<span class="${classes.assignmentChip}" data-state="${chipState}">${id}${extra ?? ''}</span>`).join('')}</span></span>
    ${plaque(active)}
  </button>
</div>`

const node = ({ task, x, y }) => {
  const state = task.status === 'cancelled' ? 'cancelled' : task.state
  return `
        <button type="button" class="${classes.dagNode}" style="left:${x}px;top:${y}px;width:${COMPACT_DAG_NODE_WIDTH}px;height:${COMPACT_DAG_NODE_HEIGHT}px"
          data-task-id="${task.id}" data-state="${state}" data-agent="${task.assignee}" data-focused="true">
          <span class="${classes.dagNodeHead}"><span class="${classes.dagNodeDot}" style="background:#4c8dff"></span>${task.id}</span>
          <span class="${classes.dagNodeLabel}">${task.subject}</span>
        </button>`
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root{
  --dsw-alias-bg-layer-1:#1b1f27; --dsw-alias-bg-layer-2:#22262f; --dsw-alias-bg-module-platform:#20242c;
  --dsw-alias-border-l2:#3a4150; --dsw-alias-border-l3:#4a5262; --dsw-alias-label-primary:#e6e9ef;
  --dsw-alias-label-secondary:#a8b0bd; --dsw-alias-label-tertiary:#7d8695; --dsw-alias-label-primary-inverted:#12151b;
  --dsw-alias-state-business-primary:#4c8dff; --dsw-alias-state-success-primary:#39b980;
  --dsw-alias-state-warn-primary:#d69e2e; --dsw-alias-state-error-primary:#e0574f;
  --dsw-alias-button-ghost-active-fill:#2a3040;
}
body{margin:0;padding:14px;background:#15181e;font:13px/1.4 system-ui,Segoe UI,sans-serif;color:var(--dsw-alias-label-primary)}
.shell{width:640px}
h2{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px}
</style><style>${css}</style></head><body>
<div class="shell">
  <h2>members — one compact line, plaque last</h2>
  <div class="${classes.delegationTree}">
    ${member({ name: 'impl-c1', role: 'Lane C1 implementer', model: 'deepseek-official/deepseek-v4-flash', action: 'action-working', activity: 'working', state: 'Working', count: '2/4', chips: [['t13', 'completed'], ['t37', 'running', ' · v4-flash'], ['t39', 'blocked']], active: true })}
    ${member({ name: 'impl-c2', role: 'Lane C2 implementer', model: 'openai/gpt-5.6-sol', action: 'action-thinking', activity: 'unknown', state: 'Pending', count: '1/2', chips: [['t14', 'blocked']], active: false })}
    ${member({ name: 'impl-d', role: 'Lane D implementer', model: 'grok/grok-4.6', action: 'action-sleeping', activity: 'idle', state: 'Delivered', count: '2/2', chips: [['t21', 'completed']], active: false })}
    ${member({ name: 'impl-b', role: 'Lane B implementer', model: '', action: 'action-sleeping', activity: 'idle', state: 'Awaiting assignment', count: '0/1', chips: [], active: false })}
  </div>

  <h2 style="margin-top:16px">phases — chains run left to right, columns stretch</h2>
  <div class="${classes.phaseBoardViewport}" data-phase-board>
    <div class="${classes.phaseBoardScroll}" data-phase-scroll>
      <div class="${classes.phaseHeaderRow}" style="width:${layout.width}px">
        ${layout.columns.map((column) => `<div class="${classes.phaseColumn}" style="left:${column.x}px;width:${column.width}px" data-phase-id="${column.phaseId}">
          <span class="${classes.phaseColumnHead}" title="${column.title ?? column.phaseId}">${column.title ?? column.phaseId}</span>
          <span class="${classes.phaseColumnCount}">${column.taskIds.length} tasks</span>
        </div>`).join('')}
      </div>
      <div class="${classes.dagCanvas}" data-layout="phases" style="width:${layout.width}px;height:${layout.height}px">
        <svg class="${classes.dagEdges}" width="${layout.width}" height="${layout.height}" aria-hidden>
          ${layout.edges.map((edge) => `<path d="${edge.path}" data-active="false"></path>`).join('')}
        </svg>
        ${layout.nodes.map(node).join('')}
      </div>
    </div>
    <p class="${classes.phaseHint}">Columns follow the declared phases; each one stretches to its longest chain.</p>
  </div>
</div>
</body></html>`

const dir = '.local/logs/ui-round2'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/phase-board.html`, html, 'utf8')
execFileSync('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=8000', '--window-size=700,520',
  `--screenshot=D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/phase-board.png`,
  `file:///D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/phase-board.html`,
], { stdio: 'ignore' })
console.log('rendered', `${dir}/phase-board.png`)
