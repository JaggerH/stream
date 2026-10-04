/**
 * 网盘域的**逐成员登记表**：`NetdiskHttpDeps` 上的每一格，都要回答"MCP 工具面吃不吃它"。
 *
 * ## 为什么需要它（活体 2026-08-25 的账）
 *
 * `openReconcile` 这一格加上去的时候只喂饱了一端：它被装在 `serve.ts` 里、拼进传给
 * `createHttpApp` 的那个**副本**上，而 MCP 工具面读的是 `kernel/plugins/agent.ts` 里的
 * `ctx.netdisk.netdiskRoutes`——**另一个对象**。结果是 HTTP `POST /api/netdisk/reconcile/open`
 * 好使，而模型手里压根没有 `reconcile_open` 这个工具。
 *
 * 它坏得毫无声音：工具不存在，和"模型不想用它"长得一模一样。活体上模型绕着
 * status / bindings / browse 试了七八步都走不通，没有任何一处报错。
 *
 * ## 这张表守的是什么
 *
 * **不是**"每一格都必须进 MCP"——有些格子本来就只服务 HTTP（挂载 UI、凭证）。
 * 守的是**每一格都被显式回答过**。往这个域加成员时这条会变红，逼一次判断：
 * 进 MCP（补一行 `mcp`）/ 只服务 HTTP（补一行 `http-only` 并写明理由）。
 *
 * 加成员时**同时记得**：能力要装在 `kernel/plugins/netdisk.ts`（两个消费端读的那一份），
 * 别装在 `serve.ts` 上——那儿只够得着 HTTP 那一端。
 */
import { describe, expect, it } from 'vitest'
import type { NetdiskDeps as NetdiskHttpDeps } from '../http/netdisk-routes.ts'

/** 每一格的归属。`why` 只在 `http-only` 时要求写——"为什么模型不需要它"。 */
const REGISTRY: Record<keyof NetdiskHttpDeps, { face: 'mcp' | 'http-only'; why?: string }> = {
  service: { face: 'mcp' },          // netdisk_bindings 的 bind/sync 侧，及 reconcile_open 的建绑定
  store: { face: 'mcp' },            // netdisk_bindings 列表
  alist: { face: 'mcp' },            // netdisk_browse
  reconcile: { face: 'mcp' },        // reconcile_status / decide / execute
  openReconcile: { face: 'mcp' },    // reconcile_open —— 这一格就是本文件的由来
  transcribeSample: { face: 'mcp' },  // netdisk_transcribe —— **没有** HTTP 端点，只有这一面
  // 追更进 MCP：`netdisk_follow`（看/开/关/跑一轮）+ `netdisk_share_verify`（验一条分享）。
  // **模型骑的是 FollowService 自己那几个方法**（`view` / `setEnabled` / `runOnce` /
  // `inspectShare`），不是另起一套转存——账本、退避、归位那一步全在方法里面，所以"绕过循环"
  // 这件事在结构上不成立。曾经这一格写着 http-only，理由正是怕模型绕过账本；真正的答案不是
  // 不给它这个能力（用户在对话里要求"补一下这部剧"是最常见的一句），而是让它只走同一条路。
  follow: { face: 'mcp' },
  // 轮末裁决器进 MCP：reconcile_adjudicate（手动「现在就裁」）+ reconcile_revoke_adjudication（整批撤回）。
  adjudicate: { face: 'mcp' },
  settings: { face: 'http-only', why: '挂载网盘的期望态，只有那个设置界面在写' },
  fetchCookies: { face: 'http-only', why: '挂载时给 AList 递 cookie，模型不碰凭证（宿主派发，包不索取）' },
  // 建分享是把用户盘上的目录**对外发布**——消费方是导出脚本（首发建一次链接），不是对话；模型要
  // 分享链接时该由用户在网盘里点，不该让它替用户决定公开什么。
  shareCreate: { face: 'http-only', why: '对外发布用户盘上的目录，消费方是导出脚本，不给模型' },
  // 列 / 删跟着建走：三件事是同一条链的两头，把"发布"关在 HTTP 面外、却让模型能列出和删掉
  // 用户所有的分享链接，是把更不可逆的那一半给了它。删除没有回收站，删错了只能重建 + 重发链接。
  shareList: { face: 'http-only', why: '账号全部分享链接的读模型，跟建分享同一条链，不给模型' },
  shareDelete: { face: 'http-only', why: '删链接不可逆、无回收站；比建分享更该由用户自己按' },
}

describe('网盘域逐成员登记表', () => {
  // 这条是"名字就是回补清单"的可执行版本：新成员没登记就红，逼一次显式判断。
  it('每一格都被显式回答过——加了新成员就来这儿补一行', () => {
    // 类型这一侧由 Record<keyof NetdiskHttpDeps, …> 保证：漏一格是编译错误，多一格也是。
    // 这里再钉一次数字，好让"表被整体换掉"这种改动也留下痕迹。
    expect(Object.keys(REGISTRY).sort()).toEqual([
      'adjudicate', 'alist', 'fetchCookies', 'follow', 'openReconcile',
      'reconcile', 'service', 'settings', 'shareCreate', 'shareDelete', 'shareList', 'store', 'transcribeSample',
    ])
  })

  it('只服务 HTTP 的那几格都写了理由——答不出理由的，多半就是该进 MCP 的', () => {
    const missing = Object.entries(REGISTRY)
      .filter(([, v]) => v.face === 'http-only' && !v.why?.trim())
      .map(([k]) => k)
    expect(missing).toEqual([])
  })

  // `openReconcile` 单独钉一次：它是这条教训的当事人，而"它在不在 MCP 面上"曾经
  // 完全没有任何一处会喊。
  it('openReconcile 归 MCP —— 它是模型开一次整理的唯一入口', () => {
    expect(REGISTRY.openReconcile.face).toBe('mcp')
  })
})
