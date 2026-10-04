import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { activate } from './activate.ts'
import type { PluginContext } from '../../src/packages/activate.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const ctx = (over: Partial<PluginContext> = {}): PluginContext => ({
  backendUrl: () => undefined,
  withAwake: (_s, fn) => fn(),
  // 这个包不碰登录态：桩子抛而不是 no-op——静默的空实现会让"其实调到了"这件事看不见。
  cookieFor: async () => { throw new Error('这个包不该调 cookieFor') },
  login: async () => { throw new Error('这个包不该调 login') },
  readSource: async () => [],
  readArticle: async () => { throw new Error('这个包不该调 readArticle') },
  log: () => {},
  config: {},
  ...over,
})

const declared = (JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
  stream: { code: { adapters: string[]; normalizers: string[]; enrichers: string[] } }
}).stream.code

describe('xhs activate', () => {
  // 交出来的名字必须与 package.json#stream.code 申报的一致：装载器按申报名单校验，漂了就是装载期硬拒。
  it('交出的 adapter / normalizer / enricher 名与 stream.code 申报的逐一相同', () => {
    const out = activate(ctx())
    expect(Object.keys(out.adapters ?? {})).toEqual(declared.adapters)
    expect(Object.keys(out.normalizers ?? {})).toEqual(declared.normalizers)
    expect(Object.keys(out.enrichers ?? {})).toEqual(declared.enrichers)
    expect(out.connect).toBeUndefined()
  })

  // 流地址表是 detail 与 resolve 之间唯一的传话渠道：enricher 记下的地址，adapter 要拿得到。
  it('detail enricher 记下的流地址，xhs-resolve 成员不再跑 recipe 就答得出', async () => {
    const readSource = vi.fn(async () => [
      { noteId: 'n1', video_stream: { h264: [{ masterUrl: 'http://cdn/n1.mp4' }] } },
    ])
    const out = activate(ctx({ readSource }))
    await out.enrichers!['xhs-detail']!({ noteId: 'n1', xsec_token: 't' })
    expect(readSource).toHaveBeenCalledTimes(1)
    const resolved = await out.adapters!.xhs!.fetch({ vid: 'n1' }, { id: '@streamapp/xhs/xhs-resolve' } as unknown as SourceManifest)
    expect(resolved).toMatchObject([{ kind: 'progressive', url: 'http://cdn/n1.mp4' }])
    expect(readSource).toHaveBeenCalledTimes(1)
  })
})
