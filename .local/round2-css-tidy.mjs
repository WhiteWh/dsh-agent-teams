/**
 * Round 2 tidy-up of the panel stylesheet: collapse the blank hole the removed
 * queue/switcher blocks left behind, re-label the section banner, and give the
 * phase board's own hint line the rule the component actually renders
 * (`css.phaseHint`), which the old shared `.viewHint` used to provide.
 */
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../src/client/ActivityPanel.module.css', import.meta.url)
let css = await readFile(file, 'utf8')
const before = css.length

const banner = '/* ── WP10: view switcher, phases, agents, queues (read-only cuts) ── */'
if (!css.includes(banner)) throw new Error('section banner not found')
css = css.replace(banner, '/* ── WP10: the phase board (the panel\'s only graph view) ── */')
css = css.replace(/── \*\/\r?\n(?:\r?\n){2,}(?=\.phaseBoardViewport)/u, '── */\n\n')

const hint = `/* The board's own footnote: it explains that columns are derived from the DAG,
   so it belongs to the board rather than to a view switcher that no longer is. */
.phaseHint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 9.5px;
  line-height: 14px;
}

.phaseBoardViewport {`
if (!css.includes('\n.phaseBoardViewport {')) throw new Error('phase board block not found')
if (css.includes('.phaseHint {')) throw new Error('phaseHint already present')
css = css.replace('\n.phaseBoardViewport {', `\n${hint}`)

await writeFile(file, css)
console.log(`ActivityPanel.module.css: ${before} -> ${css.length} bytes`)
