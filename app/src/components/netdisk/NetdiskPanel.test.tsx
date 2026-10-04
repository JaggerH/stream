import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetdiskPanel } from './NetdiskPanel.tsx'

const fetchMock = vi.hoisted(() => vi.fn())

// 两块各自的数据源在这里都摆成真实形状——/api/streams 回的是**扁**成员（`plugin_id`），
// 照嵌套形状写会在活体当场 TypeError 而类型检查一声不吭（2026-08-05 栽过）。
const STREAMS = [{
  id: 's1',
  description: '怡楽播客',
  sources: [
    { plugin_id: 'rsshub', source_template_id: 'lizhi/user/:id', params: { id: '123' } },
    { plugin_id: 'alist', source_template_id: 'alist-audio', params: { path: '/quark/怡楽/下架' } },
  ],
  cadence_seconds: 1800,
  vault_subdir: 'yile',
}]
const BINDINGS = [{
  id: 'map_a',
  left: { kind: 'stream', streamId: 's1', title: '怡楽播客' },
  right: { kind: 'alist-dir', path: '/quark/怡楽/付费', boundAt: '' },
  rightHistory: [], autoSync: true, entries: [],
}]
const SHOWS = [{
  id: 'yile', label: '怡楽播客', bindingId: 'map_a',
  sourceDirs: ['/quark/来自分享/怡乐'], subShows: [], autoExecute: false,
  shelves: { claimed: '/quark/怡楽/付费', secondary: '/quark/怡楽/下架' },
}]

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body })

function routeFetch(url: string) {
  const u = String(url)
  if (u.includes('/api/netdisk/reconcile/streams/')) return ok({ stats: { entries: 240, paid: 38, withDuration: 200, needsSupply: 40 } })
  if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: SHOWS })
  if (u.includes('/api/netdisk/mappings')) return ok(BINDINGS)
  if (u.includes('/api/streams')) return ok(STREAMS)
  if (u.includes('/api/netdisk/fs')) return ok({ path: '/', files: [] })
  return ok({})
}

const open = () => render(<NetdiskPanel open onOpenChange={() => {}} streamId="s1" streamTitle="怡楽播客" />)

describe('NetdiskPanel — 网盘入口收进来的那一个面板', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => routeFetch(url))
    vi.stubGlobal('fetch', fetchMock)
  })

  // 面板的全部意义就是一屏看全传送带两端。缺一块就退回"还得再点一个地方"。
  it('两块齐出：整理（进料口）/ 配对情况（出料口）', async () => {
    open()
    await waitFor(() => expect(screen.getByTestId('netdisk-block-reconcile')).toBeTruthy())
    expect(screen.getByTestId('netdisk-block-matching')).toBeTruthy()
  })

  /**
   * 顺序不是排版偏好：配对清单动辄几百条，整理那块配置十几行。配置摆在清单后面就等于没有
   * ——要改配置得先滚过整张表。所以「功能区在上、列表在下」这条得有测试钉住，别被后来的
   * 顺手调整推回去。
   */
  it('功能区（整理）排在列表（配对情况）前面', async () => {
    open()
    const reconcile = await screen.findByTestId('netdisk-block-reconcile')
    const matching = screen.getByTestId('netdisk-block-matching')
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(reconcile, matching)).toBe(true)
  })

  /**
   * 撤掉的那块「当作节目挂上来的目录」不许悄悄回来：它只是把成员编辑器复制了一份塞进网盘
   * 面板，真正的入口是通用的「添加来源」（`alist-audio` 源）。这里同时钉住**没有第二个写
   * 订阅成员表的地方**——面板从头到尾不该发 PATCH /api/streams。
   */
  it('不再有挂载块，也不碰订阅的成员表', async () => {
    const patched: string[] = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') patched.push(String(url))
      return routeFetch(String(url))
    })
    open()
    await waitFor(() => expect(screen.getByTestId('netdisk-block-reconcile')).toBeTruthy())
    expect(screen.queryByTestId('netdisk-block-mounts')).toBeNull()
    expect(screen.queryByText('挂载网盘目录')).toBeNull()
    expect(patched).toEqual([])
  })

  it('最上面先说该走哪条路（源站放不出来的集数）', async () => {
    open()
    expect((await screen.findByTestId('netdisk-advice')).textContent).toContain('40')
  })

  /**
   * 整理那一块摆的是**货架**，不是来源目录。来源目录是一次性进料（搬完就该没了），列在这条
   * 订阅的常驻面板上会让人以为那是一项要维护的配置，而它已经没有任何编辑入口了——要换目录是
   * 开新的一轮整理，走对话里的 `reconcile_open`（spec 2026-08-25-reconcile-as-conversation §1）。
   * 货架不一样：它由绑定派生，长期有效。
   */
  it('整理那一块摆的是这条订阅名下的两个货架，且不列来源目录', async () => {
    open()
    const block = await screen.findByTestId('reconcile-show-yile')
    expect(block.textContent).toContain('/quark/怡楽/付费')
    expect(block.textContent).toContain('/quark/怡楽/下架')
    expect(block.textContent).not.toContain('/quark/来自分享/怡乐')
    expect(block.textContent).not.toContain('来源目录')
  })

  // 别家订阅的整理配置绝不能出现在这里——归属判据走 showsForStream（绑定的 left.streamId）。
  it('别的订阅名下的整理配置不出现在这条订阅的面板里', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/api/netdisk/mappings')) return ok([{ ...BINDINGS[0], left: { kind: 'stream', streamId: '别人', title: 'x' } }])
      return routeFetch(u)
    })
    open()
    await waitFor(() => expect(screen.getByTestId('netdisk-block-reconcile')).toBeTruthy())
    expect(screen.queryByTestId('reconcile-show-yile')).toBeNull()
    // 没配过的那一档按钮就叫「整理」（点进去是同一个只读面板，唯一的动作是「让 AI 整理」）——
    // 不再是「配置整理」：那个表单已经撤了，配整理归对话。
    expect(screen.getByRole('button', { name: '整理' })).toBeTruthy()
  })

  // netdisk 没启用时后端整条 reconcile 都 503：那就说一句，别端出一个点了必然失败的按钮。
  it('整理服务 503 → 只说没接线，不给按钮', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/api/netdisk/reconcile/config')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { code: 'not_configured', message: 'x' } }) })
      }
      return routeFetch(u)
    })
    open()
    expect(await screen.findByText('整理服务没接线。')).toBeTruthy()
    // 按角色查:「整理」也是这一块的标题文字,按文本查会撞上它。
    expect(screen.queryByRole('button', { name: '打开整理' })).toBeNull()
    expect(screen.queryByRole('button', { name: '整理' })).toBeNull()
  })
})
