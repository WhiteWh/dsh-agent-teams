#!/usr/bin/env node
/**
 * Snapshot the upstream AgentTeams open-issue work queue.
 *
 * Why this exists: this checkout is a pristine upstream clone that we intend to
 * patch locally, so the upstream open-bug list is the work queue. GitHub's HTML
 * issue list is 60+ KB per page and awkward to search offline; this writes one
 * row per item into .local/upstream-issues.md for grepping and for choosing the
 * next fix.
 *
 * Two environment facts shape this script (both measured on this machine):
 *   - Node's built-in fetch works, while the HTTPS stacks in PowerShell's
 *     Invoke-WebRequest and curl.exe do not (schannel cannot acquire
 *     credentials in this sandbox). So the download is native fetch, not curl.
 *   - Node's child_process cannot spawn anything under the sandbox (EPERM on
 *     the stdio pipe), so nothing here shells out.
 *
 * Run: node .local/fetch-upstream-issues.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const url = 'https://api.github.com/repos/NanmiCoder/dsh-agent-teams/issues?state=open&per_page=100&sort=created&direction=desc'

const response = await fetch(url, {
  headers: { 'User-Agent': 'dsh-agent-teams-local', Accept: 'application/vnd.github+json' },
})
if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
const issues = await response.json()
if (!Array.isArray(issues)) throw new Error('expected a JSON array of issues')

const rows = issues.map((issue) => ({
  number: issue.number,
  kind: issue.pull_request ? 'PR' : 'issue',
  created: issue.created_at.slice(0, 10),
  comments: issue.comments,
  title: issue.title.replace(/\s+/g, ' '),
}))

const lines = [
  '# Upstream open issues and pull requests',
  '',
  `Source: ${url}`,
  `Fetched: ${new Date().toISOString()}`,
  `Count: ${rows.length}`,
  '',
  'Fetch the body of one item with:',
  '`node -e "fetch(\'https://api.github.com/repos/NanmiCoder/dsh-agent-teams/issues/<n>\').then(r=>r.text()).then(t=>console.log(t))"`',
  '',
  '| # | kind | created | comments | title |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.number} | ${r.kind} | ${r.created} | ${r.comments} | ${r.title.replace(/\|/g, '\\|')} |`),
  '',
]

writeFileSync(join(here, 'upstream-issues.json'), `${JSON.stringify(issues, null, 2)}\n`, 'utf8')
const target = join(here, 'upstream-issues.md')
writeFileSync(target, lines.join('\n'), 'utf8')
console.log(`wrote ${target} (${rows.length} rows)`)
