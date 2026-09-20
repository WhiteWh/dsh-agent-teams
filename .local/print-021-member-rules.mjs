// Local one-shot: print the 0.2.1 rules that place the member portrait, the info
// column, the plaque and the assignment line inside the row grid.
import { readFileSync } from 'node:fs'

const css = readFileSync('.local/logs/css-021.css', 'utf8')
const selectors = [
  '.memberRow > .memberAvatar',
  '.memberRow > .memberInfo',
  '.memberRow > .memberCount',
  '.memberRow > .workBar',
  '.memberRow > .assignmentLine',
  '.memberAvatar .memberArt',
  '.memberRow[',
  '.memberRow:',
  '.memberRow >',
]
for (const selector of selectors) {
  const lines = css.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith(selector.replace(' >', '')) && !lines[index].startsWith(selector)) continue
    if (!lines[index].includes('{') && !/,$/.test(lines[index])) continue
    const block = []
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      block.push(lines[cursor])
      if (lines[cursor].includes('}')) break
    }
    console.log(block.join('\n'))
    console.log('')
  }
}
