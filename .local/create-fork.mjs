#!/usr/bin/env node
/**
 * Create the public fork WhiteWh/dsh-agent-teams from NanmiCoder/dsh-agent-teams.
 *
 * The token is taken from Git Credential Manager (non-interactive) so it never
 * appears on a command line, in a log, or in shell history. Diagnostics print
 * status codes and a redirect hint only — never the credential.
 *
 * Run: node .local/create-fork.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { spawnSync } = require('node:child_process')

const GCM = 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe'
const UPSTREAM = 'NanmiCoder/dsh-agent-teams'
const OWNER = 'WhiteWh'
const REPO = 'dsh-agent-teams'

const gcm = spawnSync(GCM, ['get'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
})
if (gcm.status !== 0) {
  console.error(`git-credential-manager get failed (exit ${gcm.status}): ${String(gcm.stderr).slice(0, 300)}`)
  process.exit(1)
}
const line = String(gcm.stdout).split('\n').find(item => item.startsWith('password='))
const token = line?.slice('password='.length).trim()
if (!token) {
  console.error('no stored GitHub credential; sign in with `git push` once, or create the fork in the web UI')
  process.exit(1)
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'dsh-agent-teams-fork-script',
}

const existing = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers })
if (existing.ok) {
  const repo = await existing.json()
  console.log(`fork already exists: ${repo.full_name} (fork=${repo.fork}, private=${repo.private})`)
  process.exit(0)
}

const created = await fetch(`https://api.github.com/repos/${UPSTREAM}/forks`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: REPO, default_branch_only: false }),
})
const text = await created.text()
if (!created.ok && created.status !== 202) {
  console.error(`fork request failed: ${created.status}`)
  console.error(text.slice(0, 500))
  process.exit(1)
}
const repo = JSON.parse(text)
console.log(`fork created: ${repo.full_name} (private=${repo.private}, default_branch=${repo.default_branch})`)
console.log(`clone url: ${repo.clone_url}`)
