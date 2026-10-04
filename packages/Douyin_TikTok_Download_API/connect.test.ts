import { describe, it, expect } from 'vitest'
import { makeConnect } from './connect.ts'

describe('douyin.com connect', () => {
  it('一键订阅「我的抖音关注」→ 流形状逐字钉住（零输入，不查 cookie）', async () => {
    const { stream } = await makeConnect()['douyin.com']()
    expect(stream).toEqual({
      id: 'douyin-follow',
      description: '我的抖音关注',
      sources: [{ source_id: 'douyin-follow', params: {} }],
      cadence_seconds: 172800,
      vault_subdir: 'douyin-follow',
    })
  })
})
