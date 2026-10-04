/**
 * 四个动词（cdp_look / cdp_shot / cdp_act / cdp_pages）暴露给模型的那一面：**描述文本 + 参数
 * schema**，按「这个宿主真的有哪几档面」生成。
 *
 * 为什么不是四个死字符串：描述里同时讲着三档面（`chrome:` / `facility:` /
 * `desktop`·`app:`），而只有 Stream 后端三档齐全——没有后端的宿主（DSH 插件）只有 chrome 这一档。
 * 把整段原样发过去，等于给模型**一份说了谎的说明书**：它会去试根本不存在的面，拿到的失败还是
 * 「说明书告诉它合法」的那种，于是它会反复重试、或者把失败归因到别处。**没有任何东西会喊**——
 * 工具能跑、schema 合法、日志干净，只是模型在按一份不适用的手册干活。
 *
 * 所以这里的规矩是：**每一句只讲某一档的话，都必须挂在那一档的开关下面**；只有跨档都成立的
 * 句子才无条件出现。`tool-specs.test.ts` 就是这条规矩的守卫（chrome-only 那份里不许出现
 * `facility:` / `desktop` / `app:`）。
 *
 * 参数 schema 用的是**纯数据描述**（`CdpParamSpec[]`）而不是 zod：这个库的存在理由是"另一个
 * 进程能 import 它"，多一个运行时依赖就多一份约束；宿主自己把它翻成 zod / JSON Schema /
 * DSH 的参数格式都行。
 */

/** 一档"面"。`desktop` 一档同时覆盖 `desktop` 与 `app:<process>` 两种写法（同一个 Stream Desktop）。 */
export type CdpTier = 'chrome' | 'facility' | 'desktop'

/** Stream 后端三档齐全。插件只传 `['chrome']`。 */
export const ALL_CDP_TIERS: readonly CdpTier[] = ['chrome', 'facility', 'desktop']

export interface CdpParamSpec {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string[]'
  /** `type:'enum'` 时的取值全集，顺序即声明顺序。 */
  values?: readonly string[]
  optional?: boolean
}

export interface CdpToolSpec {
  name: 'cdp_look' | 'cdp_shot' | 'cdp_act' | 'cdp_pages'
  description: string
  parameters: readonly CdpParamSpec[]
}

const COUNT_WORD = ['no', 'one', 'two', 'three', 'four'] as const

/** 每一档在 `target` 一栏里长什么样。 */
const TARGET_FORM: Record<CdpTier, string> = {
  chrome: 'chrome:<tabId>',
  facility: 'facility:<name>',
  desktop: 'desktop / app:<process>[/<title>]',
}

/** 把若干句子接成一段：空串（= 这一档不在）直接掉出去，不留双空格。 */
const join = (parts: Array<string | false | undefined>, sep = ' '): string =>
  parts.filter((p): p is string => Boolean(p)).join(sep)

// ── cdp_look ────────────────────────────────────────────────────────────────
const LOOK_BULLET: Record<CdpTier, string> = {
  chrome:
    "• `chrome` — the user's OWN logged-in Chrome (via the extension relay). Pass `url` to OPEN a tab and eval; `interactive:true` keeps it foreground+open (returns {value, target:'chrome:<tabId>', kept:true}), else it's a silent probe closed after the read (returns {value}). To read an ALREADY-open tab pass `target:'chrome:<tabId>'` (get ids from cdp_pages) and no url.",
  facility:
    '• `facility:<name>` — the harvest tab Stream is driving for that facility (e.g. facility:xhs). {value:null, live:false} if it has no live tab.',
  desktop:
    '• `desktop` / `app:<process>[/<title>]` — a NATIVE window (not a web page). `js` is then a JSON a11y query like {"role":"Button"}, NOT JavaScript — there is no DOM and no JS to run. Returns every match, so a name collision is visible (chrome://extensions has TWO buttons named 重新加载: the browser toolbar\'s and the extension card\'s). Reading only SCOPES to the window; it never steals focus. AN EMPTY RESULT IS NOT PROOF THE ELEMENT IS ABSENT: Chromium/Electron apps (QQ, VS Code, Discord…) build their a11y tree LAZILY — a window that isn\'t in the foreground answers every query with an empty array and no error. When that is the case the reply carries an extra `unbuilt` field explaining it; treat that read as NOT DONE (foreground the window and re-read — do not go rewrite the query), and treat an empty result WITHOUT `unbuilt` as a genuine absence. Qt/Win32 apps (Telegram, explorer) keep a full tree in the background, which is what makes unattended desktop harvest possible at all. Title match is a SUBSTRING and only needed to disambiguate — with several windows of one process, an unqualified app:<process> refuses and lists candidates rather than picking one.',
}

