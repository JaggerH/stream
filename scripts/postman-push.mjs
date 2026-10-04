// Push the repo Postman collection (source of truth) to the cloud mirror.
// Convention: docs/postman.md — endpoint changes edit the repo JSON first, then run this.
//   node scripts/postman-push.mjs
// Auth: POSTMAN_API_KEY env var, falling back to the postman MCP server's env in ~/.claude.json.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const COLLECTION_UID = '32927570-2df427de-4f9b-4746-8483-cb01ebbfcded' // `stream` in My Workspace
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const collectionPath = join(repoRoot, 'docs/postman/stream.postman_collection.json')

function apiKey() {
  if (process.env.POSTMAN_API_KEY) return process.env.POSTMAN_API_KEY
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
    const key = cfg.mcpServers?.postman?.env?.POSTMAN_API_KEY
    if (key) return key
  } catch { /* fall through */ }
  console.error('No POSTMAN_API_KEY (env or ~/.claude.json mcpServers.postman.env)')
  process.exit(1)
}

const collection = JSON.parse(readFileSync(collectionPath, 'utf8'))
const res = await fetch(`https://api.getpostman.com/collections/${COLLECTION_UID}`, {
  method: 'PUT',
  headers: { 'X-Api-Key': apiKey(), 'content-type': 'application/json' },
  body: JSON.stringify({ collection }),
})
const body = await res.text()
console.log(res.ok ? `pushed OK (${res.status})` : `push FAILED (${res.status})`)
console.log(body.slice(0, 300))
process.exit(res.ok ? 0 : 1)
