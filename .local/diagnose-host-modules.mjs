/**
 * Read-only diagnosis #4: can the host's client module graph resolve
 * `@deepseek-ai/dsh-client-ui-primitives` — the one host module the plugin's client
 * bundle requires at load time?
 *
 * The package is not on disk as a directory, so either the shell bundle registers
 * that module id (fine) or the require fails and takes the whole web client with it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const hostScope = 'C:/Users/whitl/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const targets = ['@deepseek-ai/dsh-client-ui-primitives', 'IconStopFill16', 'IconWarningOutline16']
const wanted = new Set(targets)

const packages = readdirSync(hostScope).filter((name) => name.startsWith('dsh-'))
console.log(`scanning ${String(packages.length)} host packages for: ${targets.join(', ')}\n`)

/** Every file a package might ship its client half in. */
function candidateFiles(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = []
  for (const entry of Object.values(manifest.exports ?? {})) {
    const collect = (value) => {
      if (typeof value === 'string') files.push(join(packageDir, value))
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(entry)
  }
  if (manifest.main !== undefined) files.push(join(packageDir, manifest.main))
  return [...new Set(files)].filter((file) => existsSync(file) && statSync(file).size < 8 * 1024 * 1024)
}

const hits = new Map()
for (const name of packages) {
  const packageDir = join(hostScope, name)
  for (const file of candidateFiles(packageDir)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const target of wanted) {
      if (!text.includes(target)) continue
      const key = target
      const list = hits.get(key) ?? []
      list.push(`${name} → ${file.slice(hostScope.length + 1)}`)
      hits.set(key, list)
    }
  }
}

for (const target of targets) {
  const found = hits.get(target) ?? []
  console.log(`${target}:`)
  console.log(found.length === 0 ? '  no host package mentions it' : found.slice(0, 8).map((line) => `  ${line}`).join('\n'))
  console.log('')
}
