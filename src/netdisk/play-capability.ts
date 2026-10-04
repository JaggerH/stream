import type { ProviderExecutor } from '../providers/executor.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import type { ProviderDirectory } from '../providers/directory.ts'

/** 网盘文件 → 可播放流地址（转码后的 H.264+AAC）。resolution 仅供日志/选档展示。 */
export interface NetdiskPlayStream {
  url: string
  resolution?: string
  width?: number
  audioCodec?: string
  videoCodec?: string
  /** 该文件所有可播档位（好→省，含上面这一档）。播放取最好的那档，抽音轨转写要问的是「哪档最省」
   *  ——同一次 API 应答的两端。带在这个对象上，`netdisk.play` 调用点的形状（output:object）不变，
   *  不为同一个问题另立 Provider 行/调用点/源。 */
  renditions?: NetdiskRendition[]
}

/** 一个可播档位。`sizeBytes`/`bitrateBps` 只在网盘**真报了**时才有——路线判决拒绝根据猜出来的
 *  数字改道（见 src/media/audio-route.ts）。 */
export interface NetdiskRendition {
  resolution: string
  url: string
  sizeBytes?: number
  bitrateBps?: number
}

export interface NetdiskPlayDeps {
  executor: ProviderExecutor
  /** 选行判据（守门就是靠给它传 `fallback:false`）。 */
  directory: Pick<ProviderDirectory, 'match'>
  bindings?: Pick<ProviderBindings, 'dispatch'>
}

const PLAY_CALLSITE = 'netdisk.play'

/** 一条档位记录，形状不对就整条丢掉——档位是喂给成本判决的输入，宁可少一条也不能是垃圾数字。 */
function one(r: unknown): NetdiskRendition[] {
  if (!r || typeof r !== 'object') return []
  const v = r as Record<string, unknown>
  if (typeof v.url !== 'string' || typeof v.resolution !== 'string') return []
  const pos = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined)
  return [{ resolution: v.resolution, url: v.url, sizeBytes: pos(v.sizeBytes), bitrateBps: pos(v.bitrateBps) }]
}

/**
 * `netdisk.play` 调用点的守门 + 解包，和 NetdiskShareCapability 同构（verify/save 的孪生）。
 * 播放解析是按网盘选 Provider：夸克有转码流（有声）、其它网盘暂无 → 回落原始直链。
 *
 * 守门同 share：绑定与按 key 选行**两条路都传 `fallback:false`**，只认真正声明了 `<网盘>-play`
 * 的专属行——一个没有转码能力的网盘落进兜底行会拿回语义无意义的"结果"而不是诚实的「不支持」。
 */
export class NetdiskPlayCapability {
  constructor(private readonly deps: NetdiskPlayDeps) {}

  private rowFor(key: string): string | null {
    // 频道槽位上下文见 bindings.SlotContext，本调用点无频道语境故不传 ctx
    const bound = this.deps.bindings?.dispatch(PLAY_CALLSITE, key, undefined, { fallback: false })
    if (bound) return bound
    return this.deps.directory.match('resolve', key, { fallback: false })[0]?.row.id ?? null
  }

  /** 这个网盘有没有专属的转码播放行。 */
  supports(netdisk: string): boolean {
    return this.rowFor(`${netdisk}-play`) != null
  }

  /**
   * 网盘文件 fid → 转码可播流。不支持的网盘 / 无登录态 / 无转码 → null（调用方回落原始直链）。
   */
  async stream(netdisk: string, fid: string): Promise<NetdiskPlayStream | null> {
    const id = this.rowFor(`${netdisk}-play`)
    if (!id) return null
    const r = await this.deps.executor.invoke(id, fid)
    // 成员 manifest 声明 output:'object'，执行器缝上已解包——{url, resolution, …} 直达。
    if (!r || r.strategy !== 'sequential' || r.value == null) return null
    const v = r.value as Record<string, unknown>
    if (typeof v.url !== 'string') return null
    return {
      url: v.url,
      resolution: typeof v.resolution === 'string' ? v.resolution : undefined,
      width: typeof v.width === 'number' ? v.width : undefined,
      audioCodec: typeof v.audioCodec === 'string' ? v.audioCodec : undefined,
      videoCodec: typeof v.videoCodec === 'string' ? v.videoCodec : undefined,
      renditions: Array.isArray(v.renditions) ? v.renditions.flatMap((r) => one(r)) : undefined,
    }
  }
}
