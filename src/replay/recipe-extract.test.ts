import { describe, it, expect } from 'vitest'
import { captureSecret } from './recipe-runner.ts'
import { validateRecipe } from './recipe-store.ts'
import type { PageDriver } from './actions.ts'

// 一次性抽取是 recipe **第一次**获得写凭据存储的能力。所以这一组测的不是"能不能抓到"，
// 而是**它在什么情况下拒绝写**——一个被猜出来的凭据不会在这里报错，它会在很远的下游
// 变成一句"key 无效"，那时没人还找得回来源头。

const driverWith = (text: string): PageDriver =>
  ({ evalJson: async () => text, sleep: async () => {} } as unknown as PageDriver)

/** 页面在第 `readyAt` 次读取时才渲染出值 —— 模拟"提交之后一个网络往返"。 */
const driverAfter = (readyAt: number, text: string) => {
  let n = 0
  const d = { evalJson: async () => (++n >= readyAt ? text : '创建中…'), sleep: async () => {} }
  return { driver: d as unknown as PageDriver, reads: () => n }
}

describe('captureSecret — 什么时候写，什么时候拒绝', () => {
  // 活体教训：整条链路全通、key 真的建出来了，抽取却报"命中 0 处" —— 因为 innerText 不含
  // <input> 的 value，而"只显示一次"的凭据几乎总是放在只读输入框里配一个复制按钮。
  it('求值表达式要把表单控件的 value 一起读进来，不能只读 innerText', async () => {
    let seen = ''
    const driver = {
      evalJson: async (expr: string) => { seen = expr; return '' },
      sleep: async () => {},
    } as unknown as PageDriver
    await captureSecret({ field: 'apiKey', pattern: 'gsk_\\w+', timeout: 0 }, driver, () => {})
    expect(seen).toContain('innerText')
    expect(seen).toContain('input,textarea')
    expect(seen).toContain('el.value')
  })

  it('恰好命中一处 → 交给 sink，状态行只报长度不报值', async () => {
    const got: Array<[string, string]> = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: 'gsk_[A-Za-z0-9]{10,}' },
      driverWith('你的 key：gsk_abcdefghij1234567890 请立即复制'),
      (f, v) => got.push([f, v]),
    )
    expect(got).toEqual([['apiKey', 'gsk_abcdefghij1234567890']])
    expect(note).toContain('apiKey')
    expect(note).not.toContain('gsk_') // 值绝不进 trace
  })

  it('同一个值在页面上出现多次（字段里一份、复制提示里一份）→ 去重后仍算一处，照写', async () => {
    const got: string[] = []
    await captureSecret(
      { field: 'apiKey', pattern: 'gsk_[A-Za-z0-9]{10,}' },
      driverWith('gsk_abcdefghij1234567890 已复制：gsk_abcdefghij1234567890'),
      (_f, v) => got.push(v),
    )
    expect(got).toEqual(['gsk_abcdefghij1234567890'])
  })

  it('命中两个不同的候选 → 拒写。挑哪个都是猜，猜错只会在下游变成"key 无效"', async () => {
    const got: string[] = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: 'gsk_[A-Za-z0-9]{10,}' },
      driverWith('新 key gsk_aaaaaaaaaa1111111111 旧 key gsk_bbbbbbbbbb2222222222'),
      (_f, v) => got.push(v),
    )
    expect(got).toEqual([])
    expect(note).toContain('2 处')
  })

  it('一处都没命中 → 拒写（页面没到那一屏，或者形状变了）', async () => {
    const got: string[] = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: 'gsk_[A-Za-z0-9]{10,}', timeout: 0 },
      driverWith('创建失败'),
      (_f, v) => got.push(v),
    )
    expect(got).toEqual([])
    expect(note).toContain('0 处')
  })

  // 活体教训：提交点下去 196ms 就去读，页面上还什么都没有 → 报"命中 0 处"，看起来像抽取坏了，
  // 其实是 key 还没渲染。要等的东西就是要抽的东西，所以判据用这个正则本身，不另猜一个选择器。
  it('值要一个网络往返才渲染 → 轮询等到它，不是读一次就判没有', async () => {
    const { driver, reads } = driverAfter(4, 'key: gsk_abcdefghij1234567890')
    const got: string[] = []
    await captureSecret({ field: 'apiKey', pattern: 'gsk_[A-Za-z0-9]{10,}', timeout: 5000 }, driver, (_f, v) => got.push(v))
    expect(got).toEqual(['gsk_abcdefghij1234567890'])
    expect(reads()).toBeGreaterThanOrEqual(4)
  })

  it('等到上限还是没有 → 拒写（而不是永远等下去）', async () => {
    const got: string[] = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: 'gsk_\\w+', timeout: 0 },
      driverWith('创建中…'),
      (_f, v) => got.push(v),
    )
    expect(got).toEqual([])
    expect(note).toContain('0 处')
  })

  it('没装配 sink → 明确拒绝并说明原因，不是静默丢掉', async () => {
    const note = await captureSecret({ field: 'apiKey', pattern: 'gsk_\\w+' }, driverWith('gsk_x'))
    expect(note).toContain('拒绝')
  })
})

