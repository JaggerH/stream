import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { interpretObject } from '../replay/interpret.ts'
import { makeHttpFetch } from '../replay/http-fetch.ts'
import { validateRecipe } from '../replay/recipe-store.ts'
import type { HttpRecipe } from '../replay/recipe.ts'

/** 跑真实产物,不是它的复制品——decode 是 recipe JSON 里的一段表达式,判决全在里面。
 *  v3 起 output:'object':判决以对象身份回来,不再穿 item 的衣服。 */
const recipe = validateRecipe(
  'quark-share',
  JSON.parse(readFileSync(join(import.meta.dirname, '../../packages/quark/quark-share.recipe.json'), 'utf8')),
) as HttpRecipe

/** token 端点答什么,detail 端点答什么 —— 验活的判决全看 token 那一答。 */
const fakeQuark = (token: { status: number; body: unknown }, list: unknown[] = []) =>
  (async (u: URL | string) =>
    String(u).includes('/token')
      ? new Response(JSON.stringify(token.body), { status: token.status })
      : new Response(JSON.stringify({ code: 0, data: { list } }), { status: 200 })) as unknown as typeof fetch

const run = (impl: typeof globalThis.fetch) =>
  interpretObject(recipe, { fetchInPage: makeHttpFetch(recipe, undefined, impl) }, { pwd_id: 'p1' }) as Promise<{
    validity: string
    files: Array<{ name: string; is_dir: boolean; size: number }>
    reason?: string
  }>

describe('quark-share recipe —— 验活的判决（对象输出）', () => {
  it('活链:token 给 stoken → alive + 文件名', async () => {
    const f = fakeQuark({ status: 200, body: { code: 0, data: { stoken: 'st' } } }, [
      { fid: 'f1', file_name: '黄 粱 一 梦', size: 0, dir: true, pdir_fid: '0' },
    ])
    const r = await run(f)
    expect(r).toMatchObject({ validity: 'alive', files: [{ name: '黄 粱 一 梦', is_dir: true, size: 0 }] })
  })

  it('活链但空分享:not-usable——没有可取之物', async () => {
    const f = fakeQuark({ status: 200, body: { code: 0, data: { stoken: 'st' } } }, [])
    const r = await run(f)
    expect(r).toMatchObject({ validity: 'not-usable' })
  })

  it('已封禁(403/41031):上游明确的判决 → not-usable,不抛错', async () => {
    const f = fakeQuark({ status: 403, body: { status: 403, code: 41031, message: '分享者用户封禁链接查看受限' } })
    const r = await run(f)
    expect(r).toMatchObject({ validity: 'not-usable' })
    expect(String(r.reason)).toContain('封禁')
  })

  it('已取消(404/41006):上游明确的判决 → not-usable,不抛错', async () => {
    const f = fakeQuark({ status: 404, body: { status: 404, code: 41006, message: '该分享已取消' } })
    await expect(run(f)).resolves.toMatchObject({ validity: 'not-usable' })
  })

  // 活体抓到的:41012「好友已取消了分享」和 41006「该分享已取消」是同一个意思的两个码。
  // 死因码列不全(第一版白名单只有 41031/41006,这条真死链就被误报成 unknown),所以判据
  // 是 HTTP status 而不是码:4xx = 上游在讲这条链的事(判决),不是我们的失败。
  it('已取消的另一个码(404/41012):同样是判决,不能因为码没见过就报 unknown', async () => {
    const f = fakeQuark({ status: 404, body: { status: 404, code: 41012, message: '好友已取消了分享' } })
    await expect(run(f)).resolves.toMatchObject({ validity: 'not-usable' })
  })

  it('没见过的 4xx 死因码:仍按判决处理,不打地鼠', async () => {
    const f = fakeQuark({ status: 404, body: { status: 404, code: 49999, message: '未来某个新死法' } })
    await expect(run(f)).resolves.toMatchObject({ validity: 'not-usable' })
  })

  // 「我们没查成」绝不能伪装成「链接死了」:not-usable 会被默认隐藏,
  // 于是一条活链在夸克限流/故障时静悄悄消失。抛错才能让判决层落到 unknown。
  // 429 是 4xx 里唯一的例外:它讲的是我们请求太快,不是这条链的死活。并发验活正好容易撞上它,
  // 落进"判决"桶就会把一屏活链集体判死。
  it('限流(429):不是判决 → 抛错,绝不谎报死链', async () => {
    const f = fakeQuark({ status: 429, body: { status: 429, code: 60003, message: 'too many requests' } })
    await expect(run(f)).rejects.toThrow()
  })

  it('上游 5xx:不是判决 → 抛错', async () => {
    const f = fakeQuark({ status: 500, body: { status: 500, code: 50000, message: 'internal error' } })
    await expect(run(f)).rejects.toThrow()
  })

  it('body 里没有 status 时不猜:抛错而不是当成判决', async () => {
    const f = fakeQuark({ status: 500, body: { code: 50000, message: 'gateway' } })
    await expect(run(f)).rejects.toThrow()
  })
})
