/**
 * 一次点击 / 写入之前，目标**到底能不能操作**——以及操作之后，页面**到底收没收到**。
 *
 * 这一层住在共享库里，因为定位与发事件的那份实现（`ext-page.ts` 的 `makeExtPageDriver`）两条
 * transport 共用：扩展的 `chrome.debugger` 与 CDP 绑定的 `CdpRelayOps` 都只是把 `{method,params}`
 * 送进浏览器，谁都不解释选择器。可操作性检查若写在任一侧，另一侧就会漂。
 *
 * 顺序是固定的：存在 → 可见 → 启用 → 滚进视口（等布局稳定）→ 命中测试 → 节点未换。任何一步
 * 不过就返回结构化失败，**不发一个输入事件**。失败码是稳定的字符串，人话原因另给一句。
 *
 * 这里只 import 页面求值面（{@link ActionabilityPage}），不 import `src/`——`closure.test.ts`
 * 钉着共享库的运行时闭包。
 */

/** 稳定的失败分类码。前六个是动作本身的前提；后两个只属于写入。 */
export type ActionFailureCode =
  | 'not-found'
  | 'not-visible'
  | 'disabled'
  | 'covered'
  | 'detached'
  | 'outside-viewport'
  | 'not-editable'
  | 'value-mismatch'

export const ACTION_FAILURE_CODES: readonly ActionFailureCode[] = [
  'not-found',
  'not-visible',
  'disabled',
  'covered',
  'detached',
  'outside-viewport',
  'not-editable',
  'value-mismatch',
]

export function isActionFailureCode(v: unknown): v is ActionFailureCode {
  return typeof v === 'string' && (ACTION_FAILURE_CODES as readonly string[]).includes(v)
}

/** 一句人话原因 + 一个稳定码。`reason` 里可以带元素 / 遮挡元素的简述。 */
export interface ActionFailure {
  code: ActionFailureCode
  reason: string
}

/**
 * 一次点击 / 写入的回执。
 *
 * - `ok:false` 时 `reason` 必有；页面没有收到该动作的任何输入事件。
 * - `ok:true` 且 `delivery:'unconfirmed'` **不是失败**：事件已发出，但页面上没观察到可信的
 *   `click`。调用方要证据时用自己的 `expect`，这里不重试、不把它压成失败。
 */
export interface ActionReceipt {
  ok: boolean
  reason?: ActionFailure
  delivery?: 'confirmed' | 'unconfirmed'
  point?: { x: number; y: number }
}

