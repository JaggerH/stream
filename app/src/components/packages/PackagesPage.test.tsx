import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PackagesPage, bandOf } from './PackagesPage.tsx'
import type { PackageSummary, RecipePackagePreview } from '../../lib/types.ts'

const packagesFn = vi.hoisted(() => vi.fn())
const updatesFn = vi.hoisted(() => vi.fn())
const setEnabledFn = vi.hoisted(() => vi.fn())
const logsFn = vi.hoisted(() => vi.fn())
const restartFn = vi.hoisted(() => vi.fn())
const previewFn = vi.hoisted(() => vi.fn())
const uninstallFn = vi.hoisted(() => vi.fn())
const searchFn = vi.hoisted(() => vi.fn())
const wishlistFn = vi.hoisted(() => vi.fn())
const providersFn = vi.hoisted(() => vi.fn())
const pendingFn = vi.hoisted(() => vi.fn())
const healthFn = vi.hoisted(() => vi.fn())
const restartBackendFn = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
const toastInfo = vi.hoisted(() => vi.fn())

vi.mock('../acrylic/sonner.tsx', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }))

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts')
  return {
    ApiError: actual.ApiError,
    LOCAL: actual.LOCAL,
    api: {
      packages: packagesFn,
      recipePackageUpdates: updatesFn,
      setPluginEnabled: setEnabledFn,
      packageLogs: logsFn,
      restartPackage: restartFn,
      previewRecipePackage: previewFn,
      uninstallRecipePackage: uninstallFn,
      searchRecipePackages: searchFn,
      // 配方段底下挂着「待接入」清单（OnboardWishlist）——默认空，它自己就不渲染
      onboardWishlist: wishlistFn,
      // Provider 段（组件页把能力行同列）——默认空，整段不渲染
      providers: providersFn,
      // 「等待重启」横幅：待生效清单 / 重启 / 重启后轮 health
      packagesPending: pendingFn,
      health: healthFn,
      restartBackend: restartBackendFn,
      // PluginConfigSheet 里 AList 那一支会读它
      alist: { get: vi.fn().mockResolvedValue({ url: '', hasToken: false, configured: false }) },
    },
  }
})

const FIXTURE: PackageSummary[] = [
  {
    id: 'alist', name: 'AList', description: '网盘聚合，转存内容直链播放', layer: 'builtin',
    slots: { sources: 3, code: true, backend: true }, hosted: true, enabled: true, role: 'netdisk-base',
    runtime: { state: 'running', image: 'xhofe/alist:latest' },
  },
  {
    id: 'voiceprint', name: '声纹', description: '说话人分离与声纹比对', layer: 'builtin',
    slots: { backend: true }, hosted: true, enabled: true,
    runtime: { state: 'idle', image: 'sherpa:latest' },
  },
  {
    id: 'douyin-api', name: '抖音解析', description: '视频平台搜索与解析', layer: 'builtin',
    slots: { backend: true, credentials: ['douyin.com'] }, hosted: true, enabled: true,
    runtime: { state: 'running', image: 'video-service:latest' },
  },
  {
    id: 'mineru', name: 'MinerU', description: '文档解析', layer: 'builtin',
    slots: { backend: true }, hosted: true, enabled: true,
    runtime: { state: 'error', image: 'mineru:latest' },
  },
  { id: 'rsshub', name: 'RSSHub', description: 'RSSHub 全部路由目录', layer: 'builtin', slots: { sources: 51 }, hosted: false, enabled: true },
  { id: 'browser', name: 'browser', description: '无头浏览器抓取', layer: 'builtin', slots: { sources: 1 }, hosted: false, enabled: true },
  { id: 'replay', name: '回放采集', description: '在你登录态的浏览器里重放', layer: 'builtin', slots: {}, hosted: false, enabled: true },
  { id: 'xhs', name: 'xhs', description: '小红书', layer: 'builtin', slots: { recipes: 2, recipeNames: ['xhs-home', 'xhs-search'] }, hosted: false },
  { id: 'lizhi', name: 'lizhi', description: '荔枝播客', layer: 'user', pkgName: '@streamapp/lizhi', version: '1.0.2', slots: { recipes: 1, recipeNames: ['lizhi-podcast'] }, hosted: false },
]

