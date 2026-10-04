import type { Hono } from 'hono'
import type { Registry } from '../registry/registry.ts'
import type { ResolveEngine } from '../resolve/engine.ts'
import type { IntentResolver } from '../resolve/intent.ts'
import type { RadarMatcher } from '../resolve/radar.ts'
import type { SourceHealthStore } from '../source-health-store.ts'
import type { Stream } from '../streams/types.ts'
import { canonicalSourceId } from '../streams/store.ts'
import { publicSource, fallbackSource, type SourceSummary } from '../registry/public.ts'
import { withLyricsCache, type LyricsCache } from '../audio/lyrics-cache.ts'

/** The target-resolve surface: one-shot intent → resolve, over the derived source ladder,
 *  plus the Stream tree view (/api/resolve/targets). Standing subscription lives in the
 *  Channel+Stream path, not here. */
export interface ResolveDeps {
  registry: Registry
  resolveEngine: ResolveEngine
  intentResolver: IntentResolver
  radarMatcher: RadarMatcher
  sourceHealth: SourceHealthStore
  /** live Stream list — the resolve/doctor tree view */
  streams: () => Stream[]
  /** 歌词 key 的缓存（缺席 = 不缓存，每次都跑梯子）。见 `src/audio/lyrics-cache.ts`。 */
  lyricsCache?: LyricsCache
}

export function registerResolveRoutes(app: Hono, deps: ResolveDeps): void {
  // resolve a pasted URL into candidate sources via radar (RSSHub catalog + native plugins).
  // The targetType classifier still backs /api/resolutions below.
  //
  // **别把它挪回 `/api/intents`。** 那个路径属于意图跟踪那份资源（`/api/intents`、
  // `/api/intents/:id`、`.../dossier` …，见 docs/API.md）。两个不同的东西共用一个路径时，
  // 先注册的那个赢、后一个永远够不到——而**两边的单测都照常绿**：各自只挂载自己那半个 app，
  // 冲突只在真实装配里存在。活体代价是扩展 popup 拿到 `{intents:[...]}`、读 `matches` 时
  // 整个 popup 崩掉（2026-08-02）。
  app.get('/api/radar', (c) => {
    const input = c.req.query('input')
    if (!input) {
      return c.json({ error: { code: 'validation_error', message: 'input required' } }, 400)
    }
    return c.json(deps.radarMatcher.match(input))
  })

  // one-shot resolve a Target (failover ladder), ephemeral
  app.get('/api/resolutions', async (c) => {
    const input = c.req.query('input')
    let targetType = c.req.query('type')
    let key = c.req.query('key')
    if (input && (!targetType || !key)) {
      const r = deps.intentResolver.resolve(input)
      targetType = r.targetType
      key = r.key
    }
    if (!targetType || !key) {
      return c.json({ error: { code: 'validation_error', message: 'type and key, or input required' } }, 400)
    }
    // 歌词只按 key 缓存（key 文法见 docs/API.md：`<platform>:<id>` 或 `<title>::<artist>`）。
    // 壳与 MCP 的 `resolve` 工具共用一份（`src/audio/lyrics-cache.ts`）——各写一份的代价是
    // 其中一条静默地没有缓存，而两条路的单测都照常绿。
    const tt = targetType
    const result = tt === 'lyrics'
      ? await withLyricsCache(deps.lyricsCache, key, (k) => deps.resolveEngine.resolve(tt, k))
      : await deps.resolveEngine.resolve(tt, key)
    return c.json({ targetType, key, result })
  })

  // the source pool by target-type (priority + live health) — doctor as API
  app.get('/api/resolve/sources', (c) => {
    const tt = c.req.query('targetType')
    // per target-type: the live resolve ladder (Provider row members, incl. matches-catalog sources);
    // no target-type: the whole declared pool (provides-tagged manifests).
    const list = tt ? deps.resolveEngine.resolveLadder(tt) : deps.registry.all().filter((m) => m.provides?.length)
    return c.json(
      list.map((m) => ({
        ...publicSource(m),
        provides: m.provides ?? [],
        priority: m.priority ?? 100,
        health: deps.sourceHealth.stateOf(m.id),
      }))
    )
  })

  // Target tree for the frontend viewer — every Stream expanded into its Provider → Source
  // chain with live health + active-source marker.
  app.get('/api/resolve/targets', (c) => {
    const entries: Array<{
      id: string
      targetType: string
      key: string
      cadenceSeconds: number
      resolvers: Array<{ id: string; sources: Array<SourceSummary & { health: string; active: boolean }> }>
    }> = []

    // --- Stream entries (scheduler pipeline) ---
    for (const stream of deps.streams()) {
      const sourceEntries = stream.sources.map((src) => {
        const sourceId = (src.plugin_id && src.source_template_id)
          ? canonicalSourceId(src.plugin_id, src.source_template_id)
          : src.source_id!;
        const m = deps.registry.get(sourceId)
        return {
          id: sourceId,
          health: deps.sourceHealth.stateOf(sourceId),
          manifest: m,
        }
      })

      // Group sources by their declared provides → one Provider per targetType.
      // An undeclared source falls into its own provider group keyed by source_id.
      const groups = new Map<string, typeof sourceEntries>()
      for (const se of sourceEntries) {
        const types = se.manifest?.provides ?? []
        if (types.length === 0) {
          // undeclared — group solo so it still appears
          const g = groups.get(se.id) ?? []
          g.push(se)
          groups.set(se.id, g)
        } else {
          for (const tt of types) {
            const g = groups.get(tt) ?? []
            g.push(se)
            groups.set(tt, g)
          }
        }
      }

      const providers = Array.from(groups.entries()).map(([providerId, srcs]) => {
        const isExclusive = stream.strategy === 'exclusive'
        const firstHealthyIdx = isExclusive
          ? srcs.findIndex((s) => s.health === 'healthy')
          : -1
        return {
          id: providerId,
          sources: srcs.map((s, i) => ({
            ...(s.manifest ? publicSource(s.manifest) : fallbackSource(s.id)),
            health: s.health,
            active: isExclusive && firstHealthyIdx >= 0 && i === firstHealthyIdx,
          })),
        }
      })

      // Derive a primary targetType from the first provider; fall back to a generic label
      // (Stream carries no `kind` — that was always undefined here, since this raw Stream comes
      // straight from the scheduler, never through the HTTP layer that used to stamp `kind`).
      const primaryType = providers[0]?.id ?? 'stream'

      // key = first source's primary param value (e.g. playlist id).
      // Prefer the manifest-declared key_param; fall back to common id-like param names.
      const firstSrc = stream.sources[0]
      const firstSourceId = firstSrc
        ? ((firstSrc.plugin_id && firstSrc.source_template_id)
            ? canonicalSourceId(firstSrc.plugin_id, firstSrc.source_template_id)
            : firstSrc.source_id!)
        : undefined;
      const firstManifest = firstSourceId ? deps.registry.get(firstSourceId) : undefined
      const keyParam = firstManifest?.key_param ?? ['id', 'user_id', 'uid', 'url'].find((k) => k in (firstSrc?.params ?? {}))
      const key = keyParam ? String(firstSrc.params[keyParam] ?? stream.id) : stream.id

      entries.push({
        id: stream.id,
        targetType: primaryType,
        key,
        cadenceSeconds: stream.cadence_seconds,
        resolvers: providers,
      })
    }

    return c.json(entries)
  })
}
