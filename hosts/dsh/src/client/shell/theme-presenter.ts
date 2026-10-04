/**
 * 主题投影：把 ctx.theme 的快照写到 document 上。
 *
 * 这是 ui-layout 里 ThemePresenter 的**语义移植**（它不在那个包的运行时导出面里，
 * 拿不到只能照抄）：root color-scheme、body 的 `data-ds-dark-theme` 属性、token 变量、
 * theme-color meta，四样一起写、一起撤。壳反转关掉 ui-layout 那一行后，没人做这件事
 * 的症状是**整页 token 全空**——所有 `var(--dsw-*)` 失效，DSH 的每个组件都是裸的。
 *
 * `data-ds-dark-theme` 这个属性名同时是 Stream 侧 `hostTheme.ts`（面板明暗跟随）观察的
 * 键——改名两头一起改。
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** body 上选择暗色基底调色板的属性（token 样式表按它分支）。 */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

export class ShellThemePresenter {
  /** 上一次 apply 写过的 token 名——撤销集。 */
  #appliedTokens: string[] = []
  #themeColorMeta: HTMLMetaElement

  constructor() {
    this.#themeColorMeta = document.createElement('meta')
    this.#themeColorMeta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.#appliedTokens) body.style.removeProperty(name)
    this.#appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.#appliedTokens.push(name)
    }
    this.#themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.#themeColorMeta.isConnected) document.head.append(this.#themeColorMeta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.#appliedTokens) body.style.removeProperty(name)
    this.#appliedTokens = []
    this.#themeColorMeta.remove()
  }
}
