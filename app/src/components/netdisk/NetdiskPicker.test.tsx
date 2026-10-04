import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { NetdiskDirPickerDialog, NetdiskFilePickerDialog, isWithinDir, relativeToDir } from './NetdiskPicker.tsx'
import { api } from '../../lib/api.ts'

// `@testing-library/user-event` and `@testing-library/jest-dom` are not
// project dependencies (see NetdiskDirPicker.test.tsx, which already
// establishes `fireEvent` + `.toBeTruthy()`/`.toBeNull()` as the convention
// here) — these tests were adapted from userEvent/toBeInTheDocument to that
// existing style, keeping the same interactions and assertions.
vi.mock('../../lib/api.ts', () => ({
  api: { netdisk: { listFs: vi.fn(), mkdir: vi.fn() } },
}))

const listFs = vi.mocked(api.netdisk.listFs)
const mkdir = vi.mocked(api.netdisk.mkdir)

beforeEach(() => {
  listFs.mockReset()
  mkdir.mockReset()
  listFs.mockResolvedValue({ path: '/', files: [{ name: '综艺', isDir: true, size: 0 }] })
  mkdir.mockResolvedValue({ ok: true })
})

describe('NetdiskDirPickerDialog', () => {
  it('用中文文案，不是组件的英文默认值', async () => {
    render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '选定此目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeTruthy()
    expect(screen.queryByText('Choose')).toBeNull()
  })

  it('把浏览路径接到 listFs 上', async () => {
    render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

    fireEvent.click(await screen.findByRole('option', { name: '综艺' }))
    await waitFor(() => expect(listFs).toHaveBeenCalledWith(expect.anything(), '/综艺'))
  })

  it('新建文件夹拼成绝对路径交给 mkdir', async () => {
    render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const input = screen.getByRole('textbox', { name: '新建文件夹' })
    fireEvent.change(input, { target: { value: '脱口秀' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mkdir).toHaveBeenCalledWith(expect.anything(), '/脱口秀'))
  })

  it('确认时把选定的路径回传给 onPick', async () => {
    const onPick = vi.fn()
    render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={onPick} />)

    fireEvent.click(await screen.findByRole('option', { name: '综艺' }))
    fireEvent.click(screen.getByRole('button', { name: '选定此目录' }))

    expect(onPick).toHaveBeenCalledWith('/综艺')
  })

  // 从 NetdiskDirPicker.test.tsx 抢救：initialPath 不导航直接确认。上面「把浏览路径
  // 接到 listFs 上」「确认时把选定的路径回传给 onPick」两条都先点了一次 option 再
  // 确认，从没验过 initialPath 本身是否正确透传成了初始浏览路径——如果这里退化成
  // 硬编码 '/'，这条测试会抓到，前两条不会。
  it('initialPath 不导航即可直接确认——验证它原样透传给初始浏览路径', async () => {
    listFs.mockResolvedValue({ path: '/quark', files: [{ name: '玄关笔记', isDir: true, size: 0 }] })
    const onPick = vi.fn()
    render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} initialPath="/quark" onPick={onPick} />)

    fireEvent.click(await screen.findByRole('button', { name: '选定此目录' }))

    expect(onPick).toHaveBeenCalledWith('/quark')
  })

  // Minor 5：以前只靠 DialogContent 卸载来复位浏览路径（defaultPath 只在挂载时生效
  // 一次）。关闭动画（约 200ms）没跑完就重开时 Radix Presence 会复用同一个节点、不走
  // 真正的卸载/重挂载，浏览路径会停在上次的位置，不回到 initialPath。这里用 rerender
  // 模拟「open 变了但组件实例没换」这件事本身（不依赖它是否真的卸载），断言浏览路径
  // 确实被复位，不是靠 defaultPath 侥幸生效。
  it('弹窗重开会把浏览路径复位到 initialPath，即使上次没有真正卸载', async () => {
    const { rerender } = render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

    fireEvent.click(await screen.findByRole('option', { name: '综艺' }))
    await waitFor(() => expect(listFs).toHaveBeenCalledWith(expect.anything(), '/综艺'))

    rerender(<NetdiskDirPickerDialog open={false} onOpenChange={vi.fn()} onPick={vi.fn()} />)
    rerender(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

    await waitFor(() => expect(listFs).toHaveBeenLastCalledWith(expect.anything(), '/'))
  })

  describe('跨子树搜索目录', () => {
    // 只有目录行的递归结果；name 是相对搜索根的子路径。
    const subtree = () => {
      listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; dirs?: boolean }) => {
        if (opts?.recursive) {
          return {
            path,
            files: [
              { name: '剧集', isDir: true, size: 0 },
              { name: '剧集/脱口秀', isDir: true, size: 0 },
              { name: '剧集/脱口秀/ep05.mp4', isDir: false, size: 0 },
            ],
          }
        }
        return { path, files: [{ name: '剧集', isDir: true, size: 0 }] }
      })
    }

    // 两个弹窗的搜索框长得一模一样，能搜的范围却不同——这条测的就是「目录这侧也搜子树」
    // 本身：不敲字只看得到本层的「剧集」，敲了字才看得到深层的「剧集/脱口秀」。
    it('敲字后搜整棵子树，只留目录行——文件不出现在结果里', async () => {
      subtree()
      render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

      const search = await screen.findByRole('searchbox', { name: '搜索这个目录下的全部目录…' })
      fireEvent.change(search, { target: { value: '脱口秀' } })

      expect(await screen.findByRole('option', { name: '剧集/脱口秀' })).toBeTruthy()
      // 递归结果里那份 ep05.mp4 必须被滤掉：这个弹窗选的是目录。
      expect(screen.queryByRole('option', { name: '剧集/脱口秀/ep05.mp4' })).toBeNull()
      // 打给后端的是 recursive + dirs（后者是新开关；不带它后端不回目录行）。
      expect(listFs).toHaveBeenCalledWith(
        expect.anything(),
        '/',
        expect.objectContaining({ recursive: true, dirs: true, refresh: true }),
      )
    })

    // 从根目录搜等于把整个网盘走一遍——不能一打开就发。目录弹窗的 loadDir 保持单层，
    // 递归只由敲字触发。
    it('打开弹窗本身不发递归请求——等敲第一个字符才发', async () => {
      subtree()
      render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

      await screen.findByRole('option', { name: '剧集' })
      expect(listFs.mock.calls.filter(([, , o]) => (o as { recursive?: boolean } | undefined)?.recursive)).toHaveLength(0)

      fireEvent.change(screen.getByRole('searchbox'), { target: { value: '脱' } })
      await waitFor(() => {
        expect(listFs.mock.calls.filter(([, , o]) => (o as { recursive?: boolean } | undefined)?.recursive)).toHaveLength(1)
      })
    })

    it('连续按键只打一次网络（按 path 缓存 Promise），弹窗重开让缓存失效', async () => {
      subtree()
      const { rerender } = render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)

      const search = await screen.findByRole('searchbox')
      fireEvent.change(search, { target: { value: '脱' } })
      fireEvent.change(search, { target: { value: '脱口' } })
      fireEvent.change(search, { target: { value: '脱口秀' } })
      expect(await screen.findByRole('option', { name: '剧集/脱口秀' })).toBeTruthy()

      const recursiveCalls = () => listFs.mock.calls.filter(([, , o]) => (o as { recursive?: boolean } | undefined)?.recursive)
      await waitFor(() => expect(recursiveCalls()).toHaveLength(1))

      rerender(<NetdiskDirPickerDialog open={false} onOpenChange={vi.fn()} onPick={vi.fn()} />)
      rerender(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)
      fireEvent.change(await screen.findByRole('searchbox'), { target: { value: '脱' } })
      await waitFor(() => expect(recursiveCalls()).toHaveLength(2))
    })

    // 最容易拧断的一环：命中项的 name 是相对子路径（`剧集/脱口秀`），不是单段名字。
    // 点下去必须落到 `/剧集/脱口秀`——不是 `/脱口秀`，也不是 `/剧集/剧集/脱口秀`。
    it('搜出来的深层目录点下去落到正确的绝对路径（name 是相对子路径，不是单段名字）', async () => {
      subtree()
      const onPick = vi.fn()
      render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} onPick={onPick} />)

      fireEvent.change(await screen.findByRole('searchbox'), { target: { value: '脱口秀' } })
      fireEvent.click(await screen.findByRole('option', { name: '剧集/脱口秀' }))

      // 下钻后 loadDir 按新路径单层列举。
      await waitFor(() => expect(listFs).toHaveBeenLastCalledWith(expect.anything(), '/剧集/脱口秀'))
      fireEvent.click(screen.getByRole('button', { name: '选定此目录' }))
      expect(onPick).toHaveBeenCalledWith('/剧集/脱口秀')
    })

    // 非根搜索根：拼接必须以「搜索时所在的那一层」为锚，不是永远从 '/' 拼。
    it('从非根目录搜出来的深层目录，绝对路径以当时所在层为锚', async () => {
      listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean }) => {
        if (opts?.recursive) return { path, files: [{ name: '脱口秀/第3季', isDir: true, size: 0 }] }
        return { path, files: [{ name: '剧集', isDir: true, size: 0 }] }
      })
      const onPick = vi.fn()
      render(<NetdiskDirPickerDialog open onOpenChange={vi.fn()} initialPath="/夸克" onPick={onPick} />)

      fireEvent.change(await screen.findByRole('searchbox'), { target: { value: '第3季' } })
      fireEvent.click(await screen.findByRole('option', { name: '脱口秀/第3季' }))

      await waitFor(() => expect(listFs).toHaveBeenLastCalledWith(expect.anything(), '/夸克/脱口秀/第3季'))
      fireEvent.click(screen.getByRole('button', { name: '选定此目录' }))
      expect(onPick).toHaveBeenCalledWith('/夸克/脱口秀/第3季')
    })
  })
})

