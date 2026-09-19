/**
 * Packaged artwork route for the activity panel.
 *
 * The client builds every URL from `assets/agent-teams/` and appends the pack
 * revision as `?v=<revision>` (see `src/client/artwork.ts`), so the request URL
 * carries a query the file lookup must ignore. Only the allowlisted file names
 * are servable: the path never reaches the filesystem, which is what keeps a
 * traversal attempt a plain 404.
 *
 * The response is cacheable by name. That is safe *because* the client
 * revisions its URLs: a redrawn pack is a different URL, while an unchanged one
 * is served from the browser cache for a day without a round trip.
 * @module dsh-agent-teams/artwork
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Packaged artwork the host half is willing to serve, and nothing else. */
export const ART_ALLOWLIST: ReadonlySet<string> = new Set([
  'team-lead-v2.png',
  'member-researcher-v2.png', 'member-engineer-v2.png',
  'member-qa-v2.png', 'member-designer-v2.png',
  'member-security-v2.png', 'member-docs-v2.png',
  'member-data-v2.png', 'member-operator-v2.png',
  'action-working-v2.png', 'action-thinking-v2.png',
  'action-reporting-v2.png', 'action-celebrating-v2.png',
  'action-sleeping-v2.png', 'action-sending-v2.png',
  'team-lead-symbol.png',
  'member-researcher-symbol.png', 'member-engineer-symbol.png',
  'member-qa-symbol.png', 'member-designer-symbol.png',
  'member-security-symbol.png', 'member-docs-symbol.png',
  'member-data-symbol.png', 'member-operator-symbol.png',
  'action-working-symbol.png', 'action-thinking-symbol.png',
  'action-reporting-symbol.png', 'action-celebrating-symbol.png',
  'action-sleeping-symbol.png', 'action-sending-symbol.png',
])

/** The slice of a node response this route writes. */
export interface ArtworkResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: Uint8Array | string): void
}

/**
 * Serve one artwork request: the allowlisted file named by the path, or 404.
 * @param dir - absolute directory holding the packaged images.
 * @param req - request whose `url` may carry the `?v=` revision.
 * @param res - response sink.
 * @param warn - logger used when an allowlisted file cannot be read.
 */
export async function serveArtwork(
  dir: string,
  req: { url?: string },
  res: ArtworkResponse,
  warn: (message: string) => void = () => {},
): Promise<void> {
  let name: string
  try {
    name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '')
  } catch {
    // Malformed percent-encoding: treat as an unknown asset, not a 400.
    res.writeHead(404)
    res.end()
    return
  }
  if (!ART_ALLOWLIST.has(name)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const data = await readFile(join(dir, name))
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
    })
    res.end(data)
  } catch (error: unknown) {
    warn(`agent-teams: artwork read failed for ${name}: ${String(error)}`)
    res.writeHead(404)
    res.end()
  }
}
