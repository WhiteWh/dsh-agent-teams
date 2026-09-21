/**
 * Local preview: one progress bar split into the plan's phases, each zone filled with its
 * own percentage, the overall number on its own line. Rendered from the built bundle with
 * the real stylesheet.   .local\pnpm.cmd build && node .local/preview-phases-bar.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')
const names = ['progressOverview', 'progressTitle', 'progressBarBlock', 'progressBar', 'progressSegment',
  'progressSegmentFill', 'progressSegmentLegend', 'progressSegmentKey', 'progressPercent', 'progressModeButton',
  'progressSegments', 'progressLegend', 'progressSummary', 'progressSummaryDot']
const classes = {}
for (const name of names) {
  const match = new RegExp(`\\.(_[A-Za-z0-9]+_${name})\\b`).exec(bundle)
  if (match === null) throw new Error(`class not found: ${name}`)
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

const phases = [
  { label: 'Φ0 — recon', percent: 100, completed: 6, total: 6 },
  { label: 'Φ1 — build', percent: 62, completed: 8, total: 13 },
  { label: 'Φ2 — light', percent: 33, completed: 4, total: 12 },
  { label: 'unphased', percent: 0, completed: 0, total: 5 },
]
const overall = { percent: 58, completed: 18, total: 36 }

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
</style><style>${css}</style></head><body>
<div class="shell"><section class="${classes.progressOverview}" data-progress-summary>
  <span class="${classes.progressTitle}">Overall progress</span>
  <span class="${classes.progressBarBlock}" data-progress-bar="${overall.percent}">
    <span class="${classes.progressBar}" data-progress-segments data-progress-split="phase">
      ${phases.map((phase, index) => `<span class="${classes.progressSegment}" data-phase="${phase.label}" data-phase-index="${index}" style="flex-grow:${phase.total};background:none" title="${phase.label} · ${phase.percent}% · ${phase.completed}/${phase.total}"><span class="${classes.progressSegmentFill}" style="width:${phase.percent}%;background:${['#4c8dff', '#39b980', '#d69e2e', '#e0574f'][index % 4]}" data-segment-fill="${phase.label}"></span></span>`).join('')}
    </span>
    <button type="button" class="${classes.progressModeButton}" data-progress-mode="byKind">By kind</button>
  </span>
  <span class="${classes.progressPercent}" data-progress-overall>${overall.percent}% · ${overall.completed}/${overall.total}</span>
  <span class="${classes.progressSegmentLegend}" data-progress-phase-legend>
    ${phases.map((phase, index) => `<span class="${classes.progressSegmentKey}" data-phase-index="${index}">${phase.label} ${phase.percent}% · ${phase.completed}/${phase.total}</span>`).join('')}
  </span>
  <span class="${classes.progressSegments}" aria-hidden>${Array.from({ length: 24 }, (_, index) => `<span data-state="${index < 18 ? 'completed' : index < 21 ? 'running' : 'blocked'}"></span>`).join('')}</span>
  <span class="${classes.progressLegend}"><span data-state="running">■ In progress 3</span><span data-state="blocked">■ Waiting 3</span><span data-state="completed">■ Delivered 18</span></span>
  <span class="${classes.progressSummary}" data-state="running"><span class="${classes.progressSummaryDot}"></span><span>t221 ready to start</span></span>
</section></div>
</body></html>`

const dir = '.local/logs/ui-phases-bar'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/phases-bar.html`, html, 'utf8')
execFileSync('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=6000', '--window-size=700,260',
  `--screenshot=D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/phases-bar.png`,
  `file:///D:/OwlCats/AI_Tools/dsh-agent-teams/${dir}/phases-bar.html`,
], { stdio: 'ignore' })
console.log('rendered', `${dir}/phases-bar.png`)
