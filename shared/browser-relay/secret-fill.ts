/**
 * 不让模型碰到密码的登录（openspec `secret-fill`）。
 *
 * 模型只给一个**引用名**；真值由宿主注入的 {@link SecretSource} 按引用给出，只在 {@link runLogin} 的局部变量里活过
 * 这一次调用。整个过程是**原子**的：核对顶层 origin → 逐字段可信输入 → 提交 → 等页面导航走；没导航就把填过的
 * 字段清空。动作期间这张标签上的读取由 {@link ReadLocks} 拒绝——`look` / `evaluate` 跑任意表达式，事后遮蔽做不到，
 * 所以只能不让它在「密码还在框里」的那段时间里发生（design D1）。
 *
 * 秘密值不进任何返回值、错误信息、日志：错误只带引用名与字段名。值经现有 CDP 管道（`Input.insertText`）送到浏览器，
 * 中继与扩展两侧都只记命令名（design D5）。
 */
import type { ActionSpec } from './interactive-gate.ts'
import type { PageDriver } from './page-driver.ts'

/** 来源给出的一条秘密。`origins` 精确匹配（scheme + host + port），不做后缀通配。 */
export interface SecretValue {
  origins: string[]
  username?: string
  password?: string
  /** 现算的一次性码；来源负责算。 */
  totp?: string
}

/** 宿主注入的秘密来源。Stream 自己不存任何秘密；没注入 = `kind:'login'` 一律拒绝。 */
export interface SecretSource {
  /** 按引用名取。不认得 → null；认得但拒绝（例如宿主要求先审批）→ 抛带原因的错误。`ctx.origin` 先给来源，它可以再拒一次、也可以记审计。 */
  get(ref: string, ctx: { origin: string; target: string }): Promise<SecretValue | null>
}

export type SecretFillCode =
  | 'secret-source-missing'
  | 'secret-unknown'
  | 'secret-field-missing'
  | 'origin-mismatch'
  | 'login-in-iframe-unsupported'
  | 'login-no-fields'
  | 'login-field-not-found'
  | 'secret-fill-in-progress'

/** 拒绝的统一形状。`message` 只含引用名、字段名、origin——**绝不含值**。 */
export class SecretFillRefused extends Error {
  constructor(
    readonly code: SecretFillCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'SecretFillRefused'
  }
}

export type LoginField = 'username' | 'password' | 'totp'
const FIELD_ORDER: readonly LoginField[] = ['username', 'password', 'totp']
const selectorOf = (a: ActionSpec, f: LoginField): string | undefined =>
  f === 'username' ? a.usernameSelector : f === 'password' ? a.passwordSelector : a.totpSelector

export interface LoginResult {
  /** `logged-in` = 提交后页面导航走了（不代表账号密码一定对，调用方看一眼新页面）；`not-navigated` = 原地没动，字段已清空（或没清掉，见 `cleared`）。 */
  status: 'logged-in' | 'not-navigated'
  origin: string
  filled: LoginField[]
  navigated: boolean
  cleared: boolean
}

export const LOGIN_WAIT_MS = 15_000
const LOGIN_POLL_MS = 250

/** URL → 规范化 origin（`URL.origin` 已经去掉缺省端口、小写化主机）。拿不出来 = null。 */
export function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

