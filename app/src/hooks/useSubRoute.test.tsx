/**
 * 钉住「路径存哪」这个口子。它存在的理由只有一个：面板以插件形态住在别人的页面里时，
 * 地址栏不归我们——往上面写会劫持宿主的路由。所以最要紧的那条断言是**反着的**：
 * 内存档下 `window.location` 必须一动不动。
 */
import { describe, expect, it } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  SubRouteLocationProvider,
  createMemorySubRouteLocation,
  useSubRoute,
} from './useSubRoute.ts'

type Route = { kind: 'home' } | { kind: 'item'; id: string }
const parse = (p: string): Route => {
  const seg = p.split('/')
  return seg[1] === 'item' && seg[2] ? { kind: 'item', id: seg[2] } : { kind: 'home' }
}
const toPath = (r: Route) => (r.kind === 'item' ? `/item/${r.id}` : '/')

let go: (r: Route) => void
function Probe() {
  const { selection, navigate } = useSubRoute<Route>(parse, toPath)
  go = navigate
  return <div data-testid="sel">{selection.kind === 'item' ? selection.id : 'home'}</div>
}

describe('useSubRoute 的路径存放处', () => {
  it('内存档：选择跟着走，而地址栏一个字都没动', () => {
    const before = window.location.pathname
    const loc = createMemorySubRouteLocation('/')
    render(<SubRouteLocationProvider location={loc}><Probe /></SubRouteLocationProvider>)

    expect(screen.getByTestId('sel').textContent).toBe('home')
    act(() => { go({ kind: 'item', id: 'abc' }) })
    expect(screen.getByTestId('sel').textContent).toBe('abc')
    expect(loc.pathname()).toBe('/item/abc')
    // 这一条就是整个口子的存在理由——写到别人的地址栏上就是劫持宿主路由。
    expect(window.location.pathname).toBe(before)
  })

  it('内存档：路径被外力改了（订阅回调）也能重新推导出选择', () => {
    const loc = createMemorySubRouteLocation('/')
    render(<SubRouteLocationProvider location={loc}><Probe /></SubRouteLocationProvider>)
    act(() => { loc.push('/item/xyz') })
    expect(screen.getByTestId('sel').textContent).toBe('xyz')
  })

  it('内存档：初始路径就是种子（深链的等价物）', () => {
    const loc = createMemorySubRouteLocation('/item/seeded')
    render(<SubRouteLocationProvider location={loc}><Probe /></SubRouteLocationProvider>)
    expect(screen.getByTestId('sel').textContent).toBe('seeded')
  })

  it('不包 Provider = 默认走地址栏（主应用的常态）', () => {
    window.history.pushState(null, '', '/')
    render(<Probe />)
    act(() => { go({ kind: 'item', id: 'browser' }) })
    expect(window.location.pathname).toBe('/item/browser')
    expect(screen.getByTestId('sel').textContent).toBe('browser')
    window.history.pushState(null, '', '/')
  })
})
