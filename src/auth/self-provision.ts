import type { SourceManifest } from '../manifest/types.ts'

/**
 * 「这个配置缺件，有没有一条 recipe 能自己去补上」的**唯一判据**。
 *
 * 为什么是具名导出而不是在调用点内联一个 filter：这条判据会被多个消费方吃（agent 面、
 * 设置页、将来的 CLI），而内联的判据搜不到、也钉不住数字——本仓库为这个形状栽过五次
 * （见 AGENTS.md「加了一份名单 / 一条判据 → 名字就是你的回补清单」）。
 *
 * 输入是 manifest 列表而不是 Registry：判据本身不需要认识 registry，纯函数才测得动。
 */
export interface SelfProvisionOption {
  sourceId: string
  ref: string
  kind: 'read' | 'create'
  label: string
}

/**
 * `read` 和 `create` 不等价，**顺序是产出契约的一部分**。
 *
 * 读是幂等的：重跑不会在账号里堆出一排看不出区别的同名 key（理由写在
 * `packages/firecrawl/firecrawl-read-key.recipe.json` 的 `_why_read_not_create`）。
 * 所以能读就别建，只有账号里一把都没有时才退到 create。
 *
 * 判据取 sourceId 里的动词而不是新加一个 manifest 字段：这两个词是既有 recipe 的命名
 * 约定（`*-read-key` / `*-create-key`），加字段等于要求所有存量 recipe 回填一遍。
 * 认不出动词的一律当 `create`——保守的那一边（会多建一把 key，而不是漏掉一条可用的路）。
 */
function kindOf(sourceId: string): 'read' | 'create' {
  return /-read-/.test(sourceId) ? 'read' : 'create'
}

export function selfProvisionRecipesFor(
  manifests: readonly SourceManifest[],
  ref: string,
): SelfProvisionOption[] {
  const hits: SelfProvisionOption[] = []
  for (const m of manifests) {
    if (m.runtime_config?.ref !== ref) continue
    // **同一个 ref ≠ 能补它。** 声明 ref 只说明这份 Source 和那格配置有关系，方向可以是反的：
    // `eastmoney-login` 声明 ref `eastmoney` 是为了读用户手填的资金账号/交易密码
    // （`secret_params`），跑它一万遍也变不出那两个值。判据只认显式的
    // `runtime_config.provisions`（见 manifest/types.ts 那个字段的头注）——把消费方算成
    // "能补"，agent 就会去劝用户跑一条根本补不了的 recipe，那比不给建议更坏。
    if (!m.runtime_config.provisions?.length) continue
    // label 契约是「给人看的一句话」。recipe 合成的 manifest 通常没有 title
    // （见 src/replay/recipe-manifest.ts:112 只填 meta.title，而这几条 recipe 的
    // meta 只有 description），人话落在 description 里；掉到 id 是最后的兜底，
    // 那时用户看到的会是一个 kebab-case 的 id。
    hits.push({ sourceId: m.id, ref, kind: kindOf(m.id), label: m.title ?? m.description ?? m.id })
  }
  return hits.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'read' ? -1 : 1))
}
