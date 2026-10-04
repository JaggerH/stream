import { createContext, createElement, useContext, useEffect, useState, type ReactNode, type ReactElement } from 'react'

/**
 * 一个频道自己的二级路由：把频道内的选择（哪部剧 / 哪个歌单 / 哪条详情）映射到一个**路径**，
 * 让它可深链、刷新还在——而不用每个频道各写一遍 pushState + popstate + 播种那套（影视的详情
 * 路由当年就是这么漂到错的路径上的）。
 *
 * 你给两个纯函数：
 *   - `parseFrom(pathname)` → 这个路径编码的选择（也是初始/刷新时的种子）
 *   - `toPath(s)`           → 这个选择该住的完整路径（base + 子路径）
 *
 * 拿回当前 `selection` 和 `navigate(s)`。全局路由拥有频道的 **base** 路径，这里只管它下面那截。
 *
 * ## 路径存在哪：`SubRouteLocation`
 *
 * 默认是**浏览器地址栏**（`browserSubRouteLocation`）：真 history 条目，浏览器后退回上一层。
 * 但地址栏**不总是我们的**——面板以插件形态住在 DSH 的页面里时，那条 URL 归 DSH，我们往上面
 * 写等于劫持宿主的路由（刷新落到宿主 404、后退键跳的是我们的层而不是宿主的）。所以路径的存放
 * 处是一个可注入的口子：宿主页面里用 `createMemorySubRouteLocation()`，路径只活在内存里，
 * 深链和后退键一并放弃——那本来就不是我们能提供的东西。
 *
 * `parseFrom` 收的是路径字符串（不再自己读 `window.location`），这样两种存放处走同一条代码路径，
 * 也让路由解析在测试里不用碰 DOM。
 */
export interface SubRouteLocation {
  /** 当前路径（形如 `/music/playlist/x`）。 */
  pathname: () => string
  /** 换到新路径。浏览器档是 pushState（留下真历史条目）。 */
  push: (path: string) => void
  /** 路径被外力改变时（浏览器档 = 前进/后退）回调；返回退订。 */
  subscribe: (onChange: () => void) => () => void
}

/** 默认档：真地址栏 + 真历史。 */
export const browserSubRouteLocation: SubRouteLocation = {
  pathname: () => window.location.pathname,
  push: (path) => {
    if (window.location.pathname === path) return
    try {
      window.history.pushState(null, '', path)
    } catch {
      /* 地址栏写不进去（畸形/跨源路径）也要保住 app 内的跳转，见 navigate 的注释 */
    }
  },
  subscribe: (onChange) => {
    window.addEventListener('popstate', onChange)
    return () => window.removeEventListener('popstate', onChange)
  },
}

/**
 * 内存档：路径只活在这个对象里，不碰地址栏、不进浏览器历史。
 * 给「宿主页面的 URL 不归我们」的场合用（宿主里的 Stream 面板）。代价是没有深链、后退键管不到层级。
 */
export function createMemorySubRouteLocation(initial = '/'): SubRouteLocation {
  let path = initial
  const listeners = new Set<() => void>()
  return {
    pathname: () => path,
    push: (next) => {
      if (next === path) return
      path = next
      for (const fn of listeners) fn()
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => { listeners.delete(onChange) }
    },
  }
}

const SubRouteLocationContext = createContext<SubRouteLocation>(browserSubRouteLocation)

/** 给一棵子树换一个路径存放处。不包 = 用地址栏（主应用的常态）。
 *  用 `createElement` 而不是 JSX，纯粹为了这个文件留在 `.ts`——它被两个频道按显式
 *  `'../hooks/useSubRoute.ts'` 引着，改后缀要连带改每一处引用，不值当。 */
export function SubRouteLocationProvider({ location, children }: {
  location: SubRouteLocation
  children: ReactNode
}): ReactElement {
  return createElement(SubRouteLocationContext.Provider, { value: location }, children)
}

/** 当前子树的路径存放处。频道自己要拼 base 时（影视的 `videoBase`）直接读它。 */
export function useSubRouteLocation(): SubRouteLocation {
  return useContext(SubRouteLocationContext)
}

export function useSubRoute<S>(parseFrom: (pathname: string) => S, toPath: (selection: S) => string): {
  selection: S
  navigate: (selection: S) => void
} {
  const loc = useSubRouteLocation()
  const [selection, setSelection] = useState<S>(() => parseFrom(loc.pathname()))

  useEffect(() => {
    // 路径被外力改了（前进/后退）——按新路径重新推导选择。
    return loc.subscribe(() => setSelection(parseFrom(loc.pathname())))
  }, [loc, parseFrom])

  const navigate = (next: S) => {
    // app 内的选择才是真相源：先落它，这样即使路径写不进去也不会把用户困在旧的那一层。
    setSelection(next)
    loc.push(toPath(next))
  }

  return { selection, navigate }
}
