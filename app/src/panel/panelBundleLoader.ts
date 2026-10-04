/**
 * 「按需装一个面板附属 IIFE bundle」的**唯一一份**装载逻辑。
 *
 * 面板主 bundle 必须是 IIFE（跨源 `<script type=module>` 要 CORS，见 `entry.tsx` 头注），
 * 而 IIFE/UMD 格式下 Rollup 没有跨 chunk 的模块加载器——动态 `import()` 会**静默内联回主
 * 文件**（实测：加 `React.lazy` 后 `panel.js` 2224.35KB → 2224.73KB，没有任何报错）。所以
 * 真正的分包只能是"第二个/第三个独立的 IIFE bundle + 手工注入 `<script>`"，跟
 * `hosts/dsh` 的 `host.ts` 装主 bundle 是同一个模式（`globalThis.__streamXxx` +
 * `mount`/`unmount`）。
 *
 * **为什么是一份工厂而不是每个 bundle 各抄一遍**：这条链路上的坑全是"失败得很安静"那一类
 * （见下面 `load` 的注释：死 `<script>` 泄漏、两个失败出口只清了一个），已经在 host.ts 上
 * 修过三轮。每多一个附属 bundle 就多抄一份，等于把那三轮教训重新赌一次。往后再加第四个
 * bundle，只在这里 `createPanelBundleLoader(...)` 一行。
 *
 * `load` 是**对象方法**（不是裸函数导出）是为了让测试能 `vi.spyOn(xxxBundle, 'load')` 换成
 * 直接 import 那份 entry 的 `{ mount, unmount }`——跳过真的网络脚本加载（jsdom 里
 * `<script src>` 不会真的取网执行），但仍然跑真实的 mount/unmount 逻辑，不是自造一个假的。
 */
export interface PanelBundleSpec {
  /** 注入的 `<script>` / `<link>` 上那个标记属性名，也是"这份装过没有"的单例判据。 */
  marker: string
  /** IIFE 挂到全局的名字（`vite.panel.config.ts` 里那份表的 `global`）。 */
  globalName: string
  /** 产物基名：`panel-detail` → `/panel/panel-detail.js` + `/panel/panel-detail.css`。 */
  file: string
  /** 报错里给人看的名字，如「详情」「影视」。 */
  label: string
}

export interface PanelBundleLoader<T> {
  load: (backend: string) => Promise<T>
}

export function createPanelBundleLoader<T>(spec: PanelBundleSpec): PanelBundleLoader<T> {
  let cached: Promise<T> | undefined

  function ensureStylesheet(backend: string): void {
    if (document.querySelector(`link[${spec.marker}]`) !== null) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.setAttribute(spec.marker, '')
    link.href = `${backend}/panel/${spec.file}.css`
    document.head.appendChild(link)
  }

  return {
    /**
     * 装一次、全程复用；装失败清掉缓存，允许下次重试。
     *
     * 清理是**集中在一处**的（同 `hosts/dsh` 的 `host.ts` 的 `openPanel`）：不管失败
     * 发生在哪一步——script 的 `error` 事件本身、还是 `load` 了但没设出全局——都汇到同一个
     * `catch` 里把这次装的 script 摘掉。这条链路比 host.ts 简单（没有"已有 script 复用"分支，
     * `cached` 一失效下次就是全新元素，不会卡死在死元素上），但不摘的后果同样是泄漏：每失败
     * 重试一次，`<head>` 里就多一个再也不会 fire 任何事件的死 `<script>`。
     */
    load(backend: string): Promise<T> {
      if (cached !== undefined) return cached
      const promise = (async (): Promise<T> => {
        ensureStylesheet(backend)
        const script = document.createElement('script')
        try {
          script.setAttribute(spec.marker, '')
          // 同 host.ts：跨源脚本抛异常默认只报 "Script error."，加上它才拿得到真实堆栈。
          script.crossOrigin = 'anonymous'
          script.src = `${backend}/panel/${spec.file}.js`
          return await new Promise<T>((resolve, reject) => {
            script.addEventListener('load', () => {
              const bundle = (globalThis as Record<string, unknown>)[spec.globalName] as T | undefined
              if (bundle === undefined) { reject(new Error(`${spec.label} bundle 加载了但没有导出 ${spec.globalName}`)); return }
              resolve(bundle)
            })
            script.addEventListener('error', () => reject(new Error(`${spec.label} bundle 加载失败`)))
            document.head.appendChild(script)
          })
        } catch (e) {
          script.remove()
          cached = undefined
          throw e
        }
      })()
      cached = promise
      return promise
    },
  }
}
