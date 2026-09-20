/**
 * Read-only diagnosis: can the installed 0.2.2 client bundle be satisfied by the
 * host packages this profile actually has?
 *
 * The plugin's client half is one bundle registered through the host's module
 * loader, so every `@deepseek-ai/...` specifier it requires at runtime must exist
 * as an installed package that exposes a `client` entry. A specifier the bundle
 * needs but the profile cannot resolve is a load-time failure of the whole web
 * client — a blocked app, not a broken panel.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const profile = 'C:/Users/whitl/.dsh/profiles/web'
const installed = join(profile, 'node_modules/@nanmicoder/dsh-agent-teams')
const hosts = {
  '0.2.2 (installed)': join(installed, 'lib/client.js'),
  '0.2.2 (tarball copy)': 'D:/OwlCats/AI_Tools/dsh-agent-teams/lib/client.js',
}

const specifierPattern = /['"](@deepseek-ai\/[^'"]+)['"]/gu
const requirePattern = (spec) => new RegExp(`require\\(\\s*['"]${spec.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`, 'gu')

for (const [label, file] of Object.entries(hosts)) {
  if (!existsSync(file)) {
    console.log(`${label}: missing (${file})`)
    continue
  }
  const bundle = readFileSync(file, 'utf8')
  const specifiers = [...new Set([...bundle.matchAll(specifierPattern)].map((match) => match[1]))].sort()
  console.log(`\n=== ${label} — ${String(bundle.length)} bytes ===`)
  for (const spec of specifiers) {
    const requires = [...bundle.matchAll(requirePattern(spec))].length
    const packageName = spec.split('/').slice(0, 2).join('/')
    const packageDir = join(profile, 'node_modules', packageName)
    const packageJsonPath = join(packageDir, 'package.json')
    let resolved = 'NOT INSTALLED'
    if (existsSync(packageJsonPath)) {
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
      const subpath = spec.startsWith(`${packageName}/`) ? `./${spec.slice(packageName.length + 1)}` : '.'
      const exported = manifest.exports?.[subpath]
      resolved = `v${manifest.version} exports[${subpath}]=${exported === undefined ? 'ABSENT' : 'ok'}`
    }
    console.log(`  ${spec.padEnd(56)} require-calls=${String(requires)}  ${resolved}`)
  }
}

// The manifest the host reads to know what to inject.
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
console.log('\n=== installed manifest: dsh.client.inject ===')
console.log(JSON.stringify(manifest.dsh?.client, null, 2))
console.log('\n=== host client packages present in the profile ===')
const scopeDir = join(profile, 'node_modules/@deepseek-ai')
if (existsSync(scopeDir)) {
  for (const name of readdirSync(scopeDir).sort()) {
    if (!/client|ui-|session|api-/.test(name)) continue
    const packageJsonPath = join(scopeDir, name, 'package.json')
    if (!existsSync(packageJsonPath)) continue
    const hostManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const hasClient = hostManifest.exports?.['./client'] !== undefined
    console.log(`  ${name.padEnd(46)} v${String(hostManifest.version).padEnd(12)} ./client ${hasClient ? 'yes' : 'no'}`)
  }
}
