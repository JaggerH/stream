/**
 * 导航树（「空间 → 频道」）的样式表。
 *
 * **配色只走 `--stream-nav-*` 这一组 token**，默认值就定义在这里，跟着 `data-ds-dark-theme`
 * （面板判明暗的那个属性，见 `../hostTheme.ts`）给明暗两套。宿主想让它长成自己的样子，就在
 * 挂载容器上覆盖这几个变量（DSH 壳把它们一对一指到 `--dsw-alias-*`）——**默认值定义在 `:root`
 * 上而不是导航根上**，就是为了让容器上那份覆盖能被继承下来：写在导航根元素上的声明会压过
 * 祖先继承来的值，那样宿主的覆盖会静默失效。
 *
 * 默认值的数值抄自 DSH 主题包自己那份 `design-platform.css`（明暗两套的 `--dsw-alias-*` →
 * `--dsw-static-*` 解析到底），不是目测出来的近似色；**只抄数值、不引它的类名/变量名**——
 * 那些名字不在包的 `exports` 里，引用它下一次升级就静默失效（样式没了，不报错）。
 *
 * 几何（行高、槽宽、缩进、hover 规则）逐条抄自 DSH 工作区浏览器，好让「Stream → 空间 → 频道」
 * 和它上面的「工作区 → 工作区 → 会话」看起来是同一套东西。
 *
 * **为什么是 CSS 而不是 inline style**：有三条 inline style 表达不了、而它们恰好就是"看起来像
 * DSH"的全部——`:hover` 换底色、`:hover` 把文件夹图标换成折叠箭头、`:hover` 才露出行尾功能区。
 * 用 React 的 hover state 顶替等于把浏览器已经做对的事重做一遍，还会在快速划过时漏掉 mouseleave。
 *
 * 类名一律 `stream-nav-` 前缀：面板和宿主同一个文档，别撞它的名字。
 */

/** `<style>` 元素的 id——重复挂载只留一份。 */
const STYLE_ID = 'stream-nav-styles'

