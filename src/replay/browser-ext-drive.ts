/**
 * 采集侧的 driver —— **翻译层从共享库拿，这里只加编排层那几格**。
 *
 * 翻译层（goto / click / type / scroll / exists…）住在
 * `shared/browser-relay/ext-page.ts`，因为没有 Stream 后端的宿主（`@streamapp/desktop`）也要
 * 用它。本文件加回来的是**认识采集概念**的那几个动词——信息流第 N 条、身份为 X 的那张卡、
 * 按字段表抽卡、读 SSR 全局态——它们按值依赖 `dom-harvest` / `card-id` / `recipe` 的类型，
 * 那几样只对采集有意义，不能进共享库（`closure.test.ts` 钉着「库内运行时不许 import `src/`」）。
 *
 * 这条分层曾经破过一次：翻译层被整份复制进插件包，两份拷贝随后静默分家（细节见
 * `shared/browser-relay/page-driver.ts` 的头注）。往下加动词之前先判它属于哪一层。
 */
import type { PageDriver } from './actions.ts'
import type { DomFieldSpec } from './recipe.ts'
import { extractCards } from './dom-harvest.ts'
import { CARD_ID_RE_SOURCE, VISIBLE_EL_FN_SOURCE } from './card-id.ts'
import {
  makeExtPageDriver as makeBasePageDriver,
  makeExtRawPage,
  type ExtDriveOptions,
  type ExtRawPage,
  type RawPageRelay,
} from '../../shared/browser-relay/ext-page.ts'

// 老门面：这三样此前由本文件定义，几处 import 冲着它来，原样转出去。
export { makeExtRawPage }
export type { ExtRawPage, RawPageRelay }

/** 本文件这一层的注入点。翻译层自己的开关见 `ExtDriveOptions`。 */
export type ExtDriveDeps = Pick<ExtDriveOptions, 'onDebug'>

const NAME_SHIM = 'const __name=(f)=>f;'

/**
 * One in-page expression that walks a dot-path off `window` and flattens the result to
 * plain JSON *before* it crosses the CDP boundary.
 *
 * The flatten is not a nicety: a modern SPA store (xhs hydrates `__INITIAL_STATE__` into a
 * Vue reactive Proxy) is invisible to V8's value serializer — `Runtime.evaluate` with
 * returnByValue hands the backend `{}` for it, so a raw read looks like "the page has no
 * data" when the data is right there. `JSON.stringify` runs IN the page, where the Proxy's
 * get/ownKeys traps still fire, so it materializes the real values. A store that cannot be
 * stringified (cycles) falls back to the raw value rather than failing the read.
 */
export function readStateExpr(statePath: string): string {
  return `(()=>{const segs=${JSON.stringify(statePath)}.split('.');let cur=window;` +
    `for(const s of segs){cur=cur==null?cur:cur[s];}` +
    `if(cur==null)return cur;try{return JSON.parse(JSON.stringify(cur))}catch(e){return cur}})()`
}

/**
 * "点开身份为 `identity` 的那张卡" 的页内表达式：候选里取**第一个看得见的**，返回它的中心点。
 *
 * 导出是为了能单测**真正发出去的那个字符串**——页内代码没有别的办法验（假 rawPage 只按子串
 * 回答，验不到取谁）。一张卡带好几个同 id 的 anchor，其中一个是 `display:none`、rect 全 0、
 * 中心点是 (0,0)：取文档序第一个就是点在页面左上角（见 VISIBLE_EL_FN_SOURCE 的头注）。
 *
 * 一个可见候选都没有 → `null` → `openTarget` 返回 false → runner 走 `fallbackUrl`。**这是对的**：
 * 点一个看不见的元素不是"尽力而为"，是往一个未知的地方点一下（左上角常常正是站点 logo）。
 */
export function openTargetExpr(selector: string, identity: string): string {
  return (
    `(()=>{const id=${JSON.stringify(identity)};const vis=${VISIBLE_EL_FN_SOURCE};` +
    `for(const el of document.querySelectorAll(${JSON.stringify(selector)})){` +
    `if(!String(el.getAttribute('href')||'').includes(id))continue;` +
    `if(!vis(el))continue;` +
    `const r=el.getBoundingClientRect();` +
    `return{x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)}}` +
    `return null})()`
  )
}

/** extractCards runs in-page over querySelectorAll(itemSelector) — same extraction as the Playwright $$eval path. */
function readItemsExpr(itemSelector: string, fields: Record<string, DomFieldSpec>): string {
  return `(() => { ${NAME_SHIM} const extractCards=${extractCards.toString()}; const els=Array.from(document.querySelectorAll(${JSON.stringify(
    itemSelector,
  )})); return extractCards(els, ${JSON.stringify(fields)}); })()`
}

