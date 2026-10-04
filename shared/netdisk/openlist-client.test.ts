// shared/netdisk/openlist-client.test.ts
//
// 这份客户端是**两个宿主同吃的核心**（Stream 后端与 DSH 网盘插件）——所以它必须对宿主零假设：
// fetch 注入进来、baseUrl 现求值、token 裸放 Authorization 头。文件货架那层（`./alist-client.ts` 的
// `AlistClient`）同样零假设；Stream 独有的部分（standby 唤醒、plugin target 取址、网关路径改写）
// 在 `src/netdisk/alist-client.ts` 的宿主接线里，不在这里。
import { describe, it, expect } from 'vitest'
import { OpenListClient } from './openlist-client.ts'

function jsonResponse(code: number, data: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => ({ code, data, message: 'msg' }) } as Response
}

describe('OpenListClient', () => {
  it('走注入的 fetch，token 裸放 Authorization 头（无 Bearer——OpenList 对 Bearer 前缀答 401，活体实测）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse(200, { content: [{ name: 'a.mp3', size: 1, is_dir: false }] })
    }) as unknown as typeof fetch
    const client = new OpenListClient({ baseUrl: 'http://openlist:5244/', token: 'alist-perm', fetchFn })
    const entries = await client.listEntries('/quark')
    expect(entries).toEqual([{ name: 'a.mp3', size: 1, isDir: false }])
    expect(calls[0]!.url).toBe('http://openlist:5244/api/fs/list')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('alist-perm')
  })

  it('baseUrl 可以是 thunk：每次请求现求值（host 档下容器醒着时地址才存在，构造期快照必得空）', async () => {
    let base = ''
    const urls: string[] = []
    const fetchFn = (async (url: string | URL) => {
      urls.push(String(url))
      return jsonResponse(200, { raw_url: 'http://cdn/x' })
    }) as unknown as typeof fetch
    const client = new OpenListClient({ baseUrl: () => base, token: 't', fetchFn })
    base = 'http://late:5244'
    await client.rawUrl('/x')
    expect(urls[0]).toBe('http://late:5244/api/fs/get')
  })

  it('401 且有 refresh 通道 → 换 token 重试一次；没有通道 → 抛出说清', async () => {
    let n = 0
    const seenTokens: string[] = []
    const fetchFn = (async (_u: string | URL, init?: RequestInit) => {
      seenTokens.push((init?.headers as Record<string, string>).authorization)
      n++
      return n === 1 ? jsonResponse(401, null, 401) : jsonResponse(200, { raw_url: 'u' })
    }) as unknown as typeof fetch
    const client = new OpenListClient({ baseUrl: 'http://o', token: 'old', fetchFn, refresh: async () => 'new' })
    await expect(client.rawUrl('/p')).resolves.toBe('u')
    expect(seenTokens).toEqual(['old', 'new'])

    const dead = new OpenListClient({ baseUrl: 'http://o', token: 'old', fetchFn: (async () => jsonResponse(401, null, 401)) as unknown as typeof fetch })
    await expect(dead.rawUrl('/p')).rejects.toThrow(/401/)
  })

  describe('move：目标目录刚建、OpenList 说 dst 不存在 → 刷一次父目录再试一次', () => {
    // 活体（2026-09-03，喜剧之王单口季 a004422b）：同一轮里第一批 move 建出 纯享/S03 并搬成 11 份，
    // 第二批（另一个源目录）往同一个 dst 搬时 OpenList 答 `failed to get dst dir: object not found`——
    // 它是从父目录的缓存清单里找 dst 的，而那份清单还是 mkdir 之前的。刷一次父目录就有了。
    const DST_MISSING = 'failed to get dst dir: object not found'
    it('第一次 move 答 dst 不存在 → 带 refresh 列父目录 → 重发 move → 探源侧落地', async () => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = []
      let moves = 0
      const fetchFn = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url)
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        calls.push({ url: u, body })
        if (u.endsWith('/api/fs/move')) {
          if (++moves === 1) return { ok: true, status: 200, json: async () => ({ code: 500, data: null, message: DST_MISSING }) } as Response
          return jsonResponse(200, {})
        }
        if (u.endsWith('/api/fs/list')) return jsonResponse(200, { content: [] })
        throw new Error('unexpected ' + u)
      }) as unknown as typeof fetch
      const client = new OpenListClient({ baseUrl: 'http://o', token: 't', fetchFn, sleep: async () => {} })
      await client.move('/root/src', '/root/纯享/S03', ['a.mp4'])
      const seq = calls.map((c) => c.url.replace('http://o', '') + (c.body.refresh ? '?refresh' : ''))
      expect(seq.slice(0, 3)).toEqual(['/api/fs/move', '/api/fs/list?refresh', '/api/fs/move'])
      expect(calls[1]!.body.path).toBe('/root/纯享')
    })

    it('不是 dst 不存在的错（比如源文件不在）→ 不重试、原样抛', async () => {
      let moves = 0
      const fetchFn = (async (url: string | URL) => {
        const u = String(url)
        if (u.endsWith('/api/fs/move')) { moves++; return { ok: true, status: 200, json: async () => ({ code: 500, data: null, message: 'object not found' }) } as Response }
        return jsonResponse(200, { content: [] })
      }) as unknown as typeof fetch
      const client = new OpenListClient({ baseUrl: 'http://o', token: 't', fetchFn, sleep: async () => {} })
      await expect(client.move('/root/src', '/root/dst', ['a.mp4'])).rejects.toThrow(/object not found/)
      expect(moves).toBe(1)
    })

    it('只重试一次：刷完父目录第二次仍说 dst 不存在 → 抛出来，不无限循环', async () => {
      let moves = 0
      const fetchFn = (async (url: string | URL) => {
        const u = String(url)
        if (u.endsWith('/api/fs/move')) { moves++; return { ok: true, status: 200, json: async () => ({ code: 500, data: null, message: DST_MISSING }) } as Response }
        return jsonResponse(200, { content: [] })
      }) as unknown as typeof fetch
      const client = new OpenListClient({ baseUrl: 'http://o', token: 't', fetchFn, sleep: async () => {} })
      await expect(client.move('/root/src', '/root/dst', ['a.mp4'])).rejects.toThrow(/dst dir/)
      expect(moves).toBe(2)
    })
  })
})

