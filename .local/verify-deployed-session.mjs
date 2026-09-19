#!/usr/bin/env node
/**
 * Prove the deployed plugin actually loaded in a live session, without the GUI
 * token: read the session log, decompress it and look for the plugin's own
 * surfaces (tool names and the usage-prompt section it registers).
 *
 * Usage: node .local/verify-deployed-session.mjs <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('usage: node .local/verify-deployed-session.mjs <session.v3.jsonl.zstd>')
  process.exit(1)
}

// The log is a concatenation of independent zstd frames (one per flush), and
// node:zlib decodes only the first frame. Split on the frame magic and decode
// each piece on its own; a piece that fails is merged into the next attempt.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeAllFrames(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts.length === 0) return { text: '', frames: 0, failures: 0 }
  const chunks = []
  let frames = 0
  let failures = 0
  let index = 0
  while (index < starts.length) {
    const from = starts[index]
    let decoded = null
    let span = index
    while (span < starts.length && decoded === null) {
      const to = span + 1 < starts.length ? starts[span + 1] : buffer.length
      try {
        decoded = zstdDecompressSync(buffer.subarray(from, to))
      } catch {
        span += 1
      }
    }
    if (decoded === null) {
      failures += 1
      index += 1
      continue
    }
    chunks.push(decoded)
    frames += 1
    index = span + 1
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames, failures }
}

const { text, frames, failures } = decodeAllFrames(readFileSync(file))
const lines = text.split('\n').filter((line) => line.trim() !== '')
console.log(`log: ${file}`)
console.log(`zstd frames: ${frames} decoded, ${failures} unreadable`)
console.log(`records: ${lines.length}`)

const TOOLS = [
  'agent_teams_create', 'agent_teams_edit_plan', 'agent_teams_approve', 'agent_teams_add_member',
  'agent_teams_remove_member', 'agent_teams_create_task', 'agent_teams_reassign_task',
  'agent_teams_claim_task', 'agent_teams_update_task', 'agent_teams_amend_task',
  'agent_teams_send_message', 'agent_teams_status', 'agent_teams_resume', 'agent_teams_delete',
]
const found = TOOLS.filter((name) => text.includes(name))
console.log(`plugin tools present: ${found.length}/14`)
console.log(`  missing: ${TOOLS.filter((name) => !found.includes(name)).join(', ') || 'none'}`)

// The 0.1.21 surfaces: the waiver vocabulary only exists in this build.
const NEW_MARKERS = [
  'has unconfirmed waivers',
  'waiverConfirmation',
  'allowWaivers',
  'no_regression',
  'hasWaivers',
  'waived',
]
for (const marker of NEW_MARKERS) {
  console.log(`  0.1.21 marker ${marker.padEnd(24)} ${text.includes(marker) ? 'present' : 'absent'}`)
}
const usageSection = /AgentTeams captain protocol/.test(text)
console.log(`usage protocol section: ${usageSection ? 'present' : 'absent'}`)
const eventCount = (text.match(/agent-teams\//g) ?? []).length
console.log(`agent-teams/* event mentions: ${eventCount}`)

const ok = found.length === 14 && usageSection
console.log(ok
  ? 'RESULT: the plugin is loaded in this session.'
  : 'RESULT: plugin surfaces are incomplete — inspect the log before trusting the deploy.')
process.exitCode = ok ? 0 : 1
