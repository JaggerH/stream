import type { ProviderExecutor } from '../providers/executor.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import type { ProviderDirectory } from '../providers/directory.ts'

/** 判决词汇在 `shared/netdisk/share-validity.ts`（编排层与 DSH 网盘插件同一份）；这里只是沿用的名字。
 *  前端对 501 守的是同一条「没查成 ≠ 已失效」原则，这里是它在后端的另一半。 */
import type { ShareValidity, ShareFile, VerifyResult } from '../../shared/netdisk/share-validity.ts'
export type { ShareValidity, ShareFile, VerifyResult }

export interface SaveResult {
  saved: boolean
  /** 失败停在哪一步：token / detail / dest（落点目录建不出来）/ save / task；成功为 done */
  stage: string
  message: string
  dest?: string
  file_count?: number
}

export interface NetdiskShareDeps {
  executor: ProviderExecutor
  /** 选行判据（守门就是靠给它传 `fallback:false`）。 */
  directory: Pick<ProviderDirectory, 'match'>
  bindings?: Pick<ProviderBindings, 'dispatch'>
}

const VERIFY_CALLSITE = 'netdisk.share.verify'
const SAVE_CALLSITE = 'netdisk.share.save'

/**
 * `netdisk.share.*` 两个调用点的守门 + 解包，收在一处，因为多个消费方（Search Agent、影视频道
 * 搜索）要的是同一件事，不该各写一份。
 *
 * 为什么必须守门：选行在无具名匹配时会回落到本 category 的兜底行——对「未知输入也值得试一把」
 * 的能力（如 content.enrich 的网页兜底抓取）是对的，对网盘是错的：一个不支持的网盘落进任何
 * resolve 兜底行，都会拿回一个语义上无意义的"结果"而不是诚实的「不支持」。
 *
 * 所以**两条路都传 `fallback:false`**：绑定那一路（dispatch）与按 key 选行那一路（match）
 * 各自都只认真正声明了这个 key 的专属行，没有就 `supported:false`。
 */
export class NetdiskShareCapability {
  constructor(private readonly deps: NetdiskShareDeps) {}

  /** 这个网盘有没有专属行（而非兜底行）接活。 */
  private rowFor(callsite: string, key: string): string | null {
    // 频道槽位上下文见 bindings.SlotContext，本调用点无频道语境故不传 ctx
    const bound = this.deps.bindings?.dispatch(callsite, key, undefined, { fallback: false })
    if (bound) return bound
    return this.deps.directory.match('resolve', key, { fallback: false })[0]?.row.id ?? null
  }

  supports(netdisk: string, op: 'verify' | 'save'): boolean {
    const callsite = op === 'verify' ? VERIFY_CALLSITE : SAVE_CALLSITE
    return this.rowFor(callsite, `${netdisk}-${op}`) != null
  }

  /**
   * 一条分享 → 存活与否 + 里面的文件。不支持的网盘 → null（调用方据此跳过，而不是拿到假结果）。
   * `passcode` 有就带上：百度几乎每条分享都锁着提取码，没有它只能看到"存在但看不进去"。
   */
  async verify(netdisk: string, pwdId: string, opts?: { passcode?: string }): Promise<VerifyResult | null> {
    const id = this.rowFor(VERIFY_CALLSITE, `${netdisk}-verify`)
    if (!id) return null
    const r = await this.deps.executor.invoke(id, pwdId, opts?.passcode ? { overrides: { passcode: opts.passcode } } : undefined)
    if (!r || r.strategy !== 'sequential') return null
    // value == null 把两件必须分开的事合在了一起，靠 miss 上有没有 stack 拆开
    // （InvokeMiss.stack：「undefined for non-error misses」）：
    //  - 弃权（无 stack）= 成员返回 0 item（executor: `items.length ? items : null`）= recipe
    //    跑通了、上游答了、这条分享里没东西 → 这是判决：not-usable。
    //  - 抛错（有 stack）= 网络故障 / 上游 5xx / 限流 / body 不是 JSON → 我们没查成，对这条链
    //    一无所知 → unknown。把它说成"已失效"是撒谎，而死链默认隐藏，这个谎会让活链消失。
    // 混合时按 unknown 算：只要有人没查成，就不该替这条链下判决。
    if (r.value == null) {
      if (r.misses.some((m) => /needslogin|需要登录|login/i.test(m.reason))) return { validity: 'needs-login', files: [] }
      const threw = r.misses.some((m) => m.stack)
      return { validity: threw ? 'unknown' : 'not-usable', files: [] }
    }
    // 成员是 object 型（manifest.output='object'，执行器缝上已解包）：判决对象直达——
    // 「数行数猜死活」「title 当文件名」的推断纪元到此为止；validity 缺失按 unknown 处理
    // （判决说不清 = 我们不替这条链下结论）。
    const v = r.value as { validity?: unknown; files?: unknown }
    const validity = typeof v.validity === 'string' ? (v.validity as ShareValidity) : 'unknown'
    const files = (Array.isArray(v.files) ? v.files : []).map((f) => ({
      name: String((f as Record<string, unknown>)?.name ?? ''),
      is_dir: Boolean((f as Record<string, unknown>)?.is_dir),
      size: Number((f as Record<string, unknown>)?.size ?? 0),
    }))
    return { validity, files }
  }

  /** 转存进落点目录（默认取行上的 dest，可按次覆盖）。不支持的网盘 → null。 */
  /**
   * `subdir`（作品名）不是 `dest` 的替代品，是它的下一层：绑定是「一个目录 ↔ 一个左侧」一对一，
   * 所有作品共用一个落点，那个目录就同时装着几十部片子，没有哪个绑定能把它当自己的右侧。
   *
   * 落点根仍是行上的成员参数（用户在 Provider 页面改的那个）——subdir 只是它的下一层，
   * 由适配器组段。调用方不需要知道那个默认值，也就不会把配置复制到前端。
   */
  async save(netdisk: string, pwdId: string, opts?: { dest?: string; subdir?: string; passcode?: string }): Promise<SaveResult | null> {
    const id = this.rowFor(SAVE_CALLSITE, `${netdisk}-save`)
    if (!id) return null
    const overrides: Record<string, unknown> = {}
    if (opts?.dest) overrides.dest = opts.dest
    // subdir 是独立的 scalar 参数，由适配器和 dest 组段——**绝不在这里拼**：
    // 参数管道声明的是 scalar，让数组穿过它会被 String() 拍成 'a,b'（活体实测:
    // 真在盘上建出了名叫 `From Stream,流浪地球` 的目录）。
    if (opts?.subdir) overrides.subdir = opts.subdir
    if (opts?.passcode) overrides.passcode = opts.passcode
    const r = await this.deps.executor.invoke(id, pwdId, Object.keys(overrides).length ? { overrides } : undefined)
    if (!r || r.strategy !== 'sequential' || r.value == null) {
      const reason = (r?.misses ?? []).map((m) => m.reason).join('; ')
      return { saved: false, stage: 'invoke', message: reason || 'no save provider result' }
    }
    // quark-save 的 manifest 声明 output:'object'，执行器缝上已解包——结果对象直达。
    const v = r.value as Record<string, unknown>
    return {
      saved: Boolean(v.saved),
      stage: String(v.stage ?? ''),
      message: String(v.message ?? ''),
      dest: v.dest == null ? undefined : String(v.dest),
      file_count: v.file_count == null ? undefined : Number(v.file_count),
    }
  }
}
