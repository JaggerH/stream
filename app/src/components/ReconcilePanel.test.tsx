import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconcilePanel } from './ReconcilePanel.tsx'
import { DedupePreview } from './DedupePreview.tsx'
import type { MappingSet, ReconcileShowConfig, ReconcilePreview, ReconcilePlanAction } from '../lib/types.ts'

const fetchMock = vi.hoisted(() => vi.fn())

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

function ok(json: unknown) {
  return Promise.resolve({ ok: true, json: async () => json })
}

/**
 * 取渲染这条路径的那个元素。**不能用 `getByText(整条路径)`**：路径拆成了「目录段 muted +
 * 文件名 foreground」两段（公共前缀降权，见 reconcile-action-row 的 `PathText`），而 RTL 的
 * 文本匹配只看**直接文本子节点**，整条已经不在同一个文本节点里。按 `textContent` 全等取——
 * 这条断言同时守着"整条路径完整摆着、没被 truncate"。
 */
function pathMatcher(path: string) {
  return (_: string, el: Element | null) =>
    typeof el?.className === 'string' && el.className.includes('break-all') && el.textContent === path
}
function pathEl(path: string) {
  return screen.getByText(pathMatcher(path))
}
/** 断言"这条路径没出现"用它（`queryByText` 同样匹配不到被拆成两段的整条路径）。 */
function noPathEl(path: string) {
  return screen.queryByText(pathMatcher(path))
}

function fail(status: number, message: string) {
  return Promise.resolve({ ok: false, status, json: async () => ({ error: message }) })
}