/** 列条目的顺序：原生窗口那条极长，放在最后。`target` 一栏的枚举则按 `ALL_CDP_TIERS`
 *  （那是清单不是段落）。 */
const LOOK_BULLET_ORDER: readonly CdpTier[] = ['chrome', 'facility', 'desktop']

function lookDescription(has: (t: CdpTier) => boolean, tiers: readonly CdpTier[]): string {
  const bullets = LOOK_BULLET_ORDER.filter((t) => tiers.includes(t))
    .map((t) => LOOK_BULLET[t])
    .join('\n')
  return (
    `Run JavaScript in a page over CDP and return the value (JSON-serializable). One verb, ${COUNT_WORD[tiers.length] ?? tiers.length} terminal${tiers.length === 1 ? '' : 's'} — pick with \`target\`:\n` +
    bullets +
    '\n' +
    'Use for live DOM / getComputedStyle / getBoundingClientRect reads. Prefer an async IIFE for awaited work.\n' +
    join([
      'INSTEAD OF hand-writing querySelector probes, pass `inventory:true` (and no `js`) to get every visible clickable/fillable element of the page numbered: {url,title,count,truncated,items:[{n,tag,role?,name,value?,href?,rect,frame?}],frames?} (cap 200). The inventory SPANS IFRAMES, cross-origin ones included: an item inside an iframe carries `frame` (a frame id) and its `rect` is already in top-page coordinates; `frames` lists every frame {id,url,oopif,count|error} and appears only when the page has more than one. Numbers are unique across the whole tab, so feed one straight back as cdp_act `ref` — it finds its own frame. The numbers are SESSION SCAFFOLDING (a data-stream-el attribute that dies with the page) — never put one in a recipe; for anything replayable still work out a stable selector.',
      'Plain `js` runs in the TOP document only. To run it inside an iframe pass `frame` (a frame id from the inventory, or a piece of the frame URL — must match exactly one) with a `chrome:<tabId>` target; in a same-site iframe it runs in an isolated world (DOM yes, the page\'s own JS globals no).',
      // 只在有原生窗口那一档时才需要说"那一档没有 inventory"——没有那一档时这句是凭空多出来的面。
      has('desktop') && 'Not available on desktop/app targets: an a11y query is already an inventory.',
    ])
  )
}

// ── cdp_shot ────────────────────────────────────────────────────────────────
function shotDescription(has: (t: CdpTier) => boolean, tiers: readonly CdpTier[]): string {
  const targets = tiers.map((t) => TARGET_FORM[t]).join(' / ')
  return join([
    'A screenshot (base64 JPEG) of a page over CDP. cdp_look tells you what the DOM says; this tells you what the page LOOKS like.',
    `\`target\`: ${targets}${has('desktop') ? ' (native windows too)' : ''}.`,
    'Returns {shot} or {shot:null} if no frame came back.',
    has('desktop')
      ? "A chrome tab whose window is covered/minimized/locked produces no page frame; then, if that tab is the one showing in its window, the shot falls back to the NATIVE window capture automatically and returns {shot, via:'window', target:'app:<process>/<window title>', note} — the WHOLE Chrome window (tab strip + address bar, physical pixels), so don't click by its coordinates. When it can't fall back the error says what to call instead."
      : 'A chrome tab whose window is covered/minimized/locked produces no frame and errors out — bring the window on screen and retry.',
  ])
}

