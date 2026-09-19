#!/usr/bin/env node
/**
 * Documentation language gate.
 *
 * Fails when CJK text appears in a path that the policy in `AGENTS.md`
 * ("Documentation language policy") requires to be English-only. Paths that are
 * allowed to contain Chinese are listed in ALLOWED below with the reason, so the
 * exemption is explicit rather than accidental.
 *
 * Usage: node .local/lang-check.mjs [--list]
 *   --list  print every CJK-bearing file with its category instead of failing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zip', '.tgz'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'lib', '.git'])

/**
 * Paths allowed to contain CJK, with the reason. Anything not matched here is a
 * policy violation.
 */
const ALLOWED = [
  { match: /^skills\//, reason: 'vendored upstream skill files (preserve as-is)' },
  { match: /^\.dsh\/skills\//, reason: 'vendored skill mirror' },
  { match: /^docs\/(?:compatibility-audit|harness-0\.1\.5-rc\.1-audit|maintenance)-/, reason: 'dated Chinese audit, frozen' },
  { match: /^docs\/session-latency-audit-/, reason: 'dated Chinese audit, frozen' },
  { match: /^docs\/theme-support-/, reason: 'dated Chinese audit, frozen' },
  { match: /^docs\/upgrade-skill-study-/, reason: 'dated Chinese audit, frozen' },
  { match: /^docs\/releases\//, reason: 'release evidence, frozen' },
  { match: /^release-notes\/v0\.1\.(?:1[0-5]|15-alpha\.1)\.md$/, reason: 'historical release note, frozen' },
  { match: /^README_ZH\.md$/, reason: 'superseded Chinese README' },
  { match: /^LICENSE$/, reason: 'licence text, must stay verbatim' },
  { match: /^src\/client\/locales\.ts$/, reason: 'product UI dictionary (zh + en)' },
  { match: /^src\/client\/artwork\.ts$/, reason: 'CJK role matchers select the member illustration' },
  { match: /^src\/client\/ActivityPanel\.tsx$/, reason: 'strips a CJK subject prefix a model may emit' },
  { match: /^src\/quality-gates\.ts$/, reason: 'gate-test matcher patterns' },
  { match: /^scripts\//, reason: 'test fixtures and assertions exercise CJK input' },
  { match: /^\.local\//, reason: 'local notes may quote an upstream issue title' },
  { match: /^docs\/compatibility-audit-2026-09-05\/issues\.md$/, reason: 'issue table, frozen' },
]

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && !SKIP_EXTENSIONS.has(extname(entry.name))) out.push(full)
  }
  return out
}

const violations = []
const allowed = []
for (const file of walk(root)) {
  const path = relative(root, file).replaceAll('\\', '/')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (!CJK.test(text)) continue
  const rule = ALLOWED.find(candidate => candidate.match.test(path))
  if (rule === undefined) violations.push(path)
  else allowed.push({ path, reason: rule.reason })
}

if (process.argv.includes('--list')) {
  const byReason = new Map()
  for (const item of allowed) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
  console.log(`CJK-bearing files with an explicit exemption: ${allowed.length}`)
  for (const [reason, count] of [...byReason].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${String(count).padStart(3)}  ${reason}`)
  }
  if (violations.length > 0) {
    console.log(`\nViolations (must be translated or exempted): ${violations.length}`)
    for (const path of violations) console.log(`  ${path}`)
  }
  process.exitCode = violations.length > 0 ? 1 : 0
} else if (violations.length > 0) {
  console.error(`Documentation language check failed: ${violations.length} file(s) contain CJK without an exemption.`)
  for (const path of violations) console.error(`  - ${path}`)
  console.error('Translate the file to English, or add an explicit exemption in .local/lang-check.mjs with a reason.')
  process.exitCode = 1
} else {
  console.log('Documentation language check passed: every CJK-bearing file is exempt by policy.')
}
