import { describe, it, expect, vi } from 'vitest'
import { render as rtlRender } from '@testing-library/react'
import { ArtifactView } from './ArtifactView.tsx'
import * as registry from './views/registry.ts'

describe('ArtifactView', () => {
  it('view 组件内部抛错时只画一行红字,不把 React 树带走', () => {
    // table view 的真实字段是 columns/index/data(split 格式,见 table.ts),不是 rows——
    // 让 isTableData 校验本身在读 `data` 时炸,这是这份 fixture 唯一能命中 render() 内部抛错
    // 路径的写法;换成不存在的字段名只会静默走"数据形状不对"的兜底文案,测不到 catch。
    const bad = { schema: 'artifact/v1', view: 'table', name: 'n', data: { columns: [], get data() { throw new Error('炸') } }, config: {} }
    const { container } = rtlRender(<ArtifactView artifact={bad as never} theme="dark" />)
    expect(container.textContent).toMatch(/渲染失败/)
  })

  it('卸载时调用 view render 返回的 disposer——证明它真的跑了,不只是卸载没崩', () => {
    // 用真实注册表(不 mock),但换一个"认识"的 view 名字,借 unknownView 路径行不通,
    // 所以直接 spy getView 让它返回一个自造的、可观察的 render 函数。
    const disposer = vi.fn()
    const fakeRender = vi.fn(() => disposer)
    const spy = vi.spyOn(registry, 'getView').mockReturnValue(fakeRender)

    const artifact = { schema: 'artifact/v1', view: 'timeseries', name: 'n', data: {}, config: {} } as never
    const { unmount } = rtlRender(<ArtifactView artifact={artifact} theme="dark" />)

    expect(fakeRender).toHaveBeenCalledTimes(1)
    expect(disposer).not.toHaveBeenCalled()

    unmount()

    expect(disposer).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('view render 不返回任何东西(void)时,卸载不报错——必须容忍 undefined', () => {
    const spy = vi.spyOn(registry, 'getView').mockReturnValue(() => undefined)
    const artifact = { schema: 'artifact/v1', view: 'table', name: 'n', data: {}, config: {} } as never
    const { unmount } = rtlRender(<ArtifactView artifact={artifact} theme="dark" />)
    expect(() => unmount()).not.toThrow()
    spy.mockRestore()
  })
})
