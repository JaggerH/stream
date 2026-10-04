import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkBinding } from './WorkBinding.tsx'
import { api, type Connection } from '../lib/api.ts'
import type { WorkBindingView } from '../lib/types.ts'
import { setAskChatSink, type AskChatOp } from '../lib/askExtract.ts'

// 目录选择器有自己的测试；这里只关心「选完之后发生什么」。
vi.mock('./netdisk/NetdiskPicker.tsx', () => ({
  NetdiskDirPickerDialog: ({ open, onPick }: { open: boolean; onPick: (p: string) => void }) =>
    open ? (
      <div data-testid="dir-picker">
        <button type="button" data-testid="dir-picker-pick" onClick={() => onPick('/picked')}>pick</button>
      </div>
    ) : null,
}))

// 匹配详情面板有自己的测试；这里只验证「匹配详情」把它以本绑定的 setId 限定打开。
vi.mock('./netdisk/NetdiskBindings.tsx', () => ({
  NetdiskBindings: ({ focusSetId }: { focusSetId?: string }) => <div data-testid="match-detail">focus:{focusSetId}</div>,
}))

const conn = { baseUrl: 'http://x' } as Connection
const ref = { id: '1399', media: 'tv' as const, title: '权力的游戏' }

// 已绑态：管理动作收进 Popover，触发按钮 aria-label 是「网盘」。先点开才看得到打开目录/换目录/刷新。
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: '网盘' }))

beforeEach(() => { vi.restoreAllMocks() })

