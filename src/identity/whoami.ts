/**
 * `whoami` 的纯逻辑（browser-identity D5）：取路径、三态判定、页内表达式、`login` 形状的哈希与打码、声明校验。
 * 不碰网络、不碰中继——探测器（`prober.ts`）只负责把原料取回来交给这里判。
 */
import { createHash } from 'node:crypto'
import type { WhoamiSpec } from '../manifest/types.ts'
import { isCanonicalBrowserRecipe, type Recipe } from '../replay/recipe.ts'
import { hostAllowed } from '../devices/run-context.ts'

export type { WhoamiSpec }

/**
 * 探测的结果，与 `sessionPrecheck` 一个脾气：
 * - `signed-in`：取到了非空的账号 id。
 * - `signed-out`：站点确实回答了（JSON / 页面全局状态在），但 id 为空或登录标志为假。
 * - `unknown`：问不出来。**绝不当成任何一边**——把「节点断了」写成「登出了」，用户合上笔记本一晚上，
 *   第二天每个 profile 都被报成换了号。
 */
export type ProbeResult =
  | { state: 'signed-in'; accountId: string; name?: string }
  | { state: 'signed-out' }
  | { state: 'unknown'; reason: string }

/**
 * Vue 的 ref 包装（`RefImpl`：`_value` / `_rawValue`）解开。小红书的 `__INITIAL_STATE__` 里每一层都可能是 ref，
 * 经 `JSON.stringify` 之后变成 `{ _rawValue, _value, __v_isRef, dep }`；作者照页面上看到的结构写路径，宿主替他解。
 * 解到不再是 ref 为止（上限 3 层，防一个恰好叫 `_value` 的自引用对象）。
 */
export function unwrapRef(v: unknown): unknown {
  for (let i = 0; i < 3; i++) {
    if (v === null || typeof v !== 'object') return v
    const o = v as Record<string, unknown>
    if ('_value' in o) v = o._value
    else if ('_rawValue' in o) v = o._rawValue
    else return v
  }
  return v
}

/** 点路径取值，每一步先解 ref。 */
export function readPath(root: unknown, path: string): unknown {
  let cur = root
  for (const seg of path.split('.')) {
    cur = unwrapRef(cur)
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return unwrapRef(cur)
}

/** 账号 id 的文本形。空串、0、非字符串非数字都算「没有」——没有哪个真账号的 id 是 0。 */
function idText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v)
  return undefined
}

function nameText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined
}

function judge(id: unknown, name: unknown, signedIn: unknown, hasSignedIn: boolean): ProbeResult {
  if (hasSignedIn && !unwrapRef(signedIn)) return { state: 'signed-out' }
  const accountId = idText(id)
  if (!accountId) return { state: 'signed-out' }
  const n = nameText(name)
  return { state: 'signed-in', accountId, ...(n ? { name: n } : {}) }
}

/** `http` 形状：一次 GET 的回包怎么判。非 2xx、解析不了都是 `unknown`——那不是站点在回答「你是谁」。 */
export function classifyHttp(
  spec: Extract<WhoamiSpec, { kind: 'http' }>,
  res: { status: number; body: string },
): ProbeResult {
  if (res.status < 200 || res.status >= 300) return { state: 'unknown', reason: `HTTP ${res.status}` }
  if (spec.format === 'html') {
    const m = new RegExp(spec.id).exec(res.body)
    const signedIn = spec.signedIn ? new RegExp(spec.signedIn).test(res.body) : true
    const name = spec.name ? new RegExp(spec.name).exec(res.body)?.[1] : undefined
    if (m?.[1]) return judge(m[1], name, signedIn, spec.signedIn !== undefined)
    // HTML 里没找到 id：可能是登出，也可能是页面改版——只有作者给了登录标志、而它明说没登，才算登出。
    if (spec.signedIn && !signedIn) return { state: 'signed-out' }
    return { state: 'unknown', reason: 'HTML 里没有找到账号 id' }
  }
  let json: unknown
  try {
    json = JSON.parse(res.body)
  } catch {
    return { state: 'unknown', reason: '响应不是 JSON' }
  }
  return judge(
    readPath(json, spec.id),
    spec.name ? readPath(json, spec.name) : undefined,
    spec.signedIn ? readPath(json, spec.signedIn) : undefined,
    spec.signedIn !== undefined,
  )
}

/** `page` 形状要读的路径，顺序固定：id、name、signedIn（缺的用空串占位，页内读出 undefined）。 */
export function pagePaths(spec: Extract<WhoamiSpec, { kind: 'page' }>): string[] {
  return [spec.id, spec.name ?? '', spec.signedIn ?? '']
}

/**
 * 页内表达式：读几条 `window` 上的点路径，每一步解 ref，**在页内**拍平成纯 JSON 再过 CDP 边界——Vue 的
 * reactive Proxy 直接 `returnByValue` 回来是 `{}`（同 `readStateExpr` 的头注）。顺带报 id 路径的根全局在不在：
 * 根不在（风控页、没水合）是 `unknown`，不能和「根在、id 空」的登出混成一个答案。
 */