describe('ReconcilePanel — streamId scoping', () => {
  const showA: ReconcileShowConfig = {
    id: 'showA', label: '节目A', bindingId: 'bindA', sourceDirs: ['/夸克/A'],
    shelves: { claimed: '/夸克/A/付费', secondary: '/夸克/A/下架' }, subShows: [], autoExecute: false,
  }
  const showB: ReconcileShowConfig = {
    id: 'showB', label: '节目B', bindingId: 'bindB', sourceDirs: ['/夸克/B'],
    shelves: { claimed: '/夸克/B/付费', secondary: '/夸克/B/下架' }, subShows: [], autoExecute: false,
  }
  const bindingA: MappingSet = {
    id: 'bindA', left: { kind: 'playlist', streamId: 'stream-a', title: '订阅A' },
    right: { kind: 'alist-dir', path: '/夸克/A', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const bindingB: MappingSet = {
    id: 'bindB', left: { kind: 'playlist', streamId: 'stream-b', title: '订阅B' },
    right: { kind: 'alist-dir', path: '/夸克/B', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  // 这两份预览只用来分辨"面板拉的是哪个 show"——路径本身就是判据。
  // 用 `move`（落在常亮的「可以自动完成」里）而不是 pending：状态类的行收在「处理中」那一行后面，
  // 拿它当判据等于让一组"面板拉了谁"的用例去依赖折叠行为，两件事没有关系。
  const previewA: ReconcilePreview = {
    shelves: { claimed: '/夸克/A/付费', secondary: '/夸克/A/下架' }, sourceDirs: ['/夸克/A'],
    plan: [{ kind: 'move', key: 'kA', basis: 'authority:kA', dstDir: '/夸克/A/付费', src: { path: '/夸克/A/源站A的这一集.mp3', name: '源站A的这一集', size: 1, durationS: 10 } }],
    counts: { move: 1, deleteDup: 0, pending: 0, deleteLoser: 0, replace: 0, moveClaimed: 1, moveSecondary: 0 },
  }
  const previewB: ReconcilePreview = {
    shelves: { claimed: '/夸克/B/付费', secondary: '/夸克/B/下架' }, sourceDirs: ['/夸克/B'],
    plan: [{ kind: 'move', key: 'kB', basis: 'authority:kB', dstDir: '/夸克/B/付费', src: { path: '/夸克/B/源站B的这一集.mp3', name: '源站B的这一集', size: 1, durationS: 10 } }],
    counts: { move: 1, deleteDup: 0, pending: 0, deleteLoser: 0, replace: 0, moveClaimed: 1, moveSecondary: 0 },
  }

  // 面板上唯一的整理动作（spec 2026-08-24-conversational-reconcile §3.4）：把带 show 上下文的
  // 一句话送进对话——卡片→对话上下文桥。裁决与执行全在对话里进行。
  it('「让 AI 整理」：点击把 reconcilePrompt(show) 送进对话通道', async () => {
    const { setAskChatSink, reconcilePrompt } = await import('../lib/askExtract.ts')
    const sink = vi.fn()
    setAskChatSink(sink)
    try {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
        if (u.includes('/api/netdisk/mappings')) return ok([bindingA])
        if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(previewA)
        if (u.includes('/api/netdisk/reconcile/suggestions')) return ok({ items: [], summary: null })
        if (u.includes('/api/streams')) return ok([])
        throw new Error(`unexpected fetch: ${method} ${u}`)
      })
      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)
      const btn = await screen.findByRole('button', { name: /让 AI 整理/ })
      fireEvent.click(btn)
      await waitFor(() => expect(sink).toHaveBeenCalledWith({ kind: 'send', text: reconcilePrompt('showA', '节目A') }))
      // 面板自己绝不调 execute/decisions——那是对话里 agent 的活
      expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/execute'))).toBe(false)
      expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/decisions'))).toBe(false)
    } finally {
      setAskChatSink(undefined)
    }
  })

  /**
   * 「还没配过整理」那一档（needsSetup）。这里曾经是一整个设置向导（来源目录 / 付费库 / 下架库 /
   * 名称 + 一套派生 + 一条自己编排的四步提交），整段已撤：来源目录是一次性进料，不是常驻配置，
   * 改它 = 开新的一轮整理，而那条路只有一条——对话里说一句，AI 调 `reconcile_open`
   * （spec 2026-08-25-reconcile-as-conversation §1/§5）。
   *
   * `stream-orphan` 名下没有绑定 → showsForStream 筛出空 → needsSetup。
   */
  function orphanFetch(url: string, init?: RequestInit) {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
    if (u.includes('/api/netdisk/mappings')) return ok([bindingA]) // 'stream-orphan' 名下一条都没有
    if (u.includes('/api/netdisk/reconcile/suggestions')) return ok({ items: [], summary: null })
    if (u.includes('/api/streams')) return ok([])
    throw new Error(`unexpected fetch: ${method} ${u}`)
  }

  // 掉了 = 这条订阅在面板里没有任何出路：设置向导已经撤掉，没有第二个入口。
  it('还没配过 show：「让 AI 整理」把 openReconcilePrompt(stream) 送进对话通道', async () => {
    const { setAskChatSink, openReconcilePrompt } = await import('../lib/askExtract.ts')
    const sink = vi.fn()
    setAskChatSink(sink)
    try {
      fetchMock.mockImplementation(orphanFetch)
      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-orphan" streamTitle="春典JARGON" />)

      fireEvent.click(await screen.findByRole('button', { name: /让 AI 整理/ }))
      await waitFor(() => expect(sink).toHaveBeenCalledWith(
        { kind: 'send', text: openReconcilePrompt('stream-orphan', '春典JARGON') },
      ))
    } finally {
      setAskChatSink(undefined)
    }
  })

  /**
   * **面板绝不再写配置**。这条钉的是"前端没有第二个写回口"——它掉了不会有任何报错，也不会有
   * 任何用例变红，只是那个口子悄悄回来了，而它比后端 `reconcile_open` 那条少一半校验与回滚。
   */
  it('还没配过 show：整个生命周期里不发 PUT /api/netdisk/reconcile/config', async () => {
    const { setAskChatSink, openReconcilePrompt } = await import('../lib/askExtract.ts')
    const sink = vi.fn()
    setAskChatSink(sink)
    try {
      fetchMock.mockImplementation(orphanFetch)
      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-orphan" streamTitle="春典JARGON" />)

      fireEvent.click(await screen.findByRole('button', { name: /让 AI 整理/ }))
      await waitFor(() => expect(sink).toHaveBeenCalledWith(
        { kind: 'send', text: openReconcilePrompt('stream-orphan', '春典JARGON') },
      ))
      // 建目录 / 建绑定 / 改订阅成员 那三样也一并归了后端那个原子动作——面板一样都不许自己做。
      const writes = fetchMock.mock.calls.filter((c: unknown[]) => {
        const method = (c[1] as RequestInit | undefined)?.method ?? 'GET'
        return method !== 'GET' && !String(c[0]).includes('/preview')
      })
      expect(writes).toEqual([])
    } finally {
      setAskChatSink(undefined)
    }
  })

  // 已撤控件的文案零残留。改回文案就等于把那些控件的"位置"留在界面上——先烂在这里，再被补回来。
  it('还没配过 show：裁决/编辑类控件的文案一个都不在', async () => {
    fetchMock.mockImplementation(orphanFetch)
    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-orphan" streamTitle="春典JARGON" />)

    await screen.findByRole('button', { name: /让 AI 整理/ })
    for (const gone of ['添加来源目录', '保存并预览', '付费库目录', '下架库目录', '自定义目录与名称']) {
      expect(document.body.textContent).not.toContain(gone)
    }
    // 输入框整个不该有：这一档只剩两段说明 + 一颗按钮。
    expect(document.querySelectorAll('input')).toHaveLength(0)
  })

  it('with a streamId whose subscription has a matching show, previews THAT show and not another configured one', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA, showB] })
      if (u.includes('/api/netdisk/mappings')) return ok([bindingA, bindingB])
      if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(previewA)
      if (u.includes('/api/netdisk/reconcile/showB/preview') && method === 'POST') return ok(previewB)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })

    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)

    await waitFor(() => expect(pathEl('/夸克/A/源站A的这一集.mp3')).toBeTruthy())
    expect(noPathEl('/夸克/B/源站B的这一集.mp3')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/netdisk/reconcile/showA/preview', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock).not.toHaveBeenCalledWith('/api/netdisk/reconcile/showB/preview', expect.anything())
    // >1 show total, but only 1 in scope for this stream — no picker should be offered.
    expect(screen.queryByLabelText('选择节目')).toBeNull()
  })

  it('with no streamId, keeps old behaviour: all shows, defaults to shows[0], picker offered for >1', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA, showB] })
      if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(previewA)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })

    render(<ReconcilePanel open onOpenChange={() => {}} />)

    await waitFor(() => expect(pathEl('/夸克/A/源站A的这一集.mp3')).toBeTruthy())
    expect(screen.getByLabelText('选择节目')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/netdisk/mappings', expect.anything())
  })

  it('discards a config response that arrives late, superseded by a newer request', async () => {
    // 慢的第一次请求(返回旧文档 showA)在快的第二次请求(返回新文档 showB,带 identity)之后才落地——
    // 组件状态必须停在后落地请求发起前"最新"的那次请求上,不能被更晚落地的旧响应回退。
    let resolveFirst!: (v: unknown) => void
    const firstDeferred = new Promise((res) => { resolveFirst = res })
    let configGetCount = 0
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config') && method === 'GET') {
        configGetCount++
        if (configGetCount === 1) {
          return firstDeferred.then(() => ({ ok: true, json: async () => ({ shows: [showA] }) }))
        }
        return ok({ shows: [showB] })
      }
      if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(previewA)
      if (u.includes('/api/netdisk/reconcile/showB/preview') && method === 'POST') return ok(previewB)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })

    const { rerender } = render(<ReconcilePanel open={false} onOpenChange={() => {}} />)
    rerender(<ReconcilePanel open onOpenChange={() => {}} />) // fires config fetch #1 (slow, showA)
    rerender(<ReconcilePanel open={false} onOpenChange={() => {}} />)
    rerender(<ReconcilePanel open onOpenChange={() => {}} />) // fires config fetch #2 (fast, showB)

    await waitFor(() => expect(pathEl('/夸克/B/源站B的这一集.mp3')).toBeTruthy())

    // now let the stale first request land — it must NOT revert state back to showA.
    resolveFirst(undefined)

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(pathEl('/夸克/B/源站B的这一集.mp3')).toBeTruthy()
    expect(noPathEl('/夸克/A/源站A的这一集.mp3')).toBeNull()
  })

  describe('suspect-dir——目录疑似认领错误单独分组', () => {
    it('告警本身不折叠(标题+原因常亮),证据清单默认收起;no-duration 仍留在「认不出」组、不给的按钮照旧不给', async () => {
      const preview: ReconcilePreview = {
        plan: [
          {
            kind: 'pending', key: 'k1',
            src: { path: '/夸克/A/errdir/ep1.mp3', name: 'ep1.mp3', size: 100 },
            pendingKind: 'suspect-dir',
            reason: '目录疑似认领错误：该目录下的文件与本节目的认集规则大量不匹配，请确认认领的来源目录是否选对。',
          },
          {
            kind: 'pending', key: 'k2',
            src: { path: '/夸克/A/errdir/ep2.mp3', name: 'ep2.mp3', size: 100 },
            pendingKind: 'suspect-dir',
            reason: '目录疑似认领错误：该目录下的文件与本节目的认集规则大量不匹配，请确认认领的来源目录是否选对。',
          },
          {
            kind: 'pending', key: 'k3',
            src: { path: '/夸克/A/noname.mp3', name: 'noname.mp3', size: 100 },
            pendingKind: 'no-duration',
          },
        ],
        counts: { move: 0, deleteDup: 0, pending: 3, deleteLoser: 0, replace: 0, moveClaimed: 0, moveSecondary: 0 },
      }
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
        if (u.includes('/api/netdisk/mappings')) return ok([bindingA])
        if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(preview)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
        throw new Error(`unexpected fetch: ${method} ${u}`)
      })

      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)

      // 告警不折叠：标题 + 那句原因常亮（同目录只展示一次,标题和 reason 分处两个节点,各查各的）。
      expect(await screen.findByText(/这个目录多数文件认不出属于本节目/)).toBeTruthy()
      expect(screen.getByText(/该目录下的文件与本节目的认集规则大量不匹配/)).toBeTruthy()

      // 抬头摘要也得报它：主区一长,告警那段就在折线以下,抬头不说 = 用户压根不知道有这回事。
      // **按目录数**（这两条 pending 同属 /夸克/A/errdir 一个目录），不是文件数——要去确认的是目录。
      expect(screen.getByTestId('reconcile-summary').textContent).toBe('1 个目录要你确认')

      // 证据清单是证据不是主角：默认收起,点开才出现。
      expect(screen.queryByText('ep1.mp3')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /看这 2 个文件/ }))
      expect(screen.getByText('ep1.mp3')).toBeTruthy()
      expect(screen.getByText('ep2.mp3')).toBeTruthy()

      // no-duration 是状态不是待办：收进「处理中」那一行,展开后仍在「认不出」这一组里。
      expect(screen.queryByText('noname.mp3')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /处理中/ }))
      expect(screen.getByText('认不出')).toBeTruthy()
      expect(screen.getByText('noname.mp3')).toBeTruthy()

      // 裁决按钮（含「不再提醒」）已整体撤掉——豁免决定归对话（spec 2026-08-24-conversational-reconcile）。
      const noDurationRow = screen.getByText('noname.mp3').closest('[data-slot="item"]') as HTMLElement
      expect(noDurationRow.textContent).not.toContain('不再提醒')

      const suspectRow = screen.getByText('ep1.mp3').closest('[data-slot="item"]') as HTMLElement
      expect(suspectRow.textContent).not.toContain('不再提醒')
    })
  })

  /**
   * 「同一集有几个文件」这一组（spec 2026-07-30-duplicate-episode-decision-design §4）。
   * 过去一行只有来源那个文件的名字和大小，冲突的另一份连路径都没给 —— 那个问句无法回答。
   */
  describe('多份择一——同一集归成一组,并排列出全部候选', () => {
    // 路径落在 showA 的货架/来源目录下:「库内/来源」由**目录前缀**判(whereIn),不看后端那个
    // `inLib` 字段——第二货架上的文件那个字段也是 false,照它渲染会把库里的说成来源里的。
    const compare = {
      authorityDurationS: 2389,
      candidates: [
        { path: '/夸克/A/付费/玄关笔记/20.七杀.mp3', size: 249928105, durationS: 6247, inLib: true },
        { path: '/夸克/A/上游/玄关笔记/20.七杀.mp3', size: 38289594, durationS: 2390, inLib: false },
      ],
    }
    const preview: ReconcilePreview = {
      plan: [
        { kind: 'pending', key: 'k七杀', src: { path: '/夸克/A/上游/玄关笔记/20.七杀.mp3', name: '20.七杀.mp3', size: 38289594, durationS: 2390 },
          pendingKind: 'replace', reason: '两份都对得上…', compare, episode: '20.七杀' },
      ],
      counts: { move: 0, deleteDup: 0, pending: 1, deleteLoser: 0, replace: 0, moveClaimed: 0, moveSecondary: 0 },
    }
    /** 这一组的每一条 = 一张 `ActionCard`（和「可以自动完成」同一份渲染）。 */
    const decideCards = () => [...document.querySelectorAll('[data-slot="card"]')] as HTMLElement[]

    it('一张 ActionCard 摆全候选:集名当标题、节目单当尺子、每份的时长/体量/码率/库内来源都在', async () => {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
        if (u.includes('/api/netdisk/mappings')) return ok([bindingA])
        if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(preview)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
        throw new Error(`unexpected fetch: ${method} ${u}`)
      })

      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)
      await waitFor(() => expect(decideCards()).toHaveLength(1))
      const card = decideCards()[0]

      // 标题 = 节目单里那一集 + 这一集的尺子。**不是文件名**——文件名恰恰是要被质疑的那一侧。
      expect(card.querySelector('[data-slot="card-title"]')?.textContent).toContain('20.七杀')
      expect(card.textContent).toContain('节目单 39:49')   // 2389s
      expect(card.textContent).toContain('104:07')          // 库内那份 6247s
      expect(card.textContent).toContain('39:50')           // 来源那份 2390s
      expect(card.textContent).toContain('库内')
      expect(card.textContent).toContain('来源')
      expect(card.textContent).toContain('320k')            // 249928105×8÷6247÷1000
      expect(card.textContent).toContain('128k')            // 38289594×8÷2390÷1000
      expect(card.textContent).toContain('/夸克/A/付费/玄关笔记')

      // **一份都不许标成留/走**：这套卡片里 ✓＝留下、✗＝删掉，而这里一个都还没定。
      const tones = [...card.querySelectorAll('[data-slot="item-media"]')].map((m) => m.getAttribute('data-tone'))
      expect(tones).toEqual(['undecided', 'undecided'])
    })

    it('同一集的多条 pending 只出一行（后端一个来源文件一条,不许在 UI 里重复几遍同一个问题）', async () => {
      const dup: ReconcilePreview = { ...preview, plan: [
        preview.plan[0],
        { ...preview.plan[0], src: { path: '/夸克/来源B/玄关笔记/20.七杀.mp3', name: '20.七杀.mp3', size: 38289594, durationS: 2390 } },
      ] }
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
        if (u.includes('/api/netdisk/mappings')) return ok([bindingA])
        if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(dup)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
        throw new Error(`unexpected fetch: ${method} ${u}`)
      })

      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)
      // 一集一张卡（不是一个文件一张）。**卡里的候选可以重名**——库内那份和来源那份常常同名，
      // 正是这一组要裁的东西，所以按卡数断言，不按文件名出现几次。
      await waitFor(() => expect(decideCards()).toHaveLength(1))
      expect(screen.getByText(/要你决定/).textContent).toContain('1')
    })

    // `replace` 待定（比不出高下的那几份）全进「同一集有几个文件」这一组——并排看一眼就是它要的答案。
    // `swap-hold` **不进「认不出」**（那个标题说的是"连时长都拿不到"，而它什么都判出来了）。
    // 它也不再自成一块：这里这条对不上本轮任何动作（占位者谁都不动）= 真卡住了 → 进「要你决定」。
    it('replace 待定归同一组;对不上号的 swap-hold 进「要你决定」，不进「认不出」', async () => {
      const mixed: ReconcilePreview = { ...preview, plan: [
        preview.plan[0],
        { kind: 'pending', key: 'k下架同集', src: { path: '/夸克/来源/601.另一集.mp3', name: '601.另一集.mp3', size: 100, durationS: 2605 },
          pendingKind: 'replace', reason: '下架货架已有同集的一份…', compare: { authorityDurationS: 2605, candidates: [
            { path: '/夸克/来源/601.另一集.mp3', size: 100, durationS: 2605, inLib: false },
          ] } },
        { kind: 'pending', key: 'k占位', src: { path: '/夸克/来源/750.等一轮.mp3', name: '750.等一轮.mp3', size: 100, durationS: 1000 },
          pendingKind: 'swap-hold', reason: '目标目录已有同名文件…' },
      ] }
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
        if (u.includes('/api/netdisk/mappings')) return ok([bindingA])
        if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(mixed)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
        throw new Error(`unexpected fetch: ${method} ${u}`)
      })

      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)
      await waitFor(() => expect(screen.getByText('601.另一集.mp3')).toBeTruthy())
      // 七杀 + 另一集 + 那条卡住的等位
      expect(screen.getByText(/要你决定/).textContent).toContain('3')
      const secondCard = screen.getByText('601.另一集.mp3').closest('[data-slot="card"]') as HTMLElement
      expect(secondCard.textContent).toContain('43:25') // 2605s，并排对照照样渲染

      // 「等下一轮自然落位」那一块整个没了；本例没有 no-duration，所以连「处理中」都不该出现。
      expect(screen.queryByText(/等下一轮自然落位/)).toBeNull()
      expect(screen.queryByRole('button', { name: /处理中/ })).toBeNull()
      expect(screen.queryByText('认不出')).toBeNull()

      // 那条等位摆成一张卡：说清它卡住了。裁决动作（含豁免）归对话，卡上不再有按钮。
      const holdCard = [...document.querySelectorAll('[data-slot="card"]')]
        .find((c) => c.textContent?.includes('750.等一轮.mp3')) as HTMLElement
      expect(holdCard.textContent).toContain('位置被占着')
      // 裁决类动作一个不剩（证据展开那类只读按钮不在此列）
      for (const label of ['不再提醒', '就是这一集', '不是这一集', '留这份', '都不是']) {
        expect(holdCard.textContent).not.toContain(label)
      }
    })


    it('节目单没给时长（裁判缺席）→ 只并排列数据,不出那把尺子', async () => {
      const noAuth: ReconcilePreview = { ...preview, plan: [
        { ...preview.plan[0], compare: { candidates: compare.candidates } },
      ] }
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        const method = init?.method ?? 'GET'
        if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [showA] })
        if (u.includes('/api/netdisk/mappings')) return ok([bindingA])
        if (u.includes('/api/netdisk/reconcile/showA/preview') && method === 'POST') return ok(noAuth)
      if (u.includes('/api/streams')) return ok([]) // 见文件末尾「下架来源」用例
        throw new Error(`unexpected fetch: ${method} ${u}`)
      })

      render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-a" />)
      await waitFor(() => expect(decideCards()).toHaveLength(1))
      const card = decideCards()[0]
      expect(card.textContent).toContain('104:07') // 数据照摆
      expect(card.textContent).not.toContain('节目单')
    })
  })

})