// 有的平台**从不把明文放进 DOM**：智谱的 key 在列表里永远是掩码（`be11...dE4X`），明文只在点
// 复制时由一个专用端点 `/api_keys/copy/<id>` 返回，落进剪贴板。页面文本这条路对它是死的 ——
// 所以抽取要能改从 network observer 捕获的响应正文里取。判据（恰好一处）原样不变：换的是干草堆，
// 不是那根针的挑法。
describe('captureSecret — 从 network observer 捕获的响应体里取', () => {
  const bodies = (list: Array<{ url: string; text: string }>) => () => list

  it('响应体里恰好一处 → 交给 sink，且完全不去读页面文本', async () => {
    let evaluated = false
    const driver = {
      evalJson: async () => { evaluated = true; return '' },
      sleep: async () => {},
    } as unknown as PageDriver
    const got: Array<[string, string]> = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: '[0-9a-f]{32}\\.[A-Za-z0-9]{16}', from: { network: '*/api_keys/copy/*' } },
      driver,
      (f, v) => got.push([f, v]),
      bodies([{
        url: 'https://bigmodel.cn/api/biz/v1/organization/org-x/projects/proj-y/api_keys/copy/be11',
        text: '{"code":200,"data":{"apiKey":"be11c1a409d143dab4242befd34dbfd7.AbCdEfGhIjKlMnOp"}}',
      }]),
    )
    expect(got).toEqual([['apiKey', 'be11c1a409d143dab4242befd34dbfd7.AbCdEfGhIjKlMnOp']])
    expect(evaluated).toBe(false) // 声明了 network 来源就不该再去翻页面
    expect(note).not.toContain('AbCdEfGhIjKlMnOp') // 值绝不进 trace
  })

  it('只认 urlPattern 命中的那个响应 —— 别的响应里长得像的不算', async () => {
    const got: string[] = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: '[0-9a-f]{32}\\.[A-Za-z0-9]{16}', from: { network: '*/api_keys/copy/*' }, timeout: 0 },
      driverWith(''),
      (_f, v) => got.push(v),
      bodies([{
        url: 'https://bigmodel.cn/api/biz/v1/organization/org-x/projects/proj-y/api_keys',
        text: '{"data":[{"apiKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ZzZzZzZzZzZzZzZz"}]}',
      }]),
    )
    expect(got).toEqual([])
    expect(note).toContain('0 处')
  })

  it('两个响应各带一把不同的 key → 拒写（同页面文本那条一样，挑哪个都是猜）', async () => {
    const got: string[] = []
    const note = await captureSecret(
      { field: 'apiKey', pattern: '[0-9a-f]{32}\\.[A-Za-z0-9]{16}', from: { network: '*/api_keys/copy/*' } },
      driverWith(''),
      (_f, v) => got.push(v),
      bodies([
        { url: 'https://bigmodel.cn/x/api_keys/copy/a', text: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.AaAaAaAaAaAaAaAa"' },
        { url: 'https://bigmodel.cn/x/api_keys/copy/b', text: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.BbBbBbBbBbBbBbBb"' },
      ]),
    )
    expect(got).toEqual([])
    expect(note).toContain('2 处')
  })

  // 守卫钉在装载点而不是运行时：一份 `from.network` 却没挂对应 observer 的 recipe，运行起来会
  // 表现成"抽取拒绝"，而真因在几十行之外的 observers 段。装载即拒，审查那一刻就说清楚。
  // 凭证不是 item：`from.network` **不需要** recipe 另外声明 observer，引擎按 glob 自己挂一份
  // 只捕获不累积的。反过来强制声明过一版，代价是那个 observer 进了 items 管线、抓到的响应被空
  // output 判成 malformed → drift，drift 又盖住 extract 的真实结论。
  it('装载守卫：from.network 只校验 glob 本身，不要求另外声明 observer', () => {
    const base = {
      version: 1, kind: 'browser', sourceId: 'zhipu-create-key', cookieDomain: 'bigmodel.cn',
      entryUrl: 'https://bigmodel.cn/apikey/platform', steps: [], allowEmpty: true,
      session: { facility: 'zhipu', lifecycle: 'one-shot', visibility: 'interactive' },
      loginCheck: { loggedIn: '.api-keys .header-right button', wall: "a[href*='/login']" },
      output: { itemsAt: '', dedupeBy: '', targetCount: 0, mapping: {} },
      extract: { field: 'apiKey', pattern: 'x', from: { network: '*/api_keys/copy/*' } },
      meta: { runtime_config: { ref: 'zhipu', fields: { apiKey: { type: 'secret', label: 'k' } } } },
    }
    // 没有任何 observer 也照过——这才是这类 recipe 的正常形状
    expect(() => validateRecipe('zhipu-create-key', { ...base, observers: [] })).not.toThrow()
    // glob 本身不能空
    expect(() => validateRecipe('zhipu-create-key', {
      ...base, observers: [], extract: { ...base.extract, from: { network: '' } },
    })).toThrow(/from\.network/)
  })

  it('声明了 network 来源、却没装配 body 来源（recipe 没挂对应 observer）→ 明确拒绝', async () => {
    const note = await captureSecret(
      { field: 'apiKey', pattern: 'x', from: { network: '*/copy/*' } },
      driverWith(''),
      () => {},
    )
    expect(note).toContain('拒绝')
  })
})

