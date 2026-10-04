/**
 * 输入框里那个**引用格子**的两处修补——覆盖 DSH 的内部实现，所以这份文件解释得比它长。
 *
 * ## 那个格子是什么
 *
 * 一条引用在草稿里**只占一个字符**（U+FFFC）；引用的身份（source / id / label）在 DSH 自己
 * 的 occurrence 表里，不在文字里。输入框是**三层叠**的：透明文字的真 textarea（管光标与
 * 编辑）、量高度的镜像层、画装饰的高亮层——高亮层扫到那个字符，就在原位画一个
 * `<span data-decoration="chip" title="全标题"><span>标题</span></span>`。**格子的宽度就是
 * 那一个字符的字宽**，来自 DSH 内嵌的一份 620 字节字体 `DshChipCell`（U+FFFC 定死 4 em）。
 *
 * ## 病根：标题是**居中**的，所以两头一起被切
 *
 * 里面那层标题是 `display:flex;justify-content:center` + `overflow:hidden` + `text-overflow:clip`
 * 的绝对定位盒子。内容比盒子宽时，居中意味着**左右同时溢出**——《我们的家2》被切掉的是两个
 * 书名号，留在中间的反而是信息量最低的那截。**这才是病根，宽度只是次要问题**：光加宽的话，
 * 标题一长照样两头都切，只是切得晚一点。
 *
 * ## 药一：左对齐 + 右侧省略号
 *
 * 认出"引的是哪一条"靠的是标题**开头**那几个字，所以从左往右排、右边收省略号。用
 * `display:block` 而不是改 `justify-content`：`text-overflow` 只对块容器生效，flex 容器里
 * 那段匿名文字吃不到省略号。
 *
 * ## 药二：格子小幅放宽（4 em → 6 em）
 *
 * 对齐修好之后宽度退回成一个独立的小问题：4 em 只放得下三四个字，稳定露出七八个字要 6 em。
 * **改的是字宽，不是 chip 元素**——真实输入框、镜像层、高亮层共用同一个字体栈，改字宽三层
 * 同步变宽，光标和选区不会错位；只把 chip 元素撑宽的话只有高亮层变，引用后面每个字都会和
 * 光标错开，而且错得很安静。
 *
 * 这份 base64 就是 DSH 那份字体原样改一个数（`hmtx` 里 U+FFFC 那个字形的 advance ×1.5，
 * 别的一个字节没动）。`unicode-range` 钉死只管这一个码位：这份字体**只有** U+FFFC 一个
 * 字形，不钉的话它会被拿去顶别的字符，整个输入框变豆腐块。
 *
 * **换了个族名、插在 `DshChipCell` 前面**，而不是同名覆盖——实测（Chrome 141）同族同描述符
 * 的两份 `@font-face`，先声明的那份赢，后声明的那份连载都不载（`document.fonts` 里状态恒为
 * `unloaded`）。代价是要挑中那三层元素：**只认属性、不认类名**。
 *
 * ## 会怎么失效
 *
 * 全咬在 DSH 的内部实现上：`data-input-backdrop` / `data-input-mirror` / `data-decoration`
 * 三个属性。**不咬它的类名**（`uV2eYG_…` 带每次构建都会变的哈希，同一条教训写在面板那份
 * `app/src/panel/nav/nav-styles.ts` 的头注里：只抄数值、不引它的类名/变量名）。DSH 升级后如果这些属性改了名，表现是"格子又窄了、标题又居中了"——不报错，
 * 也不会连累别的东西。判法是在工作台里量这两个数：
 *
 * ```js
 * const s = document.createElement('span')
 * s.style.cssText = 'position:absolute;visibility:hidden;font:16px StreamChipCellWide,DshChipCell'
 * s.textContent = '￼'; document.body.append(s); s.getBoundingClientRect().width  // 期望 96
 * getComputedStyle(document.querySelector('[data-decoration="chip"]>span')).textOverflow // ellipsis
 * ```
 */

/** `<style>` 元素的 id——重复挂载只留一份。 */
const STYLE_ID = 'stream-chip-styles'

/** DSH 那份 `DshChipCell`，U+FFFC 的字宽 ×1.5（4 em → 6 em）。生成方式见文件头注。 */
const WIDE_CHIP_FONT = 'data:font/ttf;base64,AAEAAAAKAIAAAwAgT1MvMkT8WQgAAAEoAAAAYGNtYXAADQBPAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZCxbMtMAAACsAAAANmhoZWEDIharAAAA5AAAACRobXR4GWQAAAAAAYgAAAAIbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lvljk2gAAAdAAAABscG9zdNNweNQAAAI8AAAALQABAAAAAQAAZiqb918PPPUAAwPoAAAAAOaLfcUAAAAA5rl0LgAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAMg/zgAABdwAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAxdwAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAPz8/PwAA//z//AMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAF3AAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAD//P//AAD//P//AAUAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQALAAAAAQAAAAAAAgAHAAsAAwABBAkAAQAWABIAAwABBAkAAgAOAChEc2hDaGlwQ2VsbFJlZ3VsYXIARABzAGgAQwBoAGkAcABDAGUAbABsAFIAZQBnAHUAbABhAHIAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAgZvYmpyZXAAAAA='

const CSS = `
@font-face{font-family:StreamChipCellWide;src:url(${WIDE_CHIP_FONT})format("truetype");unicode-range:U+FFFC}
/* 三层一起换栈（缺一层就是那一层和另外两层错位）：高亮层、镜像层、真实输入框。 */
[data-input-backdrop],[data-input-mirror],[data-input-backdrop]~textarea{font-family:StreamChipCellWide,DshChipCell,var(--dsw-font-family)}
/* 标题从左往右排、右边收省略号（DSH 原样是居中 + clip，两头一起切）。 */
[data-decoration="chip"]>span{display:block;text-align:left;text-overflow:ellipsis}
`

/**
 * 把上面那段样式挂进文档（幂等）。
 *
 * 在插件装载时同步调用而不是等某个组件的 effect：输入框是 DSH 自己画的，我们没有它的渲染
 * 时机，晚一帧就是一次看得见的格子跳宽。SSR / 测试环境没有 document 时安静跳过。
 */
export function ensureChipStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.append(el)
  // 立刻把这一族拉起来。字体是**用到才载**的，不预热的话第一条引用会先按 DSH 那个
  // 4 em 的格子画一帧、字体到位后再跳宽——实测得到过这一跳。
  document.fonts?.load('16px StreamChipCellWide', '￼').catch(() => {
    /* 预热失败无所谓：真用到时还会再载一次，最坏也就是那一帧的跳宽 */
  })
}
