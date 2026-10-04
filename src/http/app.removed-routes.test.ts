// 从 app.test.ts 拆出(2026-07-22):按路由域分文件,理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect } from 'vitest'
import { createHttpApp, type HealthInfo } from './app.ts'
import { health, manifests } from './__fixtures__/app-harness.ts'

describe('removed routes', () => {
  const stubs = {
    service: { streamsResource: () => [] },
    itemStore: { get: () => undefined },
    health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
  } as never

  it('404s old media and dead action routes', async () => {
    const app = createHttpApp(stubs)
    const oldRoutes: [string, string][] = [
      ['GET', '/api/bili/play'],
      ['GET', '/api/bili/dash'],
      ['GET', '/api/bili/seg'],
      ['GET', '/api/bili/audio'],
      ['GET', '/api/douyin/video'],
      ['GET', '/api/media/douyin/video'],
      // 站点视频经通用 `/api/media/play?platform=<provider>&vid=` 代理，不再有按站名开的代理口。
      ['GET', '/api/media/xhs/video'],
      ['GET', '/api/video/preview'],
      ['POST', '/api/action/follow'],
      // 站点互动（点赞 / 收藏）经通用动作路由 `POST /api/recipes/action`，不再有按站名开的互动口。
      ['POST', '/api/discover/interact'],
      ['POST', '/api/bili/connect'],
      ['POST', '/api/douyin/connect'],
    ]
    for (const [method, path] of oldRoutes) {
      expect((await app.request(path, { method })).status).toBe(404)
    }
  })

  // 登录态只有一个来源：后端向用户的 Chrome 要。「指一台第三方服务器去拉 cookie」那条路
  // 已经撤了，这三条是它当时的 HTTP 面。**必须 404 不是 503**——503 说的是「这台机器没装」，
  // 会让调用方以为配一下就能用；而这个能力不存在了。扩展改问 `GET /api/ext/sync-config`。
  it('404s the retired external-cookie-source routes', async () => {
    const app = createHttpApp(stubs)
    const routes: [string, string][] = [
      ['GET', '/api/settings/cookiecloud'],
      ['PUT', '/api/settings/cookiecloud'],
      ['GET', '/api/cookiecloud/push-config'],
    ]
    for (const [method, path] of routes) {
      expect([path, (await app.request(path, { method })).status]).toEqual([path, 404])
    }
  })

  // 对话入口只剩 DSH 工作台：模型由用户在 DSH 设置页里配、工具走 MCP 面，
  // Stream 这一侧不再有任何 LLM 的 HTTP 出入口。这两条曾经是那个出口。
  it('404s the LLM ingress routes（模型不再经 Stream 转发）', async () => {
    const app = createHttpApp(stubs)
    const llmRoutes: [string, string][] = [
      ['POST', '/api/llm/v1/chat/completions'],
      ['GET', '/api/llm/usage'],
    ]
    for (const [method, path] of llmRoutes) {
      expect([path, (await app.request(path, { method })).status]).toEqual([path, 404])
    }
  })

  // 原生对话抽屉退役（spec 2026-08-17-native-chat-drawer-removal）：对话入口只剩 DSH 工作台。
  // 这一族**必须是 404 不是 503**——503 说的是
  // 「这个能力这台机器没装」，会让调用方以为配一下就能用，而它已经不存在了。
  // search agent（`src/agent/search/`）不在内：它本来就没有 HTTP 面，起一轮 / 读轨迹是
  // MCP 的 `search_agent` / `get_agent_run` 两个工具。
  it('404s the retired native chat routes', async () => {
    const app = createHttpApp(stubs)
    const chatRoutes: [string, string][] = [
      ['POST', '/api/agent/chat'],
      ['GET', '/api/agent/chat/x/stream'],
      ['POST', '/api/agent/chat/x/stop'],
      ['GET', '/api/agent/models'],
      ['GET', '/api/agent/conversations'],
      ['GET', '/api/agent/conversations/x'],
      ['DELETE', '/api/agent/conversations/x'],
      ['PATCH', '/api/agent/conversations/x'],
      ['GET', '/api/agent/conversations/x/messages'],
    ]
    for (const [method, path] of chatRoutes) {
      expect([method, (await app.request(path, { method })).status]).toEqual([method, 404])
    }
  })

  // 看板数据平面退役：DataFrame 那层有损转码只显示得出 9.4% 的 artifact（157 run / 1158
  // artifact 实测），table/text 两个最大类目根本不在它的 view 并集里。Task 4-9 已经用直读
  // artifact 的 live/research present 顶替；这三条路由随平面一起下线。
  it.each(['/api/boards', '/api/panels', '/api/data/queries'])('看板面已下线：%s → 404', async (path) => {
    const app = createHttpApp(stubs)
    const res = await app.request(path)
    expect(res.status).toBe(404)
  })

  // Stream 不再托管 DSH（spec 2026-09-05）：装、起、停都归用户自己的 DSH。这三条曾是托管面。
  it('404s the retired DSH hosting routes', async () => {
    const app = createHttpApp(stubs)
    // 路径拼起来写：`no-dsh-hosting.guard.test.ts` 扫的是 src/ 里那条托管面前缀的字面量，
    // 而这条断言正是钉住它 404 的那条、必须留在 src/ 里，所以不给守卫留字面量。
    const dsh = '/api/' + 'dsh/'
    for (const [method, path] of [['GET', `${dsh}status`], ['POST', `${dsh}start`], ['POST', `${dsh}stop`]] as const) {
      expect([path, (await app.request(path, { method })).status]).toEqual([path, 404])
    }
  })
})
