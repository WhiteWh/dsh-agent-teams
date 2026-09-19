// Render the members tree (with the new full-height work plaque) using the real
// built CSS module sheet, the real artwork and headless Chrome, so the change can
// be looked at before it ships. Local-only helper; nothing here is packaged.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')
const names = ['memberBlock', 'memberBranch', 'memberRow', 'memberAvatar', 'memberArt', 'memberInitial', 'memberInfo',
  'memberLine', 'memberName', 'memberRole', 'memberModel', 'memberState', 'memberStatusLine', 'memberCount',
  'assignmentLine', 'assignmentLabel', 'assignmentTasks', 'assignmentChip', 'stateArt', 'delegationTree',
  'delegationSection', 'captainNode', 'captainAvatar', 'leadAvatar', 'captainInfo', 'captainLine', 'captainName',
  'captainRole', 'workBar', 'workBarRow', 'workBarDot']
const classes = {}
for (const name of names) {
  const match = new RegExp(`\\.(_[A-Za-z0-9]+_${name})\\b`).exec(bundle)
  if (match === null) throw new Error(`class not found in bundle: ${name}`)
  classes[name] = match[1]
}
console.log('plaque classes:', classes.workBar, classes.workBarRow, classes.workBarDot)

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
    if (depth === 0 && bundle.slice(i, i + 2) === '}\n') {
      end = i + 1
      break
    }
  }
}
const css = bundle.slice(start, end)

const dir = '.local/logs/ui-workbar'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/bundle.css`, css, 'utf8')

const art = 'file:///D:/OwlCats/AI_Tools/dsh-agent-teams/assets/agent-teams/'
const plaque = active => `
      <span class="${classes.workBar}" data-active="${active}" data-work-bar="${active}">
        ${[0, 1, 2, 3, 4].map(row => `
        <span class="${classes.workBarRow}">
          ${[0, 1, 2].map(() => `<span class="${classes.workBarDot}" style="animation-delay:${(row * 0.12).toFixed(2)}s"></span>`).join('')}
        </span>`).join('')}
      </span>`
const member = (name, role, artName, action, activity, chips, label, state, status, count) => `
<div class="${classes.memberBlock}" data-activity="${activity}">
  <span class="${classes.memberBranch}" aria-hidden><span></span></span>
  <button type="button" class="${classes.memberRow}" data-activity="${activity}">
    <span class="${classes.memberAvatar}">
      ${artName === 'none' ? '' : `<img class="${classes.memberArt}" src="${art}${artName}-v2.png" alt="">`}
      <img class="${classes.stateArt}" data-activity="${activity}" src="${art}${action}-symbol.png" alt="">
    </span>
    <span class="${classes.memberInfo}">
      <span class="${classes.memberLine}">
        <span class="${classes.memberName}">${name}</span>
        <span class="${classes.memberRole}">${role}</span>
        <span class="${classes.memberModel}" role="img">deepseek-v4-flash</span>
        <span class="${classes.memberState}" data-activity="${activity}">${state}</span>
      </span>
      <span class="${classes.memberStatusLine}">${status}</span>
    </span>
    <span class="${classes.memberCount}">${count}</span>
    ${plaque(activity === 'working')}
    <span class="${classes.assignmentLine}">
      <span class="${classes.assignmentLabel}">${label}</span>
      <span class="${classes.assignmentTasks}">${chips.map(id => `<span class="${classes.assignmentChip}" data-state="completed">${id}</span>`).join('')}</span>
    </span>
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
.shell{width:588px}
</style><style>${css}</style></head><body>
<div class="shell"><div class="${classes.delegationTree}">
${member('impl-c1', 'Lane C1 — docs/briefs/LAYERS_C1.md', 'member-engineer', 'action-working', 'working', ['t13', 't37', 't39'], 'Captain assigned', 'Working', 'Working on t39 · deepseek-official/deepseek-v4-flash', '2/4')}
${member('impl-c2', 'Lane C2 — docs/briefs/LAYERS_C2.md', 'member-engineer', 'action-thinking', 'unknown', ['t14'], 'Captain assigned', 'Ready to continue', 'Waiting for assignment', '1/2')}
${member('impl-d', 'Lane D — docs/briefs/LAYERS_D.md', 'member-engineer', 'action-sleeping', 'idle', ['t21'], 'Captain assigned', 'Delivered', 'Tasks delivered', '2/2')}
</div></div>
</body></html>`

writeFileSync(`${dir}/members-tree.html`, html, 'utf8')
execFileSync('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=8000', '--window-size=620,300',
  `--screenshot=D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/members-tree.png`,
  `file:///D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/members-tree.html`,
], { stdio: 'ignore' })
console.log('rendered', `${dir}/members-tree.png`)
