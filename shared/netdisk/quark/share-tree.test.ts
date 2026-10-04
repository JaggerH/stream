import { describe, it, expect } from 'vitest'
import { makeQuarkCall, quarkShareTree } from './share-api.ts'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
/** 假分享：根下一个季文件夹 + 一个散文件；季文件夹里两集。 */
function fakeFetch() {
  const seen: string[] = []
  const fetchFn = (async (u: URL | string) => {
    const url = String(u)
    seen.push(url)
    const pdir = /pdir_fid=([^&]+)/.exec(url)?.[1]
    if (pdir === '0') return ok({ code: 0, data: { list: [
      { fid: 'D1', share_fid_token: 't-d1', file_name: 'S03', dir: true },
      { fid: 'F0', share_fid_token: 't-f0', file_name: 'readme.txt', dir: false, size: 3 },
    ] } })
    if (pdir === 'D1') return ok({ code: 0, data: { list: [
      { fid: 'F1', share_fid_token: 't-f1', file_name: 'S03E14.mkv', dir: false, size: 7 },
      { fid: 'F2', share_fid_token: 't-f2', file_name: 'S03E15.mkv', dir: false, size: 8 },
    ] } })
    return ok({ code: 0, data: { list: [] } })
  }) as unknown as typeof fetch
  return { fetchFn, seen }
}

describe('quarkShareTree', () => {
  it('递归展开文件夹，path 带上层目录名，只回文件', async () => {
    const { fetchFn } = fakeFetch()
    const files = await quarkShareTree(makeQuarkCall(fetchFn), 'p', 'ST')
    expect(files.map((f) => f.path).sort()).toEqual(['S03/S03E14.mkv', 'S03/S03E15.mkv', 'readme.txt'])
    expect(files.find((f) => f.path === 'S03/S03E14.mkv')).toMatchObject({ fid: 'F1', share_fid_token: 't-f1', size: 7, pdir_fid: 'D1' })
    expect(files.find((f) => f.path === 'readme.txt')).toMatchObject({ pdir_fid: '0' })
  })
  it('总预算：请求数够到 maxCalls 就停，已列到的照样返回；没 fid 的目录项不往下列', async () => {
    let calls = 0
    // 每个目录下 3 个子目录（其中 1 个没 fid）+ 1 个文件，无限嵌套
    const fetchFn = (async (u: URL | string) => {
      calls++
      const pdir = /pdir_fid=([^&]+)/.exec(String(u))?.[1] ?? '0'
      return ok({ code: 0, data: { list: [
        { fid: `${pdir}a`, share_fid_token: 't', file_name: 'a', dir: true },
        { fid: `${pdir}b`, share_fid_token: 't', file_name: 'b', dir: true },
        { share_fid_token: 't', file_name: 'nofid', dir: true },
        { fid: `${pdir}f`, share_fid_token: 't', file_name: 'f.mkv', dir: false, size: 1 },
      ] } })
    }) as unknown as typeof fetch
    const files = await quarkShareTree(makeQuarkCall(fetchFn), 'p', 'ST', { maxDepth: 50, maxCalls: 5 })
    expect(calls).toBe(5)
    expect(files.length).toBe(5)
    expect(files.some((f) => f.path.includes('nofid'))).toBe(false)
  })

  it('maxDepth 到顶就不再往下列', async () => {
    const { fetchFn, seen } = fakeFetch()
    const files = await quarkShareTree(makeQuarkCall(fetchFn), 'p', 'ST', { maxDepth: 0 })
    expect(files.map((f) => f.path)).toEqual(['readme.txt'])
    expect(seen.some((u) => u.includes('pdir_fid=D1'))).toBe(false)
  })
})
