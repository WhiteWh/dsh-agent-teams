/**
 * Round 3 preview (local helper, never packaged): the large member node (the
 * default), the folded tray, the fold control and the collapsible phase header,
 * rendered from the built bundle with the real stylesheet and headless Chrome.
 *
 *   .local\pnpm.cmd build && node .local/preview-round3.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')
const names = ['memberBlock', 'memberBranch', 'memberRow', 'memberAvatar', 'memberArt', 'memberInitial',
  'memberRoleIcon', 'memberInfo', 'memberLine', 'memberName', 'memberRole', 'memberModel', 'memberStateIcon',
  'stateArt', 'memberState', 'memberStatusLine', 'memberCount', 'memberCollapse', 'assignmentLine',
  'assignmentLabel', 'assignmentTasks', 'assignmentChip', 'workBar', 'workBarRow', 'workBarDot',
  'delegationTree', 'chevron']
const classes = {}
for (const name of names) {
  const match = new RegExp(`\\.(_[A-Za-z0-9]+_${name})\\b`).exec(bundle)
  if (match === null) throw new Error(`class not found in bundle: ${name}`)
  classes[name] = match[1]
}

const cssStart = bundle.indexOf('._')
const marker = /\._[A-Za-z0-9]+_[A-Za-z]+\{/u.exec(bundle.slice(cssStart))
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

const art = 'file:///D:/OwlCats/AI_Tools/dsh-agent-teams/assets/agent-teams/'
const dots = (row) => [0, 1, 2].map(() => `<span class="${classes.workBarDot}" style="animation-delay:${(row * 0.12).toFixed(2)}s"></span>`).join('')
const plaque = (active) => `<span class="${classes.workBar}" data-active="${active}" data-work-bar="${active}">${[0, 1, 2]
  .map((row) => `<span class="${classes.workBarRow}">${dots(row)}</span>`).join('')}</span>`
const chevron = (open) => `<svg class="${classes.chevron}" data-open="${open}" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden><path d="M3.5 2l3 3-3 3"></path></svg>`
const chips = (list) => list.map(([id, state, extra]) => `<span class="${classes.assignmentChip}" data-state="${state}">${id}${extra ?? ''}</span>`).join('')

const node = ({ name, role, model, state, statusLine, count, tasks, active, compact, unread }) => `
<div class="${classes.memberBlock}" data-activity="${active ? 'working' : 'idle'}" data-compact="${compact}">
  <span class="${classes.memberBranch}" aria-hidden><span></span></span>
  <button type="button" class="${classes.memberCollapse}" data-member-collapse="${name}" aria-expanded="${!compact}" title="${compact ? 'Expand this member' : 'Collapse this member'}">${chevron(!compact)}</button>
  <button type="button" class="${classes.memberRow}" data-activity="${active ? 'working' : 'idle'}" data-compact="${compact}">
    ${compact ? `
      <span class="${classes.memberAvatar}" data-unread="${unread}"><img class="${classes.memberArt}" src="${art}member-engineer-v2.png" alt=""></span>
      <img class="${classes.memberRoleIcon}" src="${art}member-engineer-symbol.png" alt="" aria-hidden title="${role}">
      <span class="${classes.memberInfo}"><span class="${classes.memberLine}">
        <span class="${classes.memberName}">${name}</span>
        <span class="${classes.memberModel}" role="img" data-member-model="${model}">${model.split('/').pop()}</span>
        <span class="${classes.memberStateIcon}" data-activity="${active ? 'working' : 'idle'}">
          <img class="${classes.stateArt}" data-activity="${active ? 'working' : 'idle'}" src="${art}action-${active ? 'working' : 'sleeping'}-symbol.png" alt="" aria-hidden>
          <span class="${classes.memberState}">${state}</span>
        </span>
      </span></span>
      <span class="${classes.memberCount}">${count}</span>
      <span class="${classes.assignmentLine}"><span class="${classes.assignmentTasks}">${chips(tasks)}</span></span>
      ${plaque(active)}` : `
      <span class="${classes.memberAvatar}" data-unread="${unread}"><img class="${classes.memberArt}" src="${art}member-engineer-v2.png" alt="" aria-hidden><img class="${classes.stateArt}" data-activity="${active ? 'working' : 'idle'}" src="${art}action-${active ? 'working' : 'sleeping'}-symbol.png" alt="" aria-hidden></span>
      <span class="${classes.memberInfo}">
        <span class="${classes.memberLine}">
          <span class="${classes.memberName}">${name}</span>
          ${role === '' ? '' : `<span class="${classes.memberRole}">${role}</span>`}
          <span class="${classes.memberModel}" role="img" data-member-model="${model}">${model.split('/').pop()}</span>
          <span class="${classes.memberState}" data-activity="${active ? 'working' : 'idle'}">${state}</span>
        </span>
        <span class="${classes.memberStatusLine}">${statusLine}</span>
      </span>
      <span class="${classes.memberCount}">${count}</span>
      ${plaque(active)}
      <span class="${classes.assignmentLine}">
        <span class="${classes.assignmentLabel}">Captain assigned</span>
        <span class="${classes.assignmentTasks}">${chips(tasks)}</span>
      </span>`}
  </button>
</div>`

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
.shell{width:660px}
h2{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px}
</style><style>${css}</style></head><body>
<div class="shell">
  <h2>members — large by default, folded on demand</h2>
  <div class="${classes.delegationTree}">
    ${node({ name: 'impl-c1', role: 'Lane C1 implementer', model: 'deepseek-official/deepseek-v4-flash', state: 'Working', statusLine: 'Working on t39 · deepseek-v4-flash', count: '2/4', tasks: [['t13', 'completed'], ['t37', 'running', ' · v4-flash'], ['t39', 'blocked']], active: true, compact: false, unread: false })}
    ${node({ name: 'impl-c2', role: 'Lane C2 implementer', model: 'openai/gpt-5.6-sol', state: 'Pending', statusLine: 'Waiting for t14 · impl-c1', count: '1/2', tasks: [['t14', 'blocked']], active: false, compact: false, unread: true })}
    ${node({ name: 'impl-c1', role: 'Lane C1 implementer', model: 'deepseek-official/deepseek-v4-flash', state: 'Working', statusLine: 'Working on t39 · deepseek-v4-flash', count: '2/4', tasks: [['t13', 'completed'], ['t37', 'running', ' · v4-flash'], ['t39', 'blocked']], active: true, compact: true, unread: false })}
    ${node({ name: 'impl-d', role: 'Lane D implementer', model: 'grok/grok-4.6', state: 'Delivered', statusLine: 'Tasks delivered', count: '2/2', tasks: [['t21', 'completed']], active: false, compact: true, unread: false })}
  </div>
  <p style="color:var(--dsw-alias-label-tertiary);font-size:10px">rows 1–2 large (default), rows 3–4 folded into the tray by their chevron</p>
</div>
</body></html>`

const dir = '.local/logs/ui-round3'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/member-nodes.html`, html, 'utf8')
execFileSync('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=8000', '--window-size=720,560',
  `--screenshot=D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/member-nodes.png`,
  `file:///D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/member-nodes.html`,
], { stdio: 'ignore' })
console.log('rendered', `${dir}/member-nodes.png`)
console.log('classes:', classes.memberCollapse, classes.memberStatusLine, classes.memberRole)
