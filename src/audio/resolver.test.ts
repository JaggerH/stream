import { describe, it, expect } from 'vitest'
import { resolveAudio, type AudioResolver } from './resolver.ts'

describe('resolveAudio chain', () => {
  const ok = (url: string, name = 'ok'): AudioResolver => ({ name, supports: () => true, resolve: async () => ({ url }) })
  const nul: AudioResolver = { name: 'nul', supports: () => true, resolve: async () => null }
  const boom: AudioResolver = { name: 'boom', supports: () => true, resolve: async () => { throw new Error('x') } }
  const unsupported: AudioResolver = { name: 'nope', supports: () => false, resolve: async () => ({ url: 'never' }) }

  it('returns the first non-null result and tags it with the provider name', async () => {
    const r = await resolveAudio({ platform: 'x' }, [nul, ok('https://a/1.mp3', 'second')])
    expect(r?.url).toBe('https://a/1.mp3')
    expect(r?.via).toBe('second')
  })

  it('skips throwing and unsupported providers', async () => {
    const r = await resolveAudio({ platform: 'x' }, [unsupported, boom, ok('https://b/2.mp3')])
    expect(r?.url).toBe('https://b/2.mp3')
  })

  it('returns null when nothing resolves', async () => {
    expect(await resolveAudio({ platform: 'x' }, [nul, boom])).toBeNull()
  })
})
