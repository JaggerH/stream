/**
 * 页面「可交互元素带编号清单」——一次 `cdp_look({inventory:true})` 换掉手写 querySelector 探 DOM。
 *
 * Adapted from Lum1104/dsh-browser (MIT)：可交互选择器与可见性判据改写自
 * `extensions/dsh-browser/src/content/extract.ts`，`data-*` 打标 + 稳定编号的思路来自同目录
 * `ids.ts`。形状换成我们自己的：那边是常驻 content script（编号存在 WeakMap 里），我们没有常驻
 * 脚本、每次注入都是新的执行环境，所以**编号的真相源只能挂在页面上**——`data-stream-el` 属性 +
 * `window.__streamInvSeq` 计数器，重复快照沿用原号、新元素才拿新号。
 *
 * 必须是**表达式**不是语句序列：facility 那条路会把它包成 `(${expression})`。
 *
 * 编号是**会话级脚手架**：页面一刷新（属性和计数器都随文档没了）就全部作废。别把
 * `[data-stream-el="7"]` 写进 recipe——recipe 要的是能重放的稳定选择器。
 */

/** 一个元素名字/值的字符预算。清单是给模型读的，长文本只会挤掉别的元素。 */
const MAX_TEXT = 80

/** 清单条目上限；超了只报 `truncated:true`，不做分页（要更细就自己收窄页面区域再看）。 */
const MAX_ITEMS = 200

/** 编号打在页面上的属性名——`cdp_act({ref})` 解析成的选择器必须与它一致。 */
export const REF_ATTRIBUTE = 'data-stream-el'

/**
 * 每份文档「已经发到几号」挂在 `<html>` 上的属性名。
 *
 * 为什么挂在 DOM 上而不是只挂 `window`：iframe 里的清单跑在**隔离世界**（`Page.createIsolatedWorld`），
 * 那边的 `window` 与页面主世界不是同一个对象，而 DOM 是两边共享的。计数只挂 `window` 的话，
 * 主世界与隔离世界各数各的，同一份文档里就会发出两个 7 号。
 */
export const SEQ_ATTRIBUTE = 'data-stream-seq'

/** `ref:<n>` 展开出的那个选择器，反解回编号；不是这个形状 → null。 */
export function refFromSelector(selector: string | undefined): number | null {
  const m = /^\[data-stream-el="(\d+)"\]$/.exec(selector ?? '')
  return m ? Number(m[1]) : null
}

/** 一份文档当前发到几号（主世界的老计数器与 `<html>` 上的新属性取大）。 */
export function inventorySeqExpression(): string {
  return `(() => { try { var d = document.documentElement; var a = d ? Number(d.getAttribute(${JSON.stringify(SEQ_ATTRIBUTE)})) || 0 : 0; var w = typeof window.__streamInvSeq === 'number' ? window.__streamInvSeq : 0; return Math.max(a, w); } catch (e) { return 0 } })()`
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="option"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[onclick]',
].join(', ')

/**
 * 一段自包含的页内 JS 表达式：扫出可见的可交互元素，编号后返回 JSON 可序列化的清单。
 *
 * 全程 try/catch —— 异常一律回 `{__error}` 而不是抛出去：这条路上抛错会被上游当成「页面挂了 /
 * 注入失败」，而实际只是某个站点的 `getComputedStyle` 在某个诡异节点上炸了，两者的下一步完全不同。
 * @returns 形如 `(() => {...})()` 的表达式源码。
 */
export function inventoryExpression(opts: { floor?: number; maxItems?: number } = {}): string {
  const floor = Math.max(0, Math.floor(opts.floor ?? 0))
  const maxItems = Math.max(0, Math.floor(opts.maxItems ?? MAX_ITEMS))
  return `(() => {
  try {
    var SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    var ATTR = ${JSON.stringify(REF_ATTRIBUTE)};
    var SEQ = ${JSON.stringify(SEQ_ATTRIBUTE)};
    var MAX_ITEMS = ${maxItems};
    var MAX_TEXT = ${MAX_TEXT};
    var w = window;
    var root = document.documentElement;
    // 起点取三者最大：主世界的老计数器、<html> 上的计数（隔离世界与主世界共享它）、调用方给的
    // 下限（跨 iframe 编号时由调用方算出全 tab 的最大号，保证不同文档里不会发出同一个号）。
    w.__streamInvSeq = Math.max(typeof w.__streamInvSeq === 'number' ? w.__streamInvSeq : 0,
      root ? Number(root.getAttribute(SEQ)) || 0 : 0, ${floor});
    var clean = function (s) {
      return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT);
    };
    var visible = function (el) {
      var st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    var all = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
    var items = [];
    var truncated = false;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      if (items.length >= MAX_ITEMS) { truncated = true; break; }
      var n = el.getAttribute(ATTR);
      if (n === null || n === '') {
        w.__streamInvSeq += 1;
        n = String(w.__streamInvSeq);
        el.setAttribute(ATTR, n);
      }
      var tag = el.tagName.toLowerCase();
      var r = el.getBoundingClientRect();
      var text = tag === 'input' ? '' : (el.innerText || el.textContent || '');
      var item = {
        n: Number(n),
        tag: tag,
        name: clean(el.getAttribute('aria-label') || text || el.getAttribute('placeholder') || el.getAttribute('title') || ''),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      };
      var role = el.getAttribute('role');
      if (role) item.role = role;
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        // 口令框的 value 是秘密不是数据——清单会原样进模型上下文，这里不给。
        if (!(tag === 'input' && el.type === 'password')) item.value = clean(el.value);
      }
      if (tag === 'a') {
        var href = el.getAttribute('href');
        if (href) item.href = href;
      }
      items.push(item);
    }
    if (root) root.setAttribute(SEQ, String(w.__streamInvSeq));
    return {
      url: location.href,
      title: document.title,
      count: items.length,
      truncated: truncated,
      items: items,
      seq: w.__streamInvSeq
    };
  } catch (e) {
    return { __error: String(e) };
  }
})()`
}