/** 「更新到 1.1.0」那条路会把这份 preview 交给 `InstallConfirmDialog` 真渲染一遍，所以它必须是
 *  一份**完整的** `RecipePackagePreview`——`recipes` / `overrides` 是必填的，`assessInstallRisk`
 *  直接 `.filter` 它们。这里的类型标注就是那颗牙：`previewFn` 是无类型的 `vi.fn()`，桩返回什么
 *  形状 TS 一概不管，漏字段的表现是渲染期抛错而**这个文件的用例照样全绿**（只有整跑的退出码
 *  会红）。字段随后端 `RecipePackagePreview` 增删时，红的是 tsc，不是某条用例。 */
const PREVIEW_LIZHI: RecipePackagePreview = {
  name: '@streamapp/lizhi',
  version: '1.1.0',
  facility: 'lizhi',
  recipes: [{ id: 'lizhi-podcast', description: '荔枝播客', capabilities: ['timeline'], effects: [], params: [] }],
  providers: [],
  overrides: [],
  confirm: 'sha',
}

beforeEach(() => {
  window.history.replaceState(null, '', '/packages')
  packagesFn.mockReset().mockResolvedValue(FIXTURE)
  updatesFn.mockReset().mockResolvedValue([])
  setEnabledFn.mockReset().mockResolvedValue({})
  logsFn.mockReset().mockResolvedValue({ lines: ['2026-08-07T03:00:00Z bind: address already in use'], truncated: false })
  restartFn.mockReset().mockResolvedValue({ state: 'running' })
  previewFn.mockReset()
  uninstallFn.mockReset().mockResolvedValue({ removed: true })
  searchFn.mockReset().mockResolvedValue([])
  wishlistFn.mockReset().mockResolvedValue({ entries: [] })
  providersFn.mockReset().mockResolvedValue([])
  pendingFn.mockReset().mockResolvedValue([])
  healthFn.mockReset().mockResolvedValue({ ok: true, started_at: '2026-09-21T00:00:00Z' })
  restartBackendFn.mockReset().mockResolvedValue({ status: 202, mode: 'supervised' })
  toastError.mockReset()
  toastSuccess.mockReset()
  toastInfo.mockReset()
})

/** Radix 的触发器对合成 click 不开（它自己建的触发器，不是原生 button 行为）。
 *  焦点 + Enter 走键盘路径 —— Radix/React 的键盘处理器不看 isTrusted。 */
function openMenu(trigger: HTMLElement) {
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
}

const band = (name: RegExp) => screen.getByRole('region', { name })
const containers = () => screen.getByRole('region', { name: /容器/ })

describe('bandOf — 具名分段判据', () => {
  it('有容器或要凭证 → 容器段', () => {
    expect(bandOf(FIXTURE[0])).toBe('container')
    expect(bandOf(FIXTURE[2])).toBe('container')
  })

  // 这是本页的拍板结论：rsshub / builtin / browser / replay 过 fillsPluginSlot，但不会在
  // 运行时坏。摆进容器段就是骗人去照料它们。
  it('内置层里提供源清单 / 代码 / 什么都没声明的 → 内置能力段', () => {
    expect(bandOf(FIXTURE[4])).toBe('builtin') // rsshub
    expect(bandOf(FIXTURE[6])).toBe('builtin') // replay：slots 全空
  })

  it('内置层里只有 recipe 数据的 → 抓取配方段', () => {
    expect(bandOf(FIXTURE[7])).toBe('recipe')
  })

  // 带了源清单的内置包不是配方包 —— 它不能卸载，也没有 npm 版本可言，动作完全不同。
  it('内置层里既有 recipe 又有源清单的算内置能力，不算配方包', () => {
    expect(bandOf({ ...FIXTURE[7], slots: { recipes: 2, sources: 1 } })).toBe('builtin')
  })

  // **第 2、3 段之间按「层」分，不按槽位。**「内置能力」段的言下之意是"跟着 Stream 一起
  // 发布"，而那一段的行也没有卸载菜单——把用户自己装进来的东西摆进去，既在骗人又让他卸不掉。
  // 一个能力包（无 recipe、无源清单）此前正好掉进这个缝里。
  it('用户层的包一律进可卸载那一段，不管填了什么槽位', () => {
    const user = { id: 'u', name: 'u', layer: 'user' as const, pkgName: '@t/u', version: '1.0.0', hosted: false }
    expect(bandOf({ ...user, slots: { capability: 'dist/index.js' } })).toBe('recipe')
    expect(bandOf({ ...user, slots: { sources: 3 } })).toBe('recipe')
    expect(bandOf({ ...user, slots: { code: true } })).toBe('recipe')
    expect(bandOf({ ...user, slots: {} })).toBe('recipe')
  })

  // 反向对照：同样的槽位在**内置层**仍然算内置能力。少了它，上面那条用"全都判成 recipe"
  // 也能过——那等于把分段判据整个拆了还看着是绿的。
  it('同样的槽位在内置层仍然是内置能力段', () => {
    const builtin = { id: 'b', name: 'b', layer: 'builtin' as const, hosted: false }
    expect(bandOf({ ...builtin, slots: { sources: 3 } })).toBe('builtin')
    expect(bandOf({ ...builtin, slots: { code: true } })).toBe('builtin')
  })

  // 后端连它的描述都解析不出来。摆进内置能力段等于说"它跟着 Stream 一起发布"，而它恰恰是
  // 用户自己装进来的那一个。
  it('读不动的包进配方段', () => {
    expect(bandOf({ id: 'rotten', name: 'rotten', layer: 'user', slots: {}, hosted: false, unreadable: 'Invalid Stream package rotten/package.json' })).toBe('recipe')
  })
})