/**
 * 采集用的 `PageDriver`：共享的翻译层 + 本文件这几格编排层动词。
 *
 * 展开顺序是**先共享后本地**——本地这几格不覆盖翻译层的任何一格（它们的名字互不相交，
 * 覆盖了就是分层错了）。`clickAt` 从共享那份拿：`openItem` / `openTarget` 自己算坐标，落到
 * 页面上仍走同一套可信手势与同一份光标位置。
 */
export function makeExtPageDriver(raw: ExtRawPage, deps: ExtDriveDeps = {}): PageDriver {
  const base = makeBasePageDriver(raw, { onDebug: deps.onDebug })
  return {
    ...base,
    async readViewport(selector: string): Promise<Array<{ id: string; top: number; height: number }>> {
      // ONE entry per feed card, viewport-only — same contract as the cloak driver. A card carries
      // several anchors for the same id (cover + title) and the virtual list keeps a buffer of
      // off-screen cards; both must be dropped or locateCard's index→Y fit is garbage.
      // 身份怎么从 href 抠出来见 card-id.ts（两个 driver 共享同一条规则的正则源码）；
      // "看得见"用同一份 vis（一张卡带一个 display:none 的同 id anchor，rect 全 0——它要是混进来，
      // 就是一条永远"在视口里"、坐标恒为 (0,0) 的假卡，把 known 和 index→Y 拟合一起污染）。
      // **先判可见再记 seen**：反过来的话，隐藏的那个先把 id 占了，真卡就被自己的影子挤掉了。
      const out = await raw.evalExpr<Array<{ id: string; top: number; height: number }>>(
        `(()=>{const re=new RegExp(${JSON.stringify(CARD_ID_RE_SOURCE)});const vis=${VISIBLE_EL_FN_SOURCE};` +
          `const vh=window.innerHeight;const seen=new Set();const out=[];` +
          `for(const el of document.querySelectorAll(${JSON.stringify(selector)})){` +
          `const m=String(el.getAttribute('href')||'').split(/[?#]/)[0].match(re);if(!m)continue;` +
          `if(seen.has(m[1]))continue;` +
          `if(!vis(el))continue;` +
          `const r=el.getBoundingClientRect();if(r.bottom<=0||r.top>=vh)continue;` +
          `seen.add(m[1]);out.push({id:m[1],top:Math.round(r.top),height:Math.round(r.height)});}` +
          `return out})()`,
      )
      return Array.isArray(out) ? out : []
    },
    async findCard(selector: string, identity: string) {
      // see the cloak driver's findCard — same contract: the target's REAL document Y when the DOM
      // still holds its (possibly off-screen) card, null when it doesn't.
      const out = await raw.evalExpr<{ docY: number; scrollY: number; viewportH: number } | null>(
        `(()=>{const id=${JSON.stringify(identity)};const vis=${VISIBLE_EL_FN_SOURCE};` +
          `const hits=[...document.querySelectorAll(${JSON.stringify(selector)})]` +
          `.filter((el)=>String(el.getAttribute('href')||'').includes(id));` +
          `const el=hits.find(vis)||hits[0];if(!el)return null;` +
          `const r=el.getBoundingClientRect();` +
          `return{docY:Math.round(r.top+window.scrollY),scrollY:Math.round(window.scrollY),viewportH:window.innerHeight}})()`,
      )
      return out ?? null
    },
    async openItem(selector: string, index: number): Promise<void> {
      const rect = await raw.evalExpr<{ x: number; y: number } | null>(
        `(()=>{const els=document.querySelectorAll(${JSON.stringify(
          selector,
        )}); if(!els.length)return null; const el=els[${index}%els.length]; const r=el.getBoundingClientRect(); return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)};})()`,
      )
      if (rect) await base.clickAt(rect.x, rect.y)
    },
    async openTarget(selector: string, identity: string): Promise<boolean> {
      const rect = await raw.evalExpr<{ x: number; y: number } | null>(openTargetExpr(selector, identity))
      if (!rect) return false
      await base.clickAt(rect.x, rect.y)
      return true
    },
    async readItems(itemSelector: string, fields: Record<string, DomFieldSpec>): Promise<Record<string, string>[]> {
      return (await raw.evalExpr<Record<string, string>[]>(readItemsExpr(itemSelector, fields))) ?? []
    },
    async readState(statePath: string): Promise<unknown> {
      // No Input, no focus — a background tab's SSR globals read fine. See readStateExpr
      // for why the value is flattened in-page instead of relying on returnByValue.
      return raw.evalExpr(readStateExpr(statePath))
    },
  }
}