/**
 * 齿轮（「来源目录」）里**只剩只读呈现**：这一轮从哪几个目录捡、两个货架各在哪。
 *
 * 编辑器（sourcesDraft / saveSources）已撤——来源目录是一次性进料，不是常驻配置；改它 = 开新
 * 的一轮整理，那条路只有一条（对话里说一句 → 后端 `reconcile_open` 原子地建货架/建绑定/补下架
 * 来源/写配置，失败整体回滚）。前端再留一个写回口就是第二个入口，而它比后端那条少一半校验与
 * 回滚（spec 2026-08-25-reconcile-as-conversation §1）。
 */
describe('ReconcilePanel — 齿轮里只剩只读呈现（面板不写配置）', () => {
  const show: ReconcileShowConfig = {
    id: 'yile', label: '怡楽播客', bindingId: 'bind1', sourceDirs: ['/quark/来自：分享/怡乐播客'],
    shelves: { claimed: '/quark/From Stream/怡楽播客/付费', secondary: '/quark/From Stream/怡楽播客/下架' },
    subShows: [], autoExecute: false,
  }
  const binding: MappingSet = {
    id: 'bind1', left: { kind: 'playlist', streamId: 'stream-yile', title: '怡乐播客' },
    right: { kind: 'alist-dir', path: '/quark/From Stream/怡楽播客/付费', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const emptyPreview: ReconcilePreview = { plan: [], counts: { move: 0, deleteDup: 0, pending: 0, deleteLoser: 0, replace: 0, moveClaimed: 0, moveSecondary: 0 } }

  function mockBackend() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [show] })
      if (u.includes('/api/netdisk/mappings')) return ok([binding])
      if (u.includes('/api/netdisk/reconcile/suggestions')) return ok({ items: [], summary: null })
      if (u.includes('/preview')) return ok(emptyPreview)
      if (u.includes('/api/streams')) return ok([])
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })
  }

  /** 齿轮收在抬头右上角（aria-label「来源目录」）。 */
  const openGear = async () => fireEvent.click(await screen.findByRole('button', { name: '来源目录' }))

  it('点开只说"这一轮从哪儿捡、搬去哪儿"，没有任何编辑控件', async () => {
    mockBackend()
    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-yile" />)

    await openGear()
    // 现状照旧看得见——收起编辑器不等于把"机器在盯哪几个文件夹"也藏了。
    expect(await screen.findByText(/本轮从 \/quark\/来自：分享\/怡乐播客 捡文件/)).toBeTruthy()
    expect(screen.getByText(/认领的搬进 \/quark\/From Stream\/怡楽播客\/付费（绑定的目录）/)).toBeTruthy()
    expect(screen.getByText(/认不出的搬进 \/quark\/From Stream\/怡楽播客\/下架（「下架」那条来源扫的目录）/)).toBeTruthy()
    // 编辑器整套没了：输入框、增删行、保存。留一个就是第二个写回口。
    expect(screen.queryByLabelText('来源目录 1')).toBeNull()
    expect(document.querySelectorAll('input')).toHaveLength(0)
    for (const gone of ['添加来源目录', '移除来源目录 1', '保存', '保存并预览', '付费库目录', '下架库目录']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
  })

  /**
   * **面板绝不再写配置**——已配置这一档同样成立（齿轮是原来那个写回口所在的地方）。
   * 它掉了不会有任何报错，只是那个口子悄悄回来了。
   */
  it('从打开到点遍齿轮，一次 PUT /api/netdisk/reconcile/config 都不发', async () => {
    mockBackend()
    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-yile" />)

    await openGear()
    await screen.findByText(/本轮从 \/quark\/来自：分享\/怡乐播客 捡文件/)
    expect(fetchMock.mock.calls.some(
      (c: unknown[]) => String(c[0]).includes('/api/netdisk/reconcile/config')
        && (c[1] as RequestInit | undefined)?.method === 'PUT',
    )).toBe(false)
  })
})

/**
 * 两个货架各归其主（spec §6 P8）：付费货架是**绑定**的落地目录，下架货架是**「下架」那条来源**
 * 扫的目录。整理只管把没归属的文件搬过去，所以配置里只有来源目录。
 */
describe('ReconcilePanel — 货架归属（P8）', () => {
  const show: ReconcileShowConfig = {
    id: 'yile', label: '怡楽播客', bindingId: 'bind1', sourceDirs: ['/quark/来自：分享/怡乐播客'],
    subShows: [], autoExecute: false,
  }
  const binding: MappingSet = {
    id: 'bind1', left: { kind: 'playlist', streamId: 'stream-yile', title: '怡乐播客' },
    right: { kind: 'alist-dir', path: '/quark/From Stream/怡楽播客/付费', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const emptyPreview: ReconcilePreview = { plan: [], counts: { move: 0, deleteDup: 0, pending: 0, deleteLoser: 0, replace: 0, moveClaimed: 0, moveSecondary: 0 } }

  // 货架地址住在别处，随时可能不成立（绑定没了、还没有下架来源、地址撞了来源目录）。
  // 后端把原因原样下发，面板必须**原文呈现**——那句话就是"该去补哪一样东西"的指路。
  it('货架解不出来时，把后端给的原因直接摆出来', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) {
        return ok({ shows: [{ ...show, shelves: null, shelvesProblem: "show 'yile': 这个订阅还没有「下架」来源——先给订阅加一条扫下架目录的来源。" }] })
      }
      if (u.includes('/api/netdisk/mappings')) return ok([binding])
      if (u.includes('/preview')) return ok(emptyPreview)
      if (u.includes('/api/streams')) return ok([])
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })

    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-yile" />)
    expect(await screen.findByText(/还没有「下架」来源/)).toBeTruthy()
  })

})