const CSS = `
:root{
  --stream-nav-label-primary: rgb(15, 17, 21);
  --stream-nav-label-secondary: rgb(97, 102, 107);
  --stream-nav-label-tertiary: rgb(129, 133, 140);
  --stream-nav-label-caption: rgb(173, 178, 184);
  --stream-nav-hover-bg: rgba(38, 49, 72, 0.06);
  --stream-nav-active-bg: rgba(38, 49, 72, 0.06);
  --stream-nav-border: rgba(0, 0, 0, 0.04);
  --stream-nav-accent: rgb(65, 118, 230);
  --stream-nav-error: rgb(236, 19, 19);
  --stream-nav-surface: rgb(255, 255, 255);
  --stream-nav-inline-padding: 12px;
  --stream-nav-ease: cubic-bezier(0.4, 0, 0.2, 1);
}
body[data-ds-dark-theme]{
  --stream-nav-label-primary: rgb(249, 250, 251);
  --stream-nav-label-secondary: rgb(207, 211, 214);
  --stream-nav-label-tertiary: rgb(173, 178, 184);
  --stream-nav-label-caption: rgb(129, 133, 140);
  --stream-nav-hover-bg: rgba(255, 255, 255, 0.08);
  --stream-nav-active-bg: rgba(255, 255, 255, 0.08);
  --stream-nav-border: rgba(255, 255, 255, 0.06);
  --stream-nav-accent: rgb(103, 158, 254);
  --stream-nav-error: rgb(242, 90, 90);
  --stream-nav-surface: rgb(28, 28, 30);
}

/* 根容器：浮层（菜单/对话框）都是它的绝对定位子元素，所以它必须是定位上下文。 */
.stream-nav-root{position:relative;box-sizing:border-box;padding:2px var(--stream-nav-inline-padding) 6px;
  color:var(--stream-nav-label-primary);font-size:14px;overflow-y:auto;overflow-x:hidden}

/* 宿主给了 footer 那一档：根变成竖排 flex（自己不滚），树在中间滚，footer 钉在底下。
   padding 从根挪进滚动区，好让 footer 的上边框横贯整列。 */
.stream-nav-root.stream-nav-has-footer{display:flex;flex-direction:column;overflow:hidden;padding:0}
.stream-nav-scroll{flex:1;min-height:0;box-sizing:border-box;padding:2px var(--stream-nav-inline-padding) 6px;
  overflow-y:auto;overflow-x:hidden}
.stream-nav-footer{flex:none;display:flex;align-items:center;gap:4px;
  padding:6px var(--stream-nav-inline-padding);border-top:1px solid var(--stream-nav-border)}
.stream-nav-footer-button{cursor:pointer;height:32px;padding:0 8px;font:inherit;font-size:13px;
  color:var(--stream-nav-label-secondary);background:0 0;border:none;border-radius:8px;
  align-items:center;gap:6px;display:inline-flex}
.stream-nav-footer-button:hover{background:var(--stream-nav-hover-bg);color:var(--stream-nav-label-primary)}
/* 明暗那颗只有图标，第一格「管理」把它推到右边。 */
.stream-nav-footer-icon{margin-left:auto;width:32px;justify-content:center;padding:0}

/* 这一行**不许** overflow:hidden：「新建」菜单是它里面一个 absolute 的浮层，裁了就是"点了没内容"
   （活体 2026-09-06）。省略号归下面的 label 自己管。 */
.stream-nav-sec-header{box-sizing:border-box;height:36px;color:var(--stream-nav-label-tertiary);border-radius:12px;flex:none;align-items:center;gap:4px;margin:2px 0 4px;padding-left:4px;display:flex;position:relative}
.stream-nav-sec-label{white-space:nowrap;text-overflow:ellipsis;min-width:0;flex:1;line-height:20px;overflow:hidden}
.stream-nav-sec-actions{flex:none;align-items:center;gap:4px;display:flex;position:relative}
.stream-nav-sec-icon{cursor:pointer;width:28px;height:28px;color:var(--stream-nav-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.stream-nav-sec-icon:hover{background:var(--stream-nav-hover-bg)}

/* 行与行之间留 2px。**贴在一起的两行，hover 底色和选中底色会连成一整块**，看起来像选中了两行。
   组与组之间 4px。 */
.stream-nav-space-row,.stream-nav-chan-row{box-sizing:border-box;cursor:pointer;user-select:none;width:100%;margin-top:2px;color:var(--stream-nav-label-primary);text-align:left;font:inherit;background:0 0;border:none;border-radius:8px;align-items:center;gap:6px;padding:0 8px;display:flex}
.stream-nav-group+.stream-nav-group{margin-top:4px}
/* 拖着频道悬在这一组上：整组描一圈主题色，说"松手就放这儿"。 */
.stream-nav-group{border-radius:12px;outline:2px solid transparent;outline-offset:-2px;transition:outline-color .12s var(--stream-nav-ease)}
.stream-nav-group.stream-nav-drop-target{outline-color:var(--stream-nav-accent);background:var(--stream-nav-hover-bg)}
.stream-nav-chan-row[draggable=true]{cursor:grab}
.stream-nav-chan-row[draggable=true]:active{cursor:grabbing}
.stream-nav-space-row:hover,.stream-nav-chan-row:hover{background:var(--stream-nav-hover-bg)}
.stream-nav-chan-row.stream-nav-selected{background:var(--stream-nav-active-bg)}
.stream-nav-space-row{height:34px;position:relative}
.stream-nav-space-row .stream-nav-row-actions{height:20px}
.stream-nav-chan-row{height:32px;gap:0}
.stream-nav-chan-row .stream-nav-title{flex:1;margin:0 6px 0 4px}
.stream-nav-chan-row:disabled{cursor:not-allowed;color:var(--stream-nav-label-tertiary)}
.stream-nav-chan-row:disabled:hover{background:0 0}

.stream-nav-slot{width:16px;height:20px;color:var(--stream-nav-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}
.stream-nav-title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}
.stream-nav-attention{flex:none;width:8px;height:8px;border-radius:50%;background:#e5484d;margin-right:6px}
.stream-nav-space-text{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}

.stream-nav-space-row .stream-nav-chevron{display:none}
.stream-nav-space-row:hover .stream-nav-chevron{display:inline-flex}
.stream-nav-space-row:hover .stream-nav-folder{display:none}
/* 文件夹图标染主题色 = 「当前看的那个频道在这一组里」。不是装饰——收起来的组一眼看不出
   里面有没有你正在看的东西。 */
.stream-nav-folder-active{color:var(--stream-nav-accent)}
.stream-nav-chevron{color:var(--stream-nav-label-caption)}
.stream-nav-arrow{transition:transform .15s var(--stream-nav-ease)}
.stream-nav-arrow-open{transform:rotate(90deg)}

.stream-nav-row-actions{flex:none;align-items:center;gap:12px;display:none}
.stream-nav-space-row:hover .stream-nav-row-actions,.stream-nav-space-row.stream-nav-menu-open .stream-nav-row-actions{display:inline-flex}
.stream-nav-space-row.stream-nav-menu-open{background:var(--stream-nav-hover-bg)}
.stream-nav-icon-button{cursor:pointer;width:16px;height:16px;color:var(--stream-nav-label-tertiary);background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}
.stream-nav-icon-button:hover{color:var(--stream-nav-label-primary)}

.stream-nav-empty{color:var(--stream-nav-label-tertiary);padding:4px 8px 4px 28px;font-size:12px;line-height:18px}
.stream-nav-error{color:var(--stream-nav-error);padding:4px 8px;font-size:12px;line-height:18px}

/* 浮层一律就地渲染、不 portal：portal 到宿主 body 会拿宿主的配色，还有多实例 body 锁那一类坑。
   菜单挂在触发它的那一行/那一块里（position:relative 的祖先），对话框挂在导航根上。 */
.stream-nav-menu{position:absolute;z-index:30;top:100%;right:0;min-width:132px;margin-top:4px;padding:4px;
  background:var(--stream-nav-surface);border:1px solid var(--stream-nav-border);border-radius:10px;
  box-shadow:0 8px 24px rgba(0,0,0,.18)}
.stream-nav-menu button{display:flex;align-items:center;width:100%;height:32px;padding:0 10px;font:inherit;font-size:13px;
  color:var(--stream-nav-label-primary);background:0 0;border:none;border-radius:6px;cursor:pointer;text-align:left}
.stream-nav-menu button:hover:not(:disabled){background:var(--stream-nav-hover-bg)}
.stream-nav-menu button:disabled{color:var(--stream-nav-label-tertiary);cursor:not-allowed}
.stream-nav-menu button.stream-nav-danger{color:var(--stream-nav-error)}

/* 弹窗 fixed 铺满视口，不是 absolute 关在侧栏那一列里：DOM 仍留在导航容器内（宿主写在容器上的
   token 覆盖照样生效、不需要 portal、不需要跟内容 root 通信），只是画到整页上。前提是导航的祖先
   没有 transform / filter（有就变成相对那个祖先），独立正门与 DSH 壳都没有。 */
.stream-nav-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:12px;background:rgba(0,0,0,.32)}
.stream-nav-dialog{box-sizing:border-box;width:100%;max-width:320px;padding:16px;background:var(--stream-nav-surface);
  border:1px solid var(--stream-nav-border);border-radius:12px;color:var(--stream-nav-label-primary)}
.stream-nav-dialog h2{margin:0 0 8px;font-size:15px;font-weight:600}
.stream-nav-dialog p{margin:0 0 12px;font-size:12px;line-height:18px;color:var(--stream-nav-label-secondary)}
.stream-nav-dialog label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--stream-nav-label-secondary)}
.stream-nav-dialog input,.stream-nav-dialog select{box-sizing:border-box;width:100%;height:32px;padding:0 8px;font:inherit;font-size:13px;
  color:var(--stream-nav-label-primary);background:0 0;border:1px solid var(--stream-nav-border);border-radius:8px}
.stream-nav-dialog-fields{display:flex;flex-direction:column;gap:12px;margin-top:12px}
.stream-nav-dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.stream-nav-dialog-footer button{font:inherit;font-size:13px;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;
  background:0 0;border:1px solid var(--stream-nav-border);color:var(--stream-nav-label-primary)}
.stream-nav-dialog-footer button:disabled{opacity:.5;cursor:not-allowed}
.stream-nav-dialog-footer button.stream-nav-primary{background:var(--stream-nav-accent);border-color:var(--stream-nav-accent);color:#fff}

@media (prefers-reduced-motion:reduce){.stream-nav-arrow{transition:none}}
`

/**
 * 把上面那段样式挂进文档（幂等）。
 *
 * 在 NavTree 首次渲染时同步调用而不是放进 effect：第一帧就得带着样式画出来，晚一帧就是
 * 一次可见的无样式闪烁。SSR / 没有 document 的环境安静跳过。
 */
export function ensureNavStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.append(el)
}
