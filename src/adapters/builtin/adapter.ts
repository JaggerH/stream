import type { Adapter, SourceExecutionContext } from '../types.ts'
import type { SourceManifest } from '../../manifest/types.ts'

export type { SourceExecutionContext } from '../types.ts'

/** 内置能力函数：input 是调用点给的原始输入（TrackRef / 查询词 / URL…），params 是
 *  manifest fixed_params ⊕ Provider 行成员 params（$input 洞已填）。
 *  合同语义与所有 adapter 一致：返回 [] = decline（落到下一档），抛错 = 失败。 */
export type BuiltinFn = (input: unknown, params: Record<string, unknown>, context?: SourceExecutionContext) => Promise<unknown[]>

/** builtin adapter — 进程内能力的 Source 化外壳（方案 A：成员一律是 Source）。
 *  播放解析/无损下载/聚合搜索/磁力/网页抓取等原 fn 成员由 plugins/builtin/package.json 与 plugins/builtin/manifests.yaml 声明
 *  manifest（名称/描述/参数都住在声明里，与其他源同权），本 adapter 按
 *  `fixed_params.mode` 分发到 bootstrap 注册的实现函数。 */
export class BuiltinAdapter implements Adapter {
  readonly id = 'builtin'
  private readonly fns = new Map<string, BuiltinFn>()

  constructor(private readonly runtimeConfigFor: (manifest: SourceManifest) => Record<string, unknown> = () => ({})) {}

  register(mode: string, fn: BuiltinFn): void {
    this.fns.set(mode, fn)
  }

  modes(): string[] {
    return [...this.fns.keys()]
  }

  async init(): Promise<void> {}

  async fetch(params: Record<string, unknown>, manifest: SourceManifest, context?: SourceExecutionContext): Promise<unknown[]> {
    const mode = String(params.mode ?? manifest.fixed_params?.mode ?? '')
    const fn = this.fns.get(mode)
    if (!fn) throw new Error(`[builtin] no implementation registered for mode "${mode}" (source ${manifest.id})`)
    return fn(params.input, params, context ?? { runtimeConfig: this.runtimeConfigFor(manifest) })
  }
}
