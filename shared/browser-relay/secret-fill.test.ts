import { describe, it, expect, vi } from 'vitest'
import type { PageDriver } from './page-driver.ts'
import type { ActionSpec } from './interactive-gate.ts'
import { classifyAction, needsConfirmation } from './interactive-gate.ts'
import { ReadLocks, runLogin, SecretFillRefused, type SecretSource } from './secret-fill.ts'

// 一个认得出来的特征串：它只许出现在「打进页面的那一次输入」里，别处一律不许出现。
const CANARY = 'Canary-9f3a7-SecretValue'

/** 页面：几个输入框 + 一份文档身份（`performance.timeOrigin`）。`navigateOnSubmit` 决定提交后换不换文档。 */
function page(opts: { navigateOnSubmit?: boolean; missing?: string[]; clearFails?: boolean } = {}) {
  const fields = new Map<string, string>()
  let docId = 1000
  const typed: Array<[string, string]> = []
  const d = {
    type: vi.fn(async (sel: string, text: string) => {
      if (opts.missing?.includes(sel)) return false
      typed.push([sel, text])
      fields.set(sel, text)
      return true
    }),
    click: vi.fn(async () => {
      if (opts.navigateOnSubmit) docId++
      return true
    }),
    submit: vi.fn(async () => {
      if (opts.navigateOnSubmit) docId++
      return true
    }),
    evalJson: vi.fn(async (expr: string) => {
      if (expr === 'performance.timeOrigin') return docId
      const m = /querySelector\("([^"]+)"\)/.exec(expr)
      if (m && !opts.clearFails) {
        fields.set(m[1]!, '')
        return true
      }
      return false
    }),
    sleep: async () => {},
  } as unknown as PageDriver
  return { d, fields, typed }
}

const source = (over: Partial<Record<string, unknown>> = {}): SecretSource & { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(async () => ({ origins: ['https://a.example'], username: 'alice', password: CANARY, ...over })),
})

const login = (a: Partial<ActionSpec> = {}): ActionSpec => ({
  kind: 'login',
  domain: 'a.example',
  secret: 'site-a',
  usernameSelector: '#u',
  passwordSelector: '#p',
  ...a,
})

const at = (url: string) => async () => url

