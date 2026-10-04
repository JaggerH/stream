import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NetdiskBindings } from './NetdiskBindings.tsx'
import type { MappingSet } from '../../lib/types.ts'

const fetchMock = vi.hoisted(() => vi.fn())

const set: MappingSet = {
  id: 'map_1',
  left: { kind: 'playlist', streamId: 's1', title: '三体广播剧' },
  right: { kind: 'alist-dir', path: '/夸克/三体', boundAt: '2026-07-07T00:00:00Z' },
  rightHistory: [],
  autoSync: true,
  lastSyncAt: '2026-07-07T01:00:00Z',
  entries: [
    { leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: '01.m4a', status: 'auto', confidence: 1 },
    { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: null, status: 'unmatched' },
  ],
}

/** Route fetch by URL: alist status, list, streams, fs, and the PATCH/POST mutations all return canned data. */
function routeFetch(url: string, init?: RequestInit) {
  const u = String(url)
  if (u.includes('/api/streams')) return Promise.resolve({ ok: true, json: async () => [] })
  if (u.includes('/api/netdisk/fs')) return Promise.resolve({ ok: true, json: async () => ({ path: '/夸克/三体', files: [{ name: '剧集', size: 0, isDir: true }, { name: '01.m4a', size: 10, isDir: false }] }) })
  if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
    return Promise.resolve({ ok: true, json: async () => [set] })
  }
  return Promise.resolve({ ok: true, json: async () => set })
}