/**
 * 扫全部绑定去重：「同一集攒了几份」每条绑定都会发生，不限于这里配过的节目——所以按绑定逐条扫，
 * 一条失败不拦别的。删不可逆，所以这条路径必然是两步：先出清单，人点确认才执行。
 */
describe('ReconcilePanel — 扫全部绑定去重', () => {
  const bindingA: MappingSet = {
    id: 'bindA', left: { kind: 'playlist', streamId: 'stream-a', title: '某剧' },
    right: { kind: 'alist-dir', path: '/夸克/某剧', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const bindingB: MappingSet = {
    id: 'bindB', left: { kind: 'playlist', streamId: 'stream-b', title: '另一部' },
    right: { kind: 'alist-dir', path: '/夸克/另一部', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const dedupePreview: ReconcilePreview = {
    // 原地模式（按绑定扫）：没有来源目录，一切都在库里。
    shelves: { claimed: '/夸克/某剧' },
    sourceDirs: [],
    plan: [{
      kind: 'delete-loser', key: 'k1', episode: '第 1 集',
      src: { path: '/夸克/某剧/S01E01.1080p.mkv', name: 'S01E01.1080p.mkv', size: 1024 ** 3 },
      keptPath: '/夸克/某剧/S01E01.2160p.mkv', basis: 'quality-loser-of:/夸克/某剧/S01E01.2160p.mkv',
    }],
    counts: { move: 0, deleteDup: 0, deleteLoser: 1, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0 },
  }

  function mount() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [] })
      if (u.includes('/api/netdisk/reconcile/bindings/bindA/preview')) return ok(dedupePreview)
      if (u.includes('/api/netdisk/reconcile/bindings/bindB/preview')) return fail(400, '绑定没有落地目录')
      if (u.includes('/api/netdisk/reconcile/bindings/bindA/execute')) return ok({ moved: 0, deleted: 1, pending: 0, errors: [] })
      if (u.includes('/api/netdisk/mappings') && method === 'GET') return ok([bindingA, bindingB])
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })
    render(<ReconcilePanel open onOpenChange={() => {}} />)
  }

  it('逐条绑定出清单：一条失败不拦别的，确认后只对有得删的那条执行', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /扫全部绑定去重/ }))

    // 聚合视图与作品页弹层共用同一个组件，一条动作一张 Card 的形状一致：
    // ① 集名（CardTitle）② 现任 ③ 另一份（各一个 Item）④ 原因（CardFooter）。
    // 两个主体都摆完整路径 + 「库内/来源」——原地模式下两份都在库里。
    const card = (await screen.findByText(pathMatcher('/夸克/某剧/S01E01.1080p.mkv'))).closest('[data-slot="card"]') as HTMLElement
    expect(card.querySelector('[data-slot="card-title"]')?.textContent).toContain('第 1 集')
    expect(card.textContent).toContain('保留/夸克/某剧/S01E01.2160p.mkv库内')
    expect(card.textContent).toContain('删除/夸克/某剧/S01E01.1080p.mkv库内')
    expect(card.textContent).toContain('原因：现任质量不低于这份（清晰度 2160p ≥ 1080p）')
    // 算不出来的那条如实占一行（原因原文），不吞掉也不拦住成功的那条
    expect(screen.getByText(/绑定没有落地目录/)).toBeTruthy()
    // 只看清单不许动网盘
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/execute'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]) === '/api/netdisk/reconcile/bindings/bindA/execute')).toBe(true))
    // 预览就失败的那条没有清单，自然也不该被执行
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('bindB/execute'))).toBe(false)
    await waitFor(() => expect(screen.getByText(/删除 1，移动 0/)).toBeTruthy())
  })
})

/**
 * 「可以自动完成」这一组里一条动作 = 一张 Card，**和「将删清单」是同一份渲染**
 * （`reconcile-action-row.tsx`）。两处摆的是同一批 plan action，各写一套必然分叉：将删清单那边
 * 先改了形状之后，用户日常看的这里还是旧的两行 truncate 形状——同一条动作在两个地方长得不一样，
 * 谁也说不清哪个是准的。
 */
