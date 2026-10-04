/**
 * 导航树的「空间」那一层：分组渲染、空分组照样在、每个空间自己的折叠、以及功能区那几个写动作。
 *
 * 用例集从 `hosts/dsh/test/sidebar-spaces.test.tsx` 搬来（那棵树以前住在 DSH 壳里），数据源
 * 从"宿主推过来的一份快照"换成 `channelStore`。盯的是三处"不会报错只会静默错"的地方：
 * 1. 空的空间（建完还没往里放频道）必须画得出来——推导法（从 channels 里推分组）会让它消失，
 *    而"能先建一个空分组"正是这一层存在的理由。
 * 2. 归属指向一个还不知道的空间时，那个频道不能从导航里丢掉。
 * 3. 写完必须重拉名录——不拉就是"建成功了但导航里没有"，而且没有任何一处会报错。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NavTree } from './NavTree.tsx'
import { channelStore } from './channel-store.ts'
import { createSpaceCollapseStore } from './space-collapse-store.ts'
import { api } from '../../lib/api.ts'
import * as transport from '../../lib/transport.ts'
import type { ChannelView, SpaceView } from '../../lib/types.ts'

const COLLAPSE_KEY = 'stream.test.nav.spaces'

function channel(id: string, label: string, spaceId: string, present: ChannelView['present'] = 'timeline'): ChannelView {
  return { id, label, present, system: false, kind: 'timeline', streams: [], space_id: spaceId } as ChannelView
}

function space(id: string, label: string, position: number): SpaceView {
  return { id, label, position }
}

const GROUPED = {
  spaces: [space('default-space', 'Default', 1), space('space-研究', '研究', 2)],
  channels: [channel('inbox', '收件箱', 'default-space'), channel('runs', '回测', 'space-研究')],
}

/** 名录喂进 store（两趟取数都走真实的 `api.*`，只把回执 mock 掉），然后挂一棵导航树。 */
async function mountNav(state: { spaces: SpaceView[]; channels: ChannelView[] } = GROUPED): Promise<void> {
  vi.spyOn(api, 'channels').mockResolvedValue(state.channels)
  vi.spyOn(api, 'spaces').mockResolvedValue(state.spaces)
  await act(async () => { await channelStore.load() })
  if (state.channels.length > 0) channelStore.setActive(state.channels[0]!.id)
  render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)
}

/** 某个空间那一行（整行是折叠触发器，`aria-controls` 指向它自己的列表容器）。 */
function spaceHeader(spaceId: string): HTMLElement {
  const el = document.querySelector(`[role="button"][aria-controls="stream-channel-list-${spaceId}"]`)
  if (el === null) throw new Error(`空间 ${spaceId} 的行不在 DOM 里`)
  return el as HTMLElement
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  channelStore.reset()
  vi.restoreAllMocks()
  // 有 footer 的那几档会挂通知铃 → EventsProvider → useWs → selectTransport().openSocket；
  // jsdom 的 WebSocket 不收面板那条**相对** '/ws'（真浏览器收），照 components.test.tsx 同款把
  // transport 打桩。**必须在 beforeEach 里建**：`restoreMocks` 每条用例后还原全部 spy，
  // 模块级只建一次的会在第一条跑完后消失，之后每条都去打真的 WebSocket。
  vi.spyOn(transport, 'selectTransport').mockReturnValue({
    fetch: vi.fn(),
    openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
  })
})

