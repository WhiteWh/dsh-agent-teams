// Local one-shot: keep ONE colour mechanism for the phase zones — the inline custom
// property — and drop the earlier per-index selector rules that fight it.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/ActivityPanel.module.css'
let css = readFileSync(file, 'utf8')
const before = css.length
const pattern = /\n?\.progressSegment\[data-phase-index='\d'\] \.progressSegmentFill \{ background: [^}]+\}\n?/gu
const fills = [...css.matchAll(pattern)].length
css = css.replace(pattern, '\n')
const legendPattern = /\n?\.progressSegmentKey\[data-phase-index='\d'\]::before \{ background: [^}]+\}\n?/gu
const keys = [...css.matchAll(legendPattern)].length
css = css.replace(legendPattern, '\n')
// A legend swatch takes the same variable as its zone.
if (!css.includes('.progressSegmentKey[data-phase]::before')) {
  css = css.replace('.progressSegmentKey::before {', ".progressSegmentKey[data-phase]::before {\n  background: var(--agent-teams-phase, var(--dsw-alias-state-business-primary));\n}\n\n.progressSegmentKey::before {")
}
css = css.replace(/\n{3,}/gu, '\n\n')
writeFileSync(file, css)
console.log(`removed ${String(fills)} fill rules and ${String(keys)} swatch rules; ${String(before)} -> ${String(css.length)} bytes`)