/** 这一层需要的页面求值面；`ExtRawPage` 结构上满足它。 */
export interface ActionabilityPage {
  evalExpr<T = unknown>(expression: string): Promise<T>
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface Probe {
  found: boolean
  tag?: string
  id?: string
  desc?: string
  visible?: boolean
  hiddenBy?: string | null
  zeroSize?: boolean
  disabled?: boolean
  disabledBy?: string | null
  editable?: boolean
  rect?: Rect
  viewport?: { w: number; h: number }
}

interface Scrolled {
  found: boolean
  stable?: boolean
  rect?: Rect
  viewport?: { w: number; h: number }
  visibleRect?: Rect | null
}

interface Hit {
  code?: ActionFailureCode
  ok?: boolean
  hitDesc?: string | null
  hasHit?: boolean
  desc?: string
}

export type Preparation =
  | { ok: true; point: { x: number; y: number }; rect: Rect }
  | { ok: false; reason: ActionFailure }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 元素自述：`<button#next.btn.primary "Next page">`——只给原因用，不参与判定。 */
const DESCRIBE = `
const __describe = (n) => {
  if (!n || !n.tagName) return '未知节点';
  const tag = n.tagName.toLowerCase();
  const id = n.id ? '#' + n.id : '';
  const cls = n.classList && n.classList.length ? '.' + Array.from(n.classList).slice(0, 2).join('.') : '';
  const role = n.getAttribute && n.getAttribute('role') ? ' role="' + n.getAttribute('role') + '"' : '';
  const label = n.getAttribute && n.getAttribute('aria-label') ? ' aria-label="' + n.getAttribute('aria-label') + '"' : '';
  const text = String((n.innerText || n.textContent || '')).replace(/\\s+/g, ' ').trim().slice(0, 60);
  // 遮挡物常常是一个无 id 的内层 div；补一句最近的祖先 id，原因里才认得出那块横幅。
  let near = '';
  if (!id) {
    for (let p = n.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      if (p.id) { near = ' (in #' + p.id + ')'; break; }
    }
  }
  return '<' + tag + id + cls + role + label + '>' + (text ? ' "' + text + '"' : '') + near;
};`

function probeExpr(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    ${DESCRIBE}
    const r = el.getBoundingClientRect();
    const R = (b) => ({ left: b.left, top: b.top, width: b.width, height: b.height });
    let hiddenBy = null;
    for (let n = el; n && n.nodeType === 1; ) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') { hiddenBy = 'display:none'; break; }
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') { hiddenBy = 'visibility:' + cs.visibility; break; }
      if (parseFloat(cs.opacity || '1') === 0) { hiddenBy = 'opacity:0'; break; }
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    if (!hiddenBy) {
      try {
        if (typeof el.checkVisibility === 'function' &&
            !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) hiddenBy = 'not rendered';
      } catch (e) { /* 老版本浏览器没有这个 API */ }
    }
    let disabledBy = null;
    try { if (el.matches(':disabled')) disabledBy = 'disabled'; } catch (e) { /* 非表单元素 */ }
    if (!disabledBy && el.getAttribute('aria-disabled') === 'true') disabledBy = 'aria-disabled="true"';
    if (!disabledBy) {
      for (let f = el.parentElement; f; f = f.parentElement) {
        if (f.tagName === 'FIELDSET' && f.disabled) { disabledBy = 'disabled fieldset'; break; }
      }
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const textish = tag === 'textarea' || tag === 'select' ||
      (tag === 'input' && ['checkbox','radio','file','submit','button','reset','image','range','color','hidden'].indexOf(type) < 0);
    const editable = !!el.isContentEditable || (textish && !el.readOnly);
    return {
      found: true, tag, id: el.id || '', desc: __describe(el),
      visible: !hiddenBy && r.width > 0 && r.height > 0,
      hiddenBy, zeroSize: r.width <= 0 || r.height <= 0,
      disabled: !!disabledBy, disabledBy, editable,
      rect: R(r), viewport: { w: innerWidth, h: innerHeight },
    };
  })()`
}

/** 滚进视口并等布局稳定：两个动画帧（各留 80ms 兜底），比较前后矩形。 */
function scrollExpr(selector: string): string {
  return `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    window.__streamActionTarget = el;
    // 只在「没完整露在视口里」时才滚——对齐 scrollIntoViewIfNeeded，别把一页已经看得到的
    // 元素每次都拽到屏幕中央（那会改写页面的滚动位置与后续坐标）。
    const r0 = el.getBoundingClientRect();
    const vw0 = innerWidth, vh0 = innerHeight;
    const seen = r0.top >= 0 && r0.left >= 0 && r0.bottom <= vh0 && r0.right <= vw0;
    if (!seen) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
      catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    }
    const tick = () => new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      try { requestAnimationFrame(() => requestAnimationFrame(fin)); } catch (e) {}
      setTimeout(fin, 80);
    });
    await tick();
    const a = el.getBoundingClientRect();
    await tick();
    const b = el.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const left = Math.max(0, b.left), top = Math.max(0, b.top);
    const right = Math.min(vw, b.right), bottom = Math.min(vh, b.bottom);
    return {
      found: true,
      stable: Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1,
      rect: { left: b.left, top: b.top, width: b.width, height: b.height },
      viewport: { w: vw, h: vh },
      visibleRect: right > left && bottom > top
        ? { left, top, width: right - left, height: bottom - top }
        : null,
    };
  })()`
}

/**
 * 命中测试 + 挂一次性点击监听。命中沿 shadow 边界向上走（`parentNode` → `ShadowRoot.host`），
 * 所以目标内部的一个 `<span>` 也算命中，而盖在它上面的另一个元素不算。
 */
function hitExpr(selector: string, x: number, y: number): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { code: 'detached' };
    ${DESCRIBE}
    const within = (n, target) => {
      for (let p = n; p; ) {
        if (p === target) return true;
        if (p.parentNode) p = p.parentNode;
        else if (p.host) p = p.host;
        else p = null;
      }
      return false;
    };
    let root = document;
    let hit = root.elementFromPoint ? root.elementFromPoint(${x}, ${y}) : null;
    for (let i = 0; i < 8 && hit && hit.shadowRoot; i++) {
      const inner = hit.shadowRoot.elementFromPoint(${x}, ${y});
      if (!inner || inner === hit) break;
      hit = inner;
    }
    window.__streamActionTap = null;
    if (window.__streamActionTapOff) { try { window.__streamActionTapOff(); } catch (e) {} }
    const onTap = (e) => { window.__streamActionTap = { trusted: !!e.isTrusted }; };
    document.addEventListener('click', onTap, true);
    window.__streamActionTapOff = () => { document.removeEventListener('click', onTap, true); };
    return {
      ok: !!hit && within(hit, el),
      hasHit: !!hit,
      hitDesc: hit ? __describe(hit) : null,
      desc: __describe(el),
    };
  })()`
}

