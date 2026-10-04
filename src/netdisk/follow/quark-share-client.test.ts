import { describe, it, expect, vi } from 'vitest'
import { quarkShareClient } from './quark-share-client.ts'

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

interface Leg {
  token?: () => Response
  detail?: (pdir: string) => Response
  sort?: () => Response
  mkdir?: () => Response
  save?: () => Response
  task?: () => Response
}

/** 一个假夸克。记下每条请求的 body，好断言"只带了给定的那几个 fid"。 */
function quark(over: Leg = {}) {
  const bodies: Record<string, any[]> = {}
  const urls: string[] = []
  let sortCount = 0
  const fetchFn = (async (u: URL | string, init?: RequestInit) => {
    const url = String(u)
    urls.push(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const leg =
      url.includes('/share/sharepage/token') ? 'token'
      : url.includes('/share/sharepage/detail') ? 'detail'
      : url.includes('/share/sharepage/save') ? 'save'
      : url.includes('/file/sort') ? 'sort'
      : url.includes('/clouddrive/task') ? 'task'
      : init?.method === 'POST' ? 'mkdir'
      : 'unknown'
    ;(bodies[leg] ??= []).push(body)
    if (leg === 'detail' && over.detail) return over.detail(new URL(url).searchParams.get('pdir_fid') ?? '0')
    const fn = (over as Record<string, (() => Response) | undefined>)[leg]
    if (fn) return fn()
    switch (leg) {
      case 'token': return ok({ code: 0, data: { stoken: 'ST' } })
      case 'detail': return ok({ code: 0, data: { list: [{ fid: 'f1', share_fid_token: 'tk1', file_name: 'S01E01.mkv', size: 100 }] } })
      // 第一次列目录空（要建），之后能看到建好的那一层
      case 'sort': return ok({ code: 0, data: { list: sortCount++ === 0 ? [] : [{ file_name: 'x', dir: true, fid: 'D' }] } })
      case 'mkdir': return ok({ code: 0, data: { fid: `DIR${(bodies.mkdir?.length ?? 1)}` } })
      case 'save': return ok({ code: 0, data: { task_id: 'T1' } })
      case 'task': return ok({ code: 0, data: { status: 2, task_title: '分享-转存' } })
      default: return ok({ code: -1 })
    }
  }) as unknown as typeof fetch
  return { fetchFn, bodies, urls }
}

const client = (fetchFn: typeof fetch, ...cookie: [] | [string | undefined]) =>
  quarkShareClient({ cookieFor: async () => (cookie.length ? cookie[0] : 'session=abc'), fetchFn })

describe('quarkShareClient.supports', () => {
  it('只认夸克', () => {
    const c = client(quark().fetchFn)
    expect(c.supports('quark')).toBe(true)
    expect(c.supports('baidu')).toBe(false)
  })
})

describe('quarkShareClient.list', () => {
  it('token → tree：整棵树的文件（含分享内路径）', async () => {
    const { fetchFn, bodies } = quark({
      detail: (pdir) =>
        pdir === '0'
          ? ok({ code: 0, data: { list: [{ fid: 'd1', share_fid_token: 'dt', file_name: 'S03', dir: true }] } })
          : ok({ code: 0, data: { list: [{ fid: 'f1', share_fid_token: 'tk1', file_name: 'S03E14.mkv', size: 42 }] } }),
    })
    const r = await client(fetchFn).list('quark', 'pwd1', 'code')
    expect(r.validity).toBe('alive')
    expect(r.files).toEqual([{ fid: 'f1', token: 'tk1', pdirFid: 'd1', name: 'S03E14.mkv', size: 42, path: 'S03/S03E14.mkv' }])
    expect(bodies.token[0]).toMatchObject({ pwd_id: 'pwd1', passcode: 'code' })
  })

  it('分享死了（4xx + code≠0）⇒ not-usable，带上夸克自己的话', async () => {
    const { fetchFn } = quark({ token: () => ok({ code: 41006, message: '分享不存在' }, 404) })
    const r = await client(fetchFn).list('quark', 'pwd1')
    expect(r.validity).toBe('not-usable')
    expect(r.reason).toContain('分享不存在')
    expect(r.files).toEqual([])
  })

  it('5xx / 429 ⇒ unknown（「没验到」，不是「验过了、不行」）', async () => {
    const { fetchFn } = quark({ token: () => ok({ code: 500, message: 'oops' }, 500) })
    expect((await client(fetchFn).list('quark', 'p')).validity).toBe('unknown')
    const t = quark({ token: () => ok({ code: 9, message: 'slow down' }, 429) })
    expect((await client(t.fetchFn).list('quark', 'p')).validity).toBe('unknown')
  })

  it('body 不是 JSON（code -1）⇒ unknown', async () => {
    const { fetchFn } = quark({ token: () => new Response('<html>', { status: 200 }) })
    const r = await client(fetchFn).list('quark', 'p')
    expect(r.validity).toBe('unknown')
  })

  it('code 0 但没有 stoken ⇒ unknown，不装作活着', async () => {
    const { fetchFn } = quark({ token: () => ok({ code: 0, data: {} }) })
    expect((await client(fetchFn).list('quark', 'p')).validity).toBe('unknown')
  })

  it('活着但一个文件都没有 ⇒ not-usable', async () => {
    const { fetchFn } = quark({ detail: () => ok({ code: 0, data: { list: [] } }) })
    const r = await client(fetchFn).list('quark', 'p')
    expect(r.validity).toBe('not-usable')
    expect(r.reason).toContain('没有文件')
  })
})

describe('quarkShareClient.save', () => {
  it('落点是 From Stream/tv-261471，不是 From Stream/From Stream/tv-261471', async () => {
    const { fetchFn, bodies } = quark()
    const r = await client(fetchFn).save('quark', 'pwd1', {
      files: [{ fid: 'f1', token: 'tk1' }],
      subdir: 'From Stream/tv-261471',
    })
    expect(r.saved).toBe(true)
    // 建目录只建两层：From Stream 与 tv-261471。多出一层就是前缀没剥掉。
    expect(bodies.mkdir.map((b) => b.file_name)).toEqual(['From Stream', 'tv-261471'])
  })

  it('只转存给定的那几个文件（不整份转存）', async () => {
    const { fetchFn, bodies } = quark()
    await client(fetchFn).save('quark', 'pwd1', {
      files: [{ fid: 'f1', token: 'stale-anon-token' }],   // 验活那次匿名会话拿的 token，转存这边不认
      subdir: 'From Stream/tv-1',
      passcode: 'pc',
    })
    // token 由转存自己的会话重取（fake 的 detail 回 tk1），fid 照单
    expect(bodies.save[0]).toMatchObject({ fid_list: ['f1'], fid_token_list: ['tk1'], pwd_id: 'pwd1' })
    // 提取码要递到 token 那一腿，否则加锁的分享转不了
    expect(bodies.token[0]).toMatchObject({ passcode: 'pc' })
  })

  it('subdir 带层级 ⇒ 作品目录下逐层建出分享里的子文件夹（第三季文件夹不平铺进根）', async () => {
    const { fetchFn, bodies } = quark()
    await client(fetchFn).save('quark', 'pwd1', { files: [{ fid: 'f1', token: 't' }], subdir: 'From Stream/tv-1/第三季（4K）' })
    expect((bodies.mkdir ?? []).map((b) => (b as { file_name: string }).file_name)).toEqual(['From Stream', 'tv-1', '第三季（4K）'])
  })

  it('没有登录态 ⇒ stage auth（调用方据此停手，别接着敲）', async () => {
    const { fetchFn } = quark()
    const r = await client(fetchFn, undefined).save('quark', 'p', { files: [{ fid: 'f', token: 't' }], subdir: 'From Stream/tv-1' })
    expect(r.saved).toBe(false)
    expect(r.stage).toBe('auth')
  })

  it('凭证只经注入的 cookieFor 拿，并且带上了 quark.cn', async () => {
    const cookieFor = vi.fn(async () => 'session=abc')
    const { fetchFn } = quark()
    await quarkShareClient({ cookieFor, fetchFn }).save('quark', 'p', { files: [{ fid: 'f', token: 't' }], subdir: 'From Stream/tv-1' })
    expect(cookieFor).toHaveBeenCalledWith('quark.cn')
  })
})
