/**
 * Shared mascot artwork lookup for the activity panel and the conversation
 * card: role keywords map to the packaged role images; the captain always
 * uses the lead mascot.
 *
 * Two packs are served from the same route: the amber terminal mascot carries
 * the member identity at full size, while the standalone role symbol marks the
 * same role in the small corner badge. The symbols exist as a separate pack
 * because a mascot scaled down to badge size is unreadable.
 *
 * Every URL ends with `?v=<ART_REVISION>`. The file names are stable across
 * packs — the whale and the amber terminal are both `member-engineer-v2.png` —
 * so without a revision a browser that cached the previous artwork keeps
 * drawing it for the whole `cache-control` lifetime, and a redeployed panel
 * looks unchanged. `scripts/art-revision.mjs` derives the revision from the
 * packaged bytes and both `pnpm build` and `scripts/verify.mjs` fail when the
 * committed value goes stale.
 * @module dsh-agent-teams/client/artwork
 */

import { ART_REVISION } from './art-revision.ts'

/** Artwork route prefix served by the plugin host half. */
export const ART_BASE = '/plugins/dsh-agent-teams/assets/'

/**
 * One packaged artwork file as an absolute, cache-busting URL.
 * @param file - packaged image name, for example `member-qa-v2.png`.
 * @returns the revisioned URL the panel renders.
 */
function artUrl(file: string): string {
  return `${ART_BASE}${file}?v=${ART_REVISION}`
}

/** Terminal mascot role artwork per role keyword. */
const ROLE_ART: ReadonlyArray<readonly [RegExp, string]> = [
  [/data|analys|metric|performance|数据|分析|指标|性能/, 'member-data-v2.png'],
  [/resear|investig|explor|study|研究|调查|探索|调研/, 'member-researcher-v2.png'],
  // Match compound QA titles (for example "QA Engineer") before the broad
  // engineer bucket, otherwise an eight-role roster repeats the engineer art.
  [/\bqa\b|test|verif|quality|测试|质量|验证/, 'member-qa-v2.png'],
  [/engineer|dev\b|server|backend|\bapi\b|runtime|watcher|contract|工程|后端|服务|接口|开发|代码|编程/, 'member-engineer-v2.png'],
  [/design|\bui\b|\bux\b|front|theme|accessib|设计|前端|主题|无障碍/, 'member-designer-v2.png'],
  [/secur|audit|risk|threat|review|安全|审计|审查|风险/, 'member-security-v2.png'],
  [/docs|writer|product|spec|撰写|文案|写作|文档|规范/, 'member-docs-v2.png'],
  [/release|\bbuild\b|deploy|\bops\b|\bci\b|ship|coordin|发布|构建|部署|运维|协调/, 'member-operator-v2.png'],
]

/** Captain artwork (always the lead mascot). */
export const LEAD_ART = artUrl('team-lead-v2.png')

/**
 * Role symbol for the small corner badge, derived from the mascot file name.
 *
 * The symbol pack ships the same nine role names, so the mapping stays a pure
 * extension of the role table above and cannot drift away from it.
 * @param artName - packaged mascot file name, for example `member-qa-v2.png`.
 * @returns the matching symbol URL.
 */
function symbolFor(artName: string): string {
  return artUrl(artName.replace(/-v2\.png$/u, '-symbol.png'))
}

/** Captain role symbol for the corner badge (always the lead symbol). */
export const LEAD_SYMBOL = symbolFor('team-lead-v2.png')

/**
 * Role text that means "this member is the lead".
 *
 * Checked against the role alone, not against `name + role`: a member may
 * legitimately be *called* Lead while holding an ordinary role, and the symbol
 * pack has a dedicated lead mark that such a member must not steal. The
 * vocabulary mirrors the lead aliases used elsewhere in the plugin and keeps
 * the CJK terms the existing role table already matches.
 */
const LEAD_ROLE = /lead|captain|队长|组长/u

/** Status action artwork per member activity. */
export const ACTION_ART: Record<'working' | 'idle' | 'unknown', string> = {
  working: artUrl('action-working-v2.png'),
  idle: artUrl('action-sleeping-v2.png'),
  unknown: artUrl('action-thinking-v2.png'),
}

/**
 * Standalone action symbol per member activity, drawn in the small corner
 * badge. A mascot scaled to badge size reads as a smudge; the symbol pack
 * exists for exactly this slot, the same reason the role symbol does.
 */
export const ACTION_SYMBOL: Record<'working' | 'idle' | 'unknown', string> = {
  working: symbolFor('action-working-v2.png'),
  idle: symbolFor('action-sleeping-v2.png'),
  unknown: symbolFor('action-thinking-v2.png'),
}

/**
 * Member role symbol, or null when no role matches. Null means the caller
 * renders its own fallback (an initial letter on the avatar, a plain dot in a
 * dense list) rather than a symbol for a role we did not match.
 *
 * Since v0.1.22 this is the *compact* mark: the avatar no longer draws it — the
 * row names the role in words — and the dense surfaces do, where neither the
 * mascot nor the label fits.
 * @param name - the member's display name.
 * @param role - the member's role text.
 * @returns the role symbol URL, or null when unmatched.
 */
export function memberSymbolUrl(name: string, role: string): string | null {
  // Match case-insensitively, like the role table below: role text reaches this
  // function as written by the captain ("Team Lead", "Captain"), never folded.
  if (LEAD_ROLE.test(role.toLowerCase())) return LEAD_SYMBOL
  const identity = `${name} ${role}`.toLowerCase()
  for (const [pattern, art] of ROLE_ART) {
    if (pattern.test(identity)) return symbolFor(art)
  }
  return null
}

/** Task owner that means "the captain holds it", as written in the team state. */
const CAPTAIN_ASSIGNEE = 'captain'

/**
 * Compact identity mark for one task owner: the captain's lead mark, or the
 * role symbol of the named member.
 *
 * Dense surfaces — a DAG node head, an assignment line, a queue row — have room
 * for a 12px mark but not for the mascot or a role label, so they draw this. A
 * null answer means "no mark we can draw": an unclaimed task, or a member whose
 * role matched no keyword. Callers keep their own fallback (a coloured dot).
 * @param assignee - the task's owner as stored in the team state.
 * @param members - the team roster used to resolve a name to its role.
 * @returns the compact mark URL, or null when the owner has none.
 */
export function ownerSymbolUrl(
  assignee: string,
  members: readonly { readonly name: string; readonly role: string }[],
): string | null {
  const owner = assignee.trim()
  if (owner === '') return null
  if (owner.toLowerCase() === CAPTAIN_ASSIGNEE) return LEAD_SYMBOL
  const member = members.find(candidate => candidate.name === owner)
  return member === undefined ? null : memberSymbolUrl(member.name, member.role)
}

/**
 * Member artwork URL, or null when no role matches (initial-letter fallback).
 * @param name - the member's display name.
 * @param role - the member's role text.
 * @returns the artwork URL, or null when unmatched.
 */
export function memberArtUrl(name: string, role: string): string | null {
  const identity = `${name} ${role}`.toLowerCase()
  for (const [pattern, art] of ROLE_ART) {
    if (pattern.test(identity)) return artUrl(art)
  }
  return null
}