/** 这份文档的身份：新文档就有新的 `timeOrigin`。读失败（正在导航、上下文已销毁）= null。 */
async function docMark(driver: PageDriver): Promise<number | null> {
  try {
    const v = await driver.evalJson!('performance.timeOrigin')
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

/** 清空一个字段。只回「清没清掉」（比的是长度），值本身不回传。 */
async function clearField(driver: PageDriver, selector: string): Promise<boolean> {
  const expr = `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || !('value' in e)) return false;` +
    ` e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));` +
    ` return e.value.length === 0 })()`
  try {
    return (await driver.evalJson!(expr)) === true
  } catch {
    return false
  }
}

export interface LoginDeps {
  source: SecretSource | undefined
  /** 这张标签顶层页面的 URL，**取自浏览器进程的记录**（tabs / Transport.url），不在页面里求值。 */
  currentUrl: () => Promise<string>
  /** 观察导航与清空字段用的 driver（缺省 = 输入用的那个）。输入那个可能带着「只许在原域名上」的复核，跳走之后就读不了了。 */
  observer?: PageDriver
  /** 给来源看的目标名（`chrome:<tabId>` / `facility:<name>`），便于它记审计。 */
  target: string
  pollMs?: number
}

/**
 * 原子登录。确认门不在这里（调用方在取锁、取值之前判过）。
 */
export async function runLogin(driver: PageDriver, action: ActionSpec, deps: LoginDeps): Promise<LoginResult> {
  if (!deps.source) throw new SecretFillRefused('secret-source-missing', '这个实例没有配置秘密来源')
  if (action.frame) throw new SecretFillRefused('login-in-iframe-unsupported', '登录表单在 iframe 里，暂不支持')
  const ref = action.secret
  if (!ref) throw new SecretFillRefused('secret-unknown', 'login 动作缺 secret（秘密的引用名）')
  const fields = FIELD_ORDER.filter((f) => selectorOf(action, f))
  if (!fields.length) throw new SecretFillRefused('login-no-fields', 'usernameSelector / passwordSelector / totpSelector 至少给一个')
  const watch = deps.observer ?? driver
  if (!watch.evalJson) throw new Error('该 driver 不支持页内求值，无法确认导航与清空字段')

  const origin = originOf(await deps.currentUrl())
  if (!origin) throw new SecretFillRefused('origin-mismatch', '读不出这张标签的 origin')
  const secret = await deps.source.get(ref, { origin, target: deps.target })
  if (!secret) throw new SecretFillRefused('secret-unknown', `没有引用名为 ${ref} 的秘密`)
  const allowed = secret.origins.map((o) => originOf(o)).filter((o): o is string => !!o)
  if (!allowed.includes(origin)) {
    throw new SecretFillRefused('origin-mismatch', `秘密 ${ref} 不能填到 ${origin}（允许：${allowed.join(', ') || '无'}）`)
  }
  // 先确认每个要填的字段都有值，再动页面：填到一半才发现缺值，等于白白把前半截留在页面上。
  for (const f of fields) {
    if (!secret[f]) throw new SecretFillRefused('secret-field-missing', `秘密 ${ref} 没有 ${f}`)
  }

  const before = await docMark(watch)
  const filled: LoginField[] = []
  const clearAll = async () => {
    let ok = true
    for (const f of filled) ok = (await clearField(watch, selectorOf(action, f)!)) && ok
    return ok
  }
  for (const f of fields) {
    const selector = selectorOf(action, f)!
    if (!(await driver.type(selector, secret[f]!))) {
      await clearAll()
      throw new SecretFillRefused('login-field-not-found', `${f} 的选择器没有命中：${selector}`)
    }
    filled.push(f)
  }

  if (action.submitSelector) await driver.click(action.submitSelector)
  else await driver.submit(selectorOf(action, filled[filled.length - 1]!)!)

  const deadline = Date.now() + (action.waitMs ?? LOGIN_WAIT_MS)
  const poll = deps.pollMs ?? LOGIN_POLL_MS
  let navigated = false
  while (Date.now() < deadline) {
    const now = await docMark(watch)
    if (now !== null && now !== before) {
      navigated = true
      break
    }
    await new Promise((r) => setTimeout(r, poll))
  }
  if (navigated) return { status: 'logged-in', origin, filled, navigated, cleared: true }
  const cleared = await clearAll()
  return { status: 'not-navigated', origin, filled, navigated, cleared }
}

/**
 * 按标签的读取锁（design D4）。键是目标名（`chrome:<tabId>` / `facility:<name>`）。锁在后端：所有读取都经后端，
 * 后端是唯一的路。被锁时立即拒绝，不排队。
 */
export class ReadLocks {
  private readonly held = new Set<string>()

  assertFree(key: string | undefined): void {
    if (key && this.held.has(key)) {
      throw new SecretFillRefused('secret-fill-in-progress', `${key} 正在登录，暂不允许读取或操作这张标签`)
    }
  }

  /** 拿锁跑 `fn`；`keep(result)` 为真时不放锁（清空失败、标签又没能关掉）。 */
  async hold<T>(key: string, fn: () => Promise<T>, keep: (r: T) => boolean = () => false): Promise<T> {
    this.assertFree(key)
    this.held.add(key)
    let release = true
    try {
      const r = await fn()
      if (keep(r)) release = false
      return r
    } finally {
      if (release) this.held.delete(key)
    }
  }

  release(key: string): void {
    this.held.delete(key)
  }

  isHeld(key: string): boolean {
    return this.held.has(key)
  }
}
