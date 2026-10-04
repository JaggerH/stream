/**
 * 「听一段网盘音频」的组装层：查缓存 → 取元数据（字节数/时长/对象 id）→ 采样转写 → 落缓存。
 *
 * 它是 `netdisk_transcribe` 工具的取数腿，**和判读没有关系**：这一层不问"这是哪一集"，只把
 * 头尾各一段原文端出来。判读归模型自己（工作台里那个正在整理的 agent），结论由 `reconcile_decide`
 * 落账。分层不是洁癖——证据必须能单独摆出来核对，这条链路后面接的是认领或删除。
 *
 * **默认采样策略住在这里，不交给模型**：听哪一段是个确定性问题（开头判身份、结尾判完不完整，
 * 理由见 `identity-probe.ts` 头注的实测），不是需要判断的取舍。参数只留一个窗口长度，而且有硬
 * 上限（见 `clampWindowS`）。
 */
import { probeHeadTail, isSliceable, PROBE_WINDOW_S, type IdentityProbe, type ProbeDeps } from './identity-probe.ts'
import { sampleKey, type SampleCache } from './sample-cache.ts'

/** 默认窗口 = 那个实测定下来的 120 秒（改小的后果见 `identity-probe.ts` 头注）。 */
export const SAMPLE_WINDOW_DEFAULT_S = PROBE_WINDOW_S
/** 下限：再小就只剩片头音乐。上限**是产品底线不是配置**——见 `clampWindowS`。 */
export const SAMPLE_WINDOW_MIN_S = 15
export const SAMPLE_WINDOW_MAX_S = 300

/**
 * 窗口秒数夹进闭区间。**上限是硬的**：这条工具的底线是「整集几十分钟不许全转」——既因为一集的
 * 转写全文会把整轮对话顶爆，也因为那是要真金白银付的 ASR 钱。
 *
 * 参数本身是给特殊情况留的口子（片头一分钟就能听出名堂时把窗口调小），不是给模型绕过采样用的
 * 旋钮。`docs/AGENT-TOOLING.md` §3.1：schema 里可见的绕过参数 = 对不服从模型的摆设，所以这里
 * 不是「劝它别调大」，是**调大了也只到上限**。
 */
export function clampWindowS(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : SAMPLE_WINDOW_DEFAULT_S
  return Math.min(SAMPLE_WINDOW_MAX_S, Math.max(SAMPLE_WINDOW_MIN_S, n))
}

export interface AudioSampleFile {
  path: string
  sizeBytes: number
  durationS: number
}

/**
 * 采样的结果。**`ok:false` 说的是"这份文件取不到证据"**（容器切不动、时长探不出来），不是
 * "听了但没听出什么"——两者在界面/对话里是两句话，混成一格就再也分不开了。
 */
export type AudioSampleOutcome =
  | { ok: true; file: AudioSampleFile; windowS: number; probe: IdentityProbe; cached: boolean }
  | { ok: false; reason: string }

export interface AudioSamplerDeps extends ProbeDeps {
  /** 网盘文件的字节数（AList `fs/get`，带 TTL 缓存）。 */
  fileSize: (path: string) => Promise<number>
  /**
   * driver 侧的对象 id（夸克即 fid）。**抛错/空 = 这个 driver 给不出**，缓存退成路径档
   * （见 `sample-cache.ts` 头注）——不是致命错误，只是要多付一次搬家后的转写钱。
   */
  fileId: (path: string) => Promise<string>
  /** 时长。`null` = 探不出来 —— 那时切不出"大约两分钟"那一段，整个采样不成立。 */
  durationOf: (file: { path: string; size: number }) => Promise<number | null>
  cache: SampleCache
  log?: (m: string) => void
}

export function makeAudioSampler(
  deps: AudioSamplerDeps,
): (input: { path: string; windowS?: number }) => Promise<AudioSampleOutcome> {
  return async (input) => {
    const windowS = clampWindowS(input.windowS)
    // 切不动的容器一次网络都不发：给 mp4/mkv 切一段回来的是解不开的字节，转写会返回空，
    // 而空转写会被读成"这段没人说话"——一个会骗人的结果，比报错糟得多。
    if (!isSliceable(input.path)) {
      return { ok: false, reason: `这类文件听不了（只支持 mp3/aac，索引在容器别处的 mp4/mkv 切一段出来解不开）：${input.path}` }
    }
    const sizeBytes = await deps.fileSize(input.path)
    const durationS = await deps.durationOf({ path: input.path, size: sizeBytes })
    if (!durationS || durationS <= 0) {
      return { ok: false, reason: `探不出这份文件的时长，切不出采样窗口：${input.path}` }
    }
    const file: AudioSampleFile = { path: input.path, sizeBytes, durationS }

    // 对象 id 取不到不该掀翻这一趟——退成路径档接着走，但**把退档说出来**：
    // "缓存好像没生效"是那种查起来最费劲、又完全不报错的毛病。
    const fileId = await deps.fileId(input.path).catch(() => '')
    const key = sampleKey(file, windowS, fileId || undefined)
    if (key.kind === 'path') {
      deps.log?.(`[netdisk] 取不到对象 id，采样缓存退成路径档（这份文件被整理搬家后要重付一次转写）：${input.path}`)
    }

    const hit = deps.cache.get(key.key, sizeBytes)
    if (hit) return { ok: true, file, windowS, probe: hit, cached: true }

    const probe = await probeHeadTail(deps, { path: file.path, sizeBytes, durationS }, { windowS })
    // 上面两道门都过了还拿不到 probe，只剩"切片区间算不出来"——照实说，别端一份空采样。
    if (!probe) return { ok: false, reason: `切不出采样窗口（字节数或时长不可用）：${input.path}` }
    deps.cache.set(key.key, file, probe)
    return { ok: true, file, windowS, probe, cached: false }
  }
}
