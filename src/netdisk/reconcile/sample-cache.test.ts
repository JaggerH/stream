import { describe, expect, it } from 'vitest'
import { openNetdiskDb } from '../db.ts'
import { SampleCache, sampleKey } from './sample-cache.ts'
import type { IdentityProbe } from './identity-probe.ts'

const probe = (text: string): IdentityProbe => ({
  head: { text, startS: 0, endS: 120 },
  tail: { text: '下期再见', startS: 5880, endS: 6000 },
  timing: { rawUrlMs: 1, fetchMs: 2, transcribeMs: 3, bytes: 4 },
})

const file = { path: '/quark/来源/116.mp3', sizeBytes: 122_000_000 }

describe('sampleKey', () => {
  /**
   * **这是这个缓存存在的全部理由**：整理的本职就是把文件从来源目录搬上货架。拿路径当 key 的话，
   * 每一份被判过的文件在搬完之后都会变成缓存里的另一个，转写钱重付一遍。
   */
  it('有对象 id 就按它——同一份文件换了路径仍是同一把 key', () => {
    const before = sampleKey({ path: '/quark/来源/116.mp3', sizeBytes: 1 }, 120, 'fid-abc')
    const after = sampleKey({ path: '/quark/货架/116.安特卫普金库案.mp3', sizeBytes: 1 }, 120, 'fid-abc')
    expect(before.key).toBe(after.key)
    expect(before.kind).toBe('fid')
  })

  /** 取不到对象 id 的 driver 退成「字节数:路径」——代价是搬一次家重付一次，回执与日志要说得出来。 */
  it('没有对象 id 就退成路径档，并如实标出这是退档', () => {
    const k = sampleKey(file, 120, undefined)
    expect(k.kind).toBe('path')
    expect(k.key).toContain(file.path)
    expect(k.key).toContain(String(file.sizeBytes))
  })

  /** 窗口长度进 key：不进的话「我要 30 秒」会拿回一份 120 秒的转写，而没有一处会喊。 */
  it('窗口长度不同 = 不同的 key', () => {
    expect(sampleKey(file, 120, 'x').key).not.toBe(sampleKey(file, 30, 'x').key)
  })
})

describe('SampleCache', () => {
  const mk = () => new SampleCache(openNetdiskDb(':memory:'))

  it('存了再取就是同一份采样', () => {
    const c = mk()
    c.set('fid:a:w120', file, probe('安特卫普'))
    expect(c.get('fid:a:w120', file.sizeBytes)?.head.text).toBe('安特卫普')
  })

  it('没存过 = undefined（去采一次），不是空采样', () => {
    expect(mk().get('fid:nope:w120', 1)).toBeUndefined()
  })

  /**
   * **命中还要复核字节数**。key 撞了就会拿另一份文件的转写当证据端上去，而它读起来毫无破绽——
   * 这条链路后面接的是认领或删除，一份对不上号的证据比没有证据糟得多。
   */
  it('字节数对不上 → 当没缓存，重新采样', () => {
    const c = mk()
    c.set('fid:a:w120', file, probe('安特卫普'))
    expect(c.get('fid:a:w120', file.sizeBytes + 1)).toBeUndefined()
  })
})