// 导入分享包的落点在这一页：导入的那一刻频道还不存在，没有哪张频道配置面能承载它，而它做的
// 事（把别人的一份编排装进来）和这一页的「装包」是同一类。导出在频道自己的配置面上。
describe('PackagesPage — 导入分享包入口', () => {
  it('顶栏有「导入分享包」，面板不常驻（点开才挂）', async () => {
    render(<PackagesPage />)
    expect(await screen.findByRole('button', { name: '导入分享包' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: '导入分享包' })).toBeNull()
  })
})

describe('PackagesPage — 网盘设置入口跟着 role 走，不认包 id', () => {
  it('带 role: netdisk-base 的那张卡才有「网盘设置」', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    expect(within(within(c).getByTestId('package-card-alist')).getByText('网盘设置')).toBeTruthy()
    expect(within(within(c).getByTestId('package-card-voiceprint')).queryByText('网盘设置')).toBeNull()
  })

  it('role 挪到别的包上，入口跟着挪；id 是 alist 但没 role 就没有入口', async () => {
    packagesFn.mockResolvedValue(FIXTURE.map((p) =>
      p.id === 'alist' ? { ...p, role: undefined } : p.id === 'voiceprint' ? { ...p, role: 'netdisk-base' as const } : p))
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    await waitFor(() => expect(within(within(c).getByTestId('package-card-voiceprint')).getByText('网盘设置')).toBeTruthy())
    expect(within(within(c).getByTestId('package-card-alist')).queryByText('网盘设置')).toBeNull()
  })
})

