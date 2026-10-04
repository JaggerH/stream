/**
 * 把 Stream 打出来的一份 bundle（`<script>` + `<link>`）装进 DSH 那一页。
 *
 * 有两个宿主用它：主面板（`host.ts`，壳的主区）和运维页（`manage-host.ts`，DSH 设置里那个
 * Stream 分区）。抽出来是因为**这里每一条都是踩出来的**，复制第二份等于赌第二份也记得住：
 *
 * - **跨源用普通 `<script>` 不用 module**：`type="module"` 要 CORS，普通 script 与
 *   `<link rel=stylesheet>` 不要。
 * - **`crossOrigin="anonymous"` 不能删**：跨源脚本抛异常时浏览器默认只给一句没有文件名和
 *   行号的 "Script error."。配合 `/panel/*` 的 CORS 头才拿得到真实堆栈——真栽过一次
 *   （产物里 `process is not defined`，在那一页上什么都看不出来）。
 * - **脚本装一次全程复用，样式表跟着挂载走**：bundle 的 React root 是模块级单例，脚本重复
 *   装没有意义；而样式表要在 unmount 时摘掉，下一次挂载必须能重新种回去——即使脚本早就装好、
 *   `load` 走了早退分支。两件事因此是两个函数，**别合并**：合在一起正是主面板那个"关了不
 *   生效"的成因（早退分支把样式表也一起跳过了）。
 * - **失败要清死元素**：script 加载失败、或者真的 load 了但没设出全局（产物过期之类，
 *   `error` 事件永远不来），都得把 DOM 里那个死 `<script>` 摘掉。留着的话下一次重试会走
 *   "已有 script"分支、把监听挂到一个已经 settle 过的元素上——那次重试永久 pending。
 */

/** 一份 bundle 的装载器。`marker` 同时用作 script/link 的 data 属性名，两个 bundle 别撞。 */
export interface AssetLoader<T> {
  /** 保证 `<link>` 在文档里（幂等）——每次挂载都调。 */
  ensureStylesheet: (backend: string) => void
  /** 装脚本并交出全局导出。失败时已经把死元素清干净，可以直接重试。 */
  load: (backend: string) => Promise<T>
  /** 摘掉样式表（unmount 时调；脚本单例保留复用）。 */
  removeStylesheet: () => void
}

export function createAssetLoader<T>(opts: {
  /** 产物基名，如 `panel` / `panel-manage`（对应 `/panel/<file>.js|.css`）。 */
  file: string
  /** DOM 上的标记属性，如 `data-stream-panel`。两个 bundle 必须不同，否则互相摘对方的样式表。 */
  marker: string
  /** IIFE 挂上去的全局名，如 `__streamPanel`。 */
  globalName: string
  /** 出错文案里的人话名字。 */
  label: string
}): AssetLoader<T> {
  const scriptSel = `script[${opts.marker}]`
  const linkSel = `link[${opts.marker}]`
  const global = (): T | undefined => (globalThis as Record<string, unknown>)[opts.globalName] as T | undefined

  const ensureStylesheet = (backend: string): void => {
    if (document.querySelector(linkSel) !== null) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.setAttribute(opts.marker, '')
    link.href = `${backend}/panel/${opts.file}.css`
    document.head.appendChild(link)
  }

  const loadScript = (backend: string): Promise<void> => {
    if (global() !== undefined) return Promise.resolve()
    const existing = document.querySelector(scriptSel)
    if (existing !== null) {
      // 已经有一次装载在跑：别假装装好了直接 resolve——那时候全局多半还是 undefined。
      // 挂上监听，跟第一个调用方等同一件事。这里不摘死元素（那是下面集中清理的事）。
      return new Promise((resolve, reject) => {
        existing.addEventListener('load', () => resolve())
        existing.addEventListener('error', () => reject(new Error(`${opts.label} bundle 加载失败（Stream 后端没起，或还没 build:panel）`)))
      })
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.setAttribute(opts.marker, '')
      script.crossOrigin = 'anonymous'
      script.src = `${backend}/panel/${opts.file}.js`
      script.addEventListener('load', () => resolve())
      script.addEventListener('error', () => reject(new Error(`${opts.label} bundle 加载失败（Stream 后端没起，或还没 build:panel）`)))
      document.head.appendChild(script)
    })
  }

  return {
    ensureStylesheet,
    load: async (backend) => {
      try {
        await loadScript(backend)
        const loaded = global()
        if (loaded === undefined) throw new Error(`${opts.label} bundle 加载了但没有导出 ${opts.globalName}`)
        return loaded
      } catch (e) {
        document.querySelector(scriptSel)?.remove()
        document.querySelector(linkSel)?.remove()
        throw e
      }
    },
    removeStylesheet: () => { document.querySelector(linkSel)?.remove() },
  }
}
