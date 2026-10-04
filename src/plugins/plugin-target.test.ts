import { afterEach, describe, expect, it } from 'vitest'
import {
  resolvePluginTarget,
  pluginNetMode,
  pluginTarget,
  setPluginTargetResolver,
  setPluginTargetMissReporter,
} from './plugin-target.ts'
import type { PluginDescriptor } from './types.ts'

const descs: PluginDescriptor[] = [
  { id: 'pansou', backend: { image: 'x', service: 'pansou', port: 8888 } } as PluginDescriptor,
  { id: 'alist', backend: { image: 'x', port: 5244 } } as PluginDescriptor, // service 缺省 → 用 id
  { id: 'builtin' } as PluginDescriptor, // 无 backend
]

describe('resolvePluginTarget', () => {
  it('compose 形态：有 backend → http://<service>:<port>', () => {
    expect(resolvePluginTarget('pansou', { descriptors: descs, mode: 'compose' })).toBe('http://pansou:8888')
  })
  it('service 缺省时回落到 plugin id', () => {
    expect(resolvePluginTarget('alist', { descriptors: descs, mode: 'compose' })).toBe('http://alist:5244')
  })
  it('无 backend 的插件 → null', () => {
    expect(resolvePluginTarget('builtin', { descriptors: descs, mode: 'compose' })).toBeNull()
  })
  it('未知插件 → null', () => {
    expect(resolvePluginTarget('nope', { descriptors: descs, mode: 'compose' })).toBeNull()
  })
  it('none 形态（桌面无门）：一律 null', () => {
    expect(resolvePluginTarget('pansou', { descriptors: descs, mode: 'none' })).toBeNull()
  })
})

describe('pluginNetMode', () => {
  it('STREAM_PLUGIN_NETWORK=compose → compose', () => {
    expect(pluginNetMode({ STREAM_PLUGIN_NETWORK: 'compose' })).toBe('compose')
  })
  it('缺省 → none', () => {
    expect(pluginNetMode({})).toBe('none')
  })
})

describe('pluginNetMode host 档', () => {
  it('STREAM_PLUGIN_NETWORK=host → host', () => {
    expect(pluginNetMode({ STREAM_PLUGIN_NETWORK: 'host' } as NodeJS.ProcessEnv)).toBe('host')
  })
  it('resolvePluginTarget 在 host 档静态解析返回 null（动态解析走 standbyOrigin）', () => {
    const descriptors = [
      { id: 'mineru', backend: { image: 'x', port: 9000 } },
    ] as unknown as PluginDescriptor[]
    expect(resolvePluginTarget('mineru', { descriptors, mode: 'host' })).toBeNull()
  })
})

// setPluginTargetResolver 让 bootstrap 在启动时把 {descriptors, mode} 绑好一次，之后每个
// server-side base 解析器（resolveTranscribeUrl/resolveMineruUrl/resolveAlistUrl/pansou，以及
// 递给包的 `ctx.backendUrl()` thunk）都读同一个注入点，不必给每个调用点单独穿 descriptors 参数。
describe('setPluginTargetResolver / pluginTarget', () => {
  afterEach(() => setPluginTargetResolver(() => null)) // 复位，别泄漏进下一个 test

  it('未接线前（如独立跑某个 client 的单测）一律 null，等价 mode=none', () => {
    expect(pluginTarget('mineru')).toBeNull()
  })

  it('bootstrap 接线后，调用方免穿参就能拿到真实 target', () => {
    setPluginTargetResolver((service) => resolvePluginTarget(service, { descriptors: descs, mode: 'compose' }))
    expect(pluginTarget('pansou')).toBe('http://pansou:8888')
    expect(pluginTarget('builtin')).toBeNull() // 无 backend 的插件仍是 null
  })
})