describe('PackagesPage — 容器段只在出事时占版面', () => {
  it('出错的那一个常驻在最上面，其余收进折叠里', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    // 出错的：常驻可见，带两个自助动作
    const broken = within(c).getByTestId('package-broken-mineru')
    expect(within(broken).getByText('MinerU')).toBeTruthy()
    expect(within(broken).getByText('看日志')).toBeTruthy()
    expect(within(broken).getByText('重试')).toBeTruthy()
    // 其余：卡片在 DOM 里但收在 <details> 里，摘要行报的是数量
    expect(within(c).getByTestId('container-fold').textContent).toContain('3')
    expect(within(c).queryByTestId('package-broken-alist')).toBeNull()
  })

  it('展开之后才是卡片，卡片上只有名字 / 描述 / 状态 / 开关', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(c).getByTestId('container-fold'))
    const alist = within(c).getByTestId('package-card-alist')
    expect(within(alist).getByText('AList')).toBeTruthy()
    expect(within(alist).getByText('运行中')).toBeTruthy()
    expect(within(alist).getByRole('switch')).toBeTruthy()
    // 撤掉的：包 id、槽位 chip（这一段按定义就是有容器的，那些 chip 全是废话）
    expect(within(alist).queryByText('容器')).toBeNull()
    expect(within(alist).queryByText('代码')).toBeNull()
  })

  // 凭证是这张卡上唯一"不说用户就不知道"的东西：它掉了会静默降级成游客态、不报错。
  it('凭证域是唯一留下的标记', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(c).getByTestId('container-fold'))
    expect(within(within(c).getByTestId('package-card-douyin-api')).getByText(/douyin\.com/)).toBeTruthy()
    expect(within(within(c).getByTestId('package-card-alist')).queryByText(/登录态/)).toBeNull()
  })

  // `bandOf` 里 `hosted` 排在 `layer === 'user'` 前面，所以用户自己 `stream add` 装进来的、
  // 带容器的第三方包落在**这一段**，不在配方段。那张卡因此也必须给得出卸载入口——否则同样是
  // 他装的东西，有容器的只能装不能卸，没容器的卸得掉。两个答案，取决于它碰巧有没有容器。
  it('用户装的带容器包：卡片上有卸载，走的是 pkgName', async () => {
    const userContainer = {
      id: 'thirdparty', name: '第三方容器', description: 'x', layer: 'user' as const,
      pkgName: '@t/thirdparty', version: '1.0.0',
      slots: { backend: true }, hosted: true, enabled: true,
      runtime: { state: 'running' as const, image: 'x:1' },
    }
    packagesFn.mockResolvedValue([...FIXTURE, userContainer])
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(c).getByTestId('container-fold'))
    const card = within(c).getByTestId('package-card-thirdparty')
    openMenu(within(card).getByRole('button', { name: /第三方容器/ }))
    fireEvent.click(await screen.findByText('卸载'))
    await waitFor(() => expect(uninstallFn).toHaveBeenCalledWith(expect.anything(), '@t/thirdparty'))
  })

  // 容器一红，那个包就从折叠段挪进出错行——于是那张带卸载菜单的卡片消失了。用户自己装的包
  // **恰恰是坏掉之后最该卸得掉**，所以出错行也要给同一个入口，判据逐字相同。
  it('用户装的带容器包坏掉时：出错行上也有卸载', async () => {
    const brokenUserContainer = {
      id: 'thirdparty', name: '第三方容器', description: 'x', layer: 'user' as const,
      pkgName: '@t/thirdparty', version: '1.0.0',
      slots: { backend: true }, hosted: true, enabled: true,
      runtime: { state: 'error' as const, image: 'x:1' },
    }
    packagesFn.mockResolvedValue([...FIXTURE, brokenUserContainer])
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    const row = within(c).getByTestId('package-broken-thirdparty')
    openMenu(within(row).getByRole('button', { name: /第三方容器/ }))
    fireEvent.click(await screen.findByText('卸载'))
    await waitFor(() => expect(uninstallFn).toHaveBeenCalledWith(expect.anything(), '@t/thirdparty'))
  })

  // 反向对照：内置的包坏了也卸不掉——出错行不该凭"它坏了"就多长一个点了会 404 的菜单。
  it('内置容器包的出错行上没有那个菜单', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    const row = within(c).getByTestId('package-broken-mineru')
    expect(within(row).queryByRole('button', { name: /mineru/i })).toBeNull()
  })

  // 反向对照：内置容器包不是用户装的，卸不掉——给它一个点了会 404 的菜单比不给更坏。
  it('内置容器包的卡片上没有那个菜单', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(c).getByTestId('container-fold'))
    const alist = within(c).getByTestId('package-card-alist')
    expect(within(alist).queryByRole('button', { name: /AList/ })).toBeNull()
  })

  it('全绿时整段就剩那一行 —— 没有异常条', async () => {
    packagesFn.mockResolvedValue(FIXTURE.filter((p) => p.runtime?.state !== 'error'))
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    expect(within(c).queryByTestId('package-broken-mineru')).toBeNull()
    expect(within(c).getByTestId('container-fold')).toBeTruthy()
  })

  it('页脚的槽位图例已经删掉 —— 要靠图例才读得懂的标记本来就不该出现', async () => {
    render(<PackagesPage />)
    await waitFor(() => containers())
    expect(screen.queryByText(/槽位标记读法/)).toBeNull()
  })
})

