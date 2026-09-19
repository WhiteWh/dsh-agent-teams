// Local one-shot: drop the CSS the removed views owned (view switcher, view hint,
// queues table) and the member-row blocks the compact row no longer uses
// (status line, role label, assignment label). Removals are anchor-driven and the
// file is written back as UTF-8.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/ActivityPanel.module.css'
const lines = readFileSync(file, 'utf8').split('\n')

/** The block that starts at a selector line and ends at its closing brace. */
function blockRange(selector) {
  const start = lines.findIndex(line => line.startsWith(selector))
  if (start === -1) throw new Error(`missing selector ${selector}`)
  let end = start
  while (end < lines.length && lines[end].trim() !== '}') end += 1
  return { start, end: end + 1 }
}
const ranges = [
  blockRange('.viewSwitcher {'),
  blockRange('.viewTab {'),
  blockRange('.viewTab:hover {'),
  blockRange(".viewTab[data-active='true'] {"),
  blockRange('.viewTab:focus-visible {'),
  blockRange('.viewHint {'),
  blockRange('.queueDot {'),
  blockRange('.queueView {'),
  blockRange('.queueHeadline {'),
  blockRange('.queueIdleCount {'),
  blockRange('.queueGroup {'),
  blockRange(".queueGroup[data-reason='queue.idle.blockedBy'] {"),
  blockRange('.queueTable {'),
  blockRange('.queueRow {'),
  blockRange('.queueRow[data-head] {'),
  blockRange(".queueRow[data-idle='true']:not([data-head]) {"),
  blockRange('.queueMember {'),
  blockRange('.queueCell {'),
  blockRange('.queueReason {'),
  blockRange(".queueReason[data-reason='queue.idle.blockedBy'] {"),
  blockRange('.memberStatusLine {'),
  blockRange('.memberRole {'),
]
const drop = new Set()
for (const range of ranges) {
  for (let at = range.start; at < range.end; at += 1) drop.add(at)
}
// The queue stylesheet section also carries small follow-up selectors; report any
// line that still mentions a removed class so nothing is left half-deleted.
const kept = lines.filter((line, index) => !drop.has(index))
const leftovers = kept
  .map((line, index) => ({ line, index }))
  .filter(entry => /\.(queue|viewTab|viewSwitcher|viewHint)[A-Za-z]*\b|\.memberStatusLine\b|\.memberRole\b/u.test(entry.line))
console.log('leftovers:', leftovers.map(entry => `${entry.index + 1}: ${entry.line.trim()}`).join(' | ') || 'none')
writeFileSync(file, kept.join('\n'), 'utf8')
console.log('removed', drop.size, 'lines; file now', kept.length, 'lines')
