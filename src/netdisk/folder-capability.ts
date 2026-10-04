import type { ProviderExecutor } from '../providers/executor.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import type { ProviderDirectory } from '../providers/directory.ts'

/** 网盘内路径段 → 该网盘网页里那个文件夹的 URL（+ 原生 fid，供缓存）。 */
export interface NetdiskFolder {
  url: string
  fid?: string
}

export interface NetdiskFolderDeps {
  executor: ProviderExecutor
  /** 选行判据（守门就是靠给它传 `fallback:false`）。 */
  directory: Pick<ProviderDirectory, 'match'>
  bindings?: Pick<ProviderBindings, 'dispatch'>
}

const FOLDER_CALLSITE = 'netdisk.folder'

/**
 * `netdisk.folder` 调用点的守门 + 解包，和 NetdiskShare/Play Capability 同构。「跳转网盘」按网盘
 * 选 Provider：夸克逐层解析路径段成 fid、拼网页 URL；其它网盘暂无 → 回落 AList 链接。
 * 守门同 share/play：绑定与按 key 选行**两条路都传 `fallback:false`**，只认真正声明
 * `<网盘>-folder` 的专属行。
 */
export class NetdiskFolderCapability {
  constructor(private readonly deps: NetdiskFolderDeps) {}

  private rowFor(key: string): string | null {
    // 频道槽位上下文见 bindings.SlotContext，本调用点无频道语境故不传 ctx
    const bound = this.deps.bindings?.dispatch(FOLDER_CALLSITE, key, undefined, { fallback: false })
    if (bound) return bound
    return this.deps.directory.match('resolve', key, { fallback: false })[0]?.row.id ?? null
  }

  supports(netdisk: string): boolean {
    return this.rowFor(`${netdisk}-folder`) != null
  }

  /** 路径段（相对网盘根）→ 网页文件夹 URL。不支持的网盘 / 无登录态 / 解析不到 → null。 */
  async folderUrl(netdisk: string, segments: string[]): Promise<NetdiskFolder | null> {
    const id = this.rowFor(`${netdisk}-folder`)
    if (!id) return null
    const r = await this.deps.executor.invoke(id, segments)
    if (!r || r.strategy !== 'sequential' || r.value == null) return null
    const v = r.value as Record<string, unknown>
    if (typeof v.url !== 'string') return null
    return { url: v.url, fid: typeof v.fid === 'string' ? v.fid : undefined }
  }
}
