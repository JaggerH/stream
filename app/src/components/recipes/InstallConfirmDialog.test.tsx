import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { InstallConfirmDialog } from './InstallConfirmDialog.tsx'
import type { RecipePackagePreview } from '../../lib/types.ts'

const recipe = (id: string, effects: string[] = []) => ({
  id, description: `${id} 的描述`, capabilities: ['timeline'], effects, params: ['keyword'],
})

const preview = (over: Partial<RecipePackagePreview> = {}): RecipePackagePreview => ({
  name: '@third/pack', version: '1.0.0', facility: 'xhs',
  rateLimit: { burst: 2, perMinute: 6 },
  recipes: [recipe('xhs-home')],
  providers: [],
  overrides: [],
  confirm: 'sha512-abc',
  ...over,
})

const setup = (p: RecipePackagePreview | null, over: { installing?: boolean; error?: string | null } = {}) => {
  const onInstall = vi.fn()
  const onCancel = vi.fn()
  render(
    <InstallConfirmDialog
      preview={p}
      installing={over.installing ?? false}
      error={over.error ?? null}
      onCancel={onCancel}
      onInstall={onInstall}
    />,
  )
  return { onInstall, onCancel }
}

describe('InstallConfirmDialog 呈现', () => {
  it('展示版本、facility、钳制后的限流、每个 recipe 的能力与覆盖列表', () => {
    setup(preview({ overrides: ['@third/pack/xhs-home', '@third/pack/xhs-search'], recipes: [recipe('xhs-home'), recipe('xhs-search')] }))
    expect(screen.getByText('安装 @third/pack@1.0.0')).toBeTruthy()
    expect(screen.getByText('xhs')).toBeTruthy()
    expect(screen.getByText('并发 2 · 每分钟 6')).toBeTruthy()
    expect(screen.getAllByText('timeline').length).toBe(2)
    expect(screen.getByText('xhs-search')).toBeTruthy()
  })

  it('明示自述限制', () => {
    setup(preview())
    expect(screen.getByText('能力与副作用由包作者自述，宿主不核实。')).toBeTruthy()
  })

  it('preview 为 null 时什么都不渲染', () => {
    const { container } = render(
      <InstallConfirmDialog preview={null} installing={false} error={null} onCancel={vi.fn()} onInstall={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })

  it('展示会用到的登录域——facility 与它名实不符是钓鱼签名，必须看得见', () => {
    setup(preview({ facility: 'xhs', cookieDomain: 'quark.cn' }))
    expect(screen.getByText('quark.cn')).toBeTruthy()
  })

  it('展示后端将替这个包代理连接的主机——装一个会让后端出站的包，这一格不能看不见', () => {
    setup(preview({ proxies: ['.lizhi.fm', 'cdn101.lizhi.fm', 'cdn.gzlzfm.com'] }))
    expect(screen.getByText('后端将替它代理连接')).toBeTruthy()
    expect(screen.getByText('.lizhi.fm、cdn101.lizhi.fm、cdn.gzlzfm.com')).toBeTruthy()
  })

  it('没有 serving 声明（proxies 缺席或为空）时不渲染代理行', () => {
    setup(preview({ proxies: [] }))
    expect(screen.queryByText('后端将替它代理连接')).toBeNull()
    setup(preview())
    expect(screen.queryByText('后端将替它代理连接')).toBeNull()
  })

  it('展示这个包声明的 Provider 行，并提示重启后端后才出现', () => {
    setup(preview({ providers: ['x-track'] }))
    expect(screen.getByText('x-track')).toBeTruthy()
    expect(screen.getByText('重启后端后才出现')).toBeTruthy()
  })

  it('没有声明 providers 时不渲染这一行', () => {
    setup(preview())
    expect(screen.queryByText('重启后端后才出现')).toBeNull()
  })

  it('风险在两处同时出现：顶部警告块与确认按钮标签', () => {
    setup(preview({ recipes: [recipe('xhs-like', ['write'])] }))
    expect(screen.getByText('这次安装需要你再确认一次')).toBeTruthy()
    const reason = '该包会写我的账户（xhs-like）'
    expect(screen.getByText(reason)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(document.body.textContent?.split(reason).length).toBe(3)
  })

  it('install 失败的原因原样展示', () => {
    setup(preview(), { error: 'confirm token mismatch for @third/pack@1.0.0' })
    expect(screen.getByText('confirm token mismatch for @third/pack@1.0.0')).toBeTruthy()
  })
})

describe('InstallConfirmDialog 的二次确认门', () => {
  it('只读且不覆盖 → 一次点击就装', () => {
    const p = preview()
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).toHaveBeenCalledTimes(1)
    expect(onInstall).toHaveBeenCalledWith(p)
  })

  it('带 write 副作用：首次点击不装，换成点名风险的确认控件，再点才装', () => {
    const p = preview({ recipes: [recipe('xhs-like', ['write'])] })
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: /确认安装/ })
    expect(confirm.textContent).toContain('该包会写我的账户')
    expect(confirm.textContent).toContain('xhs-like')
    fireEvent.click(confirm)
    expect(onInstall).toHaveBeenCalledWith(p)
  })

  it('第三方包覆盖内置源：首次点击不装，确认控件点名被替换的源 id', () => {
    const p = preview({ overrides: ['@third/pack/xhs-home'] })
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: /确认安装/ })
    expect(confirm.textContent).toContain('xhs-home')
    fireEvent.click(confirm)
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('两类风险同时命中，确认文案两条都点名（不退化成「确认」）', () => {
    const p = preview({ overrides: ['@third/pack/xhs-home'], recipes: [recipe('xhs-like', ['write'])] })
    setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    const confirm = screen.getByRole('button', { name: /确认安装/ })
    expect(confirm.textContent).toContain('xhs-like')
    expect(confirm.textContent).toContain('xhs-home')
    expect(confirm.textContent).not.toBe('确认')
  })

  it('官方包覆盖内置源仍一键完成（正常升级路径，不罚站）', () => {
    const p = preview({ name: '@streamapp/xhs', overrides: ['@streamapp/xhs/xhs-home'] })
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('同一实例换成另一个高风险包：确认状态不继承，首帧就是「安装」且点了不装', () => {
    const onInstall = vi.fn()
    const a = preview({ name: '@third/a', recipes: [recipe('a-like', ['write'])] })
    const b = preview({ name: '@third/b', recipes: [recipe('b-like', ['write'])] })
    const el = (p: RecipePackagePreview): ReactElement => (
      <InstallConfirmDialog preview={p} installing={false} error={null} onCancel={vi.fn()} onInstall={onInstall} />
    )
    const { rerender } = render(el(a))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(screen.getByRole('button', { name: /确认安装/ })).toBeTruthy()

    // 换包（例如从「更新到 x.y.z」进来）。复位必须是渲染期派生的，不能靠 effect 补一帧——
    // 否则这一帧上摆着的仍是包 A 那颗红色确认按钮，点下去就直装了包 B。
    rerender(el(b))
    expect(screen.queryByRole('button', { name: /确认安装/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /确认安装/ }).textContent).toContain('b-like')
  })

  it('同一个包「确认 → 关掉 → 再打开」时门重新武装（取消是明确的退出信号）', () => {
    const onInstall = vi.fn()
    const a = preview({ name: '@third/a', recipes: [recipe('a-like', ['write'])] })
    const el = (p: RecipePackagePreview | null): ReactElement => (
      <InstallConfirmDialog preview={p} installing={false} error={null} onCancel={vi.fn()} onInstall={onInstall} />
    )
    const { rerender } = render(el(a))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(screen.getByRole('button', { name: /确认安装/ })).toBeTruthy()

    // 页面关掉对话框 = 把 preview 置 null。组件自己处理 null（不卸载），所以复位得由它自己守。
    rerender(el(null))
    rerender(el(a))
    expect(screen.queryByRole('button', { name: /确认安装/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
  })

  it('name@version 没变但内容指纹换了（install 失败后重新 preview）：门重新武装', () => {
    const onInstall = vi.fn()
    // 同名同版本，但 tarball 换了：confirm 变了，风险面也变大了（多出覆盖内置源）。
    const before = preview({ recipes: [recipe('xhs-like', ['write'])], confirm: 'sha512-old' })
    const after = preview({ recipes: [recipe('xhs-like', ['write'])], overrides: ['@third/pack/xhs-home'], confirm: 'sha512-new' })
    const el = (p: RecipePackagePreview): ReactElement => (
      <InstallConfirmDialog preview={p} installing={false} error={null} onCancel={vi.fn()} onInstall={onInstall} />
    )
    const { rerender } = render(el(before))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(screen.getByRole('button', { name: /确认安装/ })).toBeTruthy()

    rerender(el(after))
    expect(screen.queryByRole('button', { name: /确认安装/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    // 重新升档后，文案得点名新出现的那条风险。
    expect(screen.getByRole('button', { name: /确认安装/ }).textContent).toContain('xhs-home')
  })

  it('同一份 preview 原样重试（confirm 未变）不罚站：仍停在确认档', () => {
    const p = preview({ recipes: [recipe('xhs-like', ['write'])] })
    const onInstall = vi.fn()
    const el = (error: string | null): ReactElement => (
      <InstallConfirmDialog preview={p} installing={false} error={error} onCancel={vi.fn()} onInstall={onInstall} />
    )
    const { rerender } = render(el(null))
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    rerender(el('network error'))
    fireEvent.click(screen.getByRole('button', { name: /确认安装/ }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('点「取消」当场解除已升档的确认状态', () => {
    const p = preview({ recipes: [recipe('xhs-like', ['write'])] })
    const { onCancel } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /确认安装/ })).toBeNull()
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
  })

  it('installing 期间主按钮禁用（防重复提交）', () => {
    setup(preview(), { installing: true })
    expect(screen.getByRole('button', { name: '安装中…' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('InstallConfirmDialog：带容器的包把镜像摆到眼前', () => {
  const backend = {
    image: 'ghcr.io/someone/thing:1.0',
    service: 'xhs',
    port: 8080,
    mem: '1G',
    volumes: ['xhs_data:/var/lib/data'],
    envKeys: ['API_TOKEN'],
    standby: { idleMinutes: 30 },
  }
  const withBackend = (over: Partial<RecipePackagePreview> = {}) =>
    preview({ backend, credentials: ['douyin.com'], ...over })

  it('带容器：首次点击不装，确认按钮复述镜像全名', () => {
    const p = withBackend()
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: /确认安装/ })
    expect(confirm.textContent).toContain('ghcr.io/someone/thing:1.0')
    expect(confirm.textContent).toContain('douyin.com')
    fireEvent.click(confirm)
    expect(onInstall).toHaveBeenCalledWith(p)
  })

  it('容器块摆出镜像全名、内存上限、卷、env 键名、凭证域与闲置回收', () => {
    setup(withBackend())
    expect(screen.getByText('这个包会在你的机器上跑一个容器')).toBeTruthy()
    expect(screen.getByText('容器镜像')).toBeTruthy()
    expect(screen.getByText('ghcr.io/someone/thing:1.0')).toBeTruthy()
    expect(screen.getByText('内存上限')).toBeTruthy()
    expect(screen.getByText('1G')).toBeTruthy()
    expect(screen.getByText('数据卷')).toBeTruthy()
    expect(screen.getByText('xhs_data:/var/lib/data')).toBeTruthy()
    expect(screen.getByText('环境变量（只列键名）')).toBeTruthy()
    expect(screen.getByText('API_TOKEN')).toBeTruthy()
    expect(screen.getByText('它能取的登录态')).toBeTruthy()
    expect(screen.getByText('douyin.com')).toBeTruthy()
    expect(
      screen.getByText('闲置 30 分钟后自动停掉这个容器；下次用到时再唤醒，数据卷原地留着。'),
    ).toBeTruthy()
  })

  it('容器 + 代码同在：代码那条在前，容器块与代码块都摆出来', () => {
    const p = withBackend({ code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: [] } })
    setup(p)
    expect(screen.getByText('代码入口')).toBeTruthy()
    expect(screen.getByText('容器镜像')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    const label = screen.getByRole('button', { name: /确认安装/ }).textContent ?? ''
    expect(label.indexOf('cookie')).toBeLessThan(label.indexOf('ghcr.io/someone/thing:1.0'))
  })

  it('纯数据包不被容器文案波及：档位与一键安装都不变，页面上没有容器字样', () => {
    const { onInstall } = setup(preview())
    expect(screen.queryByText('容器镜像')).toBeNull()
    expect(document.body.textContent).not.toContain('容器')
    expect(document.body.textContent).not.toContain('镜像')
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })
})

describe('InstallConfirmDialog：含代码的包是最响的一档', () => {
  const withCode = (over: Partial<RecipePackagePreview> = {}) =>
    preview({ code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: ['xhs-note'] }, ...over })

  it('含代码：首次点击不装，确认按钮复述「与 Stream 同权限」并点名注册名', () => {
    const p = withCode()
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: /确认安装/ })
    expect(confirm.textContent).toContain('cookie')
    expect(confirm.textContent).toContain('token')
    expect(confirm.textContent).toContain('xhs-note')
    fireEvent.click(confirm)
    expect(onInstall).toHaveBeenCalledWith(p)
  })

  it('含代码：把后果、注册名与入口摆在警告块里，并如实写卸载/升级要重启才生效', () => {
    setup(withCode())
    expect(screen.getByText('这个包会在 Stream 里跑它自己的代码')).toBeTruthy()
    expect(screen.getByText('代码入口')).toBeTruthy()
    expect(screen.getByText('dist/index.js')).toBeTruthy()
    expect(screen.getByText('会注册的 adapter')).toBeTruthy()
    expect(screen.getByText('会注册的 normalizer')).toBeTruthy()
    expect(
      screen.getByText('代码格的包，卸载和升级都要重启 Stream 后才生效——已加载的模块无法在运行中卸掉。'),
    ).toBeTruthy()
  })

  it('含代码 + 写账户：两条都点名，代码那条在前', () => {
    const p = withCode({ recipes: [recipe('xhs-like', ['write'])] })
    setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    const label = screen.getByRole('button', { name: /确认安装/ }).textContent ?? ''
    expect(label).toContain('xhs-like')
    expect(label.indexOf('cookie')).toBeLessThan(label.indexOf('xhs-like'))
  })

  it('只有清单 / recipe 的包不被代码文案波及：档位与一键安装都不变', () => {
    const { onInstall } = setup(preview())
    expect(screen.queryByText('代码入口')).toBeNull()
    expect(document.body.textContent).not.toContain('重启 Stream')
    expect(document.body.textContent).not.toContain('cookie')
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })
})

// 能力包不声明 `stream.code`——它导出的是一个 `Capability`。只认 `code` 的话，这份会在后端
// 进程内以完整权限运行、能取用户浏览器登录态的字节，会以「纯数据 recipe 包」的样子一键装上。
describe('InstallConfirmDialog：能力包与代码包同一档', () => {
  const withCapability = (over: Partial<RecipePackagePreview> = {}) =>
    preview({ capability: { entry: 'dist/index.js' }, ...over })

  it('首次点击不装，确认按钮复述「后端进程内 / 完整权限 / 能取登录态」', () => {
    const p = withCapability()
    const { onInstall } = setup(p)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: /确认安装/ })
    expect(confirm.textContent).toContain('完整权限')
    expect(confirm.textContent).toContain('登录态')
    fireEvent.click(confirm)
    expect(onInstall).toHaveBeenCalledWith(p)
  })

  it('警告块用最响的那个标题，并摆出入口与「重启才生效」', () => {
    setup(withCapability())
    expect(screen.getByText('这个包会在 Stream 里跑它自己的代码')).toBeTruthy()
    expect(screen.getByText('能力入口')).toBeTruthy()
    expect(screen.getByText('dist/index.js')).toBeTruthy()
    expect(
      screen.getByText('代码格的包，卸载和升级都要重启 Stream 后才生效——已加载的模块无法在运行中卸掉。'),
    ).toBeTruthy()
  })

  it('拿得到工具名就列出来（拿不到才是常态）', () => {
    setup(withCapability({ capability: { entry: 'dist/index.js', tools: ['netdisk_save'] } }))
    expect(screen.getByText('会注册的工具')).toBeTruthy()
    expect(screen.getByText('netdisk_save')).toBeTruthy()
  })

  it('没有工具名时不画那一行（空名单和"没有这一格"是两句不同的话）', () => {
    setup(withCapability())
    expect(screen.queryByText('会注册的工具')).toBeNull()
  })
})