describe('WorkBinding', () => {
  // 「还不能绑」和「没绑」是两件事。canonical 没验出 TMDb 坐标时按钮点了也没用——
  // 与其给个永远点不动的按钮，不如说清为什么。
  it('还不能绑(canonical 未验证，且无 streamId) → 说明原因，不给一个点不动的按钮', () => {
    render(<WorkBinding conn={conn} work={{ ref: null } as WorkBindingView} onChanged={() => {}} />)
    expect(screen.getByText(/未能确认/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /绑定网盘/ })).toBeNull()
  })

  // 非 TMDb 关注流（综艺）：ref 为 null、还没绑，但组件拿到了 streamId（followed 流本身就有）。
  // 后端 POST /api/netdisk/mappings 支持 {streamId, dirPath}，不能因为没 TMDb 坐标就报「还不能绑」——
  // 该给一个绑定入口，走 create({streamId})。这是本次接线要修的：详情页找不到绑定按钮、只能手搓 API。
  it('未绑 + 无 ref + 有 streamId → 给出绑定入口(不报「还不能绑」)', () => {
    render(<WorkBinding conn={conn} work={{ ref: null } as WorkBindingView} streamId="s_变形记" streamTitle="变形记" onChanged={() => {}} />)
    expect(screen.queryByText(/未能确认/)).toBeNull()
    expect(screen.getByRole('button', { name: /绑定网盘/ })).toBeTruthy()
  })

  it('未绑 + 无 ref + 有 streamId → 选完目录建 stream 绑定(带 streamId+title)，并通知刷新', async () => {
    const create = vi.spyOn(api.netdisk, 'create').mockResolvedValue({ id: 'map_new' } as never)
    const onChanged = vi.fn()
    render(<WorkBinding conn={conn} work={{ ref: null } as WorkBindingView} streamId="s_变形记" streamTitle="变形记" onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: /绑定网盘/ }))
    fireEvent.click(await screen.findByTestId('dir-picker-pick'))
    await waitFor(() => expect(create).toHaveBeenCalledWith(conn, {
      streamId: 's_变形记',
      title: '变形记',
      dirPath: '/picked',
    }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  // 优先级：有 TMDb 坐标时仍走 tmdb 新建（ref 赢 streamId），不因传了 streamId 就退化。
  it('有 ref 又有 streamId → 仍走 tmdb 新建(ref 优先)', async () => {
    const create = vi.spyOn(api.netdisk, 'create').mockResolvedValue({ id: 'map_new' } as never)
    render(<WorkBinding conn={conn} work={{ ref }} streamId="s_x" streamTitle="x" onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /绑定网盘/ }))
    fireEvent.click(await screen.findByTestId('dir-picker-pick'))
    await waitFor(() => expect(create).toHaveBeenCalledWith(conn, {
      tmdb: { id: '1399', media: 'tv', title: '权力的游戏' },
      dirPath: '/picked',
    }))
  })

  it('未绑定 → 给出绑定入口', () => {
    render(<WorkBinding conn={conn} work={{ ref }} onChanged={() => {}} />)
    expect(screen.getByRole('button', { name: /绑定网盘/ })).toBeTruthy()
  })

  // 绑定的价值全在这个数上：绑了但一集都没配上，和没绑一样不能看——匹配数就在触发按钮上，不必点开。
  it('已绑定 → 触发按钮直接显示配上几集；点开菜单能到网盘目录', async () => {
    render(
      <WorkBinding
        conn={conn}
        work={{ ref, binding: { id: 'map_1', dirPath: '/quark/From Stream/权力的游戏', total: 73, matched: 70, unaired: 0, playable: [] } }}
        onChanged={() => {}}
      />,
    )
    expect(screen.getByText(/70\s*\/\s*73/)).toBeTruthy() // 数字在触发按钮上，无需展开
    openMenu()
    // 目录名在「打开网盘目录」链接的 title/href 里，展开菜单后可见。
    expect((await screen.findByRole('link')).getAttribute('title')).toContain('From Stream/权力的游戏')
  })

  // 分母只数已播出的集：在播季「97/97」不能读成缺 4 集，未播的另起一句说；0 集未播时那句不出现。
  it('还有未播集 → 菜单里另说「另有 N 集未播」；没有就不说', async () => {
    const { unmount } = render(
      <WorkBinding conn={conn} work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 97, matched: 97, unaired: 4, playable: [] } }} onChanged={() => {}} />,
    )
    expect(screen.getByText(/97\s*\/\s*97/)).toBeTruthy()
    openMenu()
    expect(await screen.findByText(/另有 4 集未播/)).toBeTruthy()
    unmount()
    render(
      <WorkBinding conn={conn} work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 73, matched: 70, unaired: 0, playable: [] } }} onChanged={() => {}} />,
    )
    openMenu()
    await screen.findByRole('link')
    expect(screen.queryByText(/未播/)).toBeNull()
  })

  // 目录名点开直达 AList；走同源插件网关 /_p/alist（根相对，不含内部 host；后端持有该网关）。
  it('已绑目录名是链接 → 指向 AList 同源网关对应目录', async () => {
    const dir = '/quark/From Stream/权力的游戏 (2011) [tmdbid-1399]'
    render(
      <WorkBinding conn={conn} work={{ ref, binding: { id: 'map_1', dirPath: dir, total: 73, matched: 70, unaired: 0, playable: [] } }} onChanged={() => {}} />,
    )
    openMenu()
    const link = await screen.findByRole('link')
    expect(link.getAttribute('href')).toBe('http://x/_p/alist' + encodeURI(dir))
    expect(link.getAttribute('target')).toBe('_blank')
  })

  // 后端给了夸克 web URL（netdiskUrl）→ 直接跳夸克，不回落 AList。
  it('有 netdiskUrl → 目录名链接直跳网盘（夸克），不用 AList 网关', async () => {
    render(
      <WorkBinding conn={conn} work={{ ref, binding: { id: 'map_1', dirPath: '/quark/From Stream/权力的游戏 (2011) [tmdbid-1399]', total: 73, matched: 70, playable: [], netdiskUrl: 'https://pan.quark.cn/list#/list/all/abc123' } }} onChanged={() => {}} />,
    )
    openMenu()
    expect((await screen.findByRole('link')).getAttribute('href')).toBe('https://pan.quark.cn/list#/list/all/abc123')
  })

  // 坏绑定：网盘目录已被删/移（AList object-not-found），按 item 入口的转写/声纹会踩雷。
  // 后端把健康态投影进 binding.broken → 面板必须亮出来，否则用户只见功能莫名失败、无从下手。
  it('binding.broken 有值 → 亮出坏绑定告警', () => {
    render(
      <WorkBinding
        conn={conn}
        work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 6, matched: 0, playable: [], broken: { at: '2026-07-24T00:00:00.000Z', message: '[alist] code 500: failed get dir: object not found' } } }}
        onChanged={() => {}}
      />,
    )
    expect(screen.getByText(/绑定目录已失效/)).toBeTruthy()
  })

  it('无 broken → 不显示坏绑定告警', () => {
    render(
      <WorkBinding conn={conn} work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 6, matched: 6, playable: [] } }} onChanged={() => {}} />,
    )
    expect(screen.queryByText(/绑定目录已失效/)).toBeNull()
  })

  it('选完目录 → 建 tmdb 绑定(带 media)，并通知刷新', async () => {
    const create = vi.spyOn(api.netdisk, 'create').mockResolvedValue({ id: 'map_new' } as never)
    const onChanged = vi.fn()
    render(<WorkBinding conn={conn} work={{ ref }} onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: /绑定网盘/ }))
    // 目录选择器打开后，测试直接触发它的 onPick（选目录本身是 NetdiskPicker 自己的测试）
    await waitFor(() => expect(screen.getByTestId('dir-picker')).toBeTruthy())
    fireEvent.click(screen.getByTestId('dir-picker-pick'))
    await waitFor(() => expect(create).toHaveBeenCalledWith(conn, {
      tmdb: { id: '1399', media: 'tv', title: '权力的游戏' },
      dirPath: '/picked',
    }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('建绑定失败 → 说出原话，不装作成功', async () => {
    vi.spyOn(api.netdisk, 'create').mockRejectedValue(new Error('AList 不可达'))
    render(<WorkBinding conn={conn} work={{ ref }} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /绑定网盘/ }))
    fireEvent.click(await screen.findByTestId('dir-picker-pick'))
    expect(await screen.findByText(/AList 不可达/)).toBeTruthy()
  })

  // 综艺（非 TMDb 关注流）：ref 为 null，但用户已按 streamId 绑了目录。绝不能因为没坐标就报「还不能绑」——
  // 已绑就该显示绑定信息（配上几集、绑在哪）。这是本次要修的接线。
  it('非 TMDb 关注流已绑(ref null 但 binding 有值) → 显示绑定信息，不显示「还不能绑」', async () => {
    render(
      <WorkBinding
        conn={conn}
        work={{ ref: null, binding: { id: 'map_b2eb0d', dirPath: '/quark/来自：分享/王.中.王/S03 纯享', total: 6, matched: 6, playable: [] } } as WorkBindingView}
        onChanged={() => {}}
      />,
    )
    expect(screen.getByText(/6\s*\/\s*6/)).toBeTruthy()
    expect(screen.queryByText(/未能确认/)).toBeNull() // 不是「还不能绑」
    openMenu()
    expect((await screen.findByRole('link')).getAttribute('title')).toContain('S03 纯享') // 目录名在链接 title 里
  })

  // 已绑 → 换目录走 rebind(按 binding.id，旧目录进 rightHistory)，不是再 create 一个。对综艺同样成立。
  it('已绑 → 菜单里换目录调 rebind(id)，不新建', async () => {
    const rebind = vi.spyOn(api.netdisk, 'rebind').mockResolvedValue({ id: 'map_b2eb0d' } as never)
    const create = vi.spyOn(api.netdisk, 'create').mockResolvedValue({ id: 'x' } as never)
    const onChanged = vi.fn()
    render(
      <WorkBinding
        conn={conn}
        work={{ ref: null, binding: { id: 'map_b2eb0d', dirPath: '/quark/x', total: 6, matched: 6, playable: [] } } as WorkBindingView}
        onChanged={onChanged}
      />,
    )
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /换目录/ }))
    fireEvent.click(await screen.findByTestId('dir-picker-pick'))
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(conn, 'map_b2eb0d', '/picked'))
    expect(create).not.toHaveBeenCalled()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  // 刷新匹配 = 立即重新同步该绑定（重列目录、重配），跑完通知详情刷新。
  it('已绑 → 菜单里刷新匹配调 sync(id)，跑完通知刷新', async () => {
    const sync = vi.spyOn(api.netdisk, 'sync').mockResolvedValue({ entries: [{ rightFile: 'a', status: 'auto' }] } as never)
    const onChanged = vi.fn()
    render(
      <WorkBinding
        conn={conn}
        work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 73, matched: 70, unaired: 0, playable: [] } }}
        onChanged={onChanged}
      />,
    )
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /刷新匹配/ }))
    await waitFor(() => expect(sync).toHaveBeenCalledWith(conn, 'map_1'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  /**
   * 去重不再是菜单里单开的一项——它连同逐集对照、待决卡、AI 帮听一起进了网盘面板（影视与播客
   * 同一个 `NetdiskPanel`，只是这一档锁定到一条绑定）。菜单里再摆一个「一键去重」等于同一件事
   * 两个入口，而且那个入口给不了待决卡和 AI 那两样。
   * 按绑定跑整理的行为（先 preview、确认后才 execute、报错原文）由 ReconcilePanel 的测试守。
   */
  it('已绑 → 菜单里没有「一键去重」，整理收进了网盘面板', async () => {
    render(
      <WorkBinding
        conn={conn}
        work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 73, matched: 70, unaired: 0, playable: [] } }}
        onChanged={() => {}}
      />,
    )
    openMenu()
    expect(screen.queryByRole('button', { name: /一键去重/ })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /匹配详情/ }))
    expect(await screen.findByText('整理这个目录')).toBeTruthy()
    expect(screen.getByRole('button', { name: /打开整理/ })).toBeTruthy()
  })


  // 删网盘目录：不可逆，所以菜单项只开确认框，人再点一次才真删。
  const renderBound = (onChanged = vi.fn()) => {
    render(
      <WorkBinding
        conn={conn}
        work={{ ref, binding: { id: 'map_1', dirPath: '/quark/From Stream/tv-1399', total: 73, matched: 70, unaired: 0, playable: [] } }}
        onChanged={onChanged}
      />,
    )
    return onChanged
  }

  it('已绑 → 「删除网盘文件」只开确认框，光点它不删任何东西', async () => {
    const removeWithFiles = vi.spyOn(api.netdisk, 'removeWithFiles').mockResolvedValue({ ok: true } as never)
    renderBound()
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /删除网盘文件/ }))
    // 确认框把**真正会消失的那个目录**摆出来——只说「删这部作品的文件」等于让人蒙着眼点。
    expect(await screen.findByText(/\/quark\/From Stream\/tv-1399/)).toBeTruthy()
    expect(removeWithFiles).not.toHaveBeenCalled()
  })

  it('确认后 → 调 removeWithFiles(id) 并通知刷新', async () => {
    const removeWithFiles = vi.spyOn(api.netdisk, 'removeWithFiles').mockResolvedValue({ ok: true, filesDeleted: true } as never)
    const onChanged = renderBound()
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /删除网盘文件/ }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    await waitFor(() => expect(removeWithFiles).toHaveBeenCalledWith(conn, 'map_1'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('取消 → 什么都不发生', async () => {
    const removeWithFiles = vi.spyOn(api.netdisk, 'removeWithFiles').mockResolvedValue({ ok: true } as never)
    renderBound()
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /删除网盘文件/ }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText(/\/quark\/From Stream\/tv-1399/)).toBeNull())
    expect(removeWithFiles).not.toHaveBeenCalled()
  })

  // 后端删文件失败时不会解绑（文件还在盘上）——前端也就不能通知刷新去掉它，否则界面比事实先一步。
  it('删除失败 → 不通知刷新', async () => {
    vi.spyOn(api.netdisk, 'removeWithFiles').mockRejectedValue(new Error('alist down'))
    const onChanged = renderBound()
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /删除网盘文件/ }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    await waitFor(() => expect(api.netdisk.removeWithFiles).toHaveBeenCalled())
    expect(onChanged).not.toHaveBeenCalled()
  })

  // 匹配详情 → 打开限定到本绑定 setId 的面板（逐集对照 + 逐集订正都在里面）。
  it('已绑 → 菜单里「匹配详情」打开限定本绑定的面板', async () => {
    render(
      <WorkBinding
        conn={conn}
        work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 73, matched: 70, unaired: 0, playable: [] } }}
        onChanged={() => {}}
      />,
    )
    openMenu()
    fireEvent.click(await screen.findByRole('button', { name: /匹配详情/ }))
    expect((await screen.findByTestId('match-detail')).textContent).toContain('focus:map_1')
  })

  /**
   * 「AI 匹配」——程序配不上时用户唯一的出路。过去这条路只能靠用户自己打开工作台、把片名和
   * setId 手打一遍（活体 2026-09-02 就是这么发生的）。
   */
  describe('AI 匹配', () => {
    const ops: AskChatOp[] = []
    beforeEach(() => { ops.length = 0; setAskChatSink((op) => { ops.push(op) }) })

    it('已绑 → 菜单里「AI 匹配」把带 setId 的任务发进对话', async () => {
      render(
        <WorkBinding
          conn={conn}
          work={{ ref, binding: { id: 'map_1', dirPath: '/quark/x', total: 73, matched: 0, playable: [] } }}
          onChanged={() => {}}
        />,
      )
      openMenu()
      fireEvent.click(await screen.findByRole('button', { name: /AI 匹配/ }))
      await waitFor(() => expect(ops).toHaveLength(1))
      expect(ops[0].kind).toBe('send') // 是任务不是引用
      const text = (ops[0] as { text: string }).text
      expect(text).toContain('map_1')
      expect(text).toContain('权力的游戏')
    })

    // 综艺那一支 `ref` 恒为 null。光给一个 setId，人在对话里读不出这是哪一部。
    it('没有 TMDb 坐标时用关注流的名字，不发一句只有 setId 的话', async () => {
      render(
        <WorkBinding
          conn={conn}
          work={{ ref: null, binding: { id: 'map_2', dirPath: '/quark/x', total: 6, matched: 0, playable: [] } } as WorkBindingView}
          streamId="s_变形记"
          streamTitle="变形记"
          onChanged={() => {}}
        />,
      )
      openMenu()
      fireEvent.click(await screen.findByRole('button', { name: /AI 匹配/ }))
      await waitFor(() => expect(ops).toHaveLength(1))
      expect((ops[0] as { text: string }).text).toContain('变形记')
    })
  })
})
