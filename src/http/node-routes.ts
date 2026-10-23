/**
 * 浏览器节点的面板接口（browser-identity D3、D4）：识别 profile、改节点的名字与环境。
 *
 * - `GET  /api/devices/:id/profiles`                 列出那台机器上 Chrome 的 profile（只读，不开窗）
 * - `POST /api/devices/:id/profiles/claim`           开一次认领（逐个 profile 开认领页）
 * - `GET  /api/devices/:id/profiles/claim/:claimId`  轮询认领结果
 * - `PATCH /api/devices/nodes/:nodeId`               `{ label?, environment? }`，`null` 清空
 *
 * `:id` 是 host agent 的设备 id（`desktop:<host>`、配对设备的 id），`local` 指后端这台机器上的桌面 agent。
 *
 * profile 这三条**只认本机请求**，同 `/api/devices/pairing-code` 与 `/api/devices/:id/ops`：认领会在那台
 * 机器上开窗口，要有人站在机器前；列表里还带着各 profile 的 Google 邮箱。改名字与环境只是一条设置，
 * 和设备默认浏览器一样只过 API token。
 */
import type { Context, Hono } from 'hono'
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'
import type { DiscoverOpts, ProfileClaims } from '../devices/profile-claim.ts'
import type { BrowserNode } from '../devices/node-store.ts'

export interface NodeRoutesDeps {
  claims: Pick<ProfileClaims, 'discover' | 'start' | 'get'>
  nodes: { update(nodeId: string, patch: { label?: string | null; environment?: string | null }): BrowserNode | undefined }
  isLocal: (c: Context) => boolean
}

/** 环境与名字都是给人看的短文本；太长多半是贴错了东西。 */
const MAX_TEXT = 64

function failure(c: Context, e: unknown) {
  if (e instanceof DeviceOffline) return c.json({ error: '这台设备不在线' }, 404)
  if (e instanceof DeviceIncapable) return c.json({ error: `这台设备的 Stream Desktop 不支持 ${e.need}——更新它` }, 409)
  return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
}

/** `exe` / `userDataDir` 两格可选覆盖（Chrome 不在默认位置时）。 */
async function discoverOpts(c: Context): Promise<DiscoverOpts | string> {
  let body: unknown = {}
  if (c.req.method === 'GET') {
    body = { exe: c.req.query('exe'), userDataDir: c.req.query('userDataDir') }
  } else {
    // 不带 body 的 POST 是常态（全用默认位置），空 body 当 `{}`。
    const text = await c.req.text()
    if (text.trim()) {
      try { body = JSON.parse(text) } catch { return 'body 不是合法 JSON' }
    }
  }
  const { exe, userDataDir } = (body ?? {}) as Record<string, unknown>
  if ((exe !== undefined && typeof exe !== 'string') || (userDataDir !== undefined && typeof userDataDir !== 'string')) {
    return 'exe / userDataDir 可选，必须是字符串'
  }
  return { ...(exe ? { exe } : {}), ...(userDataDir ? { userDataDir } : {}) }
}

export function mountNodeRoutes(app: Hono, deps: NodeRoutesDeps): void {
  const LOCAL_ONLY = '只能在运行 Stream 的那台机器上识别 profile'

  app.get('/api/devices/:id/profiles', async (c) => {
    if (!deps.isLocal(c)) return c.json({ error: LOCAL_ONLY }, 403)
    const opts = await discoverOpts(c)
    if (typeof opts === 'string') return c.json({ error: opts }, 400)
    try { return c.json(await deps.claims.discover(c.req.param('id'), opts)) } catch (e) { return failure(c, e) }
  })

  app.post('/api/devices/:id/profiles/claim', async (c) => {
    if (!deps.isLocal(c)) return c.json({ error: LOCAL_ONLY }, 403)
    const opts = await discoverOpts(c)
    if (typeof opts === 'string') return c.json({ error: opts }, 400)
    try { return c.json(await deps.claims.start(c.req.param('id'), opts)) } catch (e) { return failure(c, e) }
  })

  app.get('/api/devices/:id/profiles/claim/:claimId', (c) => {
    if (!deps.isLocal(c)) return c.json({ error: LOCAL_ONLY }, 403)
    const s = deps.claims.get(c.req.param('claimId'))
    // 会话 2 分钟后连同 nonce 一起扔掉；过期与不存在对面板是同一件事：重新识别。
    if (!s) return c.json({ error: '没有这次认领（过期了？）' }, 404)
    return c.json(s)
  })

  app.patch('/api/devices/nodes/:nodeId', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    const b = (body ?? {}) as Record<string, unknown>
    const patch: { label?: string | null; environment?: string | null } = {}
    for (const k of ['label', 'environment'] as const) {
      const v = b[k]
      if (v === undefined) continue
      if (v !== null && typeof v !== 'string') return c.json({ error: `${k} 必须是字符串或 null` }, 400)
      const t = v?.trim() ?? null
      if (t && t.length > MAX_TEXT) return c.json({ error: `${k} 太长（最多 ${MAX_TEXT} 个字符）` }, 400)
      patch[k] = t || null
    }
    if (!Object.keys(patch).length) return c.json({ error: '没有可改的字段（label / environment）' }, 400)
    const n = deps.nodes.update(c.req.param('nodeId'), patch)
    if (!n) return c.json({ error: '没有这个节点' }, 404)
    return c.json(n)
  })
}
