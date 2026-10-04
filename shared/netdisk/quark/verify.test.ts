// shared/netdisk/quark/verify.test.ts
//
// 判例整份承袭 `src/netdisk/quark-share-recipe.test.ts`（recipe 是 Stream 侧的实现；这份 TS 是
// 网盘插件用的同一判决——recipe 运行时依赖 isolated-vm，打不进插件）。两份判决对同一组输入必须
// 给同一个答案，判例不能丢。
import { describe, expect, it } from 'vitest'
import { quarkVerify } from './verify.ts'

/** token 端点答什么，detail 端点答什么——验活的判决全看 token 那一答。 */
const fakeQuark = (token: { status: number; body: unknown }, list: unknown[] = []) =>
  (async (u: URL | string) =>
    String(u).includes('/token')
      ? new Response(JSON.stringify(token.body), { status: token.status })
      : new Response(JSON.stringify({ code: 0, data: { list } }), { status: 200 })) as unknown as typeof fetch

const run = (fetchFn: typeof fetch, passcode?: string) =>
  quarkVerify('p1', passcode !== undefined ? { passcode } : {}, { fetchFn })

describe('quarkVerify —— 验活的判决（与 quark-share recipe 同一组判例）', () => {
  it('活链：token 给 stoken → alive + 文件名', async () => {
    const f = fakeQuark({ status: 200, body: { code: 0, data: { stoken: 'st' } } }, [
      { fid: 'f1', file_name: '黄 粱 一 梦', size: 0, dir: true, pdir_fid: '0' },
    ])
    await expect(run(f)).resolves.toMatchObject({ validity: 'alive', files: [{ name: '黄 粱 一 梦', is_dir: true, size: 0 }] })
  })

  it('活链但空分享：not-usable——没有可取之物', async () => {
    const f = fakeQuark({ status: 200, body: { code: 0, data: { stoken: 'st' } } }, [])
    await expect(run(f)).resolves.toMatchObject({ validity: 'not-usable' })
  })

  it('已封禁（403/41031）：上游明确的判决 → not-usable，不抛错，reason 带原话', async () => {
    const f = fakeQuark({ status: 403, body: { status: 403, code: 41031, message: '分享者用户封禁链接查看受限' } })
    const r = await run(f)
    expect(r).toMatchObject({ validity: 'not-usable' })
    expect(String(r.reason)).toContain('封禁')
  })

  it('没见过的 4xx 死因码：仍按判决处理（判据是 HTTP status 不是码），不打地鼠', async () => {
    const f = fakeQuark({ status: 404, body: { status: 404, code: 49999, message: '未来某个新死法' } })
    await expect(run(f)).resolves.toMatchObject({ validity: 'not-usable' })
  })

  // 「我们没查成」绝不能伪装成「链接死了」：抛错才能让判决层落到 unknown。429 是 4xx 里唯一的
  // 例外：它讲的是我们请求太快，不是这条链的死活。
  it('限流（429）：不是判决 → 抛错，绝不谎报死链', async () => {
    const f = fakeQuark({ status: 429, body: { status: 429, code: 60003, message: 'too many requests' } })
    await expect(run(f)).rejects.toThrow()
  })

  it('上游 5xx：不是判决 → 抛错', async () => {
    const f = fakeQuark({ status: 500, body: { status: 500, code: 50000, message: 'internal error' } })
    await expect(run(f)).rejects.toThrow()
  })

  it('body 不是 JSON（风控页）：不是判决 → 抛错', async () => {
    const f = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await expect(run(f)).rejects.toThrow()
  })

  it('提取码随 token 请求发出去', async () => {
    const bodies: string[] = []
    const f = (async (u: URL | string, init?: RequestInit) => {
      if (String(u).includes('/token')) {
        bodies.push(String(init?.body))
        return new Response(JSON.stringify({ code: 0, data: { stoken: 'st' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { list: [{ fid: '1', file_name: 'a', size: 1, dir: false }] } }), { status: 200 })
    }) as unknown as typeof fetch
    await run(f, 'abcd')
    expect(bodies[0]).toContain('"passcode":"abcd"')
  })
})