describe('PackagesPage — 下面两段各有自己的动作', () => {
  // 跳转的落点由**宿主**注入（页内切 tab），不再写地址栏——这一页住在工作台里，那条 URL 归 DSH。
  it('内置能力段：宿主给了源页落点时，有源的才给「在源里打开」', async () => {
    render(<PackagesPage onOpenSources={() => {}} />)
    const b = await waitFor(() => band(/内置能力/))
    expect(within(within(b).getByTestId('package-row-rsshub')).getByText('在「源」里打开')).toBeTruthy()
    expect(within(within(b).getByTestId('package-row-replay')).queryByText('在「源」里打开')).toBeNull()
  })

  // 宿主没有源页时那颗键根本不画：点了没反应的链接比没有它更糟。工作台就是这一档。
  it('宿主没给源页落点 → 一颗「在源里打开」都不画', async () => {
    render(<PackagesPage />)
    const b = await waitFor(() => band(/内置能力/))
    expect(within(within(b).getByTestId('package-row-rsshub')).queryByText('在「源」里打开')).toBeNull()
  })

  it('「在源里打开」把包 id 交给宿主', async () => {
    const onOpenSources = vi.fn()
    render(<PackagesPage onOpenSources={onOpenSources} />)
    const b = await waitFor(() => band(/内置能力/))
    fireEvent.click(within(within(b).getByTestId('package-row-rsshub')).getByText('在「源」里打开'))
    expect(onOpenSources).toHaveBeenCalledWith('rsshub')
  })

  it('配方段：说得出是哪几条，不只是「2 条」', async () => {
    render(<PackagesPage />)
    const b = await waitFor(() => band(/抓取配方/))
    expect(within(b).getByText(/xhs-home · xhs-search/)).toBeTruthy()
  })

  // 「待接入」清单唯一的出口就是给那个站写一份 recipe，所以它必须和 recipe 在同一段里——
  // 单开一个面板等于开第二个收件箱。这条钉的就是「在配方段内」，不只是「页面上有」。
  it('待接入的站列在配方段里，不另立门户', async () => {
    wishlistFn.mockResolvedValue({
      entries: [{ id: 'wl_1', url: 'https://blog.example', goal: '想追这个博客', at: '2026-08-14T00:00:00.000Z' }],
    })
    render(<PackagesPage />)
    const b = await waitFor(() => band(/抓取配方/))
    expect(await within(b).findByText('想追这个博客')).toBeTruthy()
  })

  // 读不动的包必须**在页面上说出来**：它看起来只是一个 0 条配方的包，用户会以为坏的是自己
  // 那份 recipe，而真正的原因在 package.json 里。
  it('读不动的包在配方段里露面，写明原因', async () => {
    packagesFn.mockResolvedValue([
      ...FIXTURE,
      { id: 'rotten', name: 'rotten', layer: 'user', slots: {}, hosted: false, unreadable: 'Invalid Stream package rotten/package.json: Expected property name' },
    ])
    render(<PackagesPage />)
    const b = await waitFor(() => band(/抓取配方/))
    const row = await within(b).findByTestId('package-row-rotten')
    expect(within(row).getByText('读不动')).toBeTruthy()
    expect(within(row).getByText(/Expected property name/)).toBeTruthy()
  })

  // 内置包卸不掉、也没有 npm 版本可更新。给它一个点了会 404 的菜单比不给更坏。
  it('内置配方包没有操作菜单；用户装的有更新时才有', async () => {
    render(<PackagesPage />)
    const b = await waitFor(() => band(/抓取配方/))
    expect(within(within(b).getByTestId('package-row-xhs')).queryByRole('button')).toBeNull()
    expect(within(within(b).getByTestId('package-row-lizhi')).getByRole('button')).toBeTruthy()
  })

  it('三段各显示自己的计数（容器 4 / 内置 3 / 配方 2）', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/内置能力/))
    expect(within(band(/内置能力/)).getByTestId('band-count').textContent).toBe('3')
    expect(within(band(/抓取配方/)).getByTestId('band-count').textContent).toBe('2')
  })
})