// ── cdp_act ─────────────────────────────────────────────────────────────────
/** 原生窗口那一整段。它讲的全是 a11y 树、前台、锁屏——没有 desktop 档时一句都不成立。 */
const ACT_NATIVE_BLOCK =
  "ON A NATIVE WINDOW: `selector`/`expect` are JSON a11y queries, not CSS. Foreground is per-PATH, not blanket — check `via` in the result: a click that resolves to a native handle runs as `via:'invoke'` (no foreground needed, never steals the screen, works while locked); only the coordinate path (`via:'coords'` — handleless click, type, scroll) focuses the window first and is REFUSED (nothing dispatched) if the foreground can't be taken, because coordinate input is addressed to the screen and lands on whoever is on top. Locked desktop: reads and invoke work on ALREADY-materialized content, but a page never rendered this session has NO a11y subtree at all (find just comes back empty — not a gate; when the target window isn't in the foreground the not-found error appends an `a11y-unbuilt:` note saying so, otherwise a window screenshot showing a blank content area is the evidence). " +
  'SELF-DRAWN APPS WITH NO A11Y TREE (WeChat 4.x exposes one Pane and nothing else): pass `x`+`y` (absolute screen pixels) with kind:\'click\' instead of a `selector` — a pure coordinate click that always takes the foreground first. `x`/`y` are LOGICAL pixels (SendInput space). Do NOT copy numbers straight off `cdp_shot`: on a HiDPI screen the `app:` screenshot is the physical-pixel top-left quarter of the window (200% scaling → divide shot coordinates by 2), so calibrate with one trial click. `expect` can\'t see anything in such an app, so confirm with another `cdp_shot`, using evidence that lands inside the captured quarter.'

/** 「起一个应用」那一整段——同样只属于原生窗口档。 */
const ACT_LAUNCH_BLOCK =
  "LAUNCH AN APP: the same kind:'open' on a NATIVE target (`app:<process>`, e.g. app:Telegram.exe — never bare `desktop`, since the process you are opening has no window yet by definition) runs ensureApp: already-running is a no-op, otherwise it is spawned and the outcome is READ BACK — {status:'done', result:{running,started,pid,process,window?}} where `window` is present only when exactly one new window could be attributed to it (feed it straight into an `app:<process>/<title>` address; absent means don't guess). Pass `exe` (full path, or a bare filename to go through PATH) for ANYTHING BUT CHROME — with `exe` omitted the agent hunts for Chrome in the usual install locations, so you would launch a browser instead — and pass `args:[]` too, since the default args are Chrome's own `--no-startup-window`. It does NOT steal the screen (z-order/focus/minimized state untouched) and does NOT pass the high-risk gate, same as opening a tab. Use this instead of starting the exe from a shell: a shell start has no receipt — whether it launched, whether an existing instance was reused, and which window appeared are all unknowable."

