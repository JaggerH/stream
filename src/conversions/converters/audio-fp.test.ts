// src/conversions/converters/audio-fp.test.ts
import { describe, it, expect } from 'vitest'
import { makeAudioFpConverter } from './audio-fp.ts'
import { decodeFingerprint } from '../../media/audio-fingerprint.ts'
import type { ConversionContext } from '../runner.ts'

function ctx(options: Record<string, unknown> = {}): ConversionContext {
  return {
    id: 'c1', itemId: 'item-1', kind: 'audio-fp', options,
    signal: new AbortController().signal,
    stage: (_n, fn) => fn(),
  }
}

describe('makeAudioFpConverter', () => {
  it('取到字节 → 指纹 base64 落 result，totalS 取 options.durationS', async () => {
    const conv = makeAudioFpConverter({
      resolveMedia: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }),
      fingerprint: async () => new Uint32Array([7, 8, 9]),
      available: () => true,
    })
    const out = await conv.run(ctx({ durationS: 3600 }))
    expect(out.ok).toBe(true)
    const r = (out as { result: { fp: string; items: number; totalS: number } }).result
    expect(decodeFingerprint(r.fp)).toEqual(new Uint32Array([7, 8, 9]))
    expect(r.items).toBe(3)
    expect(r.totalS).toBe(3600)
  })

  it('durationS 缺席 → totalS = items/7 估', async () => {
    const conv = makeAudioFpConverter({
      resolveMedia: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }),
      fingerprint: async () => new Uint32Array(70),
      available: () => true,
    })
    const out = await conv.run(ctx())
    expect((out as { result: { totalS: number } }).result.totalS).toBe(10)
  })

  it('无可取媒体 → no_media 错误，不抛', async () => {
    const conv = makeAudioFpConverter({
      resolveMedia: async () => null,
      fingerprint: async () => { throw new Error('不该走到') },
      available: () => true,
    })
    const out = await conv.run(ctx())
    expect(out).toMatchObject({ ok: false, error: { code: 'no_media' } })
  })

  it('指纹引擎抛错 → 原话进 error（fp_failed）', async () => {
    const conv = makeAudioFpConverter({
      resolveMedia: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }),
      fingerprint: async () => { throw new Error('ffmpeg exited 1: bad stream') },
      available: () => true,
    })
    const out = await conv.run(ctx())
    expect(out).toMatchObject({ ok: false, error: { code: 'fp_failed' } })
    expect((out as { error: { message: string } }).error.message).toContain('bad stream')
  })

  it('用户取消（真实引擎 abort 时 reject）→ cancelled，不误报 fp_failed', async () => {
    const controller = new AbortController()
    const conv = makeAudioFpConverter({
      resolveMedia: async () => ({ bytes: new Uint8Array([1]), mime: 'audio/mpeg' }),
      fingerprint: async () => {
        controller.abort()
        throw new Error('The operation was aborted')
      },
      available: () => true,
    })
    const out = await conv.run({
      id: 'c1', itemId: 'item-1', kind: 'audio-fp', options: {},
      signal: controller.signal,
      stage: (_n, fn) => fn(),
    })
    expect(out).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})
