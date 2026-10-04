/**
 * `meta.secret_params` 的装载期四闸。
 *
 * 这一格开的是 `RecipeExtract` 头注明写「只写不读、也不要加」的反向口子，所以测试的重点是
 * **每一闸各自真的拒得住**，而不是"声明了能加载"。每条都断言"被拒绝"，且拒的理由指名道姓。
 *
 * 闸 3（只给内置包）不在这份里——它判的是这份 recipe 从哪个包来，属于注入那一侧。
 * **今天注入还没接线**，所以没有任何路径能把凭据送进页面；这四闸先立在装载点，
 * 等注入接上时它们已经在了，不会出现"先能注入、守卫后补"的窗口。
 */
import { describe, it, expect } from 'vitest'
import { validateRecipe } from './recipe-store.ts'

const SECRET_SLOT = {
  ref: 'dfcf:jagger',
  fields: { zjzh: { type: 'secret' }, jymm: { type: 'secret' }, note: { type: 'string' } },
}

/** 一份最小的 canonical browser recipe，`meta` 由每条用例自己给。 */
function browser(meta: Record<string, unknown>, steps: unknown[] = []) {
  return {
    version: 2, kind: 'browser', sourceId: 's', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    loginCheck: { loggedIn: '.a', wall: '.b' },
    session: { facility: 'x', lifecycle: 'one-shot', visibility: 'interactive' },
    steps,
    observers: [{ kind: 'state', statePath: 's', trigger: 'final' }],
    output: { itemsAt: 'i', dedupeBy: 'id', targetCount: 1, mapping: {} },
    meta,
  }
}

const CALL_STEP = {
  kind: 'call', service: 'ddddocr', path: '/ocr',
  input: { shotOf: '#img' }, from: 'text', bind: 'code',
}

describe('secret_params —— 装载期四闸', () => {
  it('闸 1：没有自己的 runtime_config 就不许声明 —— 凭据只能从自己那一格读', () => {
    expect(() => validateRecipe('s', browser({ secret_params: ['jymm'] })))
      .toThrow(/自己的 meta\.runtime_config/)
  })

  it('闸 2：点名的字段必须在自己的声明里是 secret，不能凭空点一个名字', () => {
    // 压根没声明过的名字
    expect(() => validateRecipe('s', browser({ runtime_config: SECRET_SLOT, secret_params: ['nope'] })))
      .toThrow(/必须在自己的 meta\.runtime_config\.fields 里.*secret/s)
    // 声明过、但不是 secret 类型的——借道普通字段同样不行
    expect(() => validateRecipe('s', browser({ runtime_config: SECRET_SLOT, secret_params: ['note'] })))
      .toThrow(/必须在自己的 meta\.runtime_config\.fields 里.*secret/s)
  })

  // 闸 4 判的是**次序**不是共存：外泄链必须先把凭据弄上页面，call 才偷得到东西。
  it('闸 4：凭据上了页面之后再 call —— 拒，且指名道姓说是哪两步', () => {
    expect(() => validateRecipe('s', browser(
      { runtime_config: SECRET_SLOT, secret_params: ['jymm'] },
      [
        { kind: 'type', selector: '#pwd', text: '{jymm}' },
        CALL_STEP,
      ],
    ))).toThrow(/step#1 的 call 排在 step#0/)
  })

  it('闸 4：隔着几步照样是同一条链', () => {
    expect(() => validateRecipe('s', browser(
      { runtime_config: SECRET_SLOT, secret_params: ['jymm'] },
      [
        { kind: 'type', selector: '#pwd', text: '{jymm}' },
        { kind: 'click', selector: '#a' },
        { kind: 'scroll', dwell_s: [1, 1], maxTimes: 1, noProgressStop: 1 },
        CALL_STEP,
      ],
    ))).toThrow(/call 排在 step#0/)
  })

  it('闸 4：`goto` 的 url 里引用 secret 也算"凭据上了页面"', () => {
    expect(() => validateRecipe('s', browser(
      { runtime_config: SECRET_SLOT, secret_params: ['zjzh'] },
      [{ kind: 'goto', url: 'https://x.com/?u={zjzh}' }, CALL_STEP],
    ))).toThrow(/call 排在 step#0/)
  })

  // 这一条是把"为什么不做成互斥"钉住的那一条：真实登录流程就长这样，
  // 一刀切互斥会把它也否掉，逼人把一次登录拆成两条 recipe 协同。
  it('闸 4：先 call 再用凭据 —— 放行，这正是登录的天然次序', () => {
    expect(() => validateRecipe('s', browser(
      { runtime_config: SECRET_SLOT, secret_params: ['zjzh', 'jymm'] },
      [
        { kind: 'goto', url: 'https://x.com/Login' },
        CALL_STEP,                                                     // 认验证码：此刻页面上还没有凭据
        { kind: 'type', selector: '#zjzh', text: '{zjzh}' },
        { kind: 'type', selector: '#pwd', text: '{jymm}' },
        { kind: 'type', selector: '#code', text: '{code}' },           // {code} 是 call 绑出来的，不是 secret
        { kind: 'click', selector: '#rdsc45' },
        { kind: 'submit', selector: '#btn' },
      ],
    ))).not.toThrow()
  })

  it('两样各自单独用都放行', () => {
    expect(() => validateRecipe('s', browser(
      { runtime_config: SECRET_SLOT, secret_params: ['zjzh', 'jymm'] },
      [{ kind: 'type', selector: '#pwd', text: '{jymm}' }],
    ))).not.toThrow()
    expect(() => validateRecipe('s', browser({}, [CALL_STEP]))).not.toThrow()
  })

  // 闸 5 是接线时才发现的：`evaluate` 会把**整个参数袋** JSON.stringify 进页面里执行的表达式
  // （recipe-runner 的 runEvaluateStep），注入的凭据会随之落进站点自己的 JS 上下文。
  // 这条泄漏在一个**早就存在**的步骤里，不在我新加的那一格——所以加一格能拿凭据的能力，
  // 要回头扫的是"谁会把参数袋递出去"。
  it('闸 5：拿得到凭据就不许有 evaluate 步骤 —— 它会把整个参数袋序列化进页面', () => {
    expect(() => validateRecipe('s', browser(
      { runtime_config: SECRET_SLOT, secret_params: ['jymm'] },
      [{ kind: 'evaluate', call: '(c,n,p)=>[]', itemsAt: 'items' }],
    ))).toThrow(/evaluate 步骤不能共存/)
  })

  it('闸 5：没声明凭据时 evaluate 照常 —— 禁的是"两样凑一起"', () => {
    expect(() => validateRecipe('s', browser(
      {},
      [{ kind: 'evaluate', call: '(c,n,p)=>[]', itemsAt: 'items' }],
    ))).not.toThrow()
  })

  it('形状不对当场拒，不静默忽略', () => {
    expect(() => validateRecipe('s', browser({ runtime_config: SECRET_SLOT, secret_params: 'jymm' })))
      .toThrow(/必须是非空字符串的数组/)
    expect(() => validateRecipe('s', browser({ runtime_config: SECRET_SLOT, secret_params: [''] })))
      .toThrow(/必须是非空字符串的数组/)
  })

  it('没声明这一格的 recipe 一切照旧 —— 这一格是 opt-in，不该动到存量', () => {
    expect(() => validateRecipe('s', browser({ runtime_config: SECRET_SLOT }))).not.toThrow()
    expect(() => validateRecipe('s', browser({}))).not.toThrow()
  })
})
