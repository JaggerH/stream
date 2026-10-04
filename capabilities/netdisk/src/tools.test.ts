// capabilities/netdisk/src/tools.test.ts
//
// 四个动词的「名字 / 参数表 / 调用行为」整套不接真宿主就能测；每一格都**绝不抛**（跑在 DSH 引擎
// 进程里，逃出去的异常带走整个工作台的插件宿主）。网络全部经注入的 fetch。
import { describe, it, expect } from 'vitest'
import { NETDISK_TOOL_NAMES, netdiskToolOptions, type NetdiskSurfaceDeps } from './tools.ts'

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 按 URL 片段分流的假网络。没路由到的请求记下来并答 404，测试能看见「发了不该发的请求」。 */
function fakeNet(routes: Array<[string, Route]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u)
    calls.push(init ? { url, init } : { url })
    const hit = routes.find(([frag]) => url.includes(frag))
    return hit ? hit[1](url, init) : json({ code: -1, message: 'unrouted' }, 404)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

function depsWith(over: Partial<NetdiskSurfaceDeps> & { fetchFn: typeof fetch }): NetdiskSurfaceDeps {
  return {
    cookieFor: async () => undefined,
    hasCookieService: () => false,
    openlist: () => undefined,
    ...over,
  }
}

const verb = (deps: NetdiskSurfaceDeps, name: string) => {
  const hit = netdiskToolOptions(deps).find((t) => t.name === name)
  if (!hit) throw new Error(`no verb ${name}`)
  return hit
}

describe('netdiskToolOptions —— 名字与参数表', () => {
  it('恰好四个动词，每个参数都带描述（模型手里那份说明书）', () => {
    const opts = netdiskToolOptions(depsWith({ fetchFn: fetch }))
    expect(opts.map((o) => o.name).sort()).toEqual(['netdisk_folder_url', 'netdisk_play_link', 'netdisk_save_share', 'netdisk_verify_share'])
    for (const o of opts) {
      expect(o.description.length).toBeGreaterThan(20)
      for (const [k, p] of Object.entries(o.parameters)) {
        expect((p as { description?: string }).description, `${o.name}.${k}`).toBeTruthy()
      }
    }
  })

  // 工具名核对方直接 import 的是 `NETDISK_TOOL_NAMES`，
  // 而模型真看到的名字来自 `netdiskToolOptions`。两者分家不会报错——宿主那张对表会拿一份不存在
  // 的名字去比，比出来的"对上了"是假的。所以这条钉的是「导出的名单 === 真产出的名字」。
  it('导出的名单与真产出的动词名逐字相等', () => {
    const produced = netdiskToolOptions(depsWith({ fetchFn: fetch })).map((o) => o.name)
    expect([...produced].sort()).toEqual([...NETDISK_TOOL_NAMES].sort())
  })

  it('save 的说明书写明它会写用户自己的网盘（不是只读）', () => {
    expect(verb(depsWith({ fetchFn: fetch }), 'netdisk_save_share').description).toMatch(/转存|写/)
  })
})