/** 写入前的最后一道：还是同一个节点、仍可见 / 启用，并且真的拿到了焦点。 */
function focusExpr(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el !== window.__streamActionTarget || !el.isConnected) return { code: 'detached' };
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') === 0)
      return { code: 'not-visible' };
    try { if (el.matches(':disabled')) return { code: 'disabled' }; } catch (e) {}
    if (el.getAttribute('aria-disabled') === 'true') return { code: 'disabled' };
    try { el.focus(); } catch (e) {}
    const active = document.activeElement;
    const focused = active === el || !!active && (el.contains(active) || (typeof active.getRootNode === 'function' && active.getRootNode().host === el));
    return focused ? { ok: true } : { code: 'not-editable' };
  })()`
}

/** 回读：只回「等于 / 不等于」，值本身不回传。 */
function readBackExpr(selector: string, text: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el !== window.__streamActionTarget || !el.isConnected) return { detached: true };
    const want = ${JSON.stringify(text)};
    let got = null;
    if (el.isContentEditable) got = String(el.textContent == null ? '' : el.textContent);
    else if ('value' in el) got = String(el.value == null ? '' : el.value);
    return { ok: got === want };
  })()`
}

function cleanupExpr(): string {
  return `(() => {
    try {
      if (window.__streamActionTapOff) { window.__streamActionTapOff(); window.__streamActionTapOff = null; }
      window.__streamActionTap = null;
      window.__streamActionTarget = null;
    } catch (e) {}
    return true;
  })()`
}

function elementReason(code: ActionFailureCode, probe: Probe, extra: string): ActionFailure {
  const what = probe.desc || probe.tag || '目标元素'
  switch (code) {
    case 'not-visible':
      return { code, reason: `元素 ${what} 不可见（${probe.zeroSize ? '零尺寸' : probe.hiddenBy || '不可见'}）` }
    case 'disabled':
      return { code, reason: `元素 ${what} 不可用（${probe.disabledBy || 'disabled'}）` }
    case 'not-editable':
      return { code, reason: `元素 ${what} 不是可编辑字段` }
    default:
      return { code, reason: `元素 ${what} 无法操作（${extra}）` }
  }
}

/**
 * 点击前准备：探测 → 滚动 → 命中测试。成功时返回落点，并且页面上已经挂好一次性点击监听
 * （调用方用完必须 {@link clearAction}）。
 */
export async function prepareClick(
  raw: ActionabilityPage,
  selector: string,
  position?: { x: number; y: number },
): Promise<Preparation> {
  const probe = await raw.evalExpr<Probe>(probeExpr(selector))
  if (!probe?.found) return { ok: false, reason: { code: 'not-found', reason: `没有命中任何元素：${selector}` } }
  if (!probe.visible) return { ok: false, reason: elementReason('not-visible', probe, '') }
  if (probe.disabled) return { ok: false, reason: elementReason('disabled', probe, '') }

  const scrolled = await raw.evalExpr<Scrolled>(scrollExpr(selector))
  if (!scrolled?.found) return { ok: false, reason: { code: 'detached', reason: `元素在滚动前被替换：${selector}` } }
  if (!scrolled.visibleRect) {
    return { ok: false, reason: { code: 'outside-viewport', reason: `元素 ${probe.desc} 在视口外（滚动后仍不可见）` } }
  }

  const rect = scrolled.rect!
  const point = position
    ? { x: Math.floor(rect.left + position.x), y: Math.floor(rect.top + position.y) }
    : {
        x: Math.floor(scrolled.visibleRect.left + scrolled.visibleRect.width / 2),
        y: Math.floor(scrolled.visibleRect.top + scrolled.visibleRect.height / 2),
      }
  const vp = scrolled.viewport ?? { w: 0, h: 0 }
  if (point.x < 0 || point.y < 0 || point.x >= vp.w || point.y >= vp.h) {
    return {
      ok: false,
      reason: { code: 'outside-viewport', reason: `点击点 (${point.x}, ${point.y}) 在 ${vp.w}×${vp.h} 视口外` },
    }
  }

  const hit = await raw.evalExpr<Hit>(hitExpr(selector, point.x, point.y))
  if (hit?.code === 'detached') {
    return { ok: false, reason: { code: 'detached', reason: `元素在命中测试时已被替换：${selector}` } }
  }
  if (!hit?.ok) {
    const why = hit?.hasHit
      ? `点击点被 ${hit.hitDesc} 遮挡`
      : '点击点上没有任何元素（可能被透明层盖住）'
    return {
      ok: false,
      reason: { code: 'covered', reason: `${why}（目标 ${hit?.desc || probe.desc}）` },
    }
  }
  return { ok: true, point, rect }
}