describe('ReconcilePanel — 「可以自动完成」的动作卡', () => {
  const show: ReconcileShowConfig = {
    id: 'showAuto', label: '怡楽', bindingId: 'bindAuto', sourceDirs: ['/夸克/怡楽/来源'],
    shelves: { claimed: '/夸克/怡楽/付费', secondary: '/夸克/怡楽/下架' }, subShows: [], autoExecute: false,
  }
  const binding: MappingSet = {
    id: 'bindAuto', left: { kind: 'playlist', streamId: 'stream-auto', title: '怡楽' },
    right: { kind: 'alist-dir', path: '/夸克/怡楽/付费', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  /** 四类自动动作各一条：认领搬入 / 认不出进下架 / 换正主 / 同集删落选。 */
  const preview: ReconcilePreview = {
    shelves: { claimed: '/夸克/怡楽/付费', secondary: '/夸克/怡楽/下架' },
    sourceDirs: ['/夸克/怡楽/来源'],
    plan: [
      {
        kind: 'move', key: 'k37', episode: '37.申与酉', basis: 'authority:k37', dstDir: '/夸克/怡楽/付费',
        src: { path: '/夸克/怡楽/来源/37.申与酉.mp3', name: '37.申与酉.mp3', size: 96 * 1024 * 1024, durationS: 6044 },
      },
      {
        kind: 'move', key: 'k花絮', basis: 'no-duration-hit:812s', dstDir: '/夸克/怡楽/下架',
        src: { path: '/夸克/怡楽/来源/花絮.mp3', name: '花絮.mp3', size: 12 * 1024 * 1024, durationS: 812 },
      },
      {
        kind: 'replace', key: 'k756', episode: '756.大家都焦虑的这么具体了吗？', dstDir: '/夸克/怡楽/付费',
        basis: 'name-authority:/夸克/怡楽/付费/756.旧的.mp3',
        src: { path: '/夸克/怡楽/来源/756.大家都焦虑的这么具体了吗？.mp3', name: '756.大家都焦虑的这么具体了吗？.mp3', size: 100 * 1024 * 1024, durationS: 6044 },
        oldPath: '/夸克/怡楽/付费/756.旧的.mp3',
        compare: {
          authorityDurationS: 6043,
          candidates: [
            { path: '/夸克/怡楽/来源/756.大家都焦虑的这么具体了吗？.mp3', size: 100 * 1024 * 1024, durationS: 6044, inLib: false },
            { path: '/夸克/怡楽/付费/756.旧的.mp3', size: 40 * 1024 * 1024, durationS: 6044, inLib: true },
          ],
        },
      },
      {
        kind: 'delete-loser', key: 'k20', episode: '20.七杀', basis: 'quality-loser-of:/夸克/怡楽/付费/20.七杀.mp3',
        src: { path: '/夸克/怡楽/来源/20.七杀.mp3', name: '20.七杀.mp3', size: 38289594, durationS: 2390 },
        keptPath: '/夸克/怡楽/付费/20.七杀.mp3',
        compare: {
          authorityDurationS: 2389,
          candidates: [
            { path: '/夸克/怡楽/来源/20.七杀.mp3', size: 38289594, durationS: 2390, inLib: false },
            { path: '/夸克/怡楽/付费/20.七杀.mp3', size: 249928105, durationS: 2390, inLib: true },
          ],
        },
      },
    ],
    counts: { move: 2, deleteDup: 0, deleteLoser: 1, replace: 1, pending: 0, moveClaimed: 1, moveSecondary: 1 },
  }

  function mount() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [show] })
      if (u.includes('/api/netdisk/mappings')) return ok([binding])
      if (u.includes('/api/netdisk/reconcile/showAuto/preview') && method === 'POST') return ok(preview)
      if (u.includes('/api/streams')) return ok([])
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })
    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-auto" />)
  }

  /** 一条动作 = 一张 Card。取"这条路径所在的那张卡"——卡的边界就是一个决定单元。 */
  const cardOf = (path: string) => pathEl(path).closest('[data-slot="card"]') as HTMLElement
  /** 这条路径那一行的处置方向：`gone`=✗ 要走、`kept`=✓ 留下。**方向断言一律钉在这个抓手上**——
   *  查 lucide 那个 svg 的内部形状既读不出语义，图标库一换又全红。 */
  const toneOf = (path: string) =>
    (pathEl(path).closest('[data-slot="item"]') as HTMLElement)
      .querySelector('[data-slot="item-media"]')
      ?.getAttribute('data-tone') ?? null

  it('三类动作同构：① 集名 ② 现任/这份 ③ 另一份/去向 ④ 原因，结构固定', async () => {
    mount()
    await waitFor(() => expect(pathEl('/夸克/怡楽/来源/37.申与酉.mp3')).toBeTruthy())

    for (const path of ['/夸克/怡楽/来源/37.申与酉.mp3', '/夸克/怡楽/来源/756.大家都焦虑的这么具体了吗？.mp3', '/夸克/怡楽/来源/20.七杀.mp3']) {
      const card = cardOf(path)
      expect(card.querySelectorAll('[data-slot="card-title"]').length).toBe(1)
      expect(card.querySelectorAll('[data-slot="item"]').length).toBe(2)        // ②③ 一个文件一个，不多不少
      expect(card.querySelectorAll('[data-slot="card-footer"]').length).toBe(1) // ④
    }

    // 换正主：删的恰恰是 ②（旧那份），留的是 ③——方向只由 ✓/✗ 说，不靠顺序。
    const swap = cardOf('/夸克/怡楽/来源/756.大家都焦虑的这么具体了吗？.mp3')
    const st = swap.textContent ?? ''
    // ① 是动作类别（这条要干什么），判据留在 ④ 那句原因里——一屏扫过去先要答"换还是删"。
    expect(st).toContain('换正主')
    expect(st).toContain('移出/夸克/怡楽/付费/756.旧的.mp3库内')
    expect(st).toContain('上位/夸克/怡楽/来源/756.大家都焦虑的这么具体了吗？.mp3来源')
    expect(st).toContain('节目单 100:43')
    expect(st).toContain('原因：这份文件名和节目单这一集对得上，现任对不上')
    // 行位（② 现任 / ③ 另一份）不印在界面上，拿各自的动作词（图标的 sr-only 名）当锚点验顺序。
    expect(st.indexOf('移出')).toBeLessThan(st.indexOf('上位'))
    expect(st.indexOf('上位')).toBeLessThan(st.indexOf('原因：'))
    // 方向钉死：换正主里被删的是**现任**，✗ 必须落在它头上——和删除类恰好相反。
    expect(toneOf('/夸克/怡楽/付费/756.旧的.mp3')).toBe('gone')
    expect(toneOf('/夸克/怡楽/来源/756.大家都焦虑的这么具体了吗？.mp3')).toBe('kept')

    // 删除类：② 保留（✓）、③ 删除（✗）。删不可逆——留的是哪份必须同时摆出来。
    const del = cardOf('/夸克/怡楽/来源/20.七杀.mp3')
    expect(del.textContent).toContain('删除同集副本')
    expect(del.textContent).toContain('保留/夸克/怡楽/付费/20.七杀.mp3库内')
    expect(del.textContent).toContain('删除/夸克/怡楽/来源/20.七杀.mp3来源')
    expect(del.textContent).toContain('原因：现任质量不低于这份（码率 837k ≥ 128k）')
    expect(toneOf('/夸克/怡楽/付费/20.七杀.mp3')).toBe('kept')
    expect(toneOf('/夸克/怡楽/来源/20.七杀.mp3')).toBe('gone')

    // 路径绝不 truncate：被省掉的那一截恰恰是"这是哪个文件夹里的哪一份"。
    expect(pathEl('/夸克/怡楽/来源/20.七杀.mp3').className).not.toContain('truncate')
  })

  // 搬运没有"另一份"，②③ 退化成「它是谁 + 它去哪」——但原来那条的信息量一样不能少：
  // 集名（匹配器给的）、当前所在目录、去向。活体真发生过 5 条 move 全对、用户看着列表判断成"错误匹配"。
  it('搬入行：集名 + 完整来源路径 + 去向目录 + 判据，一个都不少', async () => {
    mount()
    await waitFor(() => expect(pathEl('/夸克/怡楽/来源/37.申与酉.mp3')).toBeTruthy())

    // 名称在前、动作类别标记在后（`move` 没有节目单时长，所以标题里没有那个 Badge）。
    const claimed = cardOf('/夸克/怡楽/来源/37.申与酉.mp3')
    expect(claimed.querySelector('[data-slot="card-title"]')?.textContent).toBe('37.申与酉移入付费')
    expect(claimed.textContent).toContain('搬入/夸克/怡楽/来源/37.申与酉.mp3来源')
    expect(claimed.textContent).toContain('去向/夸克/怡楽/付费')
    expect(claimed.textContent).toContain('原因：匹配器把它认成节目单里的这一集')
    // 搬入是"留下"那一侧（它正被收编进库），所以是 ✓ 不是 ✗。
    expect(toneOf('/夸克/怡楽/来源/37.申与酉.mp3')).toBe('kept')
    // 去向那一行是个目录、不是被处置的一份文件，所以它没有 ✓/✗ 那一格。
    expect((pathEl('/夸克/怡楽/付费').closest('[data-slot="item"]') as HTMLElement)
      .querySelector('[data-slot="item-media"]')).toBeNull()

    // 认不出的那条：去向是下架货架，原因说清它为什么去那儿（不是消失）。
    const offline = cardOf('/夸克/怡楽/来源/花絮.mp3')
    expect(offline.querySelector('[data-slot="card-title"]')?.textContent).toBe('怡楽移入下架')
    expect(offline.textContent).toContain('去向/夸克/怡楽/下架')
    expect(offline.textContent).toContain('时长和名字都对不上节目单任何一集 → 进下架货架')
  })

  /**
   * `move` 只有一份文件 + 一个去向，复制文本同构降级：一个 `✓ 搬入`，再加一行 `→ 去向 <目录>`。
   * 去向那一行**不带 ✓/✗**——它是个目录，不是被处置的一份，给它一个处置符号就是在说谎。
   */
  it('复制文本：move 降级成「一个 ✓ 搬入 + 一行去向」，末行仍带 basis', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    mount()
    await waitFor(() => expect(pathEl('/夸克/怡楽/来源/37.申与酉.mp3')).toBeTruthy())
    const card = cardOf('/夸克/怡楽/来源/37.申与酉.mp3')
    fireEvent.click(card.querySelector('button[aria-label="复制这条决策"]') as HTMLElement)

    expect(writeText.mock.calls[0][0]).toBe(
      [
        '移入付费 · 37.申与酉',
        '✓ 搬入 /夸克/怡楽/来源/37.申与酉.mp3',
        '       来源 · 100:44 · 96.0 MiB · 133k',   // 96MiB×8÷6044÷1000
        '→ 去向 /夸克/怡楽/付费',
        '原因：匹配器把它认成节目单里的这一集',
        '判据：authority:k37',
      ].join('\n'),
    )
  })

  /**
   * 元数据粘成一坨（`100:4492.3 MiB128k`）——活体截图里最刺眼的那处，根因是
   * `cn()` 把 `flex` 吃掉了（`line-clamp-*` 与 `flex` 同属 display 组），gap 在 block 上是死代码。
   * 新形状靠**离开 `ItemDescription`** 根治：路径/元数据那一列挂在 `ItemContent` 上，而它只有
   * `min-w-0 flex-1`、不带任何 display 类，两个类从此不在同一个元素上，没得可冲突。
   *
   * **这条断言必须查 class，不能查文本**：`textContent` 有没有 flex 都是同一串（gap 不产生文本
   * 节点），所以老断言全绿、bug 活着。查 class 是这里唯一能在 jsdom 里守住排版的判据。
   */
  it('路径/元数据那一列真是 flex-col（cn() 曾把 flex 吃掉），元数据带显式「·」分隔', async () => {
    mount()
    await waitFor(() => expect(pathEl('/夸克/怡楽/来源/20.七杀.mp3')).toBeTruthy())
    const path = pathEl('/夸克/怡楽/来源/20.七杀.mp3')

    // 路径与元数据同在一列、列内上下两行：元数据因此恒定独占一行且左边缘和路径对齐
    const col = path.parentElement as HTMLElement
    expect(col.getAttribute('data-slot')).toBe('item-content')
    expect(col.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-col']))
    // 这一列绝不能是 ItemDescription：它自带 line-clamp-2，既会吞长路径，又会把 flex 挤掉。
    expect(col.className).not.toContain('line-clamp')

    // 图标与这一列是 Item 里的两个并排槽位（前导 media | 内容列），所以两行的 ✓/✗ 竖着成列
    const item = col.parentElement as HTMLElement
    expect(item.getAttribute('data-slot')).toBe('item')
    expect(item.className.split(/\s+/)).toContain('flex')
    expect(item.querySelector('[data-slot="item-media"]')?.getAttribute('data-tone')).toBe('gone')

    // 末尾元数据拼成一段带 · 的文字：只靠 gap 的话，折行到下一行行首时三个数字仍读成一串。
    expect(screen.getByText('来源 · 39:50 · 36.5 MiB · 128k')).toBeTruthy()
    expect(screen.getByText('库内 · 39:50 · 238.4 MiB · 837k')).toBeTruthy()
  })

  /**
   * 抬头那句摘要。「可省」是用户来这一趟的**原始动机**（网盘快满了），所以它必须准：
   * 删除类删的是 `src` 自己，`replace` 删的却是**现任**（`oldPath`，体量在 `compare.candidates`
   * 里）。拿 `src.size` 顶替 replace 那一项，方向正好反了——报的会是"换上来的那份有多大"。
   */
  it('抬头摘要：可省 = 删除类的 src + replace 的 oldPath（不是 src），搬运不计', async () => {
    mount()
    await waitFor(() => expect(pathEl('/夸克/怡楽/来源/37.申与酉.mp3')).toBeTruthy())

    // 36.5 MiB（删的同集副本）+ 40 MiB（换正主移出的现任）= 76.5 MiB；两条 move 一个字节都不算。
    expect(screen.getByTestId('reconcile-summary').textContent).toBe('可省 76.5 MiB · 4 项可自动完成')
    // 拿 replace 的 src（100 MiB）顶替现任那份就会变成 138.5 MiB——方向反了。
    expect(screen.getByTestId('reconcile-summary').textContent).not.toContain('138')
    // 节目名进标题：面板是从某个订阅点进来的，"在整理哪个节目"不该靠下面那个 Select 去认。
    expect(screen.getByText('整理 · 怡楽')).toBeTruthy()
  })

  /**
   * 同一条动作，在整理面板和将删清单里必须渲染成**一模一样**的一行——这条断言就是"只有一份行渲染"
   * 本身：谁再在某一处另起一套，两边的文本立刻对不上。
   */
  it('与「将删清单」是同一份行渲染：同一条动作两处文本全等', async () => {
    mount()
    await waitFor(() => expect(pathEl('/夸克/怡楽/来源/20.七杀.mp3')).toBeTruthy())
    const inPanel = cardOf('/夸克/怡楽/来源/20.七杀.mp3').textContent

    cleanup()
    render(<DedupePreview groups={[{ bindingId: 'bindAuto', label: '怡楽', preview }]} onConfirm={() => {}} />)
    const inDedupe = cardOf('/夸克/怡楽/来源/20.七杀.mp3').textContent

    expect(inPanel).toBe(inDedupe)
    // 「将删清单」只问删——搬运行不该混进去（不然"将删 N 份"这句汇总会说谎）。
    expect(screen.getByTestId('dedupe-summary').textContent).toContain('将删 2')
    expect(noPathEl('/夸克/怡楽/来源/37.申与酉.mp3')).toBeNull()
  })
})

