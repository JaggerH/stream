import { describe, it, expect } from 'vitest'
import { quarkResolveDirFid, quarkFolderUrl } from './browse.ts'

/** 假夸克 file/sort:按 pdir_fid 返回该目录的子项。key '0' = 盘根。 */
const fakeFetch = (tree: Record<string, Array<{ file_name: string; dir: boolean; fid: string }>>) =>
  (async (url: string | URL) => {
    const m = /pdir_fid=([^&]+)/.exec(String(url))
    const pdir = m ? decodeURIComponent(m[1]) : '0'
    return { json: async () => ({ code: 0, data: { list: tree[pdir] ?? [] } }) } as Response
  }) as unknown as typeof fetch

const tree = {
  '0': [{ file_name: 'From Stream', dir: true, fid: 'fidA' }, { file_name: '别的', dir: true, fid: 'z' }],
  fidA: [{ file_name: '幸运女神 (2026) [tmdbid-278624]', dir: true, fid: 'fidB' }],
}

describe('quarkResolveDirFid', () => {
  it('逐层走路径段 → 末层文件夹 fid', async () => {
    const fid = await quarkResolveDirFid(['From Stream', '幸运女神 (2026) [tmdbid-278624]'], { cookieFor: async () => 'ck', fetchFn: fakeFetch(tree) })
    expect(fid).toBe('fidB')
  })

  it('任一层找不到 → null（目录被删/改名/还没建好）', async () => {
    expect(await quarkResolveDirFid(['From Stream', '不存在'], { cookieFor: async () => 'ck', fetchFn: fakeFetch(tree) })).toBeNull()
  })

  it('同名但不是目录（是文件）→ 不认，null', async () => {
    const t = { '0': [{ file_name: 'From Stream', dir: false, fid: 'f' }] }
    expect(await quarkResolveDirFid(['From Stream'], { cookieFor: async () => 'ck', fetchFn: fakeFetch(t) })).toBeNull()
  })

  it('没有夸克登录态 → null，且绝不发请求', async () => {
    let called = 0
    const f = (async () => { called++; return { json: async () => ({}) } as Response }) as unknown as typeof fetch
    expect(await quarkResolveDirFid(['x'], { cookieFor: async () => null, fetchFn: f })).toBeNull()
    expect(called).toBe(0)
  })

  it('空路径段 → null', async () => {
    expect(await quarkResolveDirFid([], { cookieFor: async () => 'ck', fetchFn: fakeFetch(tree) })).toBeNull()
  })
})

describe('quarkFolderUrl', () => {
  it('拼夸克文件夹 web URL（fid 定位）', () => {
    expect(quarkFolderUrl('fidB')).toBe('https://pan.quark.cn/list#/list/all/fidB')
  })
})