describe('NetdiskBindings', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => routeFetch(url, init))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('renders the binding list and comparison table', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByLabelText('绑定 三体广播剧')).toBeTruthy())
    expect(screen.getByText('第1集 科学边界')).toBeTruthy()
    expect(screen.getByText('第2集 台球')).toBeTruthy()
  })

  it('scopes the list to the given streamId', async () => {
    render(<NetdiskBindings streamId="other" />)
    await waitFor(() => expect(screen.getByText('该订阅还没有网盘绑定。')).toBeTruthy())
    expect(screen.queryByLabelText('绑定 三体广播剧')).toBeNull()
  })

  // 影视二级页「匹配详情」用：按 setId 限定到单个绑定（够得着无 streamId 的 tmdb 绑定）→ 收起左侧
  // 列表，直接铺该绑定的单绑定详情（逐集对照表在里面）。
  it('focusSetId → 隐藏列表，直接铺该绑定的单绑定详情', async () => {
    render(<NetdiskBindings focusSetId="map_1" />)
    await waitFor(() => expect(screen.getByText('已绑定：三体广播剧')).toBeTruthy())
    expect(screen.getByText('第1集 科学边界')).toBeTruthy() // 逐集对照表在
    expect(screen.queryByLabelText('绑定 三体广播剧')).toBeNull() // 左侧列表按钮不在（aside 收起）
  })

  it('the netdisk-file column is copyable text, not a select', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByLabelText('复制文件名 01.m4a')).toBeTruthy())
    // the old change-binding <select> is gone; unmatched rows read 未配对
    expect(screen.queryByLabelText('换绑 第1集 科学边界')).toBeNull()
    expect(screen.getAllByText('未配对').length).toBeGreaterThan(0)
  })

  it('edit opens the file picker; picking a file PATCHes rightFile (backend stamps confirmed + corrected)', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByLabelText('编辑 第2集 台球')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('编辑 第2集 台球'))
    const opt = await screen.findByRole('option', { name: '01.m4a' })
    fireEvent.click(opt)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_1/entries/netease%3A456',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rightFile: '01.m4a' }) }),
      )
    })
  })

  it('只看未匹配 filters the table to entries without a netdisk file', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByText('第1集 科学边界')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: '只看未匹配' }))
    expect(screen.queryByText('第1集 科学边界')).toBeNull() // matched → hidden
    expect(screen.getByText('第2集 台球')).toBeTruthy()      // unmatched → shown
  })

  it('a corrected entry shows the 人工 badge (no confirm/reject buttons anywhere)', async () => {
    const corrected: MappingSet = {
      ...set,
      entries: [{ leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: '01.m4a', status: 'confirmed', corrected: { at: '2026-07-09T00:00:00Z', autoFile: 'x.m4a' } }],
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => [corrected] })
      }
      return routeFetch(url, init)
    })
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByText('人工')).toBeTruthy())
    expect(screen.queryByLabelText(/^确认/)).toBeNull()
    expect(screen.queryByLabelText(/^拒绝/)).toBeNull()
  })

  it('sync button POSTs to the sync endpoint', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /立即同步/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /立即同步/ }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_1/sync',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('renders 文件利用 coverage and expands 未用 on demand (源完整度 line dropped)', async () => {
    const withCoverage: MappingSet = {
      ...set,
      coverage: {
        left: { total: 462, matched: 143, ambiguous: 41, missing: 278 },
        right: { total: 389, matched: 143, orphan: 205 },
        missingEpisodes: [66, 67, 68],
        orphanFiles: ['随手一条.mp3', '花絮合集.mp3'],
      },
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => [withCoverage] })
      }
      return routeFetch(url, init)
    })
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByText(/文件利用/)).toBeTruthy())
    expect(screen.getByText(/未用 205/)).toBeTruthy()
    // 源完整度 line + 缺档 expander are gone (replaced by the in-table 只看未匹配 filter)
    expect(screen.queryByText(/源完整度/)).toBeNull()
    expect(screen.queryByRole('button', { name: '看缺档' })).toBeNull()

    // 未用 list reveals orphan filenames
    fireEvent.click(screen.getByRole('button', { name: '看未用' }))
    expect(screen.getByText('随手一条.mp3')).toBeTruthy()
    expect(screen.getByText('花絮合集.mp3')).toBeTruthy()
  })

  it('directory browser navigates the fs tree and picks a directory into the new binding', async () => {
    render(<NetdiskBindings streamId="other" />)
    // open the browser next to the new-binding dir input
    const browseBtn = await screen.findByLabelText('浏览网盘目录')
    fireEvent.click(browseBtn)
    // descend into the directory entry (files are non-clickable)
    const dir = await screen.findByRole('option', { name: '剧集' })
    fireEvent.click(dir)
    // commit the current path, then create the binding with it
    fireEvent.click(screen.getByRole('button', { name: '选定此目录' }))
    fireEvent.click(screen.getByRole('button', { name: /建绑定并同步/ }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('/剧集') }),
      )
    })
  })

  it('directory browser navigates and rebinds an existing binding', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /重新绑定目录/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /重新绑定目录/ }))

    // Should open the NetdiskDirPickerDialog
    const dir = await screen.findByRole('option', { name: '剧集' })
    fireEvent.click(dir)
    fireEvent.click(screen.getByRole('button', { name: '选定此目录' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_1/rebind',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ dirPath: '/夸克/三体/剧集' }) }),
      )
    })
  })

  // 「清除配对」以前只在文件选择器脚上（要先开弹窗、等一次递归列举才点得到）。通用选择器
  // 不接这个领域动作，它挪到了行上——这条盯住它没有在搬家途中丢掉。
  it('清除配对 button on a matched row PATCHes rightFile:null without opening the picker', async () => {
    render(<NetdiskBindings />)
    await waitFor(() => expect(screen.getByLabelText('清除配对 第1集 科学边界')).toBeTruthy())
    // 未配对的行没有可清的东西 → 不给按钮
    expect(screen.queryByLabelText('清除配对 第2集 台球')).toBeNull()

    fireEvent.click(screen.getByLabelText('清除配对 第1集 科学边界'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_1/entries/netease%3A123',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rightFile: null }) }),
      )
    })
  })

  // 多绑定视图：一条清单条目可能配在任意一个绑定目录下。订正弹窗要从它当前所在的那个目录
  // 开始浏览，选中的文件也要写回那个绑定——通用选择器只回一个相对文件名，「属于哪个绑定」
  // 由这一层决定，这条盯住它决定对了。
  it('多绑定视图：编辑一条已配对的条目 → 从它所在的绑定目录浏览，订正也写回那个绑定', async () => {
    const setA: MappingSet = {
      ...set,
      id: 'map_1',
      right: { kind: 'alist-dir', path: '/夸克/三体A', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        { leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: '01.m4a', status: 'auto', confidence: 1 },
        { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: null, status: 'unmatched' },
      ],
    }
    const setB: MappingSet = {
      ...set,
      id: 'map_2',
      right: { kind: 'alist-dir', path: '/夸克/三体B', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        { leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: null, status: 'unmatched' },
        { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: 'B02.m4a', status: 'confirmed' },
      ],
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/streams')) return Promise.resolve({ ok: true, json: async () => [] })
      if (u.includes('/api/netdisk/fs')) {
        const path = decodeURIComponent(new URL(u, 'http://x').searchParams.get('path') ?? '')
        return Promise.resolve({ ok: true, json: async () => ({ path, files: [{ name: `${path}/命中.m4a`.split('/').pop(), size: 10, isDir: false }] }) })
      }
      if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => [setA, setB] })
      }
      return Promise.resolve({ ok: true, json: async () => setB })
    })

    render(<NetdiskBindings streamId="s1" />)
    await waitFor(() => expect(screen.getByLabelText('编辑 第2集 台球')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('编辑 第2集 台球'))

    // 弹窗从 setB 的目录开始浏览（这条条目配在那儿），不是列表里的第一个绑定。
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`path=${encodeURIComponent('/夸克/三体B')}`),
        expect.anything(),
      )
    })
    fireEvent.click(await screen.findByRole('option', { name: '命中.m4a' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_2/entries/netease%3A456',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rightFile: '命中.m4a' }) }),
      )
    })
  })

  // 改绑之后的形状（2026-08-06 活体撞出来的）：把一条已配在 A 的条目改绑到 B，**两边都会被
  // 标成人工订正过**——A 是「被清空」（rightFile: null + corrected.autoFile 记着原来自动配的
  // 那个），B 是「收到文件」。只按 corrected 打分就分不出胜负，同分时按绑定顺序取第一个 =
  // 取到被清空的 A，于是**改绑成功了、界面却显示「未配对」**，而且 setId 指向空的那个绑定，
  // 下次点「编辑」又会去浏览 A。判据：谁手里真的有文件，谁才是 best。
  it('多绑定视图：一边被清空、另一边收到文件（都标了人工订正）→ 取有文件的那个', async () => {
    const setA: MappingSet = {
      ...set,
      id: 'map_1',
      right: { kind: 'alist-dir', path: '/夸克/三体A', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        {
          leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: null, status: 'unmatched',
          corrected: { at: '2026-08-06T03:37:16.654Z', autoFile: 'A01.m4a' },
        },
      ],
    }
    const setB: MappingSet = {
      ...set,
      id: 'map_2',
      right: { kind: 'alist-dir', path: '/夸克/三体B', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        {
          leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: 'B01.m4a', status: 'confirmed',
          corrected: { at: '2026-08-06T03:37:16.656Z', autoFile: null },
        },
      ],
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/streams')) return Promise.resolve({ ok: true, json: async () => [] })
      if (u.includes('/api/netdisk/fs')) {
        const path = decodeURIComponent(new URL(u, 'http://x').searchParams.get('path') ?? '')
        return Promise.resolve({ ok: true, json: async () => ({ path, files: [{ name: '命中.m4a', size: 10, isDir: false }] }) })
      }
      if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => [setA, setB] })
      }
      return Promise.resolve({ ok: true, json: async () => setB })
    })

    render(<NetdiskBindings streamId="s1" />)
    // 表里显示的是 B 手里那个文件，不是「未配对」。
    await waitFor(() => expect(screen.getByText('B01.m4a')).toBeTruthy())

    // setId 也得跟着走：点「编辑」从 B 的目录开始浏览，而不是被清空的 A。
    fireEvent.click(screen.getByLabelText('编辑 第1集 科学边界'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`path=${encodeURIComponent('/夸克/三体B')}`),
        expect.anything(),
      )
    })
  })

  // M3（突变检验）：多绑定视图里「清除」按钮必须清掉这条清单条目真正配上的那个绑定
  // （mergedEntries 里 best 匹配所在的 setId），不是恰好排在列表第一位的绑定。这条
  // 装配只有多绑定视图（streamId 分支）走得到——单绑定分支（<NetdiskBindings />
  // 不传 streamId）里 setId 恒等于 selected.id，测不出「挑错绑定」这种错法。
  it('多绑定视图：清除按钮清的是这条条目真正配上的那个绑定，不是列表里排第一的那个', async () => {
    const setA: MappingSet = {
      ...set,
      id: 'map_1',
      right: { kind: 'alist-dir', path: '/夸克/三体A', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: null, status: 'unmatched' },
      ],
    }
    const setB: MappingSet = {
      ...set,
      id: 'map_2',
      right: { kind: 'alist-dir', path: '/夸克/三体B', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: 'B02.m4a', status: 'confirmed' },
      ],
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/streams')) return Promise.resolve({ ok: true, json: async () => [] })
      if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => [setA, setB] })
      }
      return Promise.resolve({ ok: true, json: async () => setB })
    })

    render(<NetdiskBindings streamId="s1" />)
    await waitFor(() => expect(screen.getByLabelText('清除配对 第2集 台球')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('清除配对 第2集 台球'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_2/entries/netease%3A456',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rightFile: null }) }),
      )
    })
    // 绝不能把这条条目当成了 setA(map_1)——那是列表里排第一个，但压根没配上这条。
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/netdisk/mappings/map_1/entries/netease%3A456',
      expect.anything(),
    )
  })

  // Important 2：点「编辑」以前每次都无声把浏览目录钉回条目自己所在的绑定，用户在
  // 表头下拉里选的另一个目录会被覆盖——已配对的条目要改绑到另一个目录，得先清除、
  // 改下拉、再重新编辑。这条测试同时验证「换了绑定目录撤掉旧配对」（onPick 里
  // prevMatch.setId !== browseDir.id 那个分支）与 current 的同源判据——两者以前都
  // 因为浏览目录总被钉回条目自己的绑定而够不着，是零覆盖的死代码。
  it('已在下拉里手动选过目录后点已配对条目的「编辑」→ 浏览用户选的目录，不被钉回条目自己的绑定；选中文件后写进新绑定、清掉旧绑定', async () => {
    const setA: MappingSet = {
      ...set,
      id: 'map_1',
      right: { kind: 'alist-dir', path: '/夸克/三体A', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        { leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: '01.m4a', status: 'auto', confidence: 1 },
        { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: null, status: 'unmatched' },
      ],
    }
    const setB: MappingSet = {
      ...set,
      id: 'map_2',
      right: { kind: 'alist-dir', path: '/夸克/三体B', boundAt: '2026-07-07T00:00:00Z' },
      entries: [
        { leftKey: 'netease:123', leftTitle: '第1集 科学边界', rightFile: null, status: 'unmatched' },
        { leftKey: 'netease:456', leftTitle: '第2集 台球', rightFile: null, status: 'unmatched' },
      ],
    }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/streams')) return Promise.resolve({ ok: true, json: async () => [] })
      if (u.includes('/api/netdisk/fs')) {
        const path = decodeURIComponent(new URL(u, 'http://x').searchParams.get('path') ?? '')
        return Promise.resolve({ ok: true, json: async () => ({ path, files: [{ name: '命中.m4a', size: 10, isDir: false }] }) })
      }
      if (u.includes('/api/netdisk/mappings') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve({ ok: true, json: async () => [setA, setB] })
      }
      return Promise.resolve({ ok: true, json: async () => setB })
    })

    render(<NetdiskBindings streamId="s1" />)
    // 第1集 merge 后最佳匹配来自 setA（唯一配上的一份），排在下拉第一位。
    await waitFor(() => expect(screen.getByLabelText('编辑 第1集 科学边界')).toBeTruthy())

    // 用户在表头下拉里手动切到 setB 的目录。
    fireEvent.click(screen.getByRole('combobox', { name: '切换订正时浏览的目录' }))
    fireEvent.click(await screen.findByRole('option', { name: '/夸克/三体B' }))

    // 点「编辑」这条已配对（在 setA）的条目——浏览目录不该被钉回 setA，必须仍是用户
    // 刚选的 setB。
    fireEvent.click(screen.getByLabelText('编辑 第1集 科学边界'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`path=${encodeURIComponent('/夸克/三体B')}`),
        expect.anything(),
      )
    })

    fireEvent.click(await screen.findByRole('option', { name: '命中.m4a' }))

    // 新绑定（setB/map_2）写入选中的文件……
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_2/entries/netease%3A123',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rightFile: '命中.m4a' }) }),
      )
    })
    // ……旧绑定（setA/map_1）里那条配对被撤掉，不留一条清单条目同时挂在两个绑定上。
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/netdisk/mappings/map_1/entries/netease%3A123',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rightFile: null }) }),
      )
    })
  })
})
