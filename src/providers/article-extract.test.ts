// src/providers/article-extract.test.ts
//
// `article-extract` 行的**回落合同**——测的是行本身（成员顺序 = 成本阶梯），不是某个成员的实现。
//
// 为什么单独一个文件而不是塞进 seed.test.ts：这三条断言里有一条是**隐私边界**
//（静态页抽得出正文时，跑 JS、出境、烧额度的那一档一次都不许被调），它值得一个自己的名字。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { ensureSystemRows } from './seed.ts'
import { ProviderExecutor, type MemberResult } from './executor.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'
import { ladderTrace } from './ladder-trace.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { FirecrawlAdapter } from '../../packages/firecrawl/adapter.ts'
import * as client from '../../packages/firecrawl/client.ts'

afterEach(() => vi.restoreAllMocks())

const PAGE: client.FirecrawlPage = { markdown: '# 跑完 JS 才有的正文', finalUrl: 'https://e.com/a', creditsUsed: 1 }

/** 起一个真的执行器，跑真的种子行。成员实现按 bootstrap 的接法接：成员返回 `[obj]`，
 *  在成员契约的缝上解包成判决对象（两个成员的 manifest 都是 `output: object`）。
 *  `defuddle` 由用例给（[] = decline / [{text}] = 抽到了），`firecrawl` 用**真的**那个包 adapter
 *  （网络在 client 那一层被替掉）——否则测的就不是这一档在梯子上的真实行为了。 */
function ladder(defuddle: () => Promise<unknown[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'article-ladder-'))
  const store = new UserStore(join(dir, 'stream.db'))
  ensureSystemRows(store)
  const calls: string[] = []
  const adapter = new FirecrawlAdapter()
  // 非 builtin 成员走引擎：成员 params（`$input` 已填）并进 adapter params，runtimeConfig 由宿主解析（这里 keyless）。
  const firecrawl = (_input: unknown, params: Record<string, unknown>) =>
    adapter.fetch(params, { id: '@streamapp/firecrawl/article-firecrawl', adapter: 'firecrawl' } as SourceManifest, { runtimeConfig: {} })
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(store, SYSTEM_IDENTITIES),
    registry: { get: () => undefined } as never,
    stats: { record: () => {} } as never,
    fetchSource: async (sourceId, input, params): Promise<MemberResult> => {
      calls.push(sourceId)
      const raw = sourceId === '@streamapp/builtin/article-defuddle' ? await defuddle() : await firecrawl(input, params ?? {})
      return (raw[0] as Record<string, unknown>) ?? null // output: object 的解包（同 bootstrap）
    },
  })
  const close = () => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { executor, calls, close }
}

describe('article-extract 行 —— 成员顺序即成本阶梯', () => {
  it('裸 HTTP 的 Defuddle 在前，跑 JS 的 Firecrawl 在后', () => {
    const identity = SYSTEM_IDENTITIES.get('article-extract')!
    expect(identity.strategy).toBe('sequential')
    expect(identity.defaultMembers).toEqual([
      { source: '@streamapp/builtin/article-defuddle', params: { url: '$input' } },
      { source: '@streamapp/firecrawl/article-firecrawl', params: { url: '$input' } },
    ])
  })

  // **隐私边界的单测面**：静态页抽得出正文就不出境。这条挂了 = 每打开一篇文章都往第三方
  // 发一次 URL（还烧额度），而结果看起来完全正常——没有任何症状会提醒你。
  it('Defuddle 抽到正文 → Firecrawl 一次都没被调', async () => {
    const scrape = vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    const { executor, calls, close } = ladder(async () => [{ text: '裸 HTTP 就够了' }])
    const res = await executor.invoke('article-extract', 'https://e.com/a')
    expect((res as { value: { text: string } }).value.text).toBe('裸 HTTP 就够了')
    expect(calls).toEqual(['@streamapp/builtin/article-defuddle'])
    expect(scrape).not.toHaveBeenCalled()
    close()
  })

  it('Defuddle decline（SPA 空壳）→ Firecrawl 赢，走法记得住是谁干的', async () => {
    vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    const { executor, calls, close } = ladder(async () => []) // [] = decline
    const res = await executor.invoke('article-extract', 'https://e.com/a')
    expect((res as { value: { text: string } }).value.text).toBe('# 跑完 JS 才有的正文')
    expect(calls).toEqual(['@streamapp/builtin/article-defuddle', '@streamapp/firecrawl/article-firecrawl'])
    const trace = ladderTrace(res)
    expect(trace.via).toBe('@streamapp/firecrawl/article-firecrawl')
    expect(trace.rungs.map((r) => [r.member, r.outcome])).toEqual([
      ['@streamapp/builtin/article-defuddle', 'miss'],
      ['@streamapp/firecrawl/article-firecrawl', 'win'],
    ])
    close()
  })

  // 限流是「试了挂了」，不是「让位」。它必须以**失败**的样子留在账上——而不是变成一份空正文
  // 交出去（下游会认真地总结那段空白）。
  it('Firecrawl 限流 → 整行没有结果，misses 里看得见是谁、为什么', async () => {
    vi.spyOn(client, 'scrapeWithFirecrawl').mockRejectedValue(
      new client.FirecrawlError('rate_limited', '[firecrawl] HTTP 429 —— 限流或额度耗尽'),
    )
    const { executor, close } = ladder(async () => [])
    const res = await executor.invoke('article-extract', 'https://e.com/a')
    expect((res as { value: unknown }).value).toBeNull() // 不是 ''，也不是 {text:''}
    expect((res as { via: unknown }).via).toBeNull()
    const misses = (res as { misses: Array<{ member: string; reason: string }> }).misses
    expect(misses.map((m) => m.member)).toEqual(['@streamapp/builtin/article-defuddle', '@streamapp/firecrawl/article-firecrawl'])
    expect(misses[1].reason).toContain('429')
    close()
  })
})
