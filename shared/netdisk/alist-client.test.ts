import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AlistClient, isObjectNotFound } from './alist-client.ts'

describe('isObjectNotFound', () => {
  it('认出「文件已从网盘删除/移动」的 AList 错误（rawUrl/fileId 抛的形状）', () => {
    expect(isObjectNotFound('[alist] code 500: object not found')).toBe(true)
    expect(isObjectNotFound('failed get link: object not found')).toBe(true)
  })
  it('不把临时故障 / 别的「not found」误判成文件被删', () => {
    expect(isObjectNotFound('[alist] HTTP 502')).toBe(false)
    expect(isObjectNotFound('fetch failed')).toBe(false)
    expect(isObjectNotFound('storage not found')).toBe(false)
  })
})


function jsonResponse(code: number, data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 401,
    json: async () => ({ code, data, message: 'msg' }),
  } as Response
}

describe('AlistClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listEntries 翻页拉全量——夸克驱动每页封顶 200,per_page:0 名义全量实际截断(活体实测)', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ name: `${i}.mp3`, size: i + 1, is_dir: false }))
    const page2 = Array.from({ length: 50 }, (_, i) => ({ name: `p2-${i}.mp3`, size: i + 1, is_dir: false }))
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { content: page1, total: 250 }))
      .mockResolvedValueOnce(jsonResponse(200, { content: page2, total: 250 }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const files = await client.listEntries('/big', true)
    expect(files).toHaveLength(250)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body1 = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    const body2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(body1).toMatchObject({ page: 1, per_page: 200, refresh: true })
    // refresh 只在第 1 页发:回源一次即可,后续页读刚刷新的缓存
    expect(body2).toMatchObject({ page: 2, per_page: 200, refresh: false })
  })

  it('listDir filters out directories, returns files only', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        content: [
          { name: '01.m4a', size: 100, is_dir: false },
          { name: 'subdir', size: 0, is_dir: true },
          { name: '02.m4a', size: 200, is_dir: false },
        ],
      }),
    )
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const files = await client.listDir('/d')
    expect(files).toEqual([
      { name: '01.m4a', size: 100, isDir: false },
      { name: '02.m4a', size: 200, isDir: false },
    ])
  })

  it('listEntries keeps directories (raw passthrough)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        content: [
          { name: '01.m4a', size: 100, is_dir: false },
          { name: 'subdir', size: 0, is_dir: true },
        ],
      }),
    )
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    expect(await client.listEntries('/d')).toEqual([
      { name: '01.m4a', size: 100, isDir: false },
      { name: 'subdir', size: 0, isDir: true },
    ])
  })

  it('listDirRecursive flattens subdirs, name = relative subpath, files only', async () => {
    // /d → [00.root.mp3, 更新(dir)]; /d/更新 → [707.new.mp3]
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          content: [
            { name: '00.root.mp3', size: 1, is_dir: false },
            { name: '更新', size: 0, is_dir: true },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { content: [{ name: '707.new.mp3', size: 2, is_dir: false }] }),
      )
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const files = await client.listDirRecursive('/d')
    expect(files).toEqual([
      { name: '00.root.mp3', size: 1, isDir: false },
      { name: '更新/707.new.mp3', size: 2, isDir: false },
    ])
    // second call descended into the subdir at the right absolute path
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(secondBody.path).toBe('/d/更新')
  })

  it('listDirRecursive honors the depth guard (does not descend past maxDepth)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ name: 'deep', size: 0, is_dir: true }] }),
    )
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const files = await client.listDirRecursive('/d', 0) // depth 0 → never descend
    expect(files).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the root listing
  })

  // includeDirs 默认关是硬约束,不是保守:NetdiskFilePickerDialog 的平铺列表以「这份列表里
  // 没有可下钻的目录」为前提(它的路径钳制因此退化成保险丝)。默认值一旦翻面,文件弹窗会
  // 突然长出目录行。这条把默认值本身钉住——上面两条只验了结果形状,不验默认。
  it('listDirRecursive 默认不带目录行(includeDirs 省略 = 与显式 false 完全一致)', async () => {
    const tree = () =>
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            content: [
              { name: '00.root.mp3', size: 1, is_dir: false },
              { name: '更新', size: 0, is_dir: true },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { content: [{ name: '707.new.mp3', size: 2, is_dir: false }] }),
        )
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    tree()
    const implicit = await client.listDirRecursive('/d')
    fetchMock.mockReset()
    tree()
    const explicit = await client.listDirRecursive('/d', 5, false, false)
    expect(implicit).toEqual(explicit)
    expect(implicit.every((f) => !f.isDir)).toBe(true)
  })

  it('listDirRecursive includeDirs=true 也吐目录行,name 同样是相对子路径', async () => {
    // /d → [00.root.mp3, 更新(dir)]; /d/更新 → [707.new.mp3, 归档(dir)]; /d/更新/归档 → []
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          content: [
            { name: '00.root.mp3', size: 1, is_dir: false },
            { name: '更新', size: 0, is_dir: true },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          content: [
            { name: '707.new.mp3', size: 2, is_dir: false },
            { name: '归档', size: 0, is_dir: true },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { content: [] }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const files = await client.listDirRecursive('/d', 5, false, true)
    expect(files).toEqual([
      { name: '00.root.mp3', size: 1, isDir: false },
      { name: '更新', size: 0, isDir: true },
      { name: '更新/707.new.mp3', size: 2, isDir: false },
      { name: '更新/归档', size: 0, isDir: true },
    ])
  })

  // 深度闸门只管「还往不往下钻」,不管「这个目录自己列不列出来」——否则最深一层的目录
  // 搜都搜不到(「搜得到但下不去」尚可接受,「根本搜不到」不行)。
  it('listDirRecursive includeDirs=true:到了 maxDepth 的目录自己仍然入结果,只是不再下钻', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ name: 'deep', size: 0, is_dir: true }] }),
    )
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const files = await client.listDirRecursive('/d', 0, false, true)
    expect(files).toEqual([{ name: 'deep', size: 0, isDir: true }])
    expect(fetchMock).toHaveBeenCalledTimes(1) // 没有下钻
  })

  // —— move 的落地确认（夸克的移动是异步任务）——
  // 活体实测（2026-07-31，/quark 下临时目录）：fs/move 155ms 返回，+383ms 强制回源列源目录**文件还在**、
  // 目标目录还空，+1503ms 才翻面。整理面板执行完立刻重核对（0.7s 后）读到的就是移动前的现状，
  // 同一批 move 行原样重现——用户看到「执行了但是没有变化」。
  it('move 等到源目录里真的没有这些名字才返回（夸克 move 是异步任务）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {})) // fs/move
      .mockResolvedValueOnce(jsonResponse(200, { content: [{ name: 'a.mp3', size: 1, is_dir: false }] })) // 还没生效
      .mockResolvedValueOnce(jsonResponse(200, { content: [] })) // 生效了
    const sleeps: number[] = []
    const client = new AlistClient({
      baseUrl: 'http://alist',
      token: 'tok',
      sleep: async (ms: number) => { sleeps.push(ms) },
    })
    await client.move('/src', '/dst', ['a.mp3'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/fs/list')
    // 探针必须强制回源——读 AList 自己的 30 分钟目录缓存等于没探
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toMatchObject({ path: '/src', refresh: true })
    expect(sleeps.length).toBe(1)
  })

  it('move 已经落地时不多等一轮（首探即通过）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {})) // fs/move
      .mockResolvedValueOnce(jsonResponse(200, { content: [] })) // 首探就没了
    const sleeps: number[] = []
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok', sleep: async (ms: number) => { sleeps.push(ms) } })
    await client.move('/src', '/dst', ['a.mp3'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([])
  })

  it('move 等超时也不抛——移动本身已被接受，报失败会害得溯源不落账、无法撤销', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ name: 'a.mp3', size: 1, is_dir: false }] }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok', sleep: async () => {} })
    await expect(client.move('/src', '/dst', ['a.mp3'])).resolves.toBeUndefined()
  })

  it('listDir handles content: null → []', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: null }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    expect(await client.listDir('/d')).toEqual([])
  })

  it('rawUrl caches: two calls on same path → one fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { raw_url: 'http://cdn/file' }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    const a = await client.rawUrl('/d/01.m4a')
    const b = await client.rawUrl('/d/01.m4a')
    expect(a).toBe('http://cdn/file')
    expect(b).toBe('http://cdn/file')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rawUrl on error code does not cache and throws', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}, false))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok' })
    await expect(client.rawUrl('/d/x.m4a')).rejects.toThrow(/401/)
    // second call should hit fetch again (nothing cached)
    await expect(client.rawUrl('/d/x.m4a')).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('401 + refresh → 重登一次并用新 token 重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, {}, false)) // 首发：48h JWT 过期
      .mockResolvedValueOnce(jsonResponse(200, { content: [] }))
    const refresh = vi.fn(async () => 'fresh-token')
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'stale', refresh })
    expect(await client.listDir('/d')).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    const [, retryInit] = fetchMock.mock.calls[1]
    expect((retryInit as RequestInit).headers).toMatchObject({ authorization: 'fresh-token' })
  })

  it('信封 code 401（HTTP 200）同样触发重登', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, {})) // ok=true 但信封 401
      .mockResolvedValueOnce(jsonResponse(200, { content: [] }))
    const refresh = vi.fn(async () => 'fresh-token')
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'stale', refresh })
    expect(await client.listDir('/d')).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('无 refresh 通道的 401 保持抛错，不重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'stale' })
    await expect(client.listDir('/d')).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('token goes into authorization header (bare, no Bearer)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [] }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'my-token' })
    await client.listDir('/d')
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'my-token' })
  })

  it('base 是惰性的:构造期 thunk 还答不出地址,请求时读到后接线的地址(host 档开机时容器睡着)', async () => {
    let target: string | undefined // 构造时还是 undefined
    const client = new AlistClient({ baseUrl: () => target, token: 'tok' })
    target = 'http://127.0.0.1:45001'

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [] }))
    await client.listDir('/d')

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45001/api/fs/list')
  })

  it('注入的 fetchFn 是唯一的请求出口（宿主 / 包用它包唤醒）——全局 fetch 一次都不碰', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { content: [] }))
    const client = new AlistClient({ baseUrl: 'http://alist', token: 'tok', fetchFn: fetchFn as unknown as typeof fetch })
    await client.listDir('/d')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
