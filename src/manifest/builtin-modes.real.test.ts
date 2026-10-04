import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * builtin adapter **按 `fixed_params.mode` 分发**到 bootstrap 注册的实现函数——不是按 source id
 * （`src/adapters/builtin/adapter.ts`：`params.mode ?? manifest.fixed_params?.mode`）。
 *
 * 漏声明 mode 的代价活体见过（2026-07-30 ocr-vlm）：源装载正常、Provider 行 live、成员
 * health=healthy、keyState=stored——**每一个指标都是绿的**，直到用户真点下去，才报
 * `no implementation registered for mode ""`，而且它出现在梯子的 miss 里，长得像"这个成员
 * decline 了"。整条链路没有任何一处提前说过话。
 *
 * 为什么钉在这里而不是 loader 的 schema 里：mode 也可以由**调用时的 params** 提供
 * （`params.mode` 优先），所以"没有 fixed_params.mode"并不必然非法，装载期硬拒会误伤那类源。
 * 这份测试钉的是**本仓 builtin 清单的现状**：今天每一个都靠 fixed_params 声明，
 * 将来真出现一个靠调用参数拿 mode 的，改这里并写清它为什么例外。
 */
const MANIFESTS = fileURLToPath(new URL('../../packages/builtin/manifests.yaml', import.meta.url))

describe('packages/builtin/manifests.yaml', () => {
  it('每个 builtin 源都声明了 fixed_params.mode（分发键）', () => {
    const doc = parse(readFileSync(MANIFESTS, 'utf8')) as { sources?: unknown } | unknown[]
    const list = (Array.isArray(doc) ? doc : (doc as { sources?: unknown[] }).sources ?? []) as Array<{
      id: string
      adapter?: string
      fixed_params?: { mode?: unknown }
    }>
    expect(list.length).toBeGreaterThan(10) // 解析出来是空的话下面的断言会假绿

    const missing = list
      .filter((m) => m.adapter === 'builtin' && typeof m.fixed_params?.mode !== 'string')
      .map((m) => m.id)
    expect(missing).toEqual([])
  })

  /**
   * 第二类必须声明的字段：`output: object`。产出是**单个**结果对象（不是条目批）的 builtin 源
   * 必须声明它——执行器缝上按此解包（`src/bootstrap.ts` `m?.output === 'object'` 那一处）。
   * 漏了它，梯子会把整个 `[{...}]` 数组当赢家交出去：成员其实成功了，调用方读 `.text`/
   * `.markdown` 却是 undefined，而且因为它"赢"了，兜底成员根本不会跑——活体上表现成
   * "所有成员都没产出"，是最难查的一种故障（2026-07-30 ocr-vlm、article-firecrawl 都撞过
   * 这个坑的描述，见各自 manifest 条目里的头注）。
   *
   * 判据没法从 manifest 的其它字段通用地推出来——"这个源的产出是单个对象还是条目批"
   * 是 `src/bootstrap.ts` 里那个具体实现函数的返回形状（`BuiltinFn` 的类型签名统一是
   * `Promise<unknown[]>`，object 型只是把结果包成一元数组），manifest schema 本身不记录它，
   * `categories`/`capabilities` 等字段也答不出来（各包的 `*-resolve` 播放解析源同样是
   * `capabilities:[anchor]` 的 resolve 型源，产出的却是候选流列表而非单个对象）。所以这里
   * 退回一份**显式清单**：新加一个"产出单个结果对象"的 builtin 源时，把它加进这份清单——
   * 别指望这条测试自动认出它，那样的判据只会是一个每次都要猜的隐藏规则。
   */
  const KNOWN_OBJECT_OUTPUT_IDS = [
    'quark-save', 'quark-play', 'quark-folder',
    'article-defuddle',
    'ocr-vlm', 'ocr-mineru',
  ]

  it('已知产出单个结果对象的 builtin 源必须声明 output: object', () => {
    const doc = parse(readFileSync(MANIFESTS, 'utf8')) as unknown[]
    const list = doc as Array<{ id: string; output?: string }>
    expect(list.length).toBeGreaterThan(10) // 解析出来是空的话下面的断言会假绿

    const ids = new Set(list.map((m) => m.id))
    // 清单本身别腐化：条目从 manifest 里被改名/删掉时要察觉，不能悄悄漏检。
    for (const id of KNOWN_OBJECT_OUTPUT_IDS) expect(ids.has(id), `清单里的 ${id} 在 manifest 里已经找不到了`).toBe(true)

    const missing = list.filter((m) => KNOWN_OBJECT_OUTPUT_IDS.includes(m.id) && m.output !== 'object').map((m) => m.id)
    expect(missing).toEqual([])
  })
})
