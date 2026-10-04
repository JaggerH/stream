// src/conversions/windowing.ts
//
// 声纹分窗的断点续跑上下文。原来长在 TranscribeService 里（identifyWindowing），随转写一起
// 搬过来——它依赖的只是「一个属于本次任务的目录」，runner 通过 ctx.jobDir 供出。
//
// 语义原样保留：写一半崩掉的窗文件按「没存过」处置（跳过即重算），不挡整跑。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DebugEntry } from '../debug.ts'
import type { IdentifyWindowing, SavedWindow } from '../voiceprint/identify.ts'
import type { ConversionContext } from './runner.ts'

interface ChunkLedger {
  appendChunk(jobId: string, pointer: string): void
}

export function identifyWindowingIn(
  jobDir: string,
  ledger: ChunkLedger,
  ctx: ConversionContext,
  onDegrade: (e: unknown) => void,
  onDebug?: (entry: DebugEntry) => void
): IdentifyWindowing {
  // 账本行号即 jobDir 的最后一段（jobDirOf 就是这么拼的）——appendChunk 要用它。
  const jobId = jobDir.split(/[\\/]/).filter(Boolean).pop() ?? ctx.id
  return {
    resume: {
      load: (): SavedWindow[] => {
        let names: string[]
        try {
          names = readdirSync(jobDir)
        } catch {
          return [] // 目录还不存在 = 首跑，没有可续的窗
        }
        const out: SavedWindow[] = []
        for (const name of names) {
          if (!/^window-\d+\.json$/.test(name)) continue
          try {
            const w = JSON.parse(readFileSync(join(jobDir, name), 'utf8')) as SavedWindow
            if (typeof w?.index === 'number' && Array.isArray(w?.segments)) out.push(w)
          } catch {
            /* 写一半崩掉的窗文件：当没存过，重算该窗 */
          }
        }
        return out
      },
      save: (w) => {
        mkdirSync(jobDir, { recursive: true })
        const path = join(jobDir, `window-${w.index}.json`)
        writeFileSync(path, JSON.stringify(w))
        ledger.appendChunk(jobId, path)
      },
    },
    onProgress: (done, total) => {
      const at = Date.now()
      onDebug?.({
        id: `capability-job:identify:${ctx.itemId}@${at}#${done}`,
        at,
        channel: 'capability-job',
        key: `identify:${ctx.itemId}`,
        title: `identify:${ctx.itemId}`,
        summary: `声纹分窗 ${done}/${total} 窗完成`,
        ok: true,
        fields: [
          { label: '进度', value: `${done}/${total}` },
          { label: 'job', value: jobId },
        ],
      })
    },
    onDegrade,
  }
}