function actDescription(has: (t: CdpTier) => boolean, tiers: readonly CdpTier[]): string {
  const actable = tiers.map((t) => TARGET_FORM[t]).join(' / ')
  return join([
    'Drive a page with TRUSTED input (real click/type/scroll/goto/back), not synthetic events.',
    `\`target\`: ${actable}.`,
    "`domain` is the hostname you believe the page is on — re-checked against the browser's own record before acting.",
    // ref 的「chrome-only」是一句**相对于别的档**的话：只有 chrome 一档时它无从对比，
    // 而 "(facility harvest pages refuse it)" 更是直接点名一个不存在的面。
    'Instead of a `selector` you may pass `ref:<n>`, a number from a `cdp_look({inventory:true})` listing — it expands to the selector `[data-stream-el="<n>"]`, so it is' +
      (tiers.length > 1
        ? ' chrome-only' + (has('facility') ? ' (facility harvest pages refuse it)' : '') + ' and'
        : '') +
      ' mutually exclusive with `selector`.',
    'A `ref` inside an iframe (cross-origin included) is found and clicked there automatically. For a `selector` inside an iframe, pass `frame` (frame id from the inventory, or a piece of the frame URL) — without it selectors match the top document only; `expect` is then checked in that same frame.',
    'CONFIRM with `expect` (a selector that should appear).',
    "A click/submit that OPENS A NEW TAB (window.open / target=_blank) returns `opened:[{tabId,url,target}]` — the page most likely continued THERE, so switch to that `target` instead of re-reading the old tab. Tabs opened by a tab Stream opened join the session group automatically (cdp_pages lists them with `openerTabId`).",
    "click/type/submit whose `selector` matches NO element return {status:'not-found'} — `done` no longer doubles for that; check status, don't assume a click landed just because the call returned.",
    "HIGH-RISK actions (submit, cross-site goto, or a declared `intent` of send/publish/purchase/delete/credential) STOP and return {status:'needs-confirmation'}; re-send with confirmed:true ONLY after the user agrees.",
    has('desktop') && ACT_NATIVE_BLOCK,
    join([
      "OPEN A PAGE: kind:'open' with target:'chrome' (no tabId — that's what it returns) and `targetUrl`. Find-or-open: an already-open tab on the same URL (trailing slash / scheme+host case ignored) is activated and its window focused; otherwise a new tab is created. Returns {status:'done', result:{tabId,title,url,created}}. It attaches NO debugger and injects NOTHING, which is why `chrome://*` privileged pages open here and fail under cdp_look. A tab it CREATES joins the session tab group like everything else Stream opens (visible to the user, revocable by dragging out); a tab that was already open (`created:false`) is the user's own and is only activated.",
      // 「怎么绕过 chrome://* 不可驱动」的解法只有原生窗口那一档；没有它时只能停在"驱动不了"。
      has('desktop')
        ? 'Grouping does not make a `chrome://*` page drivable — the debugger still refuses it; to act on one, use the returned `title` to address the native window as `app:chrome.exe/<title>` (a Chrome window is titled "<tab title> - Google Chrome").'
        : 'Grouping does not make a `chrome://*` page drivable — the debugger still refuses it.',
      "`title` may come back empty if the page hadn't titled itself within ~2s. `domain` is unused by open — pass the target's hostname.",
      "`ownWindow:true` opens the page in ITS OWN unfocused Chrome window instead (grouped there as \"Stream 独立窗\", still drivable, never raised). Use it for pages that must keep rendering while the user works — a background tab gets 0 animation frames, and a tab sharing the user's window gets pushed to the background the moment they switch tabs. It reuses only a tab previously opened this way (returned as-is with `created:false`, not activated, window not focused); the user's own tab on the same URL is ignored. The window still needs Chrome's native occlusion detection off to render while covered by other apps.",
    ]),
    has('desktop') && ACT_LAUNCH_BLOCK,
  ])
}

// ── cdp_pages ───────────────────────────────────────────────────────────────
function pagesDescription(has: (t: CdpTier) => boolean): string {
  // 「单页面档」= 只有一个受管页面、既列不出也关不掉的那几档。
  const singlePage = [has('facility') && 'facility:<name>'].filter(Boolean) as string[]
  return join([
    'Enumerate (and for chrome, close) the addressable pages of a target.',
    '`target:"chrome"` lists the session-group tabs [{tabId,url,title,origin,active,openerTabId?,popup?}] — including tabs that a Stream-opened tab opened itself (`openerTabId` says which); pass `close:<tabId>` to close one (returns {closed}).',
    has('desktop') &&
      '`target:"desktop"` lists NATIVE windows [{id,process,title,foreground}] — enough to build an `app:<process>/<title>` address, which is the point: identify the target before acting.',
    singlePage.length > 0 &&
      `${singlePage.join(' / ')} return${singlePage.length === 1 ? 's' : ''} their single managed page.`,
  ])
}

