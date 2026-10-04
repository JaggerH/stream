/**
 * 把一份窗 dump 跑过**生产的**跨窗合并（`mergeWindowsDetailed`），把簇代表落成 JSON。
 *
 * 为什么不在评估脚本里自己重写一遍合并：簇代表的口径（哪些成员有资格聚进去、怎么加权）
 * 是 `windowed.ts` 定的，抄一遍就是又开一处口径分叉——`representative.ts` 头注记着上一次
 * 口径分叉的代价（登记进声纹库的「林简七」存的是庞博的声音）。
 *
 * 用法：node_modules/.bin/tsx scripts/voiceprint-dump-clusters.ts <dumpDir> <out.json>
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeWindowsDetailed, type WindowResult } from '../src/voiceprint/windowed.ts'

const [dir, out] = process.argv.slice(2)
if (!dir || !out) throw new Error('usage: voiceprint-dump-clusters.ts <dumpDir> <out.json>')

const windows: WindowResult[] = readdirSync(dir)
  .filter((n) => /^window-\d+\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as WindowResult)
  .map((w) => ({
    index: w.index,
    startS: w.startS,
    durS: w.durS,
    segments: w.segments,
    ...(w.speakers?.length ? { speakers: w.speakers } : {}),
  }))
  .sort((a, b) => a.index - b.index)

const { segments, clusterReps } = mergeWindowsDetailed(windows, { warn: () => {} })

const seconds = new Map<string, number>()
const spans = new Map<string, [number, number][]>()
for (const s of segments) {
  seconds.set(s.speaker, (seconds.get(s.speaker) ?? 0) + (s.end - s.start))
  const l = spans.get(s.speaker)
  if (l) l.push([s.start, s.end])
  else spans.set(s.speaker, [[s.start, s.end]])
}

writeFileSync(
  out,
  JSON.stringify({
    dir,
    clusters: [...seconds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cluster, sec]) => ({
        cluster,
        seconds: Number(sec.toFixed(2)),
        // `clusterReps` 只收「整份由干净代表聚出」的簇；缺席 = 这个簇没人拿得出干净代表
        rep: clusterReps.get(cluster) ?? null,
        spans: spans.get(cluster) ?? [],
      })),
  }),
)
console.log(
  `${dir}: ${seconds.size} 簇，其中 >=30s ${[...seconds.values()].filter((s) => s >= 30).length}，` +
    `有干净簇代表 ${clusterReps.size}`,
)
