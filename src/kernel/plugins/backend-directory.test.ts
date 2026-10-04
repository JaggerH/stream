import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { BackendDirectory, backendDirectoryPlugin } from './backend-directory.ts'
import { createKernel, quiesceKernel } from '../context.ts'
import { loadPlugins } from '../../plugins/loader.ts'
import { resolvePluginTarget } from '../../plugins/plugin-target.ts'
import type { PluginDescriptor } from '../../plugins/types.ts'

const PACKAGES_DIR = fileURLToPath(new URL('../../../packages', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const builtinLike: PluginDescriptor[] = [
  { id: 'pansou', backend: { image: 'x', service: 'pansou', port: 8888 } } as PluginDescriptor,
  { id: 'alist', backend: { image: 'x', port: 5244 } } as PluginDescriptor,
  { id: 'builtin' } as PluginDescriptor, // 无 backend
]

describe('BackendDirectory', () => {
  const thirdParty: PluginDescriptor[] = [
    { id: 'acme-scraper', backend: { image: 'x', service: 'acme-scraper', port: 7000 } } as PluginDescriptor,
  ]

  // 终审 Important 3：网关（serve.ts）与 target resolver（bootstrap.ts）原本都只吃内置那层
  // descriptors，于是第三方容器被建起来、被 standby 管着、被回收，`/_p/<包 id>` 却恒 404
  // （compose 档 backendUrl() 恒 undefined），而任何日志都不会提这件事。
  it('第三方带 backend 的包进得了名单，compose 档能解出容器 DNS', () => {
    const all = new BackendDirectory(builtinLike, thirdParty).all()
    expect(resolvePluginTarget('acme-scraper', { descriptors: all, mode: 'compose' })).toBe('http://acme-scraper:7000')
  })

  it('内置排在前：万一撞名，赢的是内置（第三方不能顶掉一个已存在的 service 名）', () => {
    const shadow = [{ id: 'pansou', backend: { image: 'evil', service: 'pansou', port: 1 } } as PluginDescriptor]
    const all = new BackendDirectory(builtinLike, shadow).all()
    expect(resolvePluginTarget('pansou', { descriptors: all, mode: 'compose' })).toBe('http://pansou:8888')
  })

  it('没有第三方那层时就是内置本身（老调用方行为一字不变）', () => {
    expect(new BackendDirectory(builtinLike).all()).toEqual(builtinLike)
    expect(new BackendDirectory(builtinLike, []).all()).toEqual(builtinLike)
  })

  it('第三方里没声明 backend 的包不进名单（名单的定义就是「带 backend 的包」）', () => {
    const all = new BackendDirectory([], [{ id: 'recipes-only' } as PluginDescriptor, ...thirdParty]).all()
    expect(all.map((p) => p.id)).toEqual(['acme-scraper'])
  })
})

// 钉数字：拿**真实的** packages/ 目录扫一遍（同 loader.real.test.ts 的先例），
// 断言「内置全部 + 注入的第三方 = 目录条数」。合并语义哪天被改窄（比如某处顺手加了
// 一道过滤），这里当场变红——而线上的表现只会是 `/_p/<某个 id>` 静默 404。
describe('BackendDirectory（真实 packages/ 目录）', () => {
  it('内置数 + 第三方数 = 目录条数，且顺序是内置在前', () => {
    const builtin = loadPlugins(PACKAGES_DIR)
    const injected: PluginDescriptor[] = [
      { id: 'acme-scraper', backend: { image: 'x', service: 'acme-scraper', port: 7000 } } as PluginDescriptor,
      { id: 'acme-other', backend: { image: 'x', service: 'acme-other', port: 7001 } } as PluginDescriptor,
    ]
    const all = new BackendDirectory(builtin, injected).all()
    expect(all).toHaveLength(builtin.length + injected.length)
    expect(all.slice(0, builtin.length).map((p) => p.id)).toEqual(builtin.map((p) => p.id))
    expect(all.slice(builtin.length).map((p) => p.id)).toEqual(['acme-scraper', 'acme-other'])
  })
})

// 收尾扫描：**合并只许发生在一个地方**。这一条守的不是行为，是「下一个人会不会再合一次」——
// 同型缺陷（漏一处 → 容器建起来了、健康检查绿着、`/_p/<包 id>` 恒 404、零日志）已犯四次。
describe('合并名单只有一份实现', () => {
  const sources = [
    'src/bootstrap.ts',
    'src/serve.ts',
    'src/plugins/plugin-target.ts',
    'src/plugins/standby/wire.ts',
    'src/packages/container-ops.ts',
  ]

  it('生产代码里没有 mergeBackendDescriptors 的残留', () => {
    for (const rel of sources) {
      expect(readFileSync(REPO_ROOT + rel, 'utf8'), rel).not.toMatch(/mergeBackendDescriptors/)
    }
  })

  it('没有第二处 [...plugins, ...thirdParty…] 式的手工合并', () => {
    for (const rel of sources) {
      const src = readFileSync(REPO_ROOT + rel, 'utf8')
      // bootstrap 里 `thirdPartyBackends` 只许出现在**建 BackendDirectory 的那一处**
      // （加上它自己的构造与注释）；serve/其余文件一次都不该出现。
      expect(src, rel).not.toMatch(/\.\.\.\s*plugins\s*,\s*\.\.\.\s*thirdPartyBackends/)
    }
  })
})

describe('backendDirectoryPlugin', () => {
  it('挂成 ctx.backendDirectory，销毁后消失', async () => {
    const kernel = createKernel()
    const directory = new BackendDirectory(builtinLike)
    expect(kernel.get('backendDirectory')).toBeUndefined()
    await kernel.plugin(backendDirectoryPlugin, { directory })
    // 注入的是**同一个实例**，不是同料重建的第二份——「只合并一次」是这个类存在的全部意义。
    expect(kernel.backendDirectory).toBe(directory)
    await quiesceKernel(kernel)
    expect(kernel.get('backendDirectory')).toBeUndefined()
  })
})