describe('导航按空间分组', () => {
  it('每个空间一行，频道落在自己那一组下面', async () => {
    await mountNav()
    expect(spaceHeader('default-space')).toBeTruthy()
    expect(spaceHeader('space-研究')).toBeTruthy()
    const group = document.getElementById('stream-channel-list-space-研究')
    expect(group?.textContent).toContain('回测')
    expect(group?.textContent).not.toContain('收件箱')
  })

  it('空的空间照样画出来——这一层存在的理由就是"能先建一个空分组"', async () => {
    await mountNav({
      spaces: [space('default-space', 'Default', 1), space('empty', '待归类', 2)],
      channels: [channel('inbox', '收件箱', 'default-space')],
    })
    expect(spaceHeader('empty')).toBeTruthy()
    expect(document.getElementById('stream-channel-list-empty')?.textContent).toContain('还没有频道')
  })

  it('归属指向还不知道的空间时，频道挂到第一个空间下——不从导航里消失', async () => {
    await mountNav({
      spaces: [space('default-space', 'Default', 1)],
      channels: [channel('ghosted', '孤儿', 'space-还没到货')],
    })
    expect(document.getElementById('stream-channel-list-default-space')?.textContent).toContain('孤儿')
  })

  it('空间名录还没到货时退回平铺，不画一个假的分组', async () => {
    await mountNav({ spaces: [], channels: [channel('inbox', '收件箱', 'default-space')] })
    expect(document.querySelector('[role="button"][aria-controls="stream-channel-list-default-space"]')).toBeNull()
    expect(screen.getByText('收件箱')).toBeTruthy()
  })

  it('名录和空间都还没到货时整棵不画，不占一条空骨架', () => {
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)
    expect(screen.queryByLabelText('Stream 频道')).toBeNull()
  })

  it('单个空间折起来只藏它自己的频道，别的组不动', async () => {
    await mountNav()
    fireEvent.click(spaceHeader('space-研究'))
    expect(spaceHeader('space-研究').getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById('stream-channel-list-space-研究')?.textContent).toBe('')
    expect(document.getElementById('stream-channel-list-default-space')?.textContent).toContain('收件箱')
  })

  it('折叠态存住：重新挂一棵树（= 刷新一次页面）读到的还是折起来的', async () => {
    await mountNav()
    fireEvent.click(spaceHeader('space-研究'))
    cleanup()
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)
    expect(spaceHeader('space-研究').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('点频道', () => {
  it('点一行受理的频道 → store 的当前频道跟着换，并把"点的是不是高亮那条"报给宿主', async () => {
    const picks: boolean[] = []
    vi.spyOn(api, 'channels').mockResolvedValue(GROUPED.channels)
    vi.spyOn(api, 'spaces').mockResolvedValue(GROUPED.spaces)
    await act(async () => { await channelStore.load() })
    render(<NavTree onPickChannel={(cur) => picks.push(cur)} collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)

    fireEvent.click(screen.getByText('回测'))
    expect(channelStore.getSnapshot().active).toBe('runs')
    expect(picks).toEqual([false])
    // 再点一次高亮那条：宿主收到 true（DSH 据此收栏），当前频道不动。
    fireEvent.click(screen.getByText('回测'))
    expect(picks).toEqual([false, true])
    expect(channelStore.getSnapshot().active).toBe('runs')
  })

  it('面板伺候不了的频道灰着列出来、点不动——不是悄悄不列', async () => {
    await mountNav({
      spaces: [space('default-space', 'Default', 1)],
      channels: [channel('inbox', '收件箱', 'default-space'), channel('find', '资源搜索', 'default-space', 'search')],
    })
    const row = screen.getByText('资源搜索').closest('button') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(channelStore.getSnapshot().active).not.toBe('find')
  })
})

describe('导航的写动作', () => {
  it('新建空间：POST /api/spaces，成功后重拉名录', async () => {
    await mountNav()
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 's2', label: '研究', position: 3 }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const reload = vi.spyOn(channelStore, 'load')

    fireEvent.click(screen.getByLabelText('新建'))
    fireEvent.click(screen.getByText('新建空间'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '研究' } })
    await act(async () => { fireEvent.click(screen.getByText('确定')) })

    expect(fetchMock).toHaveBeenCalledWith('/api/spaces', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ label: '研究' })
    expect(reload).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('把频道拖到另一个空间：PATCH /api/channels/:id 改 space_id，成功后重拉名录', async () => {
    await mountNav()
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'inbox' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const reload = vi.spyOn(channelStore, 'load')

    const store = new Map<string, string>()
    const dataTransfer = {
      setData: (t: string, v: string) => { store.set(t, v) },
      getData: (t: string) => store.get(t) ?? '',
      get types() { return [...store.keys()] },
      effectAllowed: '', dropEffect: '',
    }
    const row = screen.getByText('收件箱').closest('button')!
    expect(row.getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(row, { dataTransfer })
    const target = screen.getByTestId('stream-nav-group-space-研究')
    fireEvent.dragOver(target, { dataTransfer })
    expect(target.className).toContain('stream-nav-drop-target')
    await act(async () => { fireEvent.drop(target, { dataTransfer }) })

    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/channels/inbox'))!
    expect(url).toBe('/api/channels/inbox')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ space_id: 'space-研究' })
    expect(reload).toHaveBeenCalled()
    expect(target.className).not.toContain('stream-nav-drop-target')
    vi.unstubAllGlobals()
  })

  it('拖到它本来就在的空间：不发请求', async () => {
    await mountNav()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const store = new Map<string, string>()
    const dataTransfer = {
      setData: (t: string, v: string) => { store.set(t, v) }, getData: (t: string) => store.get(t) ?? '',
      get types() { return [...store.keys()] }, effectAllowed: '', dropEffect: '',
    }
    fireEvent.dragStart(screen.getByText('收件箱').closest('button')!, { dataTransfer })
    await act(async () => { fireEvent.drop(screen.getByTestId('stream-nav-group-default-space'), { dataTransfer }) })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('系统频道不能拖', async () => {
    await mountNav({
      spaces: GROUPED.spaces,
      channels: [{ ...channel('timeline', '时间线', 'default-space'), system: true }, channel('runs', '回测', 'space-研究')],
    })
    expect(screen.getByText('时间线').closest('button')!.getAttribute('draggable')).toBe('false')
    expect(screen.getByText('回测').closest('button')!.getAttribute('draggable')).toBe('true')
  })

  it('新建频道：POST /api/channels，带上这一组的空间归属', async () => {
    await mountNav()
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'c9' }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    fireEvent.click(screen.getByLabelText('在 研究 里新建频道'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '论文' } })
    await act(async () => { fireEvent.click(screen.getByText('确定')) })

    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/channels'))!
    expect(url).toBe('/api/channels')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      label: '论文', present: 'timeline', stream_ids: [], options: {}, space_id: 'space-研究',
    })
    vi.unstubAllGlobals()
  })

  // 空名字的分组在导航里就是一条看不见的空行；提交键得先拦住它（后端也拦，这是第一道）。
  it('名字是空的就提交不了', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('新建'))
    fireEvent.click(screen.getByText('新建空间'))
    expect((screen.getByText('确定') as HTMLButtonElement).disabled).toBe(true)
  })

  it('删除空间的确认文案说清"频道不会被删"——不然装着十个频道的分组前面那个删除键很吓人', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('研究 的操作'))
    fireEvent.click(screen.getByText('删除空间'))
    expect(screen.getByText(/里面的频道不会被删除，会移回默认空间/)).toBeTruthy()
  })

  it('默认空间的「删除空间」是灰的', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('Default 的操作'))
    expect((screen.getByText('删除空间') as HTMLButtonElement).disabled).toBe(true)
  })

  it('写失败说出人话，不静默——"点了没反应"和坏了长得一模一样', async () => {
    await mountNav()
    vi.stubGlobal('fetch', vi.fn(async () =>
      // 后端的错误体是 `{ error: { code, message } }`（`src/http/app.ts` 的 errorBody）。
      new Response(JSON.stringify({ error: { code: 'conflict', message: 'space id already exists' } }), { status: 409, headers: { 'content-type': 'application/json' } })))
    fireEvent.click(screen.getByLabelText('新建'))
    fireEvent.click(screen.getByText('新建空间'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '研究' } })
    await act(async () => { fireEvent.click(screen.getByText('确定')) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('space id already exists'))
    vi.unstubAllGlobals()
  })

  it('点空间行外面把行尾菜单关掉——浮层是就地渲染的，用户的手势是点别处', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('研究 的操作'))
    expect(screen.getByText('重命名')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('重命名')).toBeNull()
  })
})

