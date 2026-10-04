// capabilities/netdisk/src/config.test.ts
//
// 两档由配置决定、不由运行时猜（spec §5.2）；token 必须是永久 token 不是 48h JWT（spec §5.3 钉的
// 那个测试就是这里）。
import { describe, it, expect } from 'vitest'
import { isJwtLike, resolveTier } from './config.ts'

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.abcDEF123'
// 占位值：形状对（`alist-<uuid><随机串>`）但**不是任何真实凭证**。
// 别在这里填真 token——这个文件要公开，写进去等于把凭证提交进历史。
const PERMANENT = 'alist-00000000-0000-0000-0000-000000000000fakefakefake'

describe('isJwtLike', () => {
  it('三段 base64url、首段是 {"alg"…} 的 header → 是 JWT', () => {
    expect(isJwtLike(JWT)).toBe(true)
  })
  it('OpenList 永久 token（`alist-<uuid><随机>`）→ 不是', () => {
    expect(isJwtLike(PERMANENT)).toBe(false)
  })
})

describe('resolveTier', () => {
  it('给了 openlistUrl + 永久 token → external 档，url 去尾斜杠', () => {
    expect(resolveTier({ openlistUrl: 'http://127.0.0.1:8900/_p/alist/', openlistToken: PERMANENT })).toEqual({
      kind: 'external',
      url: 'http://127.0.0.1:8900/_p/alist',
      token: PERMANENT,
    })
  })

  it('【spec §5.3】token 是 48h JWT → invalid，说清要永久 token（插件没有 401 重登通道，JWT 过期就是静默断连）', () => {
    const tier = resolveTier({ openlistUrl: 'http://o', openlistToken: JWT })
    expect(tier.kind).toBe('invalid')
    expect((tier as { reason: string }).reason).toMatch(/JWT/)
    expect((tier as { reason: string }).reason).toMatch(/永久/)
  })

  it('给了 url 没给 token → invalid（external 档不能匿名：OpenList 的 /api 要 token）', () => {
    const tier = resolveTier({ openlistUrl: 'http://o' })
    expect(tier.kind).toBe('invalid')
    expect((tier as { reason: string }).reason).toContain('openlistToken')
  })

  it('没给 url → managed 档（插件自己拉容器；token 有没有都无所谓）', () => {
    expect(resolveTier({})).toEqual({ kind: 'managed' })
    expect(resolveTier({ openlistToken: PERMANENT })).toEqual({ kind: 'managed' })
  })

  it('空白串按没给处理', () => {
    expect(resolveTier({ openlistUrl: '  ', openlistToken: PERMANENT })).toEqual({ kind: 'managed' })
  })
})
