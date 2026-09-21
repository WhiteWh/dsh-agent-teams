// Local one-shot: move the context-artifact pointer to the 0.4.0 release notes.
import { readFileSync, writeFileSync } from 'node:fs'

const file = '.socraticodecontextartifacts.json'
let text = readFileSync(file, 'utf8')
if (text.includes('./release-notes/v0.4.0.md')) {
  console.log('already at 0.4.0')
} else {
  const before = text
  text = text.replace('"./release-notes/v0.3.0.md"', '"./release-notes/v0.4.0.md"')
  if (text === before) throw new Error('the 0.3.0 pointer was not found')
  writeFileSync(file, text)
  console.log('pointer moved to ./release-notes/v0.4.0.md')
}