// 这一组钉的是「和 DSH 工作区长一个样」里 JS 能钉住的那部分。纯 CSS 的两条（hover 换底色、
// hover 把文件夹换成箭头）在 jsdom 里没有样式表参与，钉不住，只能钉结构：两个图标槽都在
// 树里、由 CSS 决定谁显示——真出问题的形态是"某个槽根本没渲染"，那条这里拦得住。
describe('结构对齐 DSH 工作区', () => {
  it('分区标题「Stream」是标签不是折叠控件——没有 aria-expanded', async () => {
    await mountNav()
    const label = within(screen.getByLabelText('Stream 频道')).getByText('Stream')
    expect(label.closest('[aria-expanded]')).toBeNull()
    expect(label.closest('button')).toBeNull()
  })

  it('空间行同时带文件夹槽和箭头槽（谁显示交给 CSS 的 :hover）', async () => {
    await mountNav()
    const row = spaceHeader('default-space')
    expect(row.querySelector('.stream-nav-folder')).toBeTruthy()
    expect(row.querySelector('.stream-nav-chevron')).toBeTruthy()
  })

  it('频道行带 16px 前导槽——文字缩进靠它，缺了就和空间标题顶齐', async () => {
    await mountNav()
    const row = screen.getByText('收件箱').closest('.stream-nav-chan-row')
    expect(row?.querySelector('.stream-nav-slot')).toBeTruthy()
  })

  // 整行是折叠触发器，功能区的钮嵌在里面。不 stopPropagation 就是"点新建顺手把这组折起来了"。
  it('点空间行上的「新建频道」不连带折叠这一组', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('在 Default 里新建频道'))
    expect(spaceHeader('default-space').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('名称')).toBeTruthy()
  })

  it('当前频道所在的组，文件夹图标染主题色；别的组不染', async () => {
    await mountNav()
    expect(spaceHeader('default-space').querySelector('.stream-nav-folder-active')).toBeTruthy()
    expect(spaceHeader('space-研究').querySelector('.stream-nav-folder-active')).toBeNull()
  })

  it('折起来就不染——那时候图标是关着的文件夹，染色会读成"这组是打开的"', async () => {
    await mountNav()
    fireEvent.click(spaceHeader('default-space'))
    expect(spaceHeader('default-space').querySelector('.stream-nav-folder-active')).toBeNull()
  })

  // 面板不依赖任何宿主的组件库，提示就用浏览器原生那颗（DSH 那侧原来走的是它自己的气泡）。
  it('标题栏的「新建」挂原生 title', async () => {
    await mountNav()
    expect(screen.getByLabelText('新建').getAttribute('title')).toBe('新建')
  })
})

