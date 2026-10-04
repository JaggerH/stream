import { describe, it, expect } from 'vitest'
import { encodeFrame, decodeFrame, type Frame } from './protocol.ts'

describe('protocol', () => {
  it('round-trips 每种帧', () => {
    const frames: Frame[] = [
      { t: 'hello', source: 'x', domains: ['goofish.com'] },
      { t: 'event', id: 'o1', source: 'x', receivedAt: 5, payload: '{"a":1}' },
      { t: 'ack', ids: ['o1', 'o2'] },
      { t: 'cookies', pairs: 'a=1; b=2' },
    ]
    for (const f of frames) expect(decodeFrame(encodeFrame(f))).toEqual(f)
  })
  it('非法帧抛错，不静默返回半个对象', () => {
    expect(() => decodeFrame('not json')).toThrow()
    expect(() => decodeFrame('{"t":"nope"}')).toThrow()
  })
})