describe('NetdiskFilePickerDialog', () => {
  // 一打开就递归平铺——和旧 NetdiskFilePicker 的默认视图对齐（Important 1）：后端
  // recursive 模式只回文件、不回目录行，所以 loadDir 自己就是这份平铺列表，不需要
  // 用户先下钻。
  it('一打开就递归平铺整棵子树，不需要先下钻——loadDir 直接打 recursive+refresh', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) return { path, files: [{ name: '第3季/ep05.mp4', isDir: false, size: 0 }] }
      return { path, files: [] }
    })

    render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />)

    // 嵌套在子目录里的文件一次挂载就看得到——不需要任何点击。
    expect(await screen.findByRole('option', { name: '第3季/ep05.mp4' })).toBeTruthy()
    await waitFor(() => {
      expect(listFs).toHaveBeenCalledWith(expect.anything(), '/综艺/脱口秀', expect.objectContaining({ recursive: true, refresh: true }))
    })
  })

  it('loadDir 与 searchDir 共用同一份按 path 缓存的递归结果：挂载 + 连续搜索加起来只打一次网络', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) return { path, files: [{ name: 'ep05.mp4', isDir: false, size: 0 }] }
      return { path, files: [{ name: '第3季', isDir: true, size: 0 }] }
    })

    render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />)

    const search = await screen.findByRole('searchbox', { name: '搜索这个目录下的全部文件…' })
    fireEvent.change(search, { target: { value: 'e' } })
    fireEvent.change(search, { target: { value: 'ep' } })
    fireEvent.change(search, { target: { value: 'ep0' } })

    // 搜索确实在过滤（不是把全部结果原样甩回去）：'ep0' 命中 ep05.mp4。
    expect(await screen.findByRole('option', { name: 'ep05.mp4' })).toBeTruthy()

    await waitFor(() => {
      const recursiveCalls = listFs.mock.calls.filter(([, , opts]) => (opts as { recursive?: boolean } | undefined)?.recursive)
      expect(recursiveCalls).toHaveLength(1)
      expect(recursiveCalls[0][1]).toBe('/综艺/脱口秀')
      expect((recursiveCalls[0][2] as { refresh?: boolean }).refresh).toBe(true)
    })
  })

  it('弹窗重开会让 recursive 缓存失效，重新强刷（即使 dirPath 没变）', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) return { path, files: [{ name: 'ep05.mp4', isDir: false, size: 0 }] }
      return { path, files: [] }
    })

    const { rerender } = render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />)
    await screen.findByRole('option', { name: 'ep05.mp4' })
    await waitFor(() => {
      expect(listFs.mock.calls.filter(([, , opts]) => (opts as { recursive?: boolean } | undefined)?.recursive)).toHaveLength(1)
    })

    rerender(<NetdiskFilePickerDialog open={false} onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />)
    rerender(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />)

    await waitFor(() => {
      expect(listFs.mock.calls.filter(([, , opts]) => (opts as { recursive?: boolean } | undefined)?.recursive)).toHaveLength(2)
    })
  })

  it('onPick 回相对 dirPath 的名字：递归结果里嵌套子目录的相对路径原样透传', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) return { path, files: [{ name: '第3季/ep05.mp4', isDir: false, size: 0 }] }
      return { path, files: [] }
    })

    const onPick = vi.fn()
    render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={onPick} />)

    fireEvent.click(await screen.findByRole('option', { name: '第3季/ep05.mp4' }))

    expect(onPick).toHaveBeenCalledWith('第3季/ep05.mp4')
  })

  it('dirPath 为根目录（/）时相对名剥离仍然正确', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) return { path, files: [{ name: 'ep01.mp4', isDir: false, size: 0 }] }
      return { path, files: [] }
    })

    const onPick = vi.fn()
    render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/" onPick={onPick} />)

    fireEvent.click(await screen.findByRole('option', { name: 'ep01.mp4' }))

    expect(onPick).toHaveBeenCalledWith('ep01.mp4')
  })

  // Important 3：dirPath 带尾斜杠是真实的存量输入（绑定路径来自用户手敲的输入框），
  // 不规范化会让 `${dirPath}/` 拼出双斜杠，一路影响打给后端的 path、value 高亮、
  // onCommit 剥相对名。这里在一条测试里把网络调用和回传的相对名都断言到，确认
  // 规范化在整条链路上是一致的，不是各处各算各的。
  it('dirPath 带尾斜杠：规范化后打给后端的 path 与回传的相对名都不受影响', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) return { path, files: [{ name: '第3季/ep05.mp4', isDir: false, size: 0 }] }
      return { path, files: [] }
    })

    const onPick = vi.fn()
    render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀/" onPick={onPick} />)

    await waitFor(() => {
      expect(listFs).toHaveBeenCalledWith(expect.anything(), '/综艺/脱口秀', expect.objectContaining({ recursive: true }))
    })

    fireEvent.click(await screen.findByRole('option', { name: '第3季/ep05.mp4' }))
    expect(onPick).toHaveBeenCalledWith('第3季/ep05.mp4')
  })

  // Important 1：entryTitle 必须出现在肉眼可见的标题（DialogTitle），不是 sr-only 的
  // description——否则用户从清单点开弹窗后，界面上没有任何东西说清「正在给哪一条配
  // 文件」。用 getByRole('heading', ...) 而不是 findByText：后者连 sr-only 文本也会
  // 命中，测不出「看得见 vs 只有屏幕阅读器读得到」的区别（这正是本条 review 抓到的
  // 名不副实测试）。
  it('entryTitle 给出时拼进可见标题，说清正在给哪一条配文件', async () => {
    render(
      <NetdiskFilePickerDialog
        open
        onOpenChange={vi.fn()}
        dirPath="/综艺/脱口秀"
        entryTitle="第2集 台球"
        onPick={vi.fn()}
      />,
    )
    expect(await screen.findByRole('heading', { name: '选择网盘文件 · 第2集 台球' })).toBeTruthy()
  })

  it('entryTitle 省略时标题回落成通用文案', async () => {
    render(
      <NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />,
    )
    expect(await screen.findByRole('heading', { name: '选择网盘文件' })).toBeTruthy()
  })

  it('current 给出时对应的文件行带 aria-selected', async () => {
    listFs.mockResolvedValue({
      path: '/综艺/脱口秀',
      files: [
        { name: 'ep04.mp4', isDir: false, size: 0 },
        { name: 'ep05.mp4', isDir: false, size: 0 },
      ],
    })

    render(
      <NetdiskFilePickerDialog
        open
        onOpenChange={vi.fn()}
        dirPath="/综艺/脱口秀"
        current="ep05.mp4"
        onPick={vi.fn()}
      />,
    )

    const current = await screen.findByRole('option', { name: 'ep05.mp4' })
    const other = screen.getByRole('option', { name: 'ep04.mp4' })
    expect(current.getAttribute('aria-selected')).toBe('true')
    expect(other.getAttribute('aria-selected')).toBe('false')
  })

  // M4（突变检验）：value={joinAbs(dirPath, current)} 改成朴素的 `${dirPath}/${current}`
  // 在非根 dirPath 下和 joinAbs 产出完全相同的字符串（两者对非根 base 的拼接规则
  // 一致），这条 mutation 只有在 dirPath 是根目录 '/' 时才会产生可观测差异
  // （joinAbs('/', name) = '/name'，朴素模板 = '//name'）——上面那条 aria-selected
  // 测试只用了非根 dirPath，抓不到这个突变，所以补一条根目录版本。
  it('current 给出时对应的文件行带 aria-selected（根目录 dirPath——只有这个场景能分辨 joinAbs 和裸模板拼接）', async () => {
    listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
      if (opts?.recursive) {
        return { path, files: [{ name: 'ep01.mp4', isDir: false, size: 0 }, { name: 'ep02.mp4', isDir: false, size: 0 }] }
      }
      return { path, files: [] }
    })

    render(
      <NetdiskFilePickerDialog
        open
        onOpenChange={vi.fn()}
        dirPath="/"
        current="ep01.mp4"
        onPick={vi.fn()}
      />,
    )

    const current = await screen.findByRole('option', { name: 'ep01.mp4' })
    const other = screen.getByRole('option', { name: 'ep02.mp4' })
    expect(current.getAttribute('aria-selected')).toBe('true')
    expect(other.getAttribute('aria-selected')).toBe('false')
  })

  describe('路径钳制：不让浏览翻出 dirPath 之外', () => {
    // Important 1 落地后 loadDir/searchDir 都是递归平铺、后端 recursive 模式只回文件
    // 不回目录行，file-picker 模式下已经没有目录行可点——「下钻进子目录」这个交互
    // 不再存在于这个组件里了（旧版本这里曾有一条测试模拟点目录行下钻，随着交互一起
    // 删掉，不是覆盖率的丢失：被删的行为本身已经不在组件里）。但面包屑仍会渲染出
    // dirPath 以上的祖先层级（FileBrowser 从 '/' 一路铺到 path，不知道 dirPath 是一
    // 条业务边界），点它们必须被钳制拦住——这是保险丝仍然要守住的那条路径。
    it('面包屑点回 dirPath 以外的祖先目录时浏览路径不变（钳制的保险丝仍然拦得住）', async () => {
      listFs.mockImplementation(async (_c, path: string, opts?: { recursive?: boolean; refresh?: boolean }) => {
        if (opts?.recursive && path === '/综艺/脱口秀') return { path, files: [{ name: 'ep05.mp4', isDir: false, size: 0 }] }
        // 祖先目录 '/综艺' 若真的被拉取到，说明钳制没拦住——放一个和当前目录完全不同
        // 的内容，这样断言能直接分辨浏览器是不是真的跳出去了。
        if (path === '/综艺') return { path, files: [{ name: '不该看到我', isDir: false, size: 0 }] }
        return { path, files: [] }
      })

      render(<NetdiskFilePickerDialog open onOpenChange={vi.fn()} dirPath="/综艺/脱口秀" onPick={vi.fn()} />)

      // 面包屑里 dirPath 的上一级（'综艺'）仍然会渲染出来——点它应该被钳制拦住、
      // 毫无反应，而不是真的跳出 dirPath。
      await screen.findByRole('option', { name: 'ep05.mp4' })
      fireEvent.click(screen.getByRole('button', { name: '综艺' }))

      // 断言浏览路径没变：当前目录的文件还在，祖先目录的内容没有出现。
      expect(await screen.findByRole('option', { name: 'ep05.mp4' })).toBeTruthy()
      expect(screen.queryByText('不该看到我')).toBeNull()
    })

    // 兄弟目录：底层 FileBrowser 的面包屑只会渲染 dirPath 自己的祖先链，从来不会
    // 渲染出一个兄弟目录的按钮——组件级测试模拟不出「点击进了兄弟目录」这个交互
    // （没有这样的 UI 元素可点）。isWithinDir 正是组件用来判断这件事的唯一判据，
    // 直接单测它比伪造一个不存在的交互更精确。
    it('isWithinDir 拒绝兄弟目录、祖先目录，接受自身与子孙目录；根目录绑定与尾斜杠 dirPath 都判定正确', () => {
      expect(isWithinDir('/综艺/脱口秀', '/综艺/脱口秀')).toBe(true)
      expect(isWithinDir('/综艺/脱口秀/第3季', '/综艺/脱口秀')).toBe(true)
      expect(isWithinDir('/综艺/晚会', '/综艺/脱口秀')).toBe(false)
      expect(isWithinDir('/综艺', '/综艺/脱口秀')).toBe(false)
      expect(isWithinDir('/', '/综艺/脱口秀')).toBe(false)
      // 名字前缀陷阱：'/综艺/脱口秀2' 不是 '/综艺/脱口秀' 的子目录，只是字符串前缀
      // 相同——不能用裸 startsWith(dirPath) 判断，必须带上分隔符。
      expect(isWithinDir('/综艺/脱口秀2', '/综艺/脱口秀')).toBe(false)
      // M2（突变检验）：dirPath 是根目录时，prefix 特判（`dir === '/' ? '/' : ...`）
      // 是子目录被接受的唯一原因——去掉这个分支，prefix 会退化成 '//'，任何真实
      // candidate（单斜杠开头）都不会匹配，根目录绑定的钳制会整体失守但没有任何
      // 测试报红。这里直接钉住这条判定。
      expect(isWithinDir('/综艺', '/')).toBe(true)
      expect(isWithinDir('/', '/')).toBe(true)
      // Important 3：尾斜杠是真实的存量输入（绑定路径来自用户手敲的输入框），不
      // 规范化会让 `${dirPath}/` 前缀变成 `//`，导致任何子目录都被判定"不在目录内"。
      expect(isWithinDir('/综艺/脱口秀/第3季', '/综艺/脱口秀/')).toBe(true)
    })
  })

  // Important 3：onCommit 的兜底以前用 `path.startsWith(...) ? ... : path.replace(/^\//, '')`
  // 剥相对名，越界 path（不在 dir 子树内）会落进兜底分支，产出一个看着完全正常的相对名
  // （如 `综艺/脱口秀/ep05.mp4`）而不是被拒绝——那是数据损坏，不是显示问题。眼下浏览
  // 路径已被 isWithinDir 钳制，走不到这条越界路径，和 isWithinDir 本身一样，只能直接
  // 单测这个纯函数（组件级测试模拟不出「commit 一个越界 path」这个交互）。
  describe('relativeToDir：越界 path 不能被静默改写成一个看着正常的相对名', () => {
    it('在 dir 子树内的 path 正确剥离出相对名', () => {
      expect(relativeToDir('/综艺/脱口秀/第3季/ep05.mp4', '/综艺/脱口秀')).toBe('第3季/ep05.mp4')
      expect(relativeToDir('/综艺/脱口秀', '/综艺/脱口秀')).toBe('')
      expect(relativeToDir('/ep01.mp4', '/')).toBe('ep01.mp4')
      // 尾斜杠 dirPath 规范化后一致。
      expect(relativeToDir('/综艺/脱口秀/ep05.mp4', '/综艺/脱口秀/')).toBe('ep05.mp4')
    })

    it('越界 path（兄弟目录、祖先目录、名字前缀陷阱）一律返回 null', () => {
      expect(relativeToDir('/综艺/晚会/ep05.mp4', '/综艺/脱口秀')).toBeNull()
      expect(relativeToDir('/综艺/ep05.mp4', '/综艺/脱口秀')).toBeNull()
      // 名字前缀陷阱：'/综艺/脱口秀2/...' 不是 '/综艺/脱口秀' 的子目录。
      expect(relativeToDir('/综艺/脱口秀2/ep05.mp4', '/综艺/脱口秀')).toBeNull()
    })
  })
})
