import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * 「把一个网盘目录当节目源订阅」走的是**通用的「添加来源」**，不是网盘面板里另搭的一个挂载
 * 按钮。这条路只靠 manifest 上的两个声明撑着，而它们**掉了都不报错**：
 *
 * - `discoverable: true` —— 掉了 alist-audio 就从跨源发现（`Registry.search`，MCP `list_sources`
 *   和 agent 的选源都吃它）里消失，用户与 agent 都挑不到它，只是"搜不出来"；
 * - `params_schema.path.widget: netdisk-dir` —— 掉了 path 就退回一个纯文本框，用户得手敲
 *   `/quark/来自：分享/播客付费节目合集/春典 JARGON` 这种路径。**能力倒退，界面上毫无异常。**
 *
 * 另一端（widget 这个 key 兑成哪个控件）钉在前端 `SourceParamField` 的 PARAM_WIDGETS 上，
 * 由 `app/src/components/source/SourceParamField.netdiskDir.test.tsx` 守着。两端各钉一条：
 * 任一端改了 key 而另一端没跟，其中一条就会红。
 */
const MANIFESTS = fileURLToPath(new URL('./manifests.yaml', import.meta.url))

type Entry = {
  id: string
  discoverable?: boolean
  params_schema?: Record<string, { widget?: unknown; required?: unknown }>
}

function entries(): Entry[] {
  const list = parse(readFileSync(MANIFESTS, 'utf8')) as Entry[]
  expect(Array.isArray(list) && list.length).toBeTruthy() // 解析成空的话下面全是假绿
  return list
}

describe('packages/alist/manifests.yaml', () => {
  it('alist-audio 是可订阅的 feed：discoverable，且 path 挂着目录选择器', () => {
    const audio = entries().find((m) => m.id === 'alist-audio')
    expect(audio, 'alist-audio 不见了——被改名还是删了？').toBeTruthy()
    // discoverable 缺省是 true，但这里要的是**显式声明**：它是这个包里唯一露面的一条，
    // 隐式默认读不出「这是有意为之」。
    expect(audio!.discoverable).toBe(true)
    expect(audio!.params_schema?.path?.required).toBe(true)
    expect(audio!.params_schema?.path?.widget).toBe('netdisk-dir')
  })

  /**
   * 另外两条是**内部能力**，不是 feed：alist-list 供绑定向导选目录/增量 diff，alist-resolve
   * 是播放兜底的 Provider 成员。它们出现在浏览目录里，用户只会挑到一个加进订阅也不产出条目
   * 的东西——所以必须显式 discoverable:false（缺省是 true，漏写就会露面）。
   */
  it('alist-list / alist-resolve 是内部能力，不露面', () => {
    const list = entries()
    for (const id of ['alist-list', 'alist-resolve']) {
      const m = list.find((x) => x.id === id)
      expect(m, `${id} 不见了——被改名还是删了？`).toBeTruthy()
      expect(m!.discoverable, `${id} 不该出现在浏览目录里`).toBe(false)
    }
  })
})