describe('PackagesPage — 容器的两个自助动作', () => {
  it('看日志：打开抽屉并把行读出来', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(within(c).getByTestId('package-broken-mineru')).getByText('看日志'))
    expect(await screen.findByText(/address already in use/)).toBeTruthy()
    expect(logsFn).toHaveBeenCalledWith(expect.anything(), 'mineru')
  })

  it('重试：打 restart 并重拉列表', async () => {
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(within(c).getByTestId('package-broken-mineru')).getByText('重试'))
    await waitFor(() => expect(restartFn).toHaveBeenCalledWith(expect.anything(), 'mineru'))
    await waitFor(() => expect(packagesFn).toHaveBeenCalledTimes(2))
  })

  // 200 + state:'error' 表示我们试过了、容器没起来。只看有没有抛错会把一次失败的重启报成成功。
  it('重试成功返回但 state:error 时报失败，不报成功', async () => {
    restartFn.mockResolvedValue({ state: 'error', error: 'port in use' })
    render(<PackagesPage />)
    const c = await waitFor(() => containers())
    fireEvent.click(within(within(c).getByTestId('package-broken-mineru')).getByText('重试'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/还是没起来/)))
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

describe('PackagesPage — 搜索', () => {
  const search = () => screen.getByPlaceholderText(/搜/)

  it('按 id 过滤，段计数跟着变', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/内置能力/))
    fireEvent.change(search(), { target: { value: 'rsshub' } })
    await waitFor(() => expect(within(band(/内置能力/)).getByTestId('band-count').textContent).toBe('1'))
    expect(within(band(/抓取配方/)).getByTestId('band-count').textContent).toBe('0')
  })

  it('按 recipe 名过滤 —— 「我装的哪个包带了这条」是这一页的常见问题', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/抓取配方/))
    fireEvent.change(search(), { target: { value: 'xhs-search' } })
    await waitFor(() => expect(within(band(/抓取配方/)).getByTestId('band-count').textContent).toBe('1'))
  })

  it('按「容器」过滤命中带容器的那批', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/内置能力/))
    fireEvent.change(search(), { target: { value: '容器' } })
    await waitFor(() => expect(within(band(/内置能力/)).getByTestId('band-count').textContent).toBe('0'))
    expect(screen.getByTestId('package-broken-mineru')).toBeTruthy()
  })

  // 源页的「这是什么包」跳过来靠它。读一次初值，之后由用户输入接管——每次渲染都回读 URL
  // 会让人一个字都删不掉。
  it('URL 上的 ?q= 预填搜索框', async () => {
    window.history.replaceState(null, '', '/packages?q=lizhi')
    render(<PackagesPage />)
    await waitFor(() => band(/抓取配方/))
    expect((search() as HTMLInputElement).value).toBe('lizhi')
    expect(within(band(/抓取配方/)).getByTestId('band-count').textContent).toBe('1')
  })

  it('一个都没匹配上 → 空状态', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/内置能力/))
    fireEvent.change(search(), { target: { value: 'zzzz-nothing' } })
    expect(await screen.findByText(/没有匹配的包/)).toBeTruthy()
  })
})