export function pageReadExpr(paths: string[]): string {
  return `(()=>{const un=(v)=>{for(let i=0;i<3;i++){if(v===null||typeof v!=='object')return v;` +
    `if('_value' in v)v=v._value;else if('_rawValue' in v)v=v._rawValue;else return v}return v};` +
    `const read=(p)=>{if(!p)return undefined;let cur=window;for(const s of p.split('.')){cur=un(cur);` +
    `if(cur===null||typeof cur!=='object')return undefined;cur=cur[s]}cur=un(cur);` +
    `if(cur==null||typeof cur!=='object')return cur;try{return JSON.parse(JSON.stringify(cur))}catch(e){return undefined}};` +
    `const paths=${JSON.stringify(paths)};const root=paths[0].split('.')[0];` +
    `return{root:window[root]!=null,values:paths.map(read)}})()`
}

/** `page` 形状：页内表达式的回答怎么判。 */
export function classifyPage(spec: Extract<WhoamiSpec, { kind: 'page' }>, read: unknown): ProbeResult {
  const r = read as { root?: unknown; values?: unknown[] } | null | undefined
  if (!r || !Array.isArray(r.values)) return { state: 'unknown', reason: '页面没有回答' }
  if (r.root !== true) return { state: 'unknown', reason: `页面上没有 ${spec.id.split('.')[0]}` }
  const [id, name, signedIn] = r.values
  return judge(id, name, signedIn, spec.signedIn !== undefined)
}

/** `login` 形状：账号 id 存 SHA-256 的前 16 位，明文不落库。 */
export function loginAccountId(account: string): string {
  return createHash('sha256').update(account.trim()).digest('hex').slice(0, 16)
}

/** 打码的账号：`12345678` → `12****78`。太短的只留第一位。 */
export function maskAccount(account: string): string {
  const s = account.trim()
  return s.length >= 6 ? `${s.slice(0, 2)}****${s.slice(-2)}` : `${s.slice(0, 1)}****`
}

/** 一条正则源能不能用来取 id：编得过，且至少一个捕获组。 */
export function captureRegexProblem(src: string): string | null {
  let re: RegExp
  try {
    re = new RegExp(src)
  } catch (e) {
    return `不是合法的正则：${(e as Error).message}`
  }
  const groups = new RegExp(`${re.source}|`).exec('')!.length - 1
  return groups >= 1 ? null : '要带一个捕获组（取出来的那一段就是账号 id）'
}

/**
 * `whoami.url` 的主机必须落在包的允许主机里（`network.hosts ?? credentials`）。探测带的是该节点的登录态，
 * 远程设备上还要由设备代发——一个包借 `whoami` 把用户的 cookie 打到它没申报过的主机上，等于绕过了安装确认页。
 */
export function whoamiUrlProblem(w: WhoamiSpec, hosts: readonly string[]): string | null {
  if (w.kind === 'login') return null
  let url: URL
  try {
    url = new URL(w.url)
  } catch {
    return `不是合法的地址：${w.url}`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `只收 http(s) 地址：${w.url}`
  if (!hostAllowed(url.hostname, hosts)) {
    return `主机 ${url.hostname} 不在包声明的允许主机内（stream.network.hosts ?? stream.credentials：${hosts.join(', ') || '空'}）`
  }
  return null
}

/**
 * `login.param` 必须是这个 facility 的登录 recipe 声明的 `secret_params` 之一——身份就是那一格的值，
 * 指向一个不存在的格，登录之后永远写不出身份，而不会有任何一处报错。
 */
export function whoamiLoginProblem(w: WhoamiSpec, recipes: readonly Recipe[], facility: string): string | null {
  if (w.kind !== 'login') return null
  const logins = recipes.filter((r) => r.meta?.login === true && isCanonicalBrowserRecipe(r) && r.session.facility === facility)
  if (!logins.length) return `包里没有 facility "${facility}" 的登录 recipe（meta.login:true），login 形状无从取账号`
  const params = logins.flatMap((r) => r.meta?.secret_params ?? [])
  if (!params.includes(w.param)) {
    return `"${w.param}" 不是登录 recipe 的 secret_params 之一（${params.join(', ') || '空'}）`
  }
  return null
}

/** 包允许访问的主机（同 `packageNetwork`）：`network.hosts`，缺省 `credentials`。 */
export function allowedHostsOf(pkg: { credentials?: string[]; network?: { hosts: string[] } }): string[] {
  return pkg.network?.hosts ?? pkg.credentials ?? []
}

/** `url` 主机命中的那一条允许主机——cookie 快照按注册域存（`.bilibili.com`），拿 `api.bilibili.com` 去取会落空。 */
export function cookieDomainFor(url: string, hosts: readonly string[]): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  return hosts.find((h) => hostAllowed(host, [h]))?.replace(/^\./, '').toLowerCase()
}
