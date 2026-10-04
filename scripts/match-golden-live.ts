/**
 * 活体金样的**抓取壳**：从跑着的后端把两条播客 show + 一条影视绑定的左右两侧抓下来，冻成一份
 * `LiveFixture`，再交给 `src/netdisk/match-engine/live-golden.ts` 重放出报告。
 *
 * 抓取与重放分开：重放那半边是纯函数、进得了单测（CI 里没有活体后端）；这半边只出网、不判断。
 *
 * **只读**：`GET .../authority`、`POST .../preview`（预览不动网盘文件，只追加一条账本行）、
 * `GET /api/netdisk/mappings/:id`，外加 read-only 打开 `netdisk.db` 取人工 pin 与时长缓存。
 * 绝不调 `execute`。
 *
 * 用法：node_modules/.bin/tsx scripts/match-golden-live.ts <out-dir> [baseUrl] [dataDir]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { MatchSpec } from '../src/netdisk/types.ts'
import type { SpecLeft, SpecRight } from '../src/netdisk/match-spec.ts'
import { resolveSpec } from '../src/netdisk/sync.ts'
import type { LeftEntry } from '../src/netdisk/sync.ts'
import type { LedgerRow, RunRecord } from '../src/netdisk/reconcile/ledger.ts'
import type { LiveFixture, LiveGroup } from '../src/netdisk/match-engine/live-golden.ts'
import { runLiveGolden, renderLiveReport, buildLiveBaseline } from '../src/netdisk/match-engine/live-golden.ts'
import type { GoldenBaseline } from '../src/netdisk/match-engine/golden.ts'

const [outDir, baseUrl = 'http://127.0.0.1:8900', dataDir = join(process.cwd(), 'data')] = process.argv.slice(2)
if (!outDir) throw new Error('usage: match-golden-live.ts <out-dir> [baseUrl] [dataDir]')

const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${baseUrl}${path}`)
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`)
  return (await r.json()) as T
}
const post = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${baseUrl}${path}`, { method: 'POST' })
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`)
  return (await r.json()) as T
}

interface Binding {
  id: string
  left: { kind: string; media?: string; streamId?: string; id?: string; title?: string }
  right: { path: string }
  matchSpec?: MatchSpec
  entries?: { leftKey: string; rightFile: string | null; corrected?: unknown }[]
}

// ── 人工 pin 与时长缓存：read-only 直读 netdisk.db（没有 GET 端点，且这两样是匹配层的真输入）──
const db = new Database(join(dataDir, 'netdisk.db'), { readonly: true })
const isEpisodeRows = db.prepare("SELECT key FROM decisions WHERE kind = 'is-episode'").all() as { key: string }[]
/** leftKey → 人钉死的那份文件（绝对路径）。键的形状见 `reconcile/decisions.ts`，只拼不解，这里只解自己人写的。 */
const pinnedByLeftKey = new Map<string, string>()
for (const row of isEpisodeRows) {
  try {
    const v = JSON.parse(row.key.slice(row.key.indexOf(':') + 1)) as unknown
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && !pinnedByLeftKey.has(v[0])) {
      pinnedByLeftKey.set(v[0], v[1])
    }
  } catch { /* 坏行当没有 */ }
}
const durationRow = db.prepare('SELECT duration_s FROM durations WHERE key = ?')
const cachedDuration = (path: string, size: number): number | undefined => {
  const row = durationRow.get(`${size}:${path}`) as { duration_s: number | null } | undefined
  return row?.duration_s ?? undefined
}

/**
 * `right` 的还原：账本行**就是**本轮进池的全部文件（守恒律保证一文件一行），而
 * `verdict` 为 `exempt`/`dup` 的那些在 `buildPlan` 里**跑匹配之前**就出局了
 * （豁免档 ①、字节全等档 ②）。剔掉这两筐，剩下的逐字就是喂给匹配器的那份 `right`。
 */
const rightFromRows = (rows: LedgerRow[]): SpecRight[] =>
  rows
    .filter((r) => r.verdict !== 'exempt' && r.verdict !== 'dup')
    .map((r) => ({ name: r.path, size: r.size, ...(r.durationS != null ? { durationS: r.durationS } : {}) }))

/** `left` 的还原：与 `plan.ts:508-518` 同一投影（含 pin 优先级：人对问句的回答压过绑定侧订正）。 */
const leftFrom = (entries: LeftEntry[], bindingPins: Map<string, string>): SpecLeft[] =>
  entries.map((e) => {
    const pin = pinnedByLeftKey.get(e.leftKey) ?? bindingPins.get(e.leftKey)
    return {
      leftKey: e.leftKey,
      title: e.title,
      ...(e.durationS != null ? { durationS: e.durationS } : {}),
      ...(e.paid ? { paid: true } : {}),
      ...(pin ? { pinnedRight: pin } : {}),
    }
  })