describe('样式表', () => {
  it('挂一次样式表，重复挂载不叠第二份；配色只走 --stream-nav-* token', async () => {
    await mountNav()
    cleanup()
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)
    const styles = document.querySelectorAll('#stream-nav-styles')
    expect(styles.length).toBe(1)
    const css = styles[0]!.textContent ?? ''
    expect(css).toContain('--stream-nav-label-primary')
    expect(css).not.toContain('--dsw-')
    expect(css).not.toContain('--dsh-')
  })
})

/**
 * 树底下那条**宿主动作栏**。两格都是"给了才画"：DSH 一格都不给，所以那边的 DOM 必须与
 * 没有这个能力时逐字相同——多画一条 footer 就是侧栏平白矮一截，而没有任何一处会报错。
 */
describe('宿主动作栏（footer）', () => {
  it('两格都不给 → 整条不出现', async () => {
    await mountNav()
    expect(document.querySelector('.stream-nav-footer')).toBeNull()
    expect(document.querySelector('.stream-nav-scroll')).toBeNull()
    expect(document.querySelector('.stream-nav-has-footer')).toBeNull()
  })

  it('给了 onManage：画出「管理」，按下去调它', async () => {
    const onManage = vi.fn()
    await mountNav()
    cleanup()
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} footer={{ onManage }} />)
    const btn = screen.getByRole('button', { name: '管理' })
    expect(document.querySelector('.stream-nav-footer')).toBeTruthy()
    fireEvent.click(btn)
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  // 按钮上画的是**按下去会变成什么**：此刻浅色 → 月亮 +「切换到深色」。反了的话用户每次
  // 都要先按错一次才知道方向，而截图和测试都看不出来。
  it('给了 theme：按一下调 toggle，图标与文案翻到新的目标态', async () => {
    let dark = false
    const toggle = vi.fn(() => { dark = !dark })
    await mountNav()
    cleanup()
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} footer={{ theme: { isDark: () => dark, toggle } }} />)
    fireEvent.click(screen.getByLabelText('切换到深色'))
    expect(toggle).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByLabelText('切换到浅色')).toBeTruthy())
    expect(screen.queryByLabelText('切换到深色')).toBeNull()
  })

  it('只给一格时另一格不画', async () => {
    await mountNav()
    cleanup()
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} footer={{ onManage: () => {} }} />)
    expect(screen.getByRole('button', { name: '管理' })).toBeTruthy()
    expect(screen.queryByLabelText('切换到深色')).toBeNull()
  })

  // 名录还没到货时树整个不画（一条空骨架和"导航坏了"长得一样），但 footer 是宿主的动作栏，
  // 跟取数无关——它跟着一起消失的话，独立正门的「管理」和明暗在后端没起来时就没了入口。
  it('挂着「新建 / …」菜单的那两行不许 overflow:hidden——菜单是它们里面的 absolute 浮层，裁了就是"点了没内容"', () => {
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)
    const css = document.getElementById('stream-nav-styles')?.textContent ?? ''
    for (const host of ['.stream-nav-sec-header', '.stream-nav-space-row']) {
      const rules = [...css.matchAll(new RegExp(`(?:^|[\\s,}])${host.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '')
      expect(rules.length, `${host} 的规则没找到`).toBeGreaterThan(0)
      for (const body of rules) expect(body, host).not.toMatch(/overflow\s*:\s*hidden/)
    }
  })

  it('菜单开着时点侧栏里别的地方（一条频道）也关掉——"外面"不是"导航树之外"', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('新建'))
    expect(screen.getByRole('menuitem', { name: '新建频道' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByText('收件箱'))
    expect(screen.queryByRole('menuitem', { name: '新建频道' })).toBeNull()
    // 点菜单自己不关
    fireEvent.click(screen.getByLabelText('新建'))
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: '新建空间' }))
    expect(screen.getByRole('menuitem', { name: '新建空间' })).toBeTruthy()
  })

  it('弹窗按 Esc 关掉', async () => {
    await mountNav()
    fireEvent.click(screen.getByLabelText('新建'))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建频道' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('弹窗遮罩是 fixed 铺满视口，不是关在侧栏那一列里的 absolute', () => {
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} />)
    const css = document.getElementById('stream-nav-styles')?.textContent ?? ''
    const m = css.match(/\.stream-nav-overlay\s*\{([^}]*)\}/)
    expect(m, '.stream-nav-overlay 的规则没找到').toBeTruthy()
    expect(m![1]).toMatch(/position\s*:\s*fixed/)
  })

  it('名录空着时树不画，footer 照旧在', () => {
    channelStore.reset()
    render(<NavTree collapse={createSpaceCollapseStore(COLLAPSE_KEY)} footer={{ onManage: () => {} }} />)
    expect(screen.getByRole('button', { name: '管理' })).toBeTruthy()
    expect(screen.queryByText('收件箱')).toBeNull()
  })
})
