import { z } from 'zod'
import type { SharedChannel, StreamRecord, ProviderRecord, ProviderBinding } from '../store/types.ts'
import type { MappingLeft, MatchSpec, MappingEntry } from '../netdisk/types.ts'

export const STREAM_BUNDLE_FORMAT = 'stream-bundle/v1' as const
export const BUNDLE_SIZE_WARN_BYTES = 1_000_000

export interface BundleMeta {
  title: string
  description?: string
  author?: string
  created: string
  revision: string
  /** 问题报给谁；本期只存不用（导入台账 import-run-store 的 report_to 口子）。 */
  report_to?: Record<string, string>
}
export interface PluginRequirement { id: string; version?: string; homepage?: string }
export interface RecipeRequirement { id: string; version?: string }
export interface CredentialRequirement { domain: string; reason?: string }
export interface RuntimeConfigRequirement { ref: string; fields: string[] }
/** 无法归类的 plugin（catalog 里既非代码插件也非 recipe）——显式落缺失，不静默丢。 */
export interface UnclassifiedDep { plugin: string; source: string }

export interface BundleRequires {
  plugins: PluginRequirement[]
  recipes: RecipeRequirement[]
  credentials: CredentialRequirement[]
  runtimeConfig: RuntimeConfigRequirement[]
  missing?: UnclassifiedDep[]
}

/** 内嵌数据型包：整份 recipe 包内联，对方开箱即用。T3：version/integrity/author 现阶段可缺，
 *  外部 scoped-身份 change 落地后补齐。装载先兼容当前 facility 单包形态。 */
export interface EmbeddedRecipePackage {
  /** 当前身份 = facility；未来 scoped id 的 facility 段。 */
  facility: string
  author?: string
  version?: string
  integrity?: string
  /** 原样 package.json 文本，落盘时逐字写回。 */
  packageJson: string
  /** 原样 manifests.yaml 文本（若源包有）。 */
  manifestsYaml?: string
  /** 文件名（*.recipe.json）→ 该 recipe 的原始 JSON 文本。 */
  recipeFiles: Record<string, string>
}

export interface StreamBundleV1 {
  format: typeof STREAM_BUNDLE_FORMAT
  meta: BundleMeta
  channels: SharedChannel[]
  streams: StreamRecord[]
  /** 能力搭车：非系统 Provider 行（可选、只由作者显式勾选加入，不进频道闭包）。 */
  providers?: ProviderRecord[]
  /** 能力搭车：callsite→provider 的用户 binding 覆盖（可选、显式勾选）。 */
  providerBindings?: ProviderBinding[]
  /** 网盘 binding 搭车：MappingSet 可移植子集（可选、显式勾选、不进频道闭包）。 */
  netdiskBindings?: NetdiskBindingShare[]
  requires: BundleRequires
  embedded: { recipes: Record<string, EmbeddedRecipePackage> }
}

/** 网盘对齐 binding 的可移植子集（config-sharing v2 · B）：只带能重建映射的东西——
 *  left（tmdb ref 原样 / stream ref 需 stream 同包）+ matchSpec 规则 + 仅带 corrected 的精简 entries
 *  + 可选 quark 公开分享链接。**绝不带** right.path（作者本机 AList 路径）或 fileId。 */
export interface NetdiskBindingShare {
  left: MappingLeft
  matchSpec?: MatchSpec
  entries?: MappingEntry[]
  shareUrl?: string
}

// —— zod 结构门禁（配置行用宽松 record，交给 UserStore 的 CHECK 兜底细节）——
const requiresSchema = z.object({
  plugins: z.array(z.object({ id: z.string(), version: z.string().optional(), homepage: z.string().optional() })),
  recipes: z.array(z.object({ id: z.string(), version: z.string().optional() })),
  credentials: z.array(z.object({ domain: z.string(), reason: z.string().optional() })),
  runtimeConfig: z.array(z.object({ ref: z.string(), fields: z.array(z.string()) })),
  missing: z.array(z.object({ plugin: z.string(), source: z.string() })).optional(),
})
const embeddedRecipeSchema = z.object({
  facility: z.string(),
  author: z.string().optional(),
  version: z.string().optional(),
  integrity: z.string().optional(),
  packageJson: z.string(),
  manifestsYaml: z.string().optional(),
  recipeFiles: z.record(z.string(), z.string()),
})
const bundleSchema = z.object({
  format: z.literal(STREAM_BUNDLE_FORMAT),
  meta: z.object({
    title: z.string(),
    description: z.string().optional(),
    author: z.string().optional(),
    created: z.string(),
    revision: z.string(),
    report_to: z.record(z.string(), z.string()).optional(),
  }),
  channels: z.array(z.record(z.string(), z.unknown())),
  streams: z.array(z.record(z.string(), z.unknown())),
  providers: z.array(z.record(z.string(), z.unknown())).optional(),
  providerBindings: z.array(z.record(z.string(), z.unknown())).optional(),
  netdiskBindings: z.array(z.record(z.string(), z.unknown())).optional(),
  requires: requiresSchema,
  embedded: z.object({ recipes: z.record(z.string(), embeddedRecipeSchema) }),
}).refine(
  (b) => b.channels.length + b.streams.length + (b.providers?.length ?? 0) + (b.netdiskBindings?.length ?? 0) > 0,
  { message: 'channels/streams/providers/netdiskBindings 至少一个非空' },
)

export function parseBundle(raw: unknown): { ok: true; bundle: StreamBundleV1 } | { ok: false; error: string } {
  // format 门禁先行：给出「格式版本不受支持」而不是一堆 zod 噪音。
  if (raw && typeof raw === 'object' && 'format' in raw && (raw as { format?: unknown }).format !== STREAM_BUNDLE_FORMAT) {
    return { ok: false, error: `不受支持的分享包格式版本：${String((raw as { format?: unknown }).format)}（本导入器只认 ${STREAM_BUNDLE_FORMAT}）` }
  }
  const parsed = bundleSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `分享包结构非法：${issue?.path.join('.') || '(root)'} — ${issue?.message}` }
  }
  return { ok: true, bundle: parsed.data as unknown as StreamBundleV1 }
}

export function serializeBundle(b: StreamBundleV1): string {
  return JSON.stringify(b, null, 2)
}

export function deserializeBundle(text: string): { ok: true; bundle: StreamBundleV1 } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `分享包不是合法 JSON：${(e as Error).message}` }
  }
  return parseBundle(raw)
}