/** 写入前准备：探测 → 滚动 → 复核节点 → 聚焦。成功时页面上已记下目标节点。 */
export async function prepareType(raw: ActionabilityPage, selector: string): Promise<Preparation> {
  const probe = await raw.evalExpr<Probe>(probeExpr(selector))
  if (!probe?.found) return { ok: false, reason: { code: 'not-found', reason: `没有命中任何元素：${selector}` } }
  if (!probe.visible) return { ok: false, reason: elementReason('not-visible', probe, '') }
  if (probe.disabled) return { ok: false, reason: elementReason('disabled', probe, '') }
  if (!probe.editable) return { ok: false, reason: elementReason('not-editable', probe, '') }

  const scrolled = await raw.evalExpr<Scrolled>(scrollExpr(selector))
  if (!scrolled?.found) return { ok: false, reason: { code: 'detached', reason: `元素在滚动前被替换：${selector}` } }
  if (!scrolled.visibleRect) {
    return { ok: false, reason: { code: 'outside-viewport', reason: `元素 ${probe.desc} 在视口外（滚动后仍不可见）` } }
  }

  const focus = await raw.evalExpr<{ ok?: boolean; code?: ActionFailureCode }>(focusExpr(selector))
  if (focus?.code) {
    if (focus.code === 'detached') return { ok: false, reason: { code: 'detached', reason: `元素在写入前被替换：${selector}` } }
    if (focus.code === 'disabled') return { ok: false, reason: elementReason('disabled', probe, '') }
    if (focus.code === 'not-visible') return { ok: false, reason: elementReason('not-visible', probe, '') }
    return { ok: false, reason: elementReason('not-editable', probe, '') }
  }
  const rect = scrolled.rect!
  return { ok: true, point: { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) }, rect }
}

/** 回读写入结果。只比较，不返回值本身；节点被换掉时回 `detached`。 */
export async function readBackValue(
  raw: ActionabilityPage,
  selector: string,
  text: string,
  timeoutMs = 500,
): Promise<{ ok: boolean; detached: boolean }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await raw.evalExpr<{ ok?: boolean; detached?: boolean }>(readBackExpr(selector, text))
    if (r?.detached) return { ok: false, detached: true }
    if (r?.ok) return { ok: true, detached: false }
    if (Date.now() >= deadline) return { ok: false, detached: false }
    await sleep(50)
  }
}

/** 等页面收到一次可信 `click`。收不到不是失败，只是 `unconfirmed`。 */
export async function waitForTap(raw: ActionabilityPage, timeoutMs = 700): Promise<'confirmed' | 'unconfirmed'> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let tap: { trusted?: boolean } | null = null
    try {
      tap = await raw.evalExpr<{ trusted?: boolean } | null>('window.__streamActionTap || null')
    } catch {
      // 点击可能已经把文档带走了：读不到不是「没收到」，但也不能假装收到了。
      return 'unconfirmed'
    }
    if (tap) return tap.trusted ? 'confirmed' : 'unconfirmed'
    if (Date.now() >= deadline) return 'unconfirmed'
    await sleep(50)
  }
}

/** 收尾：摘掉监听、清掉目标引用。页面已经跳走时求值会失败，调用方自行 catch。 */
export async function clearAction(raw: ActionabilityPage): Promise<void> {
  await raw.evalExpr(cleanupExpr())
}