describe('put：流式上传（OpenList `PUT /api/fs/put`）', () => {
  // 下游导出脚本每周把数据包传进夸克盘：文件走 body 流过去，不整份读进内存；
  // `File-Path` 头按 OpenList 要求 URL-encode（中文路径裸放会被 Go 的 header 解析拒掉）。
  it('PUT + File-Path(URL-encode) + As-Task:false + Content-Length，token 裸放', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      // 把流吃干净，证明 body 真的是可读流而不是整份字节
      const b = init?.body as ReadableStream<Uint8Array>
      const chunks: Uint8Array[] = []
      for await (const c of b as unknown as AsyncIterable<Uint8Array>) chunks.push(c)
      calls[calls.length - 1]!.init = { ...(init ?? {}), body: Buffer.concat(chunks).toString() }
      return jsonResponse(200, null)
    }) as unknown as typeof fetch
    const client = new OpenListClient({ baseUrl: 'http://o', token: 'perm', fetchFn })
    const stream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('hello')); c.close() } })
    await client.put('/quark/闲鱼数据包/p1/a.txt', stream, 5)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://o/api/fs/put')
    expect(calls[0]!.init.method).toBe('PUT')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h.authorization).toBe('perm')
    expect(h['file-path']).toBe(encodeURIComponent('/quark/闲鱼数据包/p1/a.txt'))
    expect(h['as-task']).toBe('false')
    expect(h['content-length']).toBe('5')
    expect(calls[0]!.init.body).toBe('hello')
    expect((calls[0]!.init as { duplex?: string }).duplex).toBe('half')
  })

  it('401 → 走 refresh 重开一条流再传一次（流不能回放，所以 body 是 thunk）', async () => {
    let n = 0
    let opened = 0
    const fetchFn = (async (_u: string | URL, init?: RequestInit) => {
      n++
      if (n === 1) return jsonResponse(401, null, 401)
      expect((init?.headers as Record<string, string>).authorization).toBe('new')
      return jsonResponse(200, null)
    }) as unknown as typeof fetch
    const client = new OpenListClient({ baseUrl: 'http://o', token: 'old', fetchFn, refresh: async () => 'new' })
    await client.put('/x', () => { opened++; return new ReadableStream({ start(c) { c.close() } }) }, 0)
    expect(n).toBe(2)
    expect(opened).toBe(2)
  })

  it('OpenList 信封 code≠200 → 抛出带 message', async () => {
    const fetchFn = (async () => jsonResponse(500, null)) as unknown as typeof fetch
    const client = new OpenListClient({ baseUrl: 'http://o', token: 't', fetchFn })
    await expect(client.put('/x', () => new ReadableStream({ start(c) { c.close() } }), 0)).rejects.toThrow(/code 500/)
  })
})