describe('runLogin', () => {
  it('没有来源 → secret-source-missing，页面上什么都没发生', async () => {
    const { d } = page()
    await expect(runLogin(d, login(), { source: undefined, currentUrl: at('https://a.example/login'), target: 'chrome:1' }))
      .rejects.toMatchObject({ code: 'secret-source-missing' })
    expect(d.type).not.toHaveBeenCalled()
  })

  it('页面换了站 → origin-mismatch，不取值以外的任何动作', async () => {
    const { d } = page()
    const src = source()
    await expect(runLogin(d, login(), { source: src, currentUrl: at('https://evil.example/login'), target: 'chrome:1' }))
      .rejects.toMatchObject({ code: 'origin-mismatch' })
    expect(d.type).not.toHaveBeenCalled()
    expect(src.get).toHaveBeenCalledWith('site-a', { origin: 'https://evil.example', target: 'chrome:1' })
  })

  it('同主机不同端口 / 协议也算不同 origin', async () => {
    const { d } = page()
    await expect(runLogin(d, login(), { source: source(), currentUrl: at('http://a.example/login'), target: 'chrome:1' }))
      .rejects.toMatchObject({ code: 'origin-mismatch' })
    expect(d.type).not.toHaveBeenCalled()
  })

  it('iframe 里的表单 → login-in-iframe-unsupported', async () => {
    const { d } = page()
    await expect(runLogin(d, login({ frame: 'f1' }), { source: source(), currentUrl: at('https://a.example/'), target: 'chrome:1' }))
      .rejects.toMatchObject({ code: 'login-in-iframe-unsupported' })
  })

  it('秘密里缺要填的那一项 → 一个字都不填', async () => {
    const { d } = page()
    await expect(
      runLogin(d, login({ totpSelector: '#t' }), { source: source(), currentUrl: at('https://a.example/'), target: 'chrome:1' }),
    ).rejects.toMatchObject({ code: 'secret-field-missing' })
    expect(d.type).not.toHaveBeenCalled()
  })

  it('不认得的引用名 → secret-unknown', async () => {
    const { d } = page()
    const src = { get: vi.fn(async () => null) }
    await expect(runLogin(d, login(), { source: src, currentUrl: at('https://a.example/'), target: 'chrome:1' }))
      .rejects.toMatchObject({ code: 'secret-unknown' })
  })

  it('提交后页面导航走 → logged-in；结果里没有任何值', async () => {
    const { d, typed } = page({ navigateOnSubmit: true })
    const r = await runLogin(d, login(), { source: source(), currentUrl: at('https://a.example/login'), target: 'chrome:1', pollMs: 1 })
    expect(r).toEqual({ status: 'logged-in', origin: 'https://a.example', filled: ['username', 'password'], navigated: true, cleared: true })
    expect(typed).toEqual([['#u', 'alice'], ['#p', CANARY]])
    expect(d.submit).toHaveBeenCalledWith('#p') // 没给 submitSelector：在最后一个字段上回车
    expect(JSON.stringify(r)).not.toContain(CANARY)
  })

  it('给了 submitSelector 就点它', async () => {
    const { d } = page({ navigateOnSubmit: true })
    await runLogin(d, login({ submitSelector: '#go' }), { source: source(), currentUrl: at('https://a.example/'), target: 'chrome:1', pollMs: 1 })
    expect(d.click).toHaveBeenCalledWith('#go')
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('页面没动 → 把填过的字段清空，not-navigated + cleared', async () => {
    const { d, fields } = page({ navigateOnSubmit: false })
    const r = await runLogin(d, login({ waitMs: 20 }), { source: source(), currentUrl: at('https://a.example/'), target: 'chrome:1', pollMs: 1 })
    expect(r).toMatchObject({ status: 'not-navigated', navigated: false, cleared: true })
    expect(fields.get('#p')).toBe('')
    expect(fields.get('#u')).toBe('')
  })

  it('清空失败 → cleared:false（交给调用方关标签或保持锁）', async () => {
    const { d } = page({ navigateOnSubmit: false, clearFails: true })
    const r = await runLogin(d, login({ waitMs: 10 }), { source: source(), currentUrl: at('https://a.example/'), target: 'chrome:1', pollMs: 1 })
    expect(r).toMatchObject({ navigated: false, cleared: false })
  })

  it('第二个字段的选择器没命中 → 先清掉已填的，再报错；报错里没有值', async () => {
    const { d, fields } = page({ missing: ['#p'] })
    const err = await runLogin(d, login(), { source: source(), currentUrl: at('https://a.example/'), target: 'chrome:1' }).catch((e) => e)
    expect(err).toBeInstanceOf(SecretFillRefused)
    expect(err.code).toBe('login-field-not-found')
    expect(fields.get('#u')).toBe('')
    expect(String(err.message)).not.toContain(CANARY)
    expect(String(err.message)).not.toContain('alice')
  })

  it('观察用的 driver 与输入用的分开时，导航与清空都看观察那一个', async () => {
    const typer = page()
    const observer = page({ navigateOnSubmit: false })
    let n = 0
    ;(observer.d.evalJson as ReturnType<typeof vi.fn>).mockImplementation(async () => 2000 + n++) // 每次读都是新文档
    const r = await runLogin(typer.d, login(), {
      source: source(), observer: observer.d, currentUrl: at('https://a.example/'), target: 'chrome:1', pollMs: 1,
    })
    expect(r.navigated).toBe(true)
    expect(typer.d.evalJson).not.toHaveBeenCalled()
  })
})

describe('login 的门', () => {
  it('固定高危（凭证），未确认就要停下', () => {
    expect(classifyAction(login()).risk).toBe('high')
    expect(needsConfirmation(login())).toBe(true)
  })
})

describe('ReadLocks', () => {
  it('拿着锁时同一个键立即被拒，别的键不受影响；跑完放锁', async () => {
    const locks = new ReadLocks()
    let release!: () => void
    const running = locks.hold('chrome:1', () => new Promise<void>((r) => { release = r }))
    expect(() => locks.assertFree('chrome:1')).toThrow(/secret-fill-in-progress/)
    expect(() => locks.assertFree('chrome:2')).not.toThrow()
    release()
    await running
    expect(() => locks.assertFree('chrome:1')).not.toThrow()
  })

  it('keep 为真时不放锁', async () => {
    const locks = new ReadLocks()
    await locks.hold('facility:x', async () => 'stuck', () => true)
    expect(locks.isHeld('facility:x')).toBe(true)
  })

  it('fn 抛错也放锁', async () => {
    const locks = new ReadLocks()
    await expect(locks.hold('chrome:3', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(locks.isHeld('chrome:3')).toBe(false)
  })
})