/**
 * 三层版面：**要动手的**（可以自动完成 / 要你决定）→ **要注意的**（⚠ 目录认错）→ **只是状态**
 * （等下轮落位 / 还在探时长）。第三层用户对它无事可做，六块等权平铺时它们和前两组一样重，
 * 把"我到底要干什么"给淹了——所以收成一行「处理中 N」，想看细节再展开。
 */
describe('ReconcilePanel — 三层版面：抬头摘要与「处理中」折叠行', () => {
  const show: ReconcileShowConfig = {
    id: 'yile', label: '怡楽播客', bindingId: 'bind1', sourceDirs: ['/quark/来源'],
    shelves: { claimed: '/quark/付费', secondary: '/quark/下架' }, subShows: [], autoExecute: false,
  }
  const binding: MappingSet = {
    id: 'bind1', left: { kind: 'playlist', streamId: 'stream-yile', title: '怡乐播客' },
    right: { kind: 'alist-dir', path: '/quark/付费', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const counts = { move: 0, deleteDup: 0, deleteLoser: 0, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0 }

  function mount(preview: ReconcilePreview) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [show] })
      if (u.includes('/api/netdisk/mappings')) return ok([binding])
      if (u.includes('/preview')) return ok(preview)
      if (u.includes('/api/streams')) return ok([])
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })
    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-yile" />)
  }

  /** 状态层只剩一类：还在探时长。等位不在这里——它收进「可以自动完成」/「要你决定」两块。 */
  const statusOnly: ReconcilePreview = {
    plan: [
      { kind: 'pending', key: 'n1', pendingKind: 'no-duration', src: { path: '/quark/来源/没时长.mp3', name: '没时长.mp3', size: 1 } },
    ],
    counts: { ...counts, pending: 1 },
  }

  it('状态层默认折叠成一行「处理中 N 个还在探时长」；点开后标题与解释句都在', async () => {
    mount(statusOnly)

    const line = await screen.findByRole('button', { name: /处理中/ })
    // 整行全等——数字和后半句之间必须有真空格,否则读屏念成「处理中 1个还在探时长」。
    expect(line.textContent).toBe('处理中 1 个还在探时长')
    // 折叠态就是这一行——标题、解释句、文件全不在 DOM 里。
    expect(screen.queryByText('认不出')).toBeNull()
    expect(screen.queryByText('没时长.mp3')).toBeNull()

    fireEvent.click(line)
    expect(screen.getByText(/认不出/)).toBeTruthy()
    expect(screen.getByText(/连时长都拿不到/)).toBeTruthy()
    expect(screen.getByText('没时长.mp3')).toBeTruthy()
    // 裁决按钮已撤——状态行只展示，不给动作
    expect((screen.getByText('没时长.mp3').closest('[data-slot="item"]') as HTMLElement).textContent).not.toContain('不再提醒')
  })

  /**
   * `season-unresolved`（文件夹判不出属于哪一季）不是"还在等信息"——它有一件用户能立刻去做的
   * 事（给文件夹起个带季号的名字）,和"探时长"那种纯等待混成一句"还在探时长"会把它的出路藏起来。
   */
  it('季判不出的文件夹单独一句「N 个文件夹判不出季，原地不动」；展开后能看到 reason', async () => {
    mount({
      plan: [
        {
          kind: 'pending', key: 's1', pendingKind: 'season-unresolved',
          reason: '这个文件夹判不出属于哪一季——本轮不搬不改名；给文件夹起个带季号的名字，或把文件挪进 S<nn>/',
          src: { path: '/quark/来源/来路不明/a.mkv', name: 'a.mkv', size: 1 },
        },
      ],
      counts: { ...counts, pending: 1 },
    })

    const line = await screen.findByRole('button', { name: /处理中/ })
    expect(line.textContent).toBe('处理中 1 个文件夹判不出季，原地不动')
    expect(screen.queryByText('a.mkv')).toBeNull()

    fireEvent.click(line)
    expect(screen.getByText('a.mkv')).toBeTruthy()
    expect(screen.getByText(/给文件夹起个带季号的名字/)).toBeTruthy()
  })

  it('探时长与判不出季同时存在：折叠行两句都在，各自的展开内容互不混淆', async () => {
    mount({
      plan: [
        { kind: 'pending', key: 'n1', pendingKind: 'no-duration', src: { path: '/quark/来源/没时长.mp3', name: '没时长.mp3', size: 1 } },
        {
          kind: 'pending', key: 's1', pendingKind: 'season-unresolved',
          reason: '这个文件夹判不出属于哪一季——本轮不搬不改名；给文件夹起个带季号的名字，或把文件挪进 S<nn>/',
          src: { path: '/quark/来源/来路不明/a.mkv', name: 'a.mkv', size: 1 },
        },
      ],
      counts: { ...counts, pending: 2 },
    })

    const line = await screen.findByRole('button', { name: /处理中/ })
    expect(line.textContent).toBe('处理中 1 个还在探时长、1 个文件夹判不出季，原地不动')

    fireEvent.click(line)
    expect(screen.getByText('没时长.mp3')).toBeTruthy()
    expect(screen.getByText('a.mkv')).toBeTruthy()
    expect(screen.getByText(/给文件夹起个带季号的名字/)).toBeTruthy()
    // 「探时长」那一行不该被季组的 reason 污染
    expect((screen.getByText('没时长.mp3').closest('[data-slot="item"]') as HTMLElement).textContent)
      .not.toContain('给文件夹起个带季号的名字')
  })

  /**
   * 等位有主时**一行状态都不留**：它整个变成了腾位那条动作的后果（↳），
   * 「处理中」那一行连出现都不该出现——它一出现就等于又立了一块"还有别的事在进行中"。
   */
  it('等位有主（占位者本轮会被删）→ 状态行整个不出现，因果挂在那条动作上', async () => {
    const OCC = '/quark/付费/20.占位.mp3'
    mount({
      shelves: { claimed: '/quark/付费', secondary: '/quark/下架' }, sourceDirs: ['/quark/来源'],
      plan: [
        { kind: 'delete-redundant', key: 'kd', origin: 'file', basis: 'redundant-free:L020', episode: '020.某一集',
          src: { path: OCC, name: '20.占位.mp3', size: 1_000_000, durationS: 1000 } },
        { kind: 'pending', key: 'h1', pendingKind: 'swap-hold', blockedBy: OCC, reason: '目标目录已有同名文件…',
          src: { path: '/quark/来源/20.占位.mp3', name: '20.占位.mp3', size: 900_000, durationS: 1001 } },
      ],
      counts: { ...counts, pending: 1 },
    })

    await waitFor(() => expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /处理中/ })).toBeNull()
    // 因果现在长在**文件行自己身上**：要落位的那一份走同一套 ✓ + 路径 + 元数据，时序是它行尾
    // 那枚徽章。**不再是卡片底下挂的一句散文、也不再是夹在两行中间的一条桥**——那两种都逃出了
    // 整张卡的语言，还把两份文件的时长掰开（活体 2026-08-03 用户原话：「这个叙述 and UI ... 太挫了」）。
    const incoming = document.querySelector('[data-tone="incoming"]')!.closest('[data-slot="item"]')!
    expect(incoming.querySelector('[data-testid="slot-phase"]')!.textContent).toBe('下轮落位')
    // 换手的两端各带一段轨（走的那份红、来的那份天蓝）——同一个位置上的前任与后任。
    expect(incoming.getAttribute('data-swap')).toBe('in')
    expect(document.querySelectorAll('[data-swap="out"]')).toHaveLength(1)
    expect(incoming.textContent).toContain('/quark/来源/20.占位.mp3')
    // 时长必须在这一行上：它和上面那份的时长同处一列，差多少一眼比得出来。
    expect(incoming.textContent).toContain('16:41')
  })

  // 「没有要你动手的」不是「没有要处理的」：同屏下面正摆着一行「处理中 3」，说"没有要处理的"
  // 字面上和它打架。这句话要说的本来就是"没有需要你出手的那部分"。
  it('摘要每段为 0 就整段省略——只有状态行时说「没有要你动手的」', async () => {
    mount(statusOnly)
    await screen.findByRole('button', { name: /处理中/ })
    expect(screen.getByTestId('reconcile-summary').textContent).toBe('没有要你动手的')
  })

  it('只有「要你决定」时：不报可省、不报可自动完成，只留那一段', async () => {
    mount({
      plan: [{
        kind: 'pending', key: 'k七杀', pendingKind: 'replace', reason: '两份都对得上…',
        src: { path: '/quark/来源/20.七杀.mp3', name: '20.七杀.mp3', size: 38289594, durationS: 2390 },
        compare: { authorityDurationS: 2389, candidates: [
          { path: '/quark/付费/20.七杀.mp3', size: 249928105, durationS: 6247, inLib: true },
          { path: '/quark/来源/20.七杀.mp3', size: 38289594, durationS: 2390, inLib: false },
        ] },
      }],
      counts: { ...counts, pending: 1 },
    })

    // 库内那份和来源那份同名（这一组要裁的正是这种），所以按卡数等，不按文件名出现几次。
    await waitFor(() => expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1))
    expect(screen.getByTestId('reconcile-summary').textContent).toBe('1 项要你定')
    // 怎么看的那句提示进内容区，不再挂在标题尾巴上把计数徽标淹掉。
    expect(screen.getByText(/要你决定/).textContent).toBe('要你决定 1')
    expect(screen.getByText(/裁决在对话里进行/)).toBeTruthy()
  })
})