// 守卫的另一半钉在**装载点**——一份共享 recipe 被审查的那一刻。等到运行时才发现
// "这个字段没声明成 secret"，表现是抽取静默不生效，没有人会去找原因。
describe('validateRecipe — extract 的目标槽必须是自己声明过的 secret', () => {
  const base = {
    version: 1,
    kind: 'browser',
    sourceId: 'x-create-key',
    cookieDomain: 'x.com',
    entryUrl: 'https://x.com/keys',
    loginCheck: { loggedIn: '.me', wall: '.login' },
    session: { facility: 'x', lifecycle: 'one-shot', visibility: 'interactive' },
    steps: [{ kind: 'click', selector: '#go' }],
    observers: [],
    output: { itemsAt: '', dedupeBy: '', targetCount: 0, mapping: {} },
    allowEmpty: true,
  }
  const withMeta = (fields: Record<string, unknown>) => ({
    ...base,
    extract: { field: 'apiKey', pattern: 'k_\\w+' },
    meta: { runtime_config: { ref: 'x', fields } },
  })

  it('声明齐全 → 通过（且没有 observer/evaluate 也不算"没有产出"）', () => {
    expect(() => validateRecipe('x', withMeta({ apiKey: { type: 'secret', label: 'K' } }))).not.toThrow()
  })

  it('字段声明成 string 而不是 secret → 装载即拒', () => {
    expect(() => validateRecipe('x', withMeta({ apiKey: { type: 'string', label: 'K' } }))).toThrow(/secret/)
  })

  it('字段压根没声明 → 装载即拒（不能凭空往凭据存储塞键）', () => {
    expect(() => validateRecipe('x', withMeta({ other: { type: 'secret', label: 'O' } }))).toThrow(/apiKey/)
  })

  it('完全没有 runtime_config 声明 → 装载即拒', () => {
    expect(() => validateRecipe('x', { ...base, extract: { field: 'apiKey', pattern: 'k_\\w+' } })).toThrow(/secret/)
  })

  it('正则编译不了 → 装载即拒（运行时才发现就只是抽不到）', () => {
    expect(() =>
      validateRecipe('x', { ...withMeta({ apiKey: { type: 'secret', label: 'K' } }), extract: { field: 'apiKey', pattern: 'k_(' } }),
    ).toThrow(/正则/)
  })
})
