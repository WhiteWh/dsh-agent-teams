// Local one-shot: print the 0.2.1 locale lines this step must restore.
import { execFileSync } from 'node:child_process'

const source = execFileSync('git', ['show', '09ac60e:src/client/locales.ts'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const keys = ['member.status.', 'assignment.']
for (const line of source.split(/\r?\n/)) {
  if (keys.some((key) => line.includes(`'${key}`))) console.log(line)
}
