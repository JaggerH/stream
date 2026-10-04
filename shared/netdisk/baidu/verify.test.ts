// shared/netdisk/baidu/verify.test.ts
//
// 判例整份承袭 `src/netdisk/baidu-share-recipe.test.ts`（recipe 是 Stream 侧的实现；这份 TS 是认盘
// 插件用的同一判决——recipe 运行时依赖 isolated-vm，打不进插件）。两份对同一组输入必须给同一个答案。
import { describe, expect, it } from 'vitest'
import { baiduVerify } from './verify.ts'

const json = (body: unknown, setCookie: string[] = []) => {
  const h = new Headers({ 'content-type': 'application/json' })
  for (const c of setCookie) h.append('set-cookie', c)
  return new Response(JSON.stringify(body), { headers: h })
}
const FILE = { server_filename: '绝命墨菲', isdir: 1, size: 0 }

/** 一个假百度。每条腿默认走「带码解锁」的顺路。 */
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
      const key = first ? 'info' : 'infoUnlocked'
      seen.push(key)
      if (over[key]) return over[key]!()
      return first ? json({ errno: -9, show_msg: '提取码验证失败' }) : json({ errno: 0, uk: '111', shareid: '222' })
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

const run = (fetchFn: typeof fetch, pwdId: string, passcode?: string) =>
  baiduVerify(pwdId, passcode !== undefined ? { passcode } : {}, { fetchFn, now: () => 1700000000000 })

describe('baiduVerify —— 验活判决（与 baidu-share recipe 同一组判例）', () => {
  it('①带码解锁：真实文件名 + alive，请求顺序与 recipe 一致', async () => {
    const { fetchFn, seen } = baidu()
    const r = await run(fetchFn, '1RU7Ymxa', '1111')
    expect(r).toMatchObject({ validity: 'alive', files: [{ name: '绝命墨菲', is_dir: true, size: 0 }] })
    expect(seen).toEqual(['info', 'landing', 'verify', 'infoUnlocked', 'list'])
  })

  it('surl 去掉前导 1、t 为毫秒（百度自己的怪癖）', async () => {
    const { fetchFn, urls } = baidu()
    await run(fetchFn, '1RU7Ymxa', '1111')
    const verify = urls.find((u) => u.includes('/share/verify'))!
    expect(verify).toContain('surl=RU7Ymxa')
    expect(verify).toContain('t=1700000000000')
  })

  it('jar 整罐随行：share/list 带的是百度 Set-Cookie 的 BDCLND，不是 randsk 解码', async () => {
    const { fetchFn, cookies } = baidu()
    await run(fetchFn, '1RU7Ymxa', '1111')
    expect(cookies.list).toContain('BDCLND=REAL')
    expect(cookies.list).toContain('BAIDUID=x')
  })

  it('share/list 用 root=1（dir=/ 会答 errno 2）', async () => {
    const { fetchFn, urls } = baidu()
    await run(fetchFn, '1RU7Ymxa', '1111')
    const list = urls.find((u) => u.includes('/share/list'))!
    expect(list).toContain('root=1')
    expect(list).not.toContain('dir=')
  })

  it('②假链（errno 140）：唯一诚实的死——not-usable', async () => {
    const { fetchFn } = baidu({ info: () => json({ errno: 140, show_msg: '啊哦，链接出错了' }) })
    const r = await run(fetchFn, '1nope', '1111')
    expect(r).toMatchObject({ validity: 'not-usable' })
    expect(String(r.reason)).toContain('链接出错')
  })

  it('③错码（verify errno -9）：unknown 绝不判死——链接可证明地在', async () => {
    const { fetchFn } = baidu({ verify: () => json({ errno: -9, err_msg: '' }) })
    const r = await run(fetchFn, '1RU7Ymxa', '9999')
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('提取码不对')
  })

  it('④无码且锁着：unknown「需要提取码」，绝不判死', async () => {
    const { fetchFn } = baidu()
    const r = await run(fetchFn, '1RU7Ymxa')
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('提取码')
  })

  it('未加锁分享无码直读：alive + 文件', async () => {
    const { fetchFn, seen } = baidu({ info: () => json({ errno: 0, uk: '111', shareid: '222' }) })
    const r = await run(fetchFn, '1open')
    expect(r).toMatchObject({ validity: 'alive', files: [{ name: '绝命墨菲' }] })
    expect(seen).toEqual(['info', 'list'])
  })

  it('解锁但空分享：not-usable——没有可取之物', async () => {
    const { fetchFn } = baidu({ list: () => json({ errno: 0, list: [] }) })
    await expect(run(fetchFn, '1empty', '1111')).resolves.toMatchObject({ validity: 'not-usable' })
  })

  it('share/list 答非 0 errno：unknown 且说出是哪个', async () => {
    const { fetchFn } = baidu({ list: () => json({ errno: 2 }) })
    const r = await run(fetchFn, '1x', '1111')
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('errno 2')
  })

  it('风控 HTML 页打在 shorturlinfo 上：unknown（我们没查成），绝不当判决', async () => {
    const { fetchFn } = baidu({ info: () => new Response('<html>验证</html>', { headers: { 'content-type': 'text/html' } }) })
    const r = await run(fetchFn, '1x', '1111')
    expect(r).toMatchObject({ validity: 'unknown' })
    expect(String(r.reason)).toContain('JSON')
  })
})