/**
 * **等位（`swap-hold`）不再独占一块**——信息收进「可以自动完成」和「要你决定」这两个一等公民里。
 *
 * 为什么撤：那一块和第一块之间的因果**只存在于代码里**。活体（怡楽 2026-08-03）第一块里
 * 4 条删除执行完，第三块那 3 条就自动落位了，界面上一个字没提这层关系——用户（本人是开发者）
 * 得读很久才弄明白 `20.七杀.mp3` 占的正是《20.七杀》的槽位。
 *
 * 收进哪儿由**占位者在不在本轮计划里**决定：
 *  · 在 → 挂到腾位的那条动作上（「执行后 X 随即搬入」），它本来就是那条动作的后果。
 *  · 不在 → 它是真的卡住了（位置被一个本轮不动的文件占着），**必须进「要你决定」**——
 *    撤掉的是那一块的位置，不是撤掉这个信息。静默丢掉就是让文件永远落不了位且没人知道。
 */
describe('ReconcilePanel — 等位收进「可以自动完成」与「要你决定」', () => {
  const show: ReconcileShowConfig = {
    id: 'yile', label: '怡楽播客', bindingId: 'bind1', sourceDirs: ['/quark/来源'],
    shelves: { claimed: '/quark/付费', secondary: '/quark/下架' }, subShows: [], autoExecute: false,
  }
  const binding: MappingSet = {
    id: 'bind1', left: { kind: 'playlist', streamId: 'stream-yile', title: '怡乐播客' },
    right: { kind: 'alist-dir', path: '/quark/付费', boundAt: '2026-07-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
  }
  const counts = { move: 0, deleteDup: 0, deleteLoser: 0, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0 }

  function mount(preview: ReconcilePreview) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/config')) return ok({ shows: [show] })
      if (u.includes('/api/netdisk/mappings')) return ok([binding])
      if (u.includes('/preview')) return ok(preview)
      if (u.includes('/api/streams')) return ok([])
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })
    render(<ReconcilePanel open onOpenChange={() => {}} streamId="stream-yile" />)
  }

  const OCCUPANT = '/quark/付费/玄关笔记/20.七杀.mp3'
  const WAITER = '/quark/来源/玄关笔记/20.七杀.mp3'
  /** 活体那一对：库内那份本轮判删（免费集副本），来源那份等着它腾位。 */
  const linked: ReconcilePreview = {
    shelves: { claimed: '/quark/付费', secondary: '/quark/下架' }, sourceDirs: ['/quark/来源'],
    plan: [
      { kind: 'delete-redundant', key: 'k020', origin: 'file', basis: 'redundant-free-candidates:L020',
        candidateEpisodes: ['020.再谈身边灵异事'],
        src: { path: OCCUPANT, name: '20.七杀.mp3', size: 12_000_000, durationS: 2389 } },
      { kind: 'pending', key: 'k七杀', pendingKind: 'swap-hold', blockedBy: OCCUPANT,
        reason: '目标目录 /quark/付费/玄关笔记 已有同名文件——本轮不搬…',
        src: { path: WAITER, name: '20.七杀.mp3', size: 11_000_000, durationS: 2390 } },
    ],
    counts: { ...counts, deleteDup: 0, pending: 1 },
  }

  it('占位者就在本轮计划里 → 因果挂到那条动作上，「等下一轮自然落位」整块不再存在', async () => {
    mount(linked)

    // 腾位的那条动作自己把后果说出来：读完这张卡就知道"删掉它之后会发生什么"。
    const card = await waitFor(() => {
      const c = [...document.querySelectorAll('[data-slot="card"]')][0] as HTMLElement
      expect(c).toBeTruthy()
      return c
    })
    // 换手的两行：要落位的那一份走和被删那份**同一套**渲染（✓ + 完整路径 + 库内/来源 · 时长 ·
    // 体量 · 码率），时序是它行尾那枚徽章。两行紧邻，于是两个时长同处一列上下相邻，
    // 「谁才是这一集」不用一个字去说——中间夹一条桥恰恰会把这两个数字掰开。
    const incoming = card.querySelector('[data-tone="incoming"]')!.closest('[data-slot="item"]')!
    expect(incoming.querySelector('[data-testid="slot-phase"]')!.textContent).toBe('下轮落位')
    expect(incoming.textContent).toContain('/quark/来源/玄关笔记') // 它现在在哪儿——不然"哪一份"说不清
    expect(incoming.textContent).toContain('39:50')               // 和上面那份的时长同列可比

    // 独立那一块整个没了：标题、解释句、连「处理中」那一行都不该出现（本例没有别的状态行）。
    expect(screen.queryByText(/等下一轮自然落位/)).toBeNull()
    expect(screen.queryByText(/腾空后，这些文件下一轮自动搬入/)).toBeNull()
    expect(screen.queryByRole('button', { name: /处理中/ })).toBeNull()
    // 也没有被顺手塞进「要你决定」——它有主，不是问句。
    expect(screen.queryByText(/要你决定/)).toBeNull()
  })

  it('同一份文件同时挡着几条等位 → 每一条都说得出，一条不丢', async () => {
    mount({
      ...linked,
      plan: [
        linked.plan[0],
        linked.plan[1],
        { kind: 'pending', key: 'k七杀b', pendingKind: 'swap-hold', blockedBy: OCCUPANT,
          reason: '目标货架已有同集文件（20.七杀.mp3）——默认不重复（步 4）…',
          src: { path: '/quark/来源B/20.七杀【耗时整理】.mp3', name: '20.七杀【耗时整理】.mp3', size: 9_000_000, durationS: 2391 } },
      ],
      counts: { ...counts, pending: 2 },
    })

    // 两条等位各占一行——合成一行就得挑一个说，而被略掉的那份恰恰也在等这一下。
    const card = await waitFor(() => {
      const c = [...document.querySelectorAll('[data-slot="card"]')][0] as HTMLElement
      expect(c.querySelectorAll('[data-tone="incoming"]')).toHaveLength(2)
      return c
    })
    expect(card.textContent).toContain('/quark/来源/玄关笔记/20.七杀.mp3')
    expect(card.textContent).toContain('/quark/来源B/20.七杀【耗时整理】.mp3')
    // 徽章跟着行走：两份都在等同一个位置，两份都得说得出自己是下一轮才落位。
    expect(card.querySelectorAll('[data-testid="slot-phase"]')).toHaveLength(2)
    // 腾位的只有一份：轨的"走"那一端**恰好一段**，不是每个等位者各配一段。
    expect(card.querySelectorAll('[data-swap="out"]')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /处理中/ })).toBeNull()
  })

  it('`replace` 腾出的是 oldPath（不是 src）→ 照样对得上号', async () => {
    mount({
      ...linked,
      plan: [
        { kind: 'replace', key: 'kR', origin: 'authority', basis: 'quality-upgrade:' + OCCUPANT,
          oldPath: OCCUPANT, dstDir: '/quark/付费/玄关笔记', episode: '020.再谈身边灵异事',
          src: { path: '/quark/来源/020.再谈身边灵异事.mp3', name: '020.再谈身边灵异事.mp3', size: 20_000_000, durationS: 2389 } },
        linked.plan[1],
      ],
      counts: { ...counts, replace: 1, pending: 1 },
    })

    await waitFor(() => expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1))
    const card = document.querySelector('[data-slot="card"]') as HTMLElement
    const incoming = card.querySelector('[data-tone="incoming"]')!.closest('[data-slot="item"]')!
    expect(incoming.textContent).toContain('/quark/来源/玄关笔记/20.七杀.mp3')
  })

  /**
   * ④ 判据链的**接线**。单测已经证明 `verdictChainOf` 从判决书里推得对，但那证明不了
   * 面板真把判决书喂给了它——尤其是码率基线：它是 `buildActionRows` 的一个**可选** opts，
   * 没人生产时那条信号永远不出现，而且不报任何错。这一条就是钉住那根线。
   *
   * 数据抄活体（2026-08-03 怡楽播客）：`268.三十六年未破悬案.mp3` 名字与集号全中、时长差
   * 10 分 44 秒，且码率只有 29k——同批 150 个文件是 128k。
   */
  it('判据链接上了活体判决书：信号逐条渲染，码率反常那条也要出得来', async () => {
    const P = '/quark/付费/268.三十六年未破悬案.mp3'
    const collide: ReconcilePlanAction = {
      kind: 'pending', key: 'k268', origin: 'authority', pendingKind: 'duration-collision',
      src: { path: P, name: '268.三十六年未破悬案.mp3', size: 10_661_234, durationS: 2909 },
      episode: '268.三十六年未破悬案', collidesWith: 'item:97605fd394c56db3',
      basis: 'ambiguous:duration-contradiction:item:97605fd394c56db3',
      compare: { authorityDurationS: 3553, candidates: [{ path: P, size: 10_661_234, durationS: 2909, inLib: true }] },
      reason: '名字与「268.三十六年未破悬案」对得上，时长却差出量级——……',
    }
    mount({
      ...linked,
      plan: [collide],
      counts: { ...counts, pending: 1 },
      ledger: {
        runId: 'r1',
        rows: [
          { path: P, size: 10_661_234, durationS: 2909, verdict: 'offline', action: 'pending:duration-collision',
            basis: 'ambiguous:duration-contradiction:item:97605fd394c56db3',
            explain: {
              file: { path: P, sizeBytes: 10_661_234, durationS: 2909, kbps: 29 },
              edges: [{
                episode: { leftKey: 'item:97605fd394c56db3', title: '268.三十六年未破悬案', durationS: 3553 },
                facts: [
                  { kind: 'struct-key', key: 'epnum', value: '268' },
                  { kind: 'name', method: 'identity-exact', score: 1, cleanedLeft: '三十六年未破悬案', cleanedRight: '三十六年未破悬案', stripId: 'S0' },
                  { kind: 'duration', state: 'contradict', deltaS: 644, toleranceS: 1 },
                ],
                outcome: 'vetoed', vetoReason: 'duration-contradict', rule: 'R11',
              }],
              verdict: { rule: 'R13', disposition: 'asked' },
            } },
          // 基线要有样本才成立（< 8 行就没有基线）——同批那 128k 的大多数。
          ...Array.from({ length: 9 }, (_, i) => ({
            path: `/quark/付费/正常${i}.mp3`, size: 16_000_000, durationS: 1000, verdict: 'claimed' as const,
            basis: 'authority:L' + i, action: 'none',
            explain: {
              file: { path: `/quark/付费/正常${i}.mp3`, sizeBytes: 16_000_000, durationS: 1000, kbps: 128 },
              edges: [], verdict: { disposition: 'claimed' as const },
            },
          })),
        ],
      },
    })

    const card = await screen.findByTestId('action-chain')
    const sig = (tone: string) => [...card.querySelectorAll(`[data-tone="${tone}"]`)].map((e) => e.textContent ?? '')

    // 成立的两条与卡住的那条，各自带着实测值。
    expect(sig('ok').join('|')).toContain('268')
    expect(sig('ok').join('|')).toContain('完全一致')
    expect(sig('no').join('|')).toContain('48:29')
    expect(sig('no').join('|')).toContain('短 10 分 44 秒')
    // 码率那条**只有基线接上了才出得来**——这就是这一条测试存在的理由。
    expect(sig('warn').join('|')).toContain('29k')
    expect(sig('warn').join('|')).toContain('128k')

    // 那句散文退场：它复述的两样东西（数字、行动）界面上各有更好的位置。
    expect(card.textContent).not.toContain('时长却差出量级')
    expect(card.textContent).not.toContain('机器分不出，先不动它')
    // 解释留下，但只留解释——行动句在按钮上。
    expect(screen.getByTestId('chain-hint').textContent).toContain('可能是分享者贴错了名字')
    expect(screen.getByTestId('chain-hint').textContent).not.toContain('挪去下架')
  })

  /**
   * **不许静默丢掉**。占位者不在本轮任何动作里 = 位置被一个本轮不动的文件占着，那句
   * 「等它腾空后下一轮自然落位」当场变成假话——没人会去腾它。这种要摆到用户面前。
   */
  it('占位者不在本轮计划里 → 落进「要你决定」，说得出被谁挡着、为什么本轮动不了', async () => {
    mount({
      ...linked,
      // 本轮只有一条不相干的搬运；占位的那份谁都不动。
      plan: [
        { kind: 'move', key: 'kM', origin: 'authority', basis: 'authority:L999', dstDir: '/quark/付费',
          src: { path: '/quark/来源/999.别的集.mp3', name: '999.别的集.mp3', size: 1, durationS: 10 } },
        linked.plan[1],
      ],
      counts: { ...counts, move: 1, pending: 1 },
    })

    await waitFor(() => expect(screen.getByText(/要你决定/)).toBeTruthy())
    expect(screen.getByText(/要你决定/).textContent).toContain('1')
    expect(screen.getByTestId('reconcile-summary').textContent).toContain('1 项要你定')

    // 卡片上挡路的那份**要有完整路径**：用户下一步得自己去处理它，名字不够。
    const card = [...document.querySelectorAll('[data-slot="card"]')]
      .find((c) => c.textContent?.includes('20.七杀.mp3')) as HTMLElement
    expect(card).toBeTruthy()
    expect(card.textContent).toContain(OCCUPANT)
    // 为什么本轮动不了——那句「下一轮自然落位」在这里是假话，不许照搬。
    expect(card.textContent).toContain('本轮计划里没有任何一条动作会挪走它')
    expect(card.textContent).not.toContain('下一轮自然落位')

    // 独立那一块照旧不存在（信息换了位置，不是换了个地方原样再摆一遍）。
    expect(screen.queryByText(/等下一轮自然落位/)).toBeNull()
    expect(screen.queryByRole('button', { name: /处理中/ })).toBeNull()
  })

  /**
   * 卡住的那张卡，**主角是等着的那份文件**——标题就得是它的文件名。退化成作品名（「怡楽播客」）
   * 时，一屏几张卡顶着同一个标题，用户得逐张往下读文件行才知道哪张说的是哪一份。
   * 这一档没有集名可用：等位是"搬不进去"，后端不带 `episode`，而绝不许拿文件名冒充集名——
   * 所以它走 `fileName` 那一格（等宽字体、和下面那条路径读的是同一个东西）。
   */
  it('卡住那张卡的标题 = 等着的那份文件名，不退化成作品名', async () => {
    mount({
      ...linked,
      plan: [
        { kind: 'move', key: 'kM', origin: 'authority', basis: 'authority:L999', dstDir: '/quark/付费',
          src: { path: '/quark/来源/999.别的集.mp3', name: '999.别的集.mp3', size: 1, durationS: 10 } },
        { ...linked.plan[1], origin: 'authority' },
      ],
      counts: { ...counts, move: 1, pending: 1 },
    })

    await waitFor(() => expect(screen.getByText(/要你决定/)).toBeTruthy())
    const card = [...document.querySelectorAll('[data-slot="card"]')]
      .find((c) => c.textContent?.includes('位置被占着')) as HTMLElement
    expect(card.querySelector('[data-testid="action-subject"]')?.textContent).toBe('20.七杀.mp3')
  })

  it('老后端没有 blockedBy → 同样进「要你决定」，绝不静默消失', async () => {
    mount({
      ...linked,
      plan: [{ ...linked.plan[1], blockedBy: undefined }],
      counts: { ...counts, pending: 1 },
    })

    await waitFor(() => expect(screen.getByText(/要你决定/)).toBeTruthy())
    const card = document.querySelector('[data-slot="card"]') as HTMLElement
    expect(card.textContent).toContain('20.七杀.mp3')
  })
})

