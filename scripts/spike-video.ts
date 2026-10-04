/**
 * Smoke the aggregated video/torrent search end-to-end against live RSSHub.
 * Exercises the real path: catalog manifest → RssHubAdapter.fetch → present()
 * (the torrent/magnet presenter). Prints per-source counts + sample magnets.
 *
 * Run:  pnpm tsx scripts/spike-video.ts "鬼灭之刃"
 */
import { RssHubAdapter } from '../src/rsshub-adapter.ts'
import { loadRsshubCatalog } from '../src/rsshub-catalog.ts'
import { present, type RawItem } from '../src/content/present.ts'

const ROUTES_JSON = process.env.RSSHUB_CATALOG
if (!ROUTES_JSON) throw new Error('set RSSHUB_CATALOG to RSSHub assets/build/routes.json before running this spike')

const VIDEO_SOURCES: { id: string; param: string }[] = [
  { id: 'rsshub:nyaa/search/:query?', param: 'query' },
  { id: 'rsshub:nyaa/sukebei/search/:query?', param: 'query' },
  { id: 'rsshub:u3c3/search/:keyword/:preview?', param: 'keyword' },
  { id: 'rsshub:comicat/search/:keyword', param: 'keyword' },
  { id: 'rsshub:btbtla/detail/:name', param: 'name' },
  { id: 'rsshub:javdb/search/:keyword?/:filter?/:sort?', param: 'keyword' },
]

async function main() {
  const q = process.argv[2] ?? '鬼灭之刃'
  console.log(`[spike-video] query="${q}"\n`)

  const catalog = loadRsshubCatalog(ROUTES_JSON)
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const adapter = new RssHubAdapter()
  await adapter.init({})

  let grand = 0
  for (const s of VIDEO_SOURCES) {
    const manifest = byId.get(s.id)
    if (!manifest) {
      console.log(`✗ ${s.id} — NOT in catalog`)
      continue
    }
    const t0 = Date.now()
    try {
      const raw = (await adapter.fetch({ [s.param]: q }, manifest)) as RawItem[]
      const presented = raw.map((r) => present(r, manifest))
      const withMag = presented.filter((c) =>
        c.media?.some((m) => m.kind === 'link' && /^(magnet|ed2k):/.test(m.url))
      )
      grand += raw.length
      console.log(`✓ ${s.id}  ${raw.length} items, ${withMag.length} w/ magnet  (${Date.now() - t0}ms)`)
      for (const c of presented.slice(0, 2)) {
        const mag = c.media?.find((m) => m.kind === 'link') as { url: string; title?: string } | undefined
        console.log(`    · ${(c.title ?? '').slice(0, 60)}`)
        if (mag) console.log(`      ${mag.title}  ${mag.url.slice(0, 70)}…`)
      }
    } catch (e) {
      console.log(`✗ ${s.id} — ${(e as Error).message.slice(0, 120)}  (${Date.now() - t0}ms)`)
    }
  }
  console.log(`\n[spike-video] total raw items across sources: ${grand}`)
}

main().catch((e) => {
  console.error('[spike-video] fatal:', e)
  process.exit(1)
})
