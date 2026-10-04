import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { interpretObject } from '../replay/interpret.ts'
import { makeHttpFetch } from '../replay/http-fetch.ts'
import { validateRecipe } from '../replay/recipe-store.ts'
import type { HttpRecipe } from '../replay/recipe.ts'

/** 跑真实产物，不是它的复制品——判决逻辑全在 recipe JSON 的 params/sign/decode 里。
 *  fixture 原样承袭 baidu-verify.test.ts（它随 TS 实现一起退役，判例不能丢）。 */
const recipe = validateRecipe(
  'baidu-share',
  JSON.parse(readFileSync(join(import.meta.dirname, '../../packages/baidu/baidu-share.recipe.json'), 'utf8')),
) as HttpRecipe

const json = (body: unknown, setCookie: string[] = []) => {
  const h = new Headers({ 'content-type': 'application/json' })
  for (const c of setCookie) h.append('set-cookie', c)
  return new Response(JSON.stringify(body), { headers: h })
}
const FILE = { server_filename: '绝命墨菲', isdir: 1, size: 0 }

/** A fake baidu. Each leg defaults to the happy (unlocked-by-passcode) path. */
function baidu(over: Partial<Record<'info' | 'infoUnlocked' | 'verify' | 'list' | 'landing', () => Response>> = {}) {
  const seen: string[] = []
  const urls: string[] = []
  const cookies: Record<string, string | undefined> = {}
  let infoCalls = 0
  const fetchFn = (async (u: URL | string, init?: RequestInit) => {
    const url = String(u)
    urls.push(url)
    if (url.includes('/api/shorturlinfo')) {
      const first = infoCalls++ === 0
      seen.push(first ? 'info' : 'infoUnlocked')
      const key = first ? 'info' : 'infoUnlocked'
      if (over[key]) return over[key]!()
      return first
        ? json({ errno: -9, show_msg: '提取码验证失败' })
        : json({ errno: 0, uk: '111', shareid: '222' })
    }
    if (url.includes('/share/verify')) {
      seen.push('verify')
      return over.verify ? over.verify() : json({ errno: 0, randsk: 'r%2Bsk' }, ['BDCLND=REAL; path=/', 'BAIDUID=x; path=/'])
    }
    if (url.includes('/share/list')) {
      seen.push('list')
      cookies.list = (init?.headers as Record<string, string> | undefined)?.cookie
      return over.list ? over.list() : json({ errno: 0, list: [FILE] })
    }
    seen.push('landing')
    return over.landing ? over.landing() : new Response('<html>', { headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
  return { fetchFn, seen, urls, cookies }
}

const run = (fetchFn: typeof fetch, params: Record<string, string>) =>
  interpretObject(recipe, { fetchInPage: makeHttpFetch(recipe, undefined, fetchFn, () => 1700000000) }, params)

describe('baidu-share recipe —— 验活判决（对照退役的 baidu-verify.ts 判例）', () => {
  it('①带码解锁：真实文件名 + alive，请求顺序与 TS 实现一致', async () => {
    const { fetchFn, seen } = baidu()
    const r = await run(fetchFn, { pwd_id: '1RU7Ymxa', passcode: '1111' })
    expect(r).toMatchObject({ validity: 'alive', files: [{ name: '绝命墨菲', is_dir: true, size: 0 }] })
    expect(seen).toEqual(['info', 'landing', 'verify', 'infoUnlocked', 'list'])
  })

  it('surl 去掉前导 1、t 为毫秒——compute.params 派生（百度自己的怪癖）', async () => {
    const { fetchFn, urls } = baidu()
    await run(fetchFn, { pwd_id: '1RU7Ymxa', passcode: '1111' })
    const verify = urls.find((u) => u.includes('/share/verify'))!
    expect(verify).toContain('surl=RU7Ymxa')
    expect(verify).toContain('t=1700000000000')
  })

  it('jar 整罐随行：share/list 带的是百度 Set-Cookie 的 BDCLND，不是 randsk 解码', async () => {
    const { fetchFn, cookies } = baidu()
    await run(fetchFn, { pwd_id: '1RU7Ymxa', passcode: '1111' })
    expect(cookies.list).toContain('BDCLND=REAL')
    expect(cookies.list).toContain('BAIDUID=x')
  })

  it('share/list 用 root=1（dir=/ 会答 errno 2）', async () => {
    const { fetchFn, urls } = baidu()
    await run(fetchFn, { pwd_id: '1RU7Ymxa', passcode: '1111' })
    const list = urls.find((u) => u.includes('/share/list'))!
    expect(list).toContain('root=1')
    expect(list).not.toContain('dir=')
  })

  it('②假链（errno 140）：唯一诚实的死——not-usable', async () => {
    const { fetchFn } = baidu({ info: () => json({ errno: 140, show_msg: '啊哦，链接出错了' }), infoUnlocked: () => json({ errno: 140 }) })
    const r = (await run(fetchFn, { pwd_id: '1nope', passcode: '1111' })) as Record<string, unknown>
    expect(r).toMatchObject({ validity: 'not-usable' })
    expect(String(r.reason)).toContain('链接出错')
  })

  it('③错码（verify errno -9）：unknown 绝不判死——链接可证明地在', async () => {
    const { fetchFn } = baidu({ verify: () => json({ errno: -9, err_msg: '' }), infoUnlocked: () => json({ errno: -9 }) })
    const r = (await run(fetchFn, { pwd_id: '1RU7Ymxa', passcode: '9999' })) as Record<string, unknown>
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('提取码不对')
  })

  it('④无码且锁着：unknown「需要提取码」，绝不判死', async () => {
    const { fetchFn } = baidu({ infoUnlocked: () => json({ errno: -9 }) })
    const r = (await run(fetchFn, { pwd_id: '1RU7Ymxa' })) as Record<string, unknown>
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('提取码')
  })

  it('未加锁分享无码直读：alive + 文件（拍平的 B5 分支——verify 白跑一趟由 decode 收拾）', async () => {
    const { fetchFn } = baidu({
      info: () => json({ errno: 0, uk: '111', shareid: '222' }),
      infoUnlocked: () => json({ errno: 0, uk: '111', shareid: '222' }),
      verify: () => json({ errno: -9 }),
    })
    const r = await run(fetchFn, { pwd_id: '1open' })
    expect(r).toMatchObject({ validity: 'alive', files: [{ name: '绝命墨菲' }] })
  })

  it('解锁但空分享：not-usable——没有可取之物', async () => {
    const { fetchFn } = baidu({ list: () => json({ errno: 0, list: [] }) })
    const r = await run(fetchFn, { pwd_id: '1empty', passcode: '1111' })
    expect(r).toMatchObject({ validity: 'not-usable' })
  })

  it('share/list 答非 0 errno：unknown 且说出是哪个', async () => {
    const { fetchFn } = baidu({ list: () => json({ errno: 2 }) })
    const r = (await run(fetchFn, { pwd_id: '1x', passcode: '1111' })) as Record<string, unknown>
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('errno 2')
  })

  // 风控 HTML 页打在 JSON prefetch 上会抛错（parse:'json' 严格）。这在成员层落成 error-miss，
  // share-capability 把它归 unknown——判决相同，路径不同：错误路径而非判决路径。
  it('风控 HTML 页打在 shorturlinfo 上：抛错（上层归 unknown），绝不当判决', async () => {
    const { fetchFn } = baidu({ info: () => new Response('<html>验证</html>', { headers: { 'content-type': 'text/html' } }) })
    await expect(run(fetchFn, { pwd_id: '1x', passcode: '1111' })).rejects.toThrow()
  })
})