/** 绑定里人工订正的那些 → 绝对路径（同 `reconcile/service.ts:425-429` 的拼法）。 */
const bindingPinsOf = (b: Binding): Map<string, string> =>
  new Map(
    (b.entries ?? [])
      .filter((e) => e.corrected && e.rightFile)
      .map((e) => [e.leftKey, `${b.right.path.replace(/\/$/, '')}/${e.rightFile!}`]),
  )

interface CaptureTarget { name: string; authorityPath: string; previewPath: string; bindingId: string }

async function captureGroup(t: CaptureTarget): Promise<LiveGroup[]> {
  const binding = await get<Binding>(`/api/netdisk/mappings/${t.bindingId}`)
  const authority = await get<{ entries: LeftEntry[] }>(t.authorityPath)
  const preview = await post<{ ledger: RunRecord; shelves: { claimed: string; secondary?: string } }>(t.previewPath)
  const spec = resolveSpec(binding as never)
  const left = leftFrom(authority.entries, bindingPinsOf(binding))
  const groups: LiveGroup[] = [{
    name: t.name,
    source: `${t.authorityPath}（左，P12 端点）+ ${t.previewPath} 的账本行剔除 exempt/dup（右，= buildPlan 喂给匹配器的那份）+ 绑定 ${t.bindingId} 的 resolveSpec（谱）`,
    spec,
    left,
    right: rightFromRows(preview.ledger.rows),
  }]

  // 第二货架单独一组：`reviewSecondary` 是同一个匹配器**另跑一次**（左不变、右只有货架文件），
  // 切换后它同样要切，所以金样里必须有这一组。账本只记产生了动作的行，取全量得去列目录。
  const shelf = preview.shelves.secondary
  if (shelf) {
    const listed = await get<{ files: { name: string; size: number; isDir: boolean }[] }>(
      `/api/netdisk/fs?path=${encodeURIComponent(shelf)}&recursive=1`,
    )
    const right: SpecRight[] = listed.files
      .filter((f) => !f.isDir && /\.(mkv|mp4|avi|mov|ts|m2ts|flv|wmv|m4v|webm|rmvb|mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i.test(f.name))
      .map((f) => {
        const path = `${shelf}/${f.name}`
        const durationS = cachedDuration(path, f.size)
        return { name: path, size: f.size, ...(durationS != null ? { durationS } : {}) }
      })
    groups.push({
      name: `${t.name}#下架货架复核`,
      source: `同上的左 + GET /api/netdisk/fs?path=${shelf}（右，时长取自 netdisk.db 的 durations 缓存）`,
      spec,
      left,
      right,
    })
  }
  return groups
}

const targets: CaptureTarget[] = [
  { name: 'yile', authorityPath: '/api/netdisk/reconcile/yile/authority', previewPath: '/api/netdisk/reconcile/yile/preview', bindingId: 'map_02ec21' },
  { name: 'lizhi-user-z7o4v', authorityPath: '/api/netdisk/reconcile/lizhi-user-z7o4v/authority', previewPath: '/api/netdisk/reconcile/lizhi-user-z7o4v/preview', bindingId: 'map_e1cec7' },
  { name: 'binding:map_9fe142（进击的巨人）', authorityPath: '/api/netdisk/reconcile/bindings/map_9fe142/authority', previewPath: '/api/netdisk/reconcile/bindings/map_9fe142/preview', bindingId: 'map_9fe142' },
]

const groups: LiveGroup[] = []
for (const t of targets) {
  try {
    groups.push(...(await captureGroup(t)))
    console.error(`[capture] ${t.name} ok`)
  } catch (e) {
    console.error(`[capture] ${t.name} 跳过：${(e as Error).message}`)
  }
}

const fixture: LiveFixture = { capturedAt: new Date().toISOString(), groups }
writeFileSync(join(outDir, 'live-fixture.json'), JSON.stringify(fixture, null, 2))

/**
 * 有旧基线（`<out-dir>/live-baseline.json` 已在）就拿它对照，没有就本次即录。
 * **别拿新抓的一份去覆盖还没看过的旧基线**——那等于把漂移抹掉：脚本只在没有基线时落盘，
 * 要重录就先把旧的挪走（挪之前先把 diff 看一遍）。
 */
const baselinePath = join(outDir, 'live-baseline.json')
const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as GoldenBaseline) : undefined
const result = runLiveGolden(fixture, baseline)
if (!baseline) writeFileSync(baselinePath, `${JSON.stringify(buildLiveBaseline(fixture, `活体抓取于 ${fixture.capturedAt}`), null, 2)}\n`)

const report = renderLiveReport(fixture, result)
writeFileSync(join(outDir, 'live-report.md'), report)
console.log(report)
process.exit(result.driftTotal > 0 ? 1 : 0)
