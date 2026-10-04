import type { Adapter, AdapterFetchResult } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const NETEASE_BASE = 'https://music.163.com'
const MATCH_THRESHOLD = 0.5
/** 这个包认领的平台键（= facility）。key 的 `<platform>:` 前缀按它分流。 */
const PLATFORM = 'netease'

/** Strip parenthetical qualifiers ("(Live)", "（Remix）"), punctuation, and casing so
 *  "Faded (Radio Edit)" and "faded" score as identical. Keeps CJK characters as-is
 *  (\p{L}\p{N} covers them). */
export function normalize(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
}

/** Levenshtein distance, iterative single-row DP. No external dep — inputs are short titles,
 *  so O(n*m) is fine and this avoids adding a string-similarity library for one function. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[b.length]
}

/** Normalized similarity in [0,1]. Either side empty → 0 (never a vacuous match — an empty
 *  title/artist must not win a lyrics lookup by default). */
export function similarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  const dist = levenshtein(na, nb)
  return 1 - dist / Math.max(na.length, nb.length)
}

/** Best-scoring candidate ≥ MATCH_THRESHOLD among a NetEase search response's `result.songs`,
 *  or undefined if none clears the bar. artistScore takes the best of the candidate's
 *  collaborating artists (NetEase already returns them as an array). */
export function bestMatch(
  title: string, artist: string, songs: Array<{ id: number; name: string; artists: Array<{ name: string }> }>,
): { id: string; score: number } | undefined {
  let best: { id: string; score: number } | undefined
  for (const s of songs) {
    const titleScore = similarity(title, s.name)
    const artistScore = Math.max(0, ...s.artists.map((a) => similarity(artist, a.name)))
    const score = titleScore * 0.5 + artistScore * 0.5
    if (!best || score > best.score) best = { id: String(s.id), score }
  }
  return best && best.score >= MATCH_THRESHOLD ? best : undefined
}

async function fetchLyric(f: typeof fetch, songId: string): Promise<string | undefined> {
  const r = await f(`${NETEASE_BASE}/api/song/lyric?id=${encodeURIComponent(songId)}&lv=1&kv=1&tv=-1`, {
    headers: { Referer: NETEASE_BASE, 'User-Agent': 'Mozilla/5.0' },
  })
  if (!r.ok) throw new Error(`[netease-lyrics] lyric fetch failed: ${r.status}`)
  const body = (await r.json()) as { lrc?: { lyric?: string } }
  return body.lrc?.lyric || undefined
}

async function searchSongId(f: typeof fetch, title: string, artist: string): Promise<{ id: string; score: number } | undefined> {
  const q = `${title} ${artist}`.trim()
  const r = await f(`${NETEASE_BASE}/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=5`, {
    headers: { Referer: NETEASE_BASE, 'User-Agent': 'Mozilla/5.0' },
  })
  if (!r.ok) throw new Error(`[netease-lyrics] search failed: ${r.status}`)
  const body = (await r.json()) as { result?: { songs?: Array<{ id: number; name: string; artists: Array<{ name: string }> }> } }
  return bestMatch(title, artist, body.result?.songs ?? [])
}

export interface NeteaseLyricsDeps { fetch?: typeof fetch }

/**
 * `lyrics-search` 行的一个成员（`categories: [music, lyrics]` + `key_param: input` 让它被
 * `{mode:'auto', category:'lyrics'}` 现取到）。key 三种走法（文法见 docs/PACKAGE.md §2.2）：
 *  - `netease:<id>`      → 已知曲目，直取歌词接口
 *  - `<title>::<artist>` → 模糊搜，取最高分候选（≥50%）再取歌词
 *  - 别家平台前缀        → **decline（返回 `[]`）**，把机会让给梯子的下一档歌词源
 * 网络错误是**抛**不是 `{matched:false}`——缓存在调用侧（`/api/resolutions` 与 MCP 的
 * `resolve`，同一份壳 `src/audio/lyrics-cache.ts`），只缓存判决，一次抖动不该被冻成
 * 7 天的"查无此歌"。
 *
 * **key 从 `params.input` 来，不是第一个位置参数。** 经 `resolveEngine.fetchSource` 时订阅键
 * 由 `buildParams` 灌进 `manifest.key_param`（`src/kernel/plugins/provider.ts`），本包 manifest
 * 写的是 `key_param: input`。读第一个位置参数是 `BuiltinFn` 的形状，本包不走 builtin 那条路。
 */
export class NeteaseLyricsAdapter implements Adapter {
  readonly id = 'netease-lyrics'
  private readonly f: typeof fetch
  constructor(deps: NeteaseLyricsDeps = {}) {
    this.f = deps.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async init(): Promise<void> { /* 无凭证 */ }

  async fetch(params: Record<string, unknown>, _manifest: SourceManifest): Promise<unknown[] | AdapterFetchResult> {
    const key = String(params.input ?? '').trim()
    if (!key) return [{ matched: false }]
    if (key.startsWith(`${PLATFORM}:`)) {
      const songId = key.slice(PLATFORM.length + 1)
      const lrc = await fetchLyric(this.f, songId)
      return [lrc ? { matched: true, songId, lrc } : { matched: false }]
    }
    // 别家平台的已知曲目引用（`<platform>:<id>`）——decline。
    //
    // 冒号后面**必须紧跟一个非空白字符**，`::` 排除。少了这条，一个普普通通的歌名
    // （`Song: Reprise`——冒号 + 空格）会被当成"别家平台的引用"而 decline，于是它连模糊搜
    // 都不走，歌词静默不出。平台键和 id 之间不会有空格，歌名里的冒号后面几乎总有。
    if (/^[a-z0-9-]+:(?!:)\S/i.test(key) && !key.includes('::')) return []
    const [title, artist] = key.split('::')
    const hit = await searchSongId(this.f, title ?? '', artist ?? '')
    if (!hit) return [{ matched: false }]
    const lrc = await fetchLyric(this.f, hit.id)
    return [lrc ? { matched: true, songId: hit.id, lrc } : { matched: false }]
  }
}
