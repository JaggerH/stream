/**
 * End-to-end pipeline spike: fetch → convert → dedup → vault write.
 * Skips login cookies (uses no-cookie public routes).
 *
 * Run:
 *   pnpm spike:pipeline
 *
 * Outputs markdown files to /tmp/stream-spike-vault/
 */

import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureInit } from '../src/rsshub-adapter.ts'
import { tickStream } from '../src/stream-pipeline.ts'
import { DedupStore } from '../src/dedup-store.ts'
import type { StreamConfig } from '../src/types.ts'

const vaultRoot = mkdtempSync(join(tmpdir(), 'stream-spike-'))
const dedupDbPath = join(vaultRoot, 'dedup.db')

const streams: StreamConfig[] = [
  {
    id: 'hackernews-best',
    rsshub_path: '/hackernews/best',
    cadence_seconds: 0,
    vault_subdir: 'hackernews',
  },
  {
    id: 'v2ex-hot',
    rsshub_path: '/v2ex/topics/hot',
    cadence_seconds: 0,
    vault_subdir: 'v2ex',
  },
  {
    id: '36kr-newsflash',
    rsshub_path: '/36kr/newsflashes',
    cadence_seconds: 0,
    vault_subdir: '36kr',
  },
]

async function main() {
  console.log(`[spike-pipeline] vault: ${vaultRoot}`)
  console.log(`[spike-pipeline] dedup: ${dedupDbPath}`)

  console.log('\n[spike-pipeline] initializing RSSHub (no cookies)...')
  await ensureInit({})

  const dedup = new DedupStore(dedupDbPath)

  console.log('\n[spike-pipeline] FIRST tick (should write new items)')
  for (const stream of streams) {
    await tickStream(stream, vaultRoot, dedup)
  }

  console.log('\n[spike-pipeline] SECOND tick (should be 100% dedup)')
  for (const stream of streams) {
    await tickStream(stream, vaultRoot, dedup)
  }

  console.log('\n[spike-pipeline] vault inventory:')
  for (const stream of streams) {
    const dir = join(vaultRoot, stream.vault_subdir)
    try {
      const files = readdirSync(dir)
      console.log(`  ${stream.vault_subdir}/  ${files.length} files`)
      for (const f of files.slice(0, 3)) {
        console.log(`    - ${f}`)
      }
      if (files.length > 3) console.log(`    ... and ${files.length - 3} more`)
    } catch (e) {
      console.log(`  ${stream.vault_subdir}/  (empty or error: ${(e as Error).message})`)
    }
  }

  console.log('\n[spike-pipeline] dedup counts:')
  for (const stream of streams) {
    console.log(`  ${stream.id}: ${dedup.countForStream(stream.id)} seen`)
  }

  dedup.close()
  console.log(`\n[spike-pipeline] ✓ vault preserved at ${vaultRoot} (inspect with: ls ${vaultRoot})`)
  console.log(`[spike-pipeline]   cleanup: rm -rf ${vaultRoot}`)
}

main().catch((e) => {
  console.error('[spike-pipeline] failed:', e)
  process.exit(1)
})