/**
 * **按绑定整理（影视那一档）**：没有 show 配置，直接对着一条绑定跑同一条管线。
 *
 * 这一档是从影视作品页进来的。它存在的理由不是"再来一个入口"，而是那边原先够不着待决卡——
 * 旧的「一键去重」只出将删清单。行为守在这里（影视那边只守"菜单指向这个面板"）。
 */
describe('ReconcilePanel — 按绑定（影视）', () => {
  const dedupePreview: ReconcilePreview = {
    shelves: { claimed: '/夸克/某剧' },
    sourceDirs: [],
    plan: [{
      kind: 'delete-loser', key: 'k1', episode: '第 1 集',
      src: { path: '/夸克/某剧/S01E01.1080p.mkv', name: 'S01E01.1080p.mkv', size: 1024 ** 3 },
      keptPath: '/夸克/某剧/S01E01.2160p.mkv', basis: 'quality-loser-of:/夸克/某剧/S01E01.2160p.mkv',
    }] as unknown as ReconcilePlanAction[],
    counts: { move: 0, deleteDup: 0, deleteLoser: 1, replace: 0, pending: 0, moveClaimed: 0, moveSecondary: 0 },
  } as unknown as ReconcilePreview

  function mount(over?: { previewFails?: string }) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/api/netdisk/reconcile/bindings/map_1/preview')) {
        return over?.previewFails ? fail(400, over.previewFails) : ok(dedupePreview)
      }
      if (u.includes('/api/netdisk/reconcile/bindings/map_1/execute')) return ok({ moved: 0, deleted: 1, pending: 0, errors: [] })
      throw new Error(`unexpected fetch: ${method} ${u}`)
    })
    render(<ReconcilePanel open onOpenChange={() => {}} bindingId="map_1" streamTitle="权力的游戏" />)
  }

  // 走的必须是按绑定那条路。走成 show 那条的表现不是报错，是**什么都不发生**——这一档没有 show。
  it('预览走 bindings/:id/preview，且整个过程不去读整理配置', async () => {
    mount()
    expect((await screen.findByText(pathMatcher('/夸克/某剧/S01E01.1080p.mkv')))).toBeTruthy()
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/reconcile/config'))).toBe(false)
  })

  it('作品名进标题——不然就是对着一屏文件名猜自己在整理哪一部', async () => {
    mount()
    await screen.findByText(pathMatcher('/夸克/某剧/S01E01.1080p.mkv'))
    expect(screen.getByText('整理 · 权力的游戏')).toBeTruthy()
  })

  // 面板退只读（spec 2026-08-24-conversational-reconcile §3.2）：清单只看，执行归对话。
  it('只看清单不动网盘——面板上没有执行按钮，也从不自己调 execute', async () => {
    mount()
    await screen.findByText(pathMatcher('/夸克/某剧/S01E01.1080p.mkv'))
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/execute'))).toBe(false)
    expect(screen.queryByRole('button', { name: /执行/ })).toBeNull()
  })

  it('预览失败 → 后端原文原样呈现（那是用户该去改什么的唯一线索）', async () => {
    mount({ previewFails: '绑定没有落地目录' })
    expect(await screen.findByText(/绑定没有落地目录/)).toBeTruthy()
  })

  // 「扫全部绑定去重」会去动别的作品。从一部作品点进来的面板上摆它，是个不该有的走火口。
  it('不出「扫全部绑定去重」', async () => {
    mount()
    await screen.findByText(pathMatcher('/夸克/某剧/S01E01.1080p.mkv'))
    expect(screen.queryByRole('button', { name: /扫全部绑定去重/ })).toBeNull()
  })
})

