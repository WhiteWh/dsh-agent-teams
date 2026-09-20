// Local one-shot: print every current rule whose selector mentions a member or the
// state artwork, so the two variant layouts can be written without guessing.
import { readFileSync } from 'node:fs'

const css = readFileSync('src/client/ActivityPanel.module.css', 'utf8')
const blocks = css.split(/\r?\n\r?\n/)
for (const block of blocks) {
  const head = block.slice(0, block.indexOf('{')).trim()
  if (head === '' || head.startsWith('/*')) continue
  if (!/member|stateArt|workBar|assignment|delegationTree|taskEmpty/.test(head)) continue
  console.log(block.trim())
  console.log('')
}
