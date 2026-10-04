/**
 * 导航里每个「空间」自己的折叠态（哪几组收起来了）。
 *
 * **和「整条侧栏收窄」是两个状态，别搅在一起**：侧栏收不收窄是宿主的几何（DSH 里收窄时整棵
 * 导航不渲染，独立正门不做这一档）；这里存的是宽侧栏里**某一组**折起来了，只藏那一组的
 * 频道行，空间行还在。
 *
 * 两者独立的机制钉子有两根：(1) 这个 store 建在模块级、不随 NavTree 的挂载/卸载生灭——
 * 宿主把导航收掉再展开回来，读到的还是原值；(2) 值落 localStorage，刷新后仍在。少了第一根，
 * "收窄再展开"就会把用户刚折起来的组弹回展开态（组件 state 跟着卸载没了），而这既不报错
 * 也不好复现。
 *
 * key 前缀刻意用 `stream.`：面板住在别人的页面里，同一个 localStorage 域，别撞宿主的名字。
 */

/** localStorage 的 key。 */
export const SPACE_COLLAPSE_KEY = 'stream.sidebar.spaces'

export interface SpaceCollapseStore {
  subscribe: (fn: () => void) => () => void
  /** 收起来的空间 id。引用稳定——只有 toggle 换新 Set。 */
  getSnapshot: () => ReadonlySet<string>
  toggle: (id: string) => void
}

/**
 * 读回收起来的空间 id。存的是 id 数组；读到任何不认识的形状都当"一个都没收起来"——
 * 这是别人也能写的一个 key，读不出来就当没存过，绝不因此弄崩导航。
 * @param key - localStorage key。
 * @returns 起始集合。
 */
function loadIds(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    // 读不出来就当没存过（隐私模式 / 配额 / 别人写坏了）。
  }
  return new Set()
}

/**
 * 建一个"哪些空间被收起来了"的 store。
 *
 * **存的是收起来的那些**，不是展开的那些：新建一个空间时它默认展开（不在集合里），
 * 这是用户刚建完想往里放东西时唯一合理的状态。反过来存"展开的"会让每个新空间默认收起。
 * @param key - localStorage key，默认 {@link SPACE_COLLAPSE_KEY}（测试用它换隔离的 key）。
 * @returns useSyncExternalStore 形状的 store + 一个按 id 的 toggle。
 */
export function createSpaceCollapseStore(key: string = SPACE_COLLAPSE_KEY): SpaceCollapseStore {
  let ids = loadIds(key)
  const listeners = new Set<() => void>()
  return {
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    getSnapshot: () => ids,
    toggle: (id) => {
      const next = new Set(ids)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      ids = next
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        // 写不进去只丢掉"记住"这一项，本次折叠照常生效。
      }
      for (const fn of [...listeners]) fn()
    },
  }
}

/**
 * 导航共用的那一份折叠态。模块级：NavTree 挂载/卸载不该重置用户折起来的那几组
 * （见文件头注的第一根钉子）。
 */
export const spaceCollapse: SpaceCollapseStore = createSpaceCollapseStore()