// 答空时的现场记录（spec 2026-08-19-plugin-target-empty-observability）。这一层只负责「答空了就
// 喊一声」，事实收集在 packages.ts、分类与渲染在 target-miss.ts —— 这里钉的是喊声本身。
describe('setPluginTargetMissReporter', () => {
  afterEach(() => {
    setPluginTargetResolver(() => null)
    setPluginTargetMissReporter(null)
  })

  it('答空 → reporter 收到 service;答出来 → 一声不吭', () => {
    const seen: string[] = []
    setPluginTargetResolver((service) => resolvePluginTarget(service, { descriptors: descs, mode: 'compose' }))
    setPluginTargetMissReporter((s) => { seen.push(s) })
    expect(pluginTarget('pansou')).toBe('http://pansou:8888')
    expect(seen).toEqual([])
    expect(pluginTarget('builtin')).toBeNull()
    expect(seen).toEqual(['builtin'])
  })

  it('resolver 未接线时答空也报（"钩子没接"本身就是要记的现场）', () => {
    const seen: string[] = []
    setPluginTargetResolver(null)
    setPluginTargetMissReporter((s) => { seen.push(s) })
    expect(pluginTarget('mineru')).toBeNull()
    expect(seen).toEqual(['mineru'])
  })

  it('reporter 抛错不改变取址行为——观测绝不能反过来打死主链路', () => {
    setPluginTargetResolver((service) => resolvePluginTarget(service, { descriptors: descs, mode: 'compose' }))
    setPluginTargetMissReporter(() => { throw new Error('debug bus exploded') })
    expect(() => pluginTarget('builtin')).not.toThrow()
    expect(pluginTarget('builtin')).toBeNull()
    expect(pluginTarget('pansou')).toBe('http://pansou:8888')
  })

  it('未接 reporter（单测/stdio）一律 no-op', () => {
    setPluginTargetMissReporter(null)
    expect(pluginTarget('nope')).toBeNull()
  })
})

// 窥视档：**只是问一句地址，不打算用它**（状态面板、`available()` 这类纯探测）。host 档下
// standby 管着的容器闲置就 stop，停着时没有 loopback 宿主口 —— 答空是**正确答案**，喊出来只是
// 噪音。实测 2026-08-24 起 777 条 `plugin-target` 现场里 777 条来自这类探测、0 条来自真正的
// 消费路径（先 withAwake 再取址），频道被淹。这里钉的是「静音只静喊声，不动取址」。
describe('pluginTarget 窥视档（peek）', () => {
  afterEach(() => {
    setPluginTargetResolver(() => null)
    setPluginTargetMissReporter(null)
  })

  it('peek 答空 → reporter 不被调用；返回值与普通档逐字相同', () => {
    const seen: string[] = []
    setPluginTargetResolver((service) => resolvePluginTarget(service, { descriptors: descs, mode: 'compose' }))
    setPluginTargetMissReporter((s) => { seen.push(s) })
    const peeked = pluginTarget('builtin', { peek: true })
    expect(peeked).toBeNull()
    expect(seen).toEqual([]) // 窥视不喊
    expect(peeked).toBe(pluginTarget('builtin')) // 取址行为零变化
    expect(seen).toEqual(['builtin']) // 普通档照喊 —— 静音的只有窥视那一档
  })

  it('peek 答得出来时也与普通档逐字相同（两档只差一个喊声）', () => {
    setPluginTargetResolver((service) => resolvePluginTarget(service, { descriptors: descs, mode: 'compose' }))
    setPluginTargetMissReporter(() => { throw new Error('不该被调用') })
    expect(pluginTarget('pansou', { peek: true })).toBe('http://pansou:8888')
    expect(pluginTarget('alist', { peek: true })).toBe('http://alist:5244')
  })

  it('resolver 未接线时 peek 也不喊（探测本来就不关心钩子接没接）', () => {
    const seen: string[] = []
    setPluginTargetResolver(null)
    setPluginTargetMissReporter((s) => { seen.push(s) })
    expect(pluginTarget('mineru', { peek: true })).toBeNull()
    expect(seen).toEqual([])
  })
})

// 「内置 + 第三方」的合并名单已收进 BackendDirectory（src/kernel/plugins/backend-directory.ts），
// 它自己的测试在 backend-directory.test.ts。