describe('PackagesPage — 装 / 卸 / 升级都收在这一页', () => {
  it('「添加包」开抽屉，里面是市场搜索', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/内置能力/))
    fireEvent.click(screen.getByText('添加包'))
    expect(await screen.findByText(/粘进来/)).toBeTruthy()
  })

  it('有新版的配方行给出版本，菜单里能更新', async () => {
    updatesFn.mockResolvedValue([{ name: '@streamapp/lizhi', installed: '1.0.2', latest: '1.1.0' }])
    previewFn.mockResolvedValue(PREVIEW_LIZHI)
    render(<PackagesPage />)
    expect(await screen.findByText(/可更新 1\.1\.0/)).toBeTruthy()
    openMenu(within(screen.getByTestId('package-row-lizhi')).getByRole('button'))
    fireEvent.click(await screen.findByText(/更新到 1\.1\.0/))
    await waitFor(() => expect(previewFn).toHaveBeenCalledWith(expect.anything(), '@streamapp/lizhi', '1.1.0'))
  })

  it('卸载走 pkgName（不是目录名/显示名）', async () => {
    render(<PackagesPage />)
    await waitFor(() => band(/抓取配方/))
    openMenu(within(screen.getByTestId('package-row-lizhi')).getByRole('button'))
    fireEvent.click(await screen.findByText('卸载'))
    await waitFor(() => expect(uninstallFn).toHaveBeenCalledWith(expect.anything(), '@streamapp/lizhi'))
  })

  it('查更新失败不影响列表（registry 抖动不该让页面打不开）', async () => {
    updatesFn.mockRejectedValue(new Error('registry down'))
    render(<PackagesPage />)
    expect(await screen.findByText('lizhi')).toBeTruthy()
    expect(screen.queryByText(/可更新/)).toBeNull()
  })

  // ── Provider 段（组件页，spec 2026-08-17-component-page） ────────────────────
  const PROVIDERS = [
    { id: 'video-search', label: '影视搜索', description: '', category: 'search', serves: [], strategy: 'concurrent', status: 'live', callSites: [], members: [{ source: 'a' }, { source: 'b' }], resolvedMembers: [], calls: { total: 0, byMember: {}, lastCalledAt: null } },
    { id: 'imported', label: '搭车行', description: '', category: 'download', serves: [], strategy: 'sequential', status: 'live', callSites: [], members: [], resolvedMembers: [], calls: { total: 0, byMember: {}, lastCalledAt: null }, parked: true },
  ]

  // 这一段是组件在 UI 上仅存的那一面，**只读**：编辑面已下线，行不可点。
  it('Provider 段列出能力行：类别、成员数、parked 徽章', async () => {
    providersFn.mockResolvedValue(PROVIDERS)
    render(<PackagesPage />)
    const section = await waitFor(() => band(/能力行/))
    const row = within(section).getByTestId('provider-row-video-search')
    expect(within(row).getByText('影视搜索')).toBeTruthy()
    expect(within(row).getByText('搜索')).toBeTruthy()
    expect(within(row).getByText('2 个成员')).toBeTruthy()
    expect(within(within(section).getByTestId('provider-row-imported')).getByText('未激活')).toBeTruthy()
  })

  // 别给这一行加回 onClick：编辑面没了，点了什么都不发生的行和坏了长得一模一样。
  it('组件行不可点——没有落点就不给可点的样子', async () => {
    providersFn.mockResolvedValue(PROVIDERS)
    render(<PackagesPage />)
    const row = within(await waitFor(() => band(/能力行/))).getByTestId('provider-row-video-search')
    expect(row.className).not.toContain('cursor-pointer')
  })

  it('Provider 列表拉不下来只丢这一段，包清单照常（它才是这一页的主体）', async () => {
    providersFn.mockRejectedValue(new Error('boom'))
    render(<PackagesPage />)
    expect(await screen.findByText('lizhi')).toBeTruthy()
    expect(screen.queryByText(/能力行/)).toBeNull()
  })
})

// 能力包在这一页上原本和一份纯数据的 recipe 包长得一模一样，而它的权限完全不同（后端进程内、
// 完整权限、能取登录态）。和凭证域 chip 同一条理由：不说用户就不知道。
describe('PackagesPage — 能力槽位那一格', () => {
  const CAP: PackageSummary = {
    id: 'demo-cap', name: '演示能力', description: '一个能力包', layer: 'user',
    pkgName: '@t/demo-cap', version: '1.0.0',
    slots: { capability: 'dist/index.js', tools: ['netdisk_save', 'netdisk_verify'] },
    hosted: false,
  }

  it('有工具名就把工具名摆出来（那才是用户在对话里天天见的东西）', async () => {
    packagesFn.mockResolvedValue([...FIXTURE, CAP])
    render(<PackagesPage />)
    const row = await screen.findByTestId('package-row-demo-cap')
    expect(within(row).getByText('netdisk_save')).toBeTruthy()
    expect(within(row).getByText('netdisk_verify')).toBeTruthy()
  })

  // 它是用户自己装进来的，所以必须落在**可卸载**那一段，并且真有那个入口。摆进「内置能力」
  // 段就是说"它跟着 Stream 一起发布"，而且那一段的行没有菜单——用户卸不掉自己装的东西。
  it('落在可卸载那一段，并且真有卸载入口', async () => {
    packagesFn.mockResolvedValue([...FIXTURE, CAP])
    render(<PackagesPage />)
    const row = await screen.findByTestId('package-row-demo-cap')
    expect(within(band(/抓取配方/)).getByTestId('package-row-demo-cap')).toBeTruthy()
    openMenu(within(row).getByRole('button'))
    expect(await screen.findByText('卸载')).toBeTruthy()
  })

  // 空数组说的是「声明了能力但没装载/没注册工具」，是一句真话——但那时不能凑一句带名字的
  // 空话，换成不点名的那一格。
  it('列不出工具名时退回不带名字的那一格', async () => {
    packagesFn.mockResolvedValue([...FIXTURE, { ...CAP, slots: { capability: 'dist/index.js', tools: [] } }])
    render(<PackagesPage />)
    const row = await screen.findByTestId('package-row-demo-cap')
    expect(within(row).getByText('在后端跑代码')).toBeTruthy()
  })

  it('没填能力槽位的包一格都不画（分级不能把每个包都标一遍）', async () => {
    render(<PackagesPage />)
    const row = await screen.findByTestId('package-row-xhs')
    expect(within(row).queryByText('在后端跑代码')).toBeNull()
  })

  it('按工具名搜得到——用户记得的是那个动词，不是 npm 包名', async () => {
    packagesFn.mockResolvedValue([...FIXTURE, CAP])
    render(<PackagesPage />)
    await waitFor(() => screen.getByTestId('package-row-demo-cap'))
    fireEvent.change(screen.getByPlaceholderText(/搜/), { target: { value: 'netdisk_save' } })
    await waitFor(() => expect(screen.getByTestId('package-row-demo-cap')).toBeTruthy())
    expect(screen.queryByTestId('package-row-xhs')).toBeNull()
  })
})

