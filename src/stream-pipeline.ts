import { createHash } from 'crypto'
import { join } from 'path'
import { fetchRoute } from './rsshub-adapter.ts'
import { writeItemToVault } from './vault-writer.ts'
import { classifyAd, type AdRules } from './content/ad-filter.ts'
import { includeFold } from './content/title-filter.ts'
import type { DedupStore } from './dedup-store.ts'
import type { StreamConfig, StreamItem } from './types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickIdSeed(rssItem: any): string {
  // 优先 guid (RSS unique id 语义), 次选 link, 最后 title
  // 不用 pubDate (有些源是 "Invalid Date" literal, 不稳定)
  return String(rssItem.guid ?? rssItem.id ?? rssItem.link ?? rssItem.title ?? '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeStreamItem(streamId: string, routePath: string, rssItem: any, adRules?: AdRules, sourceId?: string, titleInclude?: string[], season?: number): StreamItem {
  const seed = `${streamId}|${pickIdSeed(rssItem)}`
  const id = createHash('sha256').update(seed).digest('hex').slice(0, 16)

  const title = rssItem.title ?? '(untitled)'
  const body_text = rssItem.content?.text ?? stripHtml(rssItem.description)
  const url = rssItem.link
  const attachments = collectAttachments(rssItem)

  const item: StreamItem = {
    id,
    stream_id: streamId,
    source_id: sourceId,
    season,
    source_type: 'rsshub-bridge',
    source_route: routePath,
    fetched_at: new Date().toISOString(),
    timestamp: parseTimestamp(rssItem.pubDate),
    title,
    url,
    author: rssItem.author,
    author_avatar: rssItem.author_avatar,
    comment_count: rssItem.comment_count,
    like_count: rssItem.like_count,
    body_html: rssItem.content?.html ?? rssItem.description,
    body_text,
    attachments,
    raw: rssItem,
  }

  if (adRules) {
    const categories = Array.isArray(rssItem.category)
      ? rssItem.category.map(String)
      : rssItem.category != null
        ? [String(rssItem.category)]
        : []
    const muted = classifyAd(
      { title, text: body_text, urls: [url, ...(attachments ?? [])].filter(Boolean), categories },
      adRules
    )
    if (muted) item.muted = muted
  }

  // 只看包含 (title-include allow-filter): fold any item whose title matches NONE of the keywords.
  // Complements ad_filter (which folds what MATCHES); an already-ad-muted item keeps its ad reason.
  // Shared with the reclassify-history endpoint via includeFold so ingest + retro-apply agree.
  if (!item.muted) {
    const m = includeFold(title, titleInclude)
    if (m) item.muted = m
  }

  return item
}

function parseTimestamp(raw: unknown): string {
  if (!raw) return new Date().toISOString()
  // A bare number is ambiguous: Date() reads it as MILLISECONDS, but plenty of APIs publish
  // Unix time in SECONDS (douyin `create_time`, HN, most CN feeds) — read as ms those land in
  // 1970. Anything under 1e11 ms is before 1973, i.e. never a real pubDate, so it is seconds.
  const n = typeof raw === 'number' ? raw : NaN
  const d = Number.isFinite(n) && Math.abs(n) < 1e11 ? new Date(n * 1000) : new Date(raw as string | number | Date)
  if (Number.isNaN(d.getTime())) return new Date().toISOString()
  return d.toISOString()
}

function stripHtml(s?: string): string | undefined {
  if (!s) return undefined
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectAttachments(rssItem: any): string[] | undefined {
  const att: string[] = []
  if (rssItem.enclosure_url) att.push(rssItem.enclosure_url)
  if (Array.isArray(rssItem.attachments)) {
    for (const a of rssItem.attachments) {
      if (typeof a === 'string') att.push(a)
      else if (a?.url) att.push(a.url)
    }
  }
  return att.length > 0 ? att : undefined
}

/**
 * Convert raw items → StreamItem, dedup, and write the new ones to the vault.
 * Shared by both the legacy tickStream and the registry-driven Scheduler.
 * Pass already-merged items (fan-out merging happens upstream) so cross-source
 * duplicates collapse on the shared dedup store.
 */
export async function persistItems(
  streamId: string,
  sourceRoute: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawItems: any[],
  vaultDir: string | undefined,
  dedup: DedupStore,
  onNew?: (item: StreamItem) => void | Promise<void>,
  adRules?: AdRules,
  sourceId?: string,
  titleInclude?: string[],
  /**
   * Batched durable write of the item read-model, run in ONE transaction. Supplied by the caller
   * because it owns the itemStore + type (and normalizes each item). Split from the per-item path so
   * a big harvest is one WAL commit instead of N synchronous ones — the per-item writes stalled the
   * event loop ~1.5s (see src/loop-lag.ts). Omit it for callers that don't populate an itemStore.
   */
  commit?: (items: StreamItem[]) => void,
  season?: number,
): Promise<{ fetched: number; written: number }> {
  // Phase 1 (async, per-item I/O): dedup-filter + vault write; collect the genuinely-new items.
  // Nothing is marked seen until the batched flush below, so dedup.has can't catch a duplicate id
  // appearing twice WITHIN this harvest — track ids seen this batch to avoid a double write.
  const fresh: StreamItem[] = []
  const seenThisBatch = new Set<string>()
  for (const rssItem of rawItems) {
    const streamItem = makeStreamItem(streamId, sourceRoute, rssItem, adRules, sourceId, titleInclude, season)
    if (seenThisBatch.has(streamItem.id) || dedup.has(streamItem.id)) continue
    seenThisBatch.add(streamItem.id)
    try {
      if (vaultDir) await writeItemToVault(streamItem, vaultDir)
      fresh.push(streamItem)
    } catch (e) {
      console.error(`[${streamId}] vault write failed for ${streamItem.id}:`, (e as Error).message)
      seenThisBatch.delete(streamItem.id) // not persisted → let a later harvest retry it
    }
  }
  // Phase 2 (sync, batched): durable writes, each store in ONE transaction (one fsync, not N).
  // Order matches the old per-item path: item read-model first, then dedup — a crash between them
  // re-harvests the item (INSERT OR IGNORE), it is never silently dropped.
  commit?.(fresh)
  dedup.addMany(fresh.map((it) => ({ id: it.id, streamId })))
  // Phase 3: notify per genuinely-new item, AFTER it is durably stored.
  for (const it of fresh) await onNew?.(it)
  return { fetched: rawItems.length, written: fresh.length }
}

export async function tickStream(
  stream: StreamConfig,
  vaultRoot: string,
  dedup: DedupStore
): Promise<{ fetched: number; written: number }> {
  let data
  try {
    data = await fetchRoute(stream.rsshub_path)
  } catch (e) {
    console.error(`[${stream.id}] fetch failed:`, (e as Error).message)
    return { fetched: 0, written: 0 }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (data?.item ?? data?.items ?? []) as any[]
  const vaultDir = join(vaultRoot, stream.vault_subdir)
  const res = await persistItems(stream.id, stream.rsshub_path, items, vaultDir, dedup)

  console.log(
    `[${new Date().toISOString()}] [${stream.id}] fetched=${res.fetched} new=${res.written}`
  )
  return res
}