describe('netdisk_verify_share', () => {
  it('quark：活链 → alive + 文件', async () => {
    const { fetchFn } = fakeNet([
      ['/sharepage/token', () => json({ code: 0, data: { stoken: 'st' } })],
      ['/sharepage/detail', () => json({ code: 0, data: { list: [{ fid: '1', file_name: 'E01.mkv', size: 3, dir: false }] } })],
    ])
    const r = await verb(depsWith({ fetchFn }), 'netdisk_verify_share').execute({ netdisk: 'quark', pwd_id: 'p1' })
    expect(r).toMatchObject({ validity: 'alive', files: [{ name: 'E01.mkv' }] })
  })

  it('baidu：假链 → not-usable', async () => {
    const { fetchFn } = fakeNet([['/api/shorturlinfo', () => json({ errno: 140, show_msg: '啊哦，链接出错了' })]])
    const r = await verb(depsWith({ fetchFn }), 'netdisk_verify_share').execute({ netdisk: 'baidu', pwd_id: '1nope', passcode: '1111' })
    expect(r).toMatchObject({ validity: 'not-usable' })
  })

  it('上游 5xx（我们没查成）→ unknown + reason，不抛', async () => {
    const { fetchFn } = fakeNet([['/sharepage/token', () => json({ status: 500, code: 50000, message: 'boom' }, 500)]])
    const r = (await verb(depsWith({ fetchFn }), 'netdisk_verify_share').execute({ netdisk: 'quark', pwd_id: 'p1' })) as Record<string, unknown>
    expect(r.validity).toBe('unknown')
    expect(String(r.reason)).toContain('boom')
  })

  it('不认识的网盘 → 说人话的失败，列出认识的那几个', async () => {
    const r = (await verb(depsWith({ fetchFn: fetch }), 'netdisk_verify_share').execute({ netdisk: 'aliyun', pwd_id: 'x' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/quark/)
  })
})

describe('netdisk_save_share（写用户自己的盘）', () => {
  it('没有 cookie 服务 → 失败 + 指路装浏览器插件，一个请求都不发', async () => {
    const { fetchFn, calls } = fakeNet([])
    const r = (await verb(depsWith({ fetchFn }), 'netdisk_save_share').execute({ pwd_id: 'p1', dest: 'From Stream' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.hint)).toContain('Stream Desktop')
    expect(calls).toEqual([])
  })

  it('有 cookie 服务但取不到 quark.cn → quarkSave 自己的 stage:auth（不是我们编的）', async () => {
    const { fetchFn } = fakeNet([])
    const deps = depsWith({ fetchFn, hasCookieService: () => true, cookieFor: async () => undefined })
    const r = await verb(deps, 'netdisk_save_share').execute({ pwd_id: 'p1', dest: 'From Stream' })
    expect(r).toMatchObject({ saved: false, stage: 'auth' })
  })

  it('有登录态 → cookie 随请求走，转存完成回 stage:done', async () => {
    const { fetchFn, calls } = fakeNet([
      ['/sharepage/token', () => json({ code: 0, data: { stoken: 'st' } })],
      ['/sharepage/detail', () => json({ code: 0, data: { list: [{ fid: 'f', share_fid_token: 't', file_name: 'a' }] } })],
      ['/file/sort', () => json({ code: 0, data: { list: [{ file_name: 'From Stream', dir: true, fid: 'd1' }] } })],
      ['/sharepage/save', () => json({ code: 0, data: { task_id: 'task' } })],
      ['/task', () => json({ code: 0, data: { status: 2, task_title: '转存完成' } })],
    ])
    const deps = depsWith({ fetchFn, hasCookieService: () => true, cookieFor: async (d) => (d === 'quark.cn' ? '__pus=a' : undefined) })
    const r = await verb(deps, 'netdisk_save_share').execute({ pwd_id: 'p1', dest: 'From Stream' })
    expect(r).toMatchObject({ saved: true, stage: 'done' })
    expect((calls[0]!.init?.headers as Record<string, string>).cookie).toBe('__pus=a')
  })
})

describe('netdisk_play_link', () => {
  it('没有 OpenList（external 档没配 / managed 档未落地）→ 失败说清，不抛', async () => {
    const r = (await verb(depsWith({ fetchFn: fetch }), 'netdisk_play_link').execute({ path: '/quark/x.mkv' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/OpenList/)
  })

  it('external 档 → 直链来自 OpenList；有夸克登录态时再带一路转码流', async () => {
    const { fetchFn } = fakeNet([
      ['/file/v2/play', () => json({ code: 0, data: { video_list: [{ resolution: 'high', accessable: true, trans_status: 'success', video_info: { url: 'http://t/high.mp4', width: 1280 } }] } })],
    ])
    const openlist = { rawUrl: async (p: string) => `http://cdn/${p}`, fileId: async () => 'fid-1' }
    const deps = depsWith({ fetchFn, openlist: () => openlist, hasCookieService: () => true, cookieFor: async () => '__pus=a' })
    const r = await verb(deps, 'netdisk_play_link').execute({ path: '/quark/x.mkv' })
    expect(r).toMatchObject({ rawUrl: 'http://cdn//quark/x.mkv', stream: { url: 'http://t/high.mp4', resolution: 'high' } })
  })

  it('没登录态 → 只有直链，没有转码流（不编）', async () => {
    const { fetchFn, calls } = fakeNet([])
    const openlist = { rawUrl: async () => 'http://cdn/x', fileId: async () => 'fid-1' }
    const r = await verb(depsWith({ fetchFn, openlist: () => openlist }), 'netdisk_play_link').execute({ path: '/quark/x.mkv' })
    expect(r).toEqual({ rawUrl: 'http://cdn/x' })
    expect(calls).toEqual([])
  })

  it('OpenList 抛（文件已删）→ 失败说清', async () => {
    const openlist = { rawUrl: async () => { throw new Error('[alist] code 500: object not found') }, fileId: async () => 'x' }
    const r = (await verb(depsWith({ fetchFn: fetch, openlist: () => openlist }), 'netdisk_play_link').execute({ path: '/gone' })) as Record<string, unknown>
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('object not found')
  })
})

describe('netdisk_folder_url', () => {
  it('quark：逐层找到 → 夸克 web URL + fid', async () => {
    const { fetchFn } = fakeNet([
      ['/file/sort', (url) => json({ code: 0, data: { list: url.includes('pdir_fid=0') ? [{ file_name: 'From Stream', dir: true, fid: 'A' }] : [{ file_name: 'tv-1', dir: true, fid: 'B' }] } })],
    ])
    const deps = depsWith({ fetchFn, hasCookieService: () => true, cookieFor: async () => 'c=1' })
    const r = await verb(deps, 'netdisk_folder_url').execute({ netdisk: 'quark', path: 'From Stream/tv-1' })
    expect(r).toEqual({ found: true, url: 'https://pan.quark.cn/list#/list/all/B', fid: 'B' })
  })

  it('找不到 → found:false 且不抛', async () => {
    const { fetchFn } = fakeNet([['/file/sort', () => json({ code: 0, data: { list: [] } })]])
    const deps = depsWith({ fetchFn, hasCookieService: () => true, cookieFor: async () => 'c=1' })
    const r = await verb(deps, 'netdisk_folder_url').execute({ netdisk: 'quark', path: 'nope' })
    expect(r).toMatchObject({ found: false })
  })
})
