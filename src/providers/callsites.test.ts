import { describe, it, expect, afterEach } from 'vitest'
import { PROVIDER_CALLSITES, providerCallsite } from './callsites.ts'
import { setPackageIdentities } from './identities.ts'

const decl = (callsites: string[]) => [{
  facility: 'pkg',
  declaration: {
    id: 'pkg-track', category: 'resolve' as const, serveKeys: ['pkg'], strategy: 'sequential' as const,
    label: 'L', description: 'D', members: [{ mode: 'auto' as const, matches: 'pkg.com/song' }], callsites,
  },
}]

afterEach(() => setPackageIdentities([]))

describe('music.track.* 调用点', () => {
  it('两条都是 dispatch（按 platform 键派发，不是绑死一行）', () => {
    for (const id of ['music.track.resolve', 'music.track.download']) {
      expect(providerCallsite(id)!.mode).toBe('dispatch')
    }
  })
  it('没有包声明时默认行为空——宿主自己不认识任何取歌平台', () => {
    expect(providerCallsite('music.track.resolve')!.defaultProviderIds).toEqual([])
  })
  it('包声明了 callsites → 默认行列表现取得到它（不是启动时冻住的）', () => {
    setPackageIdentities(decl(['music.track.resolve', 'music.track.download']))
    expect(providerCallsite('music.track.resolve')!.defaultProviderIds).toEqual(['pkg-track'])
    expect(PROVIDER_CALLSITES.find((c) => c.id === 'music.track.download')!.defaultProviderIds).toEqual(['pkg-track'])
  })
  it('其余调用点的默认行不受影响', () => {
    setPackageIdentities(decl(['music.track.resolve']))
    expect(providerCallsite('llm.chat')!.defaultProviderIds).toEqual(['llm'])
  })
})
