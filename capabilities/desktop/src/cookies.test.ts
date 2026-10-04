// capabilities/desktop/src/cookies.test.ts
//
// 「把用户浏览器里某个域的登录态交给同进程的别的插件」——这是 `streamBrowserCookies` 服务的全部
// 契约：按域取、后缀匹配、拼成 Cookie 头；取不到就是 undefined + 一行说清原因，绝不抛。
import { describe, it, expect } from 'vitest'
import { cookieHeaderFor, createBrowserCookieService } from './cookies.ts'

describe('cookieHeaderFor', () => {
  it('后缀匹配：`.quark.cn` / `pan.quark.cn` 的 cookie 都算 quark.cn 的；无关域不混进来', () => {
    const header = cookieHeaderFor(
      {
        '.quark.cn': [{ name: '__pus', value: 'a' }],
        'pan.quark.cn': [{ name: '__puus', value: 'b' }],
        'baidu.com': [{ name: 'BDUSS', value: 'x' }],
      },
      'quark.cn',
    )
    expect(header).toBe('__pus=a; __puus=b')
  })

  it('空名条目（扩展偶尔同步出 name:"" 的记录）扔掉——裸 `=value` 是畸形 Cookie 头', () => {
    expect(cookieHeaderFor({ 'quark.cn': [{ name: '', value: 'x' }, { name: 'k', value: 'v' }] }, 'quark.cn')).toBe('k=v')
  })

  it('一个都没有 → undefined，不是空串（调用方按「没登录态」分支）', () => {
    expect(cookieHeaderFor({}, 'quark.cn')).toBeUndefined()
    expect(cookieHeaderFor({ 'quark.cn': [] }, 'quark.cn')).toBeUndefined()
  })
})

describe('createBrowserCookieService', () => {
  const relayWith = (opts: { connected: boolean; cookies?: Record<string, unknown[]>; refused?: string[]; throws?: Error }) => {
    const pulled: string[][] = []
    return {
      pulled,
      relay: {
        get connected() {
          return opts.connected
        },
        async cookiePull(domains: string[]) {
          pulled.push(domains)
          if (opts.throws) throw opts.throws
          return { cookies: opts.cookies ?? {}, refused: opts.refused ?? [] }
        },
      },
    }
  }

  it('中继连着 → 只拉这一个域，拼成 Cookie 头交出去', async () => {
    const { relay, pulled } = relayWith({ connected: true, cookies: { '.quark.cn': [{ name: '__pus', value: 'a' }] } })
    const svc = createBrowserCookieService(relay, () => {})
    await expect(svc.cookieFor('quark.cn')).resolves.toBe('__pus=a')
    expect(pulled).toEqual([['quark.cn']])
  })

  it('中继没连 → undefined + 一行说清「扩展没连上」，一条命令都不发', async () => {
    const logs: string[] = []
    const { relay, pulled } = relayWith({ connected: false })
    const svc = createBrowserCookieService(relay, (l) => logs.push(l))
    await expect(svc.cookieFor('quark.cn')).resolves.toBeUndefined()
    expect(pulled).toEqual([])
    expect(logs.join()).toMatch(/没有连上|未连/)
  })

  it('域被扩展拒了（不在它申报的同步域里）→ undefined，且日志说这是配置问题不是没登录', async () => {
    const logs: string[] = []
    const { relay } = relayWith({ connected: true, refused: ['quark.cn'] })
    const svc = createBrowserCookieService(relay, (l) => logs.push(l))
    await expect(svc.cookieFor('quark.cn')).resolves.toBeUndefined()
    expect(logs.join()).toContain('同步域')
  })

  it('cookiesFor：整条记录（name/value/domain…）按同一把后缀尺子交出——挂载灌 storage 要的是记录不是头', async () => {
    const { relay } = relayWith({
      connected: true,
      cookies: {
        '.quark.cn': [{ name: '__pus', value: 'a', domain: '.quark.cn', httpOnly: true }],
        'baidu.com': [{ name: 'BDUSS', value: 'x', domain: 'baidu.com' }],
      },
    })
    const svc = createBrowserCookieService(relay, () => {})
    await expect(svc.cookiesFor('pan.quark.cn')).resolves.toEqual([{ name: '__pus', value: 'a', domain: '.quark.cn', httpOnly: true }])
    await expect(svc.cookiesFor('115.com')).resolves.toEqual([])
  })

  it('cookiePull 抛（超时/断连）→ 收成 undefined，不逃出去', async () => {
    const { relay } = relayWith({ connected: true, throws: new Error('ext-relay socket disconnected') })
    const svc = createBrowserCookieService(relay, () => {})
    await expect(svc.cookieFor('quark.cn')).resolves.toBeUndefined()
  })
})
