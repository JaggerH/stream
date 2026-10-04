import { describe, it, expect } from 'vitest'
import { makeConnect } from './connect.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'

describe('bilibili.com connect', () => {
  const client = (uid: string | null, name = 'ME') => ({
    myUid: async () => uid,
    user: async () => ({ uid: uid!, name, face: '' }),
  }) as never

  it('从 cookie 读到自己的 uid → 一条合并的「我的关注」流', async () => {
    const { stream, extra } = await makeConnect(client('42'))['bilibili.com']()
    expect(stream.id).toBe('bilibili-following-42')
    expect(stream.sources[0].params).toEqual({ uid: '42' })
    expect(extra).toEqual({ uid: '42', name: 'ME' })
  })

  it('名字取不到也照样建流（名字只是好看）', async () => {
    const broken = { myUid: async () => '42', user: async () => { throw new Error('card api hiccup') } } as never
    const { stream } = await makeConnect(broken)['bilibili.com']()
    expect(stream.id).toBe('bilibili-following-42')
  })

  it('没有登录 cookie → ValidationError（宿主翻 400）', async () => {
    await expect(makeConnect(client(null))['bilibili.com']()).rejects.toBeInstanceOf(ValidationError)
  })
})
