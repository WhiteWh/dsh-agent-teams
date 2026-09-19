#!/usr/bin/env node
/**
 * Browser-cache forensics: which bytes did the browser really store for a URL?
 *
 * Chrome's simple cache keeps the key (URL) and the payload inside one entry
 * file, so a raw scan finds the URL and every embedded PNG. Extracted PNGs are
 * hashed, which answers "is the browser showing the old artwork?" without
 * DevTools.
 *
 * Usage:
 *   node .local/scan-browser-cache.mjs <cacheDir> <urlFragment> <pngToCompare...>
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [dir, needle, ...references] = process.argv.slice(2)
if (dir === undefined || needle === undefined) {
  console.error('usage: node .local/scan-browser-cache.mjs <cacheDir> <urlFragment> [pngToCompare...]')
  process.exit(1)
}

const known = new Map()
for (const file of references) {
  const bytes = readFileSync(file)
  for (const png of extractPngs(bytes)) known.set(sha256(png), file)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Every complete PNG in a byte blob (signature .. IEND). */
function extractPngs(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const end = Buffer.from('IEND\xaeB`\x82', 'latin1')
  const found = []
  let from = 0
  for (;;) {
    const start = buffer.indexOf(signature, from)
    if (start < 0) return found
    const stop = buffer.indexOf(end, start)
    if (stop < 0) return found
    found.push(buffer.subarray(start, stop + end.length))
    from = stop + end.length
  }
}

function walk(current, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const files = walk(dir)
let hits = 0
let scanned = 0
for (const file of files) {
  let bytes
  try {
    if (statSync(file).size === 0) continue
    bytes = readFileSync(file)
  } catch {
    continue
  }
  scanned += 1
  if (!bytes.includes(needle)) continue
  hits += 1
  console.log(`\n[hit] ${file}  (${bytes.length} bytes)`)
  const pngs = extractPngs(bytes)
  if (pngs.length === 0) console.log('      URL present, no complete PNG payload in this entry')
  for (const png of pngs) {
    const hash = sha256(png)
    const match = known.get(hash)
    console.log(`      png ${String(png.length).padStart(8)} bytes  ${hash.slice(0, 16)}  ${match ?? 'NOT one of the compared files'}`)
  }
}
console.log(`\nscanned ${scanned} cache files, ${hits} contained ${JSON.stringify(needle)}`)
