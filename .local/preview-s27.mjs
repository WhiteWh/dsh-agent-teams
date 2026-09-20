/**
 * Round 3 preview #2 (local helper, never packaged): the three-colour progress bar
 * and a closed phase column, rendered from the built bundle with the real CSS.
 *
 *   .local\pnpm.cmd build && node .local/preview-s27.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')
const names = ['progressOverview', 'progressTitle', 'progressBarBlock', 'progressBar', 'progressSegment',
  'progressSegmentFill', 'progressSegmentLegend', 'progressSegmentKey', 'progressPercent', 'progressModeButton',
  'progressSegments', 'progressLegend', 'progressSummary', 'progressSummaryDot',
  'phaseBoardViewport', 'phaseBoardScroll', 'phaseHeaderRow', 'phaseColumn', 'phaseColumnHead',
  'phaseColumnCount', 'phaseClosedMark', 'dagCanvas', 'dagEdges', 'dagNode', 'dagNodeHead', 'dagNodeDot',
  'dagNodeLabel', 'phaseHint']
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

const segments = [
  { origin: 'plan', completed: 14, total: 16, percent: 88 },
  { origin: 'added', completed: 3, total: 5, percent: 60 },
  { origin: 'followup', completed: 1, total: 3, percent: 33 },
]
const labels = { plan: 'Original plan', added: 'Added while running', followup: 'Added after the plan' }
const total = segments.reduce((sum, segment) => sum + segment.total, 0)
const completed = segments.reduce((sum, segment) => sum + segment.completed, 0)
const percent = Math.round((completed / total) * 100)

const phaseColumn = (id, title, count, x, width, closed) => `
        <div class="${classes.phaseColumn}" style="left:${x}px;width:${width}px" data-phase-id="${id}" data-closed="${closed}">
          <span class="${classes.phaseColumnHead}">${title}</span>
          <span class="${classes.phaseColumnCount}">${count} tasks</span>
          ${closed ? `<span class="${classes.phaseClosedMark}">Closed</span>` : ''}
        </div>`

const node = (id, label, x, y, state) => `
        <button type="button" class="${classes.dagNode}" style="left:${x}px;top:${y}px;width:92px;height:30px" data-state="${state}">
          <span class="${classes.dagNodeHead}"><span class="${classes.dagNodeDot}" style="background:#4c8dff"></span>${id}</span>
          <span class="${classes.dagNodeLabel}">${label}</span>
        </button>`

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
  <section class="${classes.progressOverview}" data-progress-summary>
    <span class="${classes.progressTitle}">Overall progress</span>
    <span class="${classes.progressBarBlock}" data-progress-bar="${percent}">
      <span class="${classes.progressBar}" data-progress-segments>
        ${segments.map((segment) => `<span class="${classes.progressSegment}" data-origin="${segment.origin}" style="flex-grow:${segment.total}" title="${labels[segment.origin]} · ${segment.percent}% · ${segment.completed}/${segment.total}"><span class="${classes.progressSegmentFill}" style="width:${segment.percent}%" data-segment-fill="${segment.origin}"></span></span>`).join('')}
      </span>
      <span class="${classes.progressPercent}">${percent}% · ${completed}/${total}</span>
      <button type="button" class="${classes.progressModeButton}" data-progress-mode="byKind">By kind</button>
    </span>
    <span class="${classes.progressSegmentLegend}" data-progress-segment-legend>
      ${segments.map((segment) => `<span class="${classes.progressSegmentKey}" data-origin="${segment.origin}">${labels[segment.origin]} ${segment.completed}/${segment.total}</span>`).join('')}
    </span>
    <span class="${classes.progressSegments}" aria-hidden>
      ${Array.from({ length: 24 }, (_, index) => `<span data-state="${index < 18 ? 'completed' : index < 21 ? 'running' : 'blocked'}"></span>`).join('')}
    </span>
    <span class="${classes.progressLegend}"><span data-state="running">■ In progress 1</span><span data-state="blocked">■ Waiting 1</span><span data-state="completed">■ Delivered 18</span></span>
    <span class="${classes.progressSummary}" data-state="running"><span class="${classes.progressSummaryDot}"></span><span>t45 ready to start</span></span>
  </section>

  <h2 style="margin-top:16px">phases — a closed column is settled history</h2>
  <div class="${classes.phaseBoardViewport}" data-phase-board>
    <div class="${classes.phaseBoardScroll}" data-phase-scroll>
      <div class="${classes.phaseHeaderRow}" style="width:470px">
        ${phaseColumn('E0', 'Phase 1 — recon', 2, 0, 210, true)}
        ${phaseColumn('E1', 'Phase 2 — build', 3, 236, 92, false)}
        ${phaseColumn('E2', 'Phase 3 — follow-up', 2, 354, 92, false)}
      </div>
      <div class="${classes.dagCanvas}" data-layout="phases" style="width:470px;height:68px">
        <svg class="${classes.dagEdges}" width="470" height="68" aria-hidden>
          <path d="M92 15C106 15,104 15,118 15"></path>
          <path d="M210 15C224 15,222 15,236 15"></path>
        </svg>
        ${node('t1', 'Recon', 0, 0, 'completed')}
        ${node('t2', 'Accept recon', 118, 0, 'completed')}
        ${node('t3', 'Build lane A', 236, 0, 'running')}
        ${node('t4', 'Build lane B', 236, 38, 'blocked')}
        ${node('t5', 'Follow-up', 354, 0, 'pending')}
      </div>
    </div>
    <p class="${classes.phaseHint}">Columns follow the declared phases; each one stretches to its longest chain.</p>
  </div>
</div>
</body></html>`

const dir = '.local/logs/ui-round3'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/progress-closed-phase.html`, html, 'utf8')
execFileSync('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=8000', '--window-size=720,520',
  `--screenshot=D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/progress-closed-phase.png`,
  `file:///D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/progress-closed-phase.html`,
], { stdio: 'ignore' })
console.log('rendered', `${dir}/progress-closed-phase.png`)
