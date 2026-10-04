/**
 * 弹窗的引导兜底（对应 index.html 里的 `#boot-fallback`）。
 *
 * 单独成模块只为一件事：**可测**。这两条逻辑的失效方式都是"弹窗什么都不显示"——
 * 屏幕上和"没弹出来"长得一模一样、没有任何一处会喊，所以必须有测试钉着。
 */

const FALLBACK_ID = 'boot-fallback'
const ERROR_ID = 'boot-error'

/** 把一个抛出来的东西写进兜底里显示。兜底已被摘掉（React 已挂载）时什么都不做。 */
export function showBootError(err: unknown, doc: Document = document): void {
  const slot = doc.getElementById(ERROR_ID)
  if (!slot) return
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  // 追加而不是覆盖：module script 加载失败会一口气发好几个 error 事件（每个 <script> 一个），
  // 只留最后一个的话，最先失败、也最能说明病因的那个就没了。
  slot.textContent = slot.textContent ? `${slot.textContent}\n${text}` : text
}

/**
 * `#root` 一有内容就把兜底摘掉。
 *
 * 判据是 DOM 真的长出了东西——不是 `render()` 调用返回。返回一个取消函数（测试用；
 * 弹窗自己不需要取消，页面关了一起没）。
 */
export function dismissWhenMounted(doc: Document = document): () => void {
  const root = doc.getElementById('root')
  const fallback = doc.getElementById(FALLBACK_ID)
  if (!root || !fallback) return () => {}

  const drop = () => fallback.remove()
  if (root.childElementCount > 0) {
    drop()
    return () => {}
  }
  const obs = new MutationObserver(() => {
    if (root.childElementCount > 0) {
      drop()
      obs.disconnect()
    }
  })
  obs.observe(root, { childList: true })
  return () => obs.disconnect()
}
