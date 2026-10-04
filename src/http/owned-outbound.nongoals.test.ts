/**
 * 非目标守卫：本 change 只建通道，不碰 rewriter、不叠代理/重试/限流、不改 SSRF 语义。
 * 用源码静态断言把"没做的事"钉住，防后人在 owned 里偷偷加逻辑。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('owned-outbound 非目标守卫', () => {
  it('owned 原语只做绑定捕获，不含代理/重试/限流', () => {
    const src = read('./owned-outbound.ts')
    expect(src).not.toMatch(/retry|proxy|rateLimit|setTimeout|backoff/i)
  })

  it('未改动 RSSHub request-rewriter（owned 不 import rsshub-adapter）', () => {
    const src = read('./owned-outbound.ts')
    expect(src).not.toContain('rsshub-adapter')
  })

  it('SSRF 守卫仍在 safe-fetch（isPrivateHost/publicHttpUrl 未移走）', () => {
    const src = read('../adapters/safe-fetch.ts')
    expect(src).toContain('function isPrivateHost')
    expect(src).toContain('function publicHttpUrl')
  })

  it('按主机带 Referer 的业务判断不在 owned 里（image-fetch 问包的 serving 声明）', () => {
    expect(read('./image-fetch.ts')).toContain('refererForUrl')
    expect(read('./owned-outbound.ts')).not.toMatch(/refererFor/)
  })
})
