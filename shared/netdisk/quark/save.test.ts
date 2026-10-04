import { describe, it, expect, vi } from 'vitest'
import { quarkSave } from './save.ts'

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const FILE = { fid: 'f1', share_fid_token: 'tk1', file_name: '黄 粱 一 梦' }

/** A fake quark. `over` replaces any leg; every leg defaults to the happy path. */
function quark(over: Partial<Record<'token' | 'detail' | 'sort' | 'mkdir' | 'save' | 'task', () => Response>> = {}) {
  const calls: string[] = []
  let sortCount = 0
  const fetchFn = (async (u: URL | string, init?: RequestInit) => {
    const url = String(u)
    const leg =
      url.includes('/share/sharepage/token') ? 'token'
      : url.includes('/share/sharepage/detail') ? 'detail'
      : url.includes('/share/sharepage/save') ? 'save'
      : url.includes('/file/sort') ? 'sort'
      : url.includes('/clouddrive/task') ? 'task'
      : init?.method === 'POST' ? 'mkdir'
      : 'unknown'
    calls.push(leg)
    if (over[leg as keyof typeof over]) return over[leg as keyof typeof over]!()
    switch (leg) {
      case 'token': return ok({ code: 0, data: { stoken: 'ST' } })
      case 'detail': return ok({ code: 0, data: { list: [FILE] } })
      case 'sort': return ok({ code: 0, data: { list: sortCount++ === 0 ? [] : [{ file_name: 'From Stream', dir: true, fid: 'DEST' }] } })
      case 'mkdir': return ok({ code: 0, data: { fid: 'NEW' } })
      case 'save': return ok({ code: 0, data: { task_id: 'T1' } })
      case 'task': return ok({ code: 0, data: { status: 2, task_title: '分享-转存' } })
      default: return ok({ code: -1 })
    }
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const deps = (fetchFn: typeof fetch) => ({
  cookieFor: async () => 'session=abc',
  fetchFn,
  sleep: async () => {},
})

describe('quarkSave', () => {
  it('transfers into a freshly created destination and reports where it landed', async () => {
    const { fetchFn, calls } = quark()
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r).toMatchObject({ saved: true, stage: 'done', dest: 'From Stream', to_pdir_fid: 'NEW', file_count: 1, files: '黄 粱 一 梦' })
    // created it, then never re-listed to find it — file/sort can't see a just-made folder
    expect(calls).toEqual(['token', 'detail', 'sort', 'mkdir', 'save', 'task'])
  })

  it('reuses an existing destination instead of making a second one', async () => {
    const { fetchFn, calls } = quark({ sort: () => ok({ code: 0, data: { list: [{ file_name: 'From Stream', dir: true, fid: 'OLD' }] } }) })
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r).toMatchObject({ saved: true, to_pdir_fid: 'OLD' })
    expect(calls).not.toContain('mkdir')
  })

  // quark refuses a same-name folder, so losing the create race just means someone else made it
  it('recovers from a lost create race (23008) by looking the folder up again', async () => {
    const { fetchFn } = quark({ mkdir: () => ok({ code: 23008, message: '同名冲突' }) })
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r).toMatchObject({ saved: true, to_pdir_fid: 'DEST' })
  })

  it('reports the dest stage when the folder can neither be found nor made', async () => {
    const { fetchFn } = quark({
      sort: () => ok({ code: 0, data: { list: [] } }),
      mkdir: () => ok({ code: 31001, message: '空间不足' }),
    })
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r).toMatchObject({ saved: false, stage: 'dest' })
    expect(r.message).toContain('空间不足')
  })

  // the verdict rides in the body of a 403 — a bare status would hide 分享者用户封禁
  it('reads a dead share out of quark´s error body, quoting its reason', async () => {
    const { fetchFn, calls } = quark({ token: () => ok({ code: 41031, message: '分享者用户封禁链接查看受限' }, 403) })
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r).toEqual({ saved: false, stage: 'token', message: '分享者用户封禁链接查看受限' })
    expect(calls).toEqual(['token']) // stops right there — nothing else is worth asking
  })

  it('reports an empty share as the detail stage, not as success', async () => {
    const { fetchFn } = quark({ detail: () => ok({ code: 0, data: { list: [] } }) })
    expect(await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))).toMatchObject({ saved: false, stage: 'detail' })
  })

  it('reports a refused save with quark´s own reason', async () => {
    const { fetchFn } = quark({ save: () => ok({ code: 41013, message: '容量不足' }) })
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r).toMatchObject({ saved: false, stage: 'save', message: '容量不足' })
  })

  // the transfer is a job: saved:true must mean quark said it finished
  it('waits for the async job and fails on a failed one', async () => {
    const { fetchFn } = quark({ task: () => ok({ code: 0, data: { status: 3, task_title: '转存失败' } }) })
    expect(await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))).toMatchObject({ saved: false, stage: 'task' })
  })

  it('does not claim success for a job still running when the wait runs out', async () => {
    const { fetchFn } = quark({ task: () => ok({ code: 0, data: { status: 0 } }) })
    const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
    expect(r.saved).toBe(false)
    expect(r.stage).toBe('task')
    expect(r.message).toContain('可能仍在进行')
  })

  it('says so when there is no quark login at all', async () => {
    const { fetchFn } = quark()
    const r = await quarkSave('p1', { dest: 'From Stream' }, { cookieFor: async () => undefined, fetchFn, sleep: async () => {} })
    expect(r).toMatchObject({ saved: false, stage: 'auth' })
  })

  it('opts.files 给了就只转存那些：fid 照单，token 用本会话的 detail 重取，不信调用方带来的', async () => {
    const { fetchFn, calls } = quark({ detail: () => ok({ code: 0, data: { list: [FILE, { fid: 'X', share_fid_token: 'fresh-x', file_name: 'x.mkv' }] } }) })
    let saveBody = ''
    const spy = (async (u: URL | string, init?: RequestInit) => {
      if (String(u).includes('/sharepage/save')) saveBody = String(init?.body ?? '')
      return fetchFn(u as string, init)
    }) as unknown as typeof fetch
    const r = await quarkSave('p1', { dest: 'From Stream', files: [{ fid: 'X', share_fid_token: 'stale-x' }] }, deps(spy))
    expect(r).toMatchObject({ saved: true, file_count: 1 })
    expect(calls).toContain('detail')
    expect(JSON.parse(saveBody)).toMatchObject({ fid_list: ['X'], fid_token_list: ['fresh-x'], pdir_fid: '0' })
  })

  it('要的 fid 在分享里已经不在了 → detail 阶段失败，说清哪几个', async () => {
    const { fetchFn } = quark()   // 默认 detail 只有 f1
    const r = await quarkSave('p1', { dest: 'From Stream', files: [{ fid: 'gone', share_fid_token: 't' }] }, deps(fetchFn))
    expect(r).toMatchObject({ saved: false, stage: 'detail' })
    expect(r.message).toContain('gone')
  })

  it('files 按分享里的父目录分组：每组各 detail 一次重取 token、各 save 一次带自己的 pdir_fid，所有 task 都到 2 才算 done', async () => {
    const saves: Array<{ pdir_fid: string; fid_list: string[]; fid_token_list: string[] }> = []
    const detailed: string[] = []
    const polled: string[] = []
    let n = 0
    const fetchFn = (async (u: URL | string, init?: RequestInit) => {
      const url = String(u)
      if (url.includes('/share/sharepage/token')) return ok({ code: 0, data: { stoken: 'ST' } })
      if (url.includes('/share/sharepage/detail')) {
        const pdir = /pdir_fid=([^&]+)/.exec(url)![1]
        detailed.push(pdir)
        return ok({ code: 0, data: { list: pdir === 'D1'
          ? [{ fid: 'A', share_fid_token: 'fa', file_name: 'a' }, { fid: 'B', share_fid_token: 'fb', file_name: 'b' }, { fid: 'Z', share_fid_token: 'fz', file_name: 'z' }]
          : [{ fid: 'D1', share_fid_token: 'fd', file_name: 'S03', dir: true }, { fid: 'R', share_fid_token: 'fr', file_name: 'r' }] } })
      }
      if (url.includes('/file/sort')) return ok({ code: 0, data: { list: [{ file_name: 'From Stream', dir: true, fid: 'DEST' }] } })
      if (url.includes('/share/sharepage/save')) {
        const b = JSON.parse(String(init?.body)) as { pdir_fid: string; fid_list: string[]; fid_token_list: string[] }
        saves.push({ pdir_fid: b.pdir_fid, fid_list: b.fid_list, fid_token_list: b.fid_token_list })
        return ok({ code: 0, data: { task_id: `T${++n}` } })
      }
      if (url.includes('/clouddrive/task')) {
        const id = /task_id=([^&]+)/.exec(url)![1]
        polled.push(id)
        // 第一组（D1，2 个文件）夸克说只转进去 1 个；第二组 1 个如数——总计 2/3，message 要说出来
        return ok({ code: 0, data: { status: 2, task_title: 'ok', save_as: { save_as_sum_num: id === 'T1' ? 1 : 1 } } })
      }
      return ok({ code: -1 })
    }) as unknown as typeof fetch
    const r = await quarkSave('p1', {
      dest: 'From Stream',
      files: [
        { fid: 'A', share_fid_token: 'stale', pdir_fid: 'D1' },
        { fid: 'R', share_fid_token: 'stale' },               // 顶层 detail 的条目没有 pdir_fid → 根
        { fid: 'B', share_fid_token: 'stale', pdir_fid: 'D1' },
      ],
    }, deps(fetchFn))
    expect(r).toMatchObject({ saved: true, stage: 'done', file_count: 2 })
    expect(r.message).toContain('2/3')
    expect(detailed.sort()).toEqual(['0', 'D1'])
    expect(saves).toEqual([
      { pdir_fid: 'D1', fid_list: ['A', 'B'], fid_token_list: ['fa', 'fb'] },
      { pdir_fid: '0', fid_list: ['R'], fid_token_list: ['fr'] },
    ])
    expect(polled.sort()).toEqual(['T1', 'T2'])
  })

  it('passes the passcode through to the token call', async () => {
    let body = ''
    const { fetchFn } = quark({ token: () => ok({ code: 0, data: { stoken: 'ST' } }) })
    const spy = (async (u: URL | string, init?: RequestInit) => {
      if (String(u).includes('/token')) body = String(init?.body ?? '')
      return fetchFn(u as string, init)
    }) as unknown as typeof fetch
    await quarkSave('p1', { dest: 'From Stream', passcode: 'x9y8' }, deps(spy))
    expect(body).toContain('"passcode":"x9y8"')
  })

  // 绑定是「一个目录 ↔ 一个左侧」一对一。所有作品都转存进同一个 From Stream，那个目录就同时
  // 装着几十部片子 —— 没有哪个绑定能把它当自己的右侧。所以落点必须按作品分层。
  describe('嵌套落点（按作品分目录）', () => {
    /** 逐层建目录的假 quark：记下每次 mkdir 的 (pdir_fid, file_name) */
    const nested = () => {
      const mkdirs: Array<{ pdir_fid: string; file_name: string }> = []
      const fids: Record<string, string> = { 'From Stream': 'FID_ROOT', 权力的游戏: 'FID_WORK' }
      const fetchFn = (async (u: URL | string, init?: RequestInit) => {
        const url = String(u)
        if (url.includes('/share/sharepage/token')) return ok({ code: 0, data: { stoken: 'ST' } })
        if (url.includes('/share/sharepage/detail')) return ok({ code: 0, data: { list: [FILE] } })
        if (url.includes('/share/sharepage/save')) return ok({ code: 0, data: { task_id: 'T1' } })
        if (url.includes('/clouddrive/task')) return ok({ code: 0, data: { status: 2 } })
        if (url.includes('/file/sort')) return ok({ code: 0, data: { list: [] } }) // 都不存在 → 都要建
        if (init?.method === 'POST') {
          const b = JSON.parse(String(init.body ?? '{}'))
          mkdirs.push({ pdir_fid: b.pdir_fid, file_name: b.file_name })
          return ok({ code: 0, data: { fid: fids[b.file_name] ?? 'FID_X' } })
        }
        return ok({ code: -1 })
      }) as unknown as typeof fetch
      return { fetchFn, mkdirs }
    }

    it('subdir → 落点下逐层建，投递到作品目录', async () => {
      const { fetchFn, mkdirs } = nested()
      const r = await quarkSave('p1', { dest: 'From Stream', subdir: '权力的游戏' }, deps(fetchFn))
      expect(r.saved).toBe(true)
      expect(mkdirs).toEqual([
        { pdir_fid: '0', file_name: 'From Stream' },
        { pdir_fid: 'FID_ROOT', file_name: '权力的游戏' },
      ])
      // 投递到作品目录，不是落点根 —— 否则绑定的右侧还是那个混装目录
      expect(r.to_pdir_fid).toBe('FID_WORK')
    })

    it('单层 dest 仍按老样子工作（存量调用方零改动）', async () => {
      const { fetchFn, mkdirs } = nested()
      const r = await quarkSave('p1', { dest: 'From Stream' }, deps(fetchFn))
      expect(r.saved).toBe(true)
      expect(mkdirs).toEqual([{ pdir_fid: '0', file_name: 'From Stream' }])
      expect(r.to_pdir_fid).toBe('FID_ROOT')
    })

    it('作品名里的斜杠不劈成目录 —— 片名可以带 /', async () => {
      const { fetchFn, mkdirs } = nested()
      const r = await quarkSave('p1', { dest: 'From Stream', subdir: 'A/B: 副标题' }, deps(fetchFn))
      expect(mkdirs.map((m) => m.file_name)).toEqual(['From Stream', 'A_B: 副标题'])
      // 返回的 dest 必须是 sanitize 后的实际路径（'/'→'_'）——调用方拿它拼绑定的 AList 路径，
      // 用原始 'A/B' 会让绑定指向一个不存在的两层目录。
      expect(r.dest).toBe('From Stream/A_B: 副标题')
    })
  })
})