describe('PackagesPage — 「等待重启」横幅', () => {
  const PENDING = [
    { name: '@streamapp/mineru', kind: 'updated' as const, from: '1.0.0', to: '1.0.1', needsRestart: true, why: '容器要重启后按 x:1.0.1 重建' },
  ]

  it('没有待生效项 → 不画横幅', async () => {
    render(<PackagesPage />)
    await screen.findByTestId('package-row-xhs')
    expect(pendingFn).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('pending-restart-banner')).toBeNull()
  })

  it('老后端没这个口（抛错）→ 不画横幅、页照开', async () => {
    pendingFn.mockRejectedValue(new Error('404'))
    render(<PackagesPage />)
    await screen.findByTestId('package-row-xhs')
    await waitFor(() => expect(pendingFn).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('pending-restart-banner')).toBeNull()
    expect(screen.queryByText(/加载失败|loadFailed/)).toBeNull()
  })

  // 判据是 started_at **变了**：202 之后旧进程还在优雅关，health 照样 200，只看连通会误判。
  it('点「现在重启」→ 轮 health 直到 started_at 变了才重新 load，横幅随 pending 清空而消失', async () => {
    pendingFn.mockResolvedValue(PENDING)
    render(<PackagesPage />)
    expect(await screen.findByTestId('pending-restart-banner')).toBeTruthy()
    expect(pendingFn).toHaveBeenCalledTimes(1)

    // 重启后 pending 清空（后端现算，新进程装载的就是盘上的）
    pendingFn.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: /现在重启/ }))
    await waitFor(() => expect(restartBackendFn).toHaveBeenCalledWith(expect.anything(), false))
    expect(await screen.findByText(/后端重启中/)).toBeTruthy()

    // 第一轮 health 仍是旧进程 → 不 load
    await new Promise((r) => setTimeout(r, 2_100))
    expect(pendingFn).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/后端重启中/)).toBeTruthy()

    healthFn.mockResolvedValue({ ok: true, started_at: '2026-09-21T00:05:00Z' })
    await waitFor(() => expect(pendingFn).toHaveBeenCalledTimes(2), { timeout: 4_000 })
    await waitFor(() => expect(screen.queryByTestId('pending-restart-banner')).toBeNull())
  }, 10_000)

  // 没有基线就没法判「started_at 变了」：不进轮询（轮下去只会在旧进程身上误判或超时报红），如实说一句。
  it('restart 之前的 health 基线取不到 → 不轮询，toast「重启已发出，请稍后手动刷新」', async () => {
    pendingFn.mockResolvedValue(PENDING)
    healthFn.mockRejectedValue(new Error('offline'))
    render(<PackagesPage />)
    expect(await screen.findByTestId('pending-restart-banner')).toBeTruthy()
    healthFn.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /现在重启/ }))
    await waitFor(() => expect(restartBackendFn).toHaveBeenCalledWith(expect.anything(), false))
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/重启已发出|Restart sent/)))
    // 结束这一轮：重拉列表，横幅从「重启中」回到可点
    await waitFor(() => expect(pendingFn).toHaveBeenCalledTimes(2))
    expect(healthFn).toHaveBeenCalledTimes(1)   // 只有取基线那一次，没有轮询
    await new Promise((r) => setTimeout(r, 2_100))
    expect(healthFn).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  }, 10_000)
})