const LOOK_PARAMS: readonly CdpParamSpec[] = [
  { name: 'target', type: 'string' },
  { name: 'js', type: 'string', optional: true },
  { name: 'url', type: 'string', optional: true },
  { name: 'interactive', type: 'boolean', optional: true },
  { name: 'inventory', type: 'boolean', optional: true },
  { name: 'frame', type: 'string', optional: true },
]

/** `exe` / `args` 只服务于「起一个原生应用」（kind:'open' 打在 `app:<process>` 上）。没有
 *  原生窗口那一档时它们无处可用——留在 schema 里同样是在说谎，只不过谎话藏在参数表而不是散文里。 */
const ACT_NATIVE_PARAMS: readonly CdpParamSpec[] = [
  { name: 'exe', type: 'string', optional: true },
  { name: 'args', type: 'string[]', optional: true },
  { name: 'x', type: 'number', optional: true },
  { name: 'y', type: 'number', optional: true },
]

const actParams = (has: (t: CdpTier) => boolean): CdpParamSpec[] => [
  { name: 'target', type: 'string' },
  {
    name: 'kind',
    type: 'enum',
    values: ['goto', 'back', 'click', 'type', 'submit', 'scroll', 'exists', 'look', 'evaluate', 'open', 'setFiles'],
  },
  { name: 'domain', type: 'string' },
  { name: 'ref', type: 'number', optional: true },
  { name: 'frame', type: 'string', optional: true },
  { name: 'selector', type: 'string', optional: true },
  { name: 'text', type: 'string', optional: true },
  { name: 'targetUrl', type: 'string', optional: true },
  ...(has('desktop') ? ACT_NATIVE_PARAMS : []),
  { name: 'px', type: 'number', optional: true },
  { name: 'paths', type: 'string[]', optional: true },
  { name: 'expression', type: 'string', optional: true },
  { name: 'expect', type: 'string', optional: true },
  { name: 'intent', type: 'enum', values: ['send', 'publish', 'purchase', 'delete', 'credential'], optional: true },
  { name: 'confirmed', type: 'boolean', optional: true },
  { name: 'ownWindow', type: 'boolean', optional: true },
]

/**
 * 按宿主支持的档位生成四个动词的工具面。
 *
 * `tiers` 必须含 `chrome`——四个动词的骨架（tabId 寻址、`ref` 编号、open 返回 tabId）都长在
 * 那一档上，没有它这四个名字就不该出现。
 */
export function cdpToolSpecs(tiers: readonly CdpTier[] = ALL_CDP_TIERS): CdpToolSpec[] {
  if (!tiers.includes('chrome')) throw new Error('cdpToolSpecs: chrome 档是这四个动词的骨架，不能缺')
  const has = (t: CdpTier): boolean => tiers.includes(t)
  // 声明顺序统一按 ALL_CDP_TIERS，免得调用方传参顺序不同就产出两份不同的说明书。
  const ordered = ALL_CDP_TIERS.filter(has)
  return [
    { name: 'cdp_look', description: lookDescription(has, ordered), parameters: LOOK_PARAMS },
    {
      name: 'cdp_shot',
      description: shotDescription(has, ordered),
      parameters: [{ name: 'target', type: 'string' }],
    },
    { name: 'cdp_act', description: actDescription(has, ordered), parameters: actParams(has) },
    {
      name: 'cdp_pages',
      description: pagesDescription(has),
      parameters: [
        { name: 'target', type: 'string' },
        { name: 'close', type: 'number', optional: true },
      ],
    },
  ]
}

/** 按名字取一份描述——宿主往往一个个 push 条目，不想自己在数组里找。 */
export function cdpToolSpec(name: CdpToolSpec['name'], tiers?: readonly CdpTier[]): CdpToolSpec {
  const hit = cdpToolSpecs(tiers).find((s) => s.name === name)
  if (!hit) throw new Error(`unknown cdp tool ${name}`)
  return hit
}
