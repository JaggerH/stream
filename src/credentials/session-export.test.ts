import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportSession, sessionFileName, validateSessionExport, type SessionExportSpec } from './session-export.ts'
import type { BrowserCookie } from '../types.ts'

const outDir = (): string => mkdtempSync(join(tmpdir(), 'session-export-'))

const COOKIES: BrowserCookie[] = [
  { name: 'sid', value: 'abc', domain: 'jywg.example.com', path: '/', httpOnly: true },
  { name: 'uid', value: '42', domain: '.example.com', path: '/' },
]

const spec = (over: Partial<SessionExportSpec> = {}): SessionExportSpec => ({
  name: 'broker',
  alias: 'alice',
  domain: 'example.com',
  out_dir: outDir(),
  ...over,
})

const deps = (over: Partial<Parameters<typeof exportSession>[1]> = {}) => ({
  cookiesFor: async () => COOKIES,
  cookieHeader: async () => 'sid=abc; uid=42',
  fetchText: async () => '<html><body><input name="em_validatekey" value="KEY-123"></body></html>',
  now: () => 1_700_000_000_000,
  ...over,
})

describe('sessionFileName', () => {
  it('跟消费者的命名约定一致（cookies_<name>_<alias>.json）', () => {
    expect(sessionFileName({ name: 'dfcf', alias: 'jagger' })).toBe('cookies_dfcf_jagger.json')
    expect(sessionFileName({ name: 'dfcf' })).toBe('cookies_dfcf.json')
  })
})

describe('validateSessionExport', () => {
  it('extras.url 落在别的域上 → 装载期就拒（一份声明不能拿 A 域的凭据打 B 域）', () => {
    const bad = validateSessionExport(spec({
      extras: { k: { url: 'https://evil.test/steal', selector: 'input' } },
    }))
    expect(bad).toMatch(/不在 domain/)
  })

  it('extras.url 指向内网 / 宿主自己 → 拒（SSRF）', () => {
    expect(validateSessionExport(spec({
      extras: { k: { url: 'http://127.0.0.1:8900/api/tasks', selector: 'input' } },
    }))).toMatch(/公网 http/)
  })

  it('同域的 https 页面放行', () => {
    expect(validateSessionExport(spec({
      extras: { k: { url: 'https://jywg.example.com/Trade/Buy', selector: 'input' } },
    }))).toBeNull()
  })
})

describe('exportSession', () => {
  it('写出消费者约定的 payload：saved_at 秒 + 整条 cookie 记录 + alias + extras', async () => {
    const s = spec({ extras: { validatekey: { url: 'https://jywg.example.com/Trade/Buy', selector: 'input[name="em_validatekey"]', attr: 'value' } } })
    const res = await exportSession(s, deps())
    expect(res.ok).toBe(true)
    expect(res.extras).toEqual(['validatekey'])
    const payload = JSON.parse(readFileSync(res.path!, 'utf-8'))
    expect(payload).toEqual({
      saved_at: 1_700_000_000,
      cookies: COOKIES,
      alias: 'alice',
      validatekey: 'KEY-123',
    })
  })

  it('文件权限 0600 —— 里面是明文登录态，且已存在的旧文件也要被收紧', async () => {
    const dir = outDir()
    const path = join(dir, sessionFileName({ name: 'broker', alias: 'alice' }))
    writeFileSync(path, '{}', { mode: 0o644 })
    const res = await exportSession(spec({ out_dir: dir }), deps())
    expect(res.ok).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('一条 cookie 都没有 → 不落盘，且回执说清两个成因', async () => {
    const s = spec()
    const res = await exportSession(s, deps({ cookiesFor: async () => [] }))
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/没登录|同步范围/)
    expect(() => statSync(join(s.out_dir, sessionFileName(s)))).toThrow()
  })

  it('必填 extra 取不到 → 整份不写（旧文件留着比一份缺字段的新文件强）', async () => {
    const dir = outDir()
    const path = join(dir, sessionFileName({ name: 'broker', alias: 'alice' }))
    writeFileSync(path, '{"validatekey":"OLD"}')
    const res = await exportSession(
      spec({ out_dir: dir, extras: { validatekey: { url: 'https://jywg.example.com/Trade/Buy', selector: '#em_validatekey', attr: 'value' } } }),
      deps({ fetchText: async () => '<html><body><input id="txtZjzh"></body></html>' }),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/没取到/)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ validatekey: 'OLD' })
  })

  it('optional 的 extra 取不到 → 照写，只是少那一格', async () => {
    const res = await exportSession(
      spec({ extras: { nice: { url: 'https://jywg.example.com/x', selector: '#nope', optional: true } } }),
      deps(),
    )
    expect(res.ok).toBe(true)
    expect(res.extras).toEqual([])
    expect(JSON.parse(readFileSync(res.path!, 'utf-8')).nice).toBeUndefined()
  })

  it('取 extra 的那一发请求带上该域的 Cookie 头（没有它读回的就是登录页）', async () => {
    let seen: Record<string, string> | undefined
    await exportSession(
      spec({ extras: { k: { url: 'https://jywg.example.com/Trade/Buy', selector: 'input', attr: 'value' } } }),
      deps({ fetchText: async (_u, headers) => { seen = headers; return '<input value="v">' } }),
    )
    expect(seen).toEqual({ cookie: 'sid=abc; uid=42' })
  })

  it('声明的 headers 原样发，但写在声明里的 cookie 盖不掉宿主那份登录态', async () => {
    let seen: Record<string, string> | undefined
    await exportSession(
      spec({ extras: { k: { url: 'https://jywg.example.com/x', selector: 'input', attr: 'value', headers: { 'user-agent': 'UA/1', cookie: 'forged=1' } } } }),
      deps({ fetchText: async (_u, headers) => { seen = headers; return '<input value="v">' } }),
    )
    expect(seen).toEqual({ 'user-agent': 'UA/1', cookie: 'sid=abc; uid=42' })
  })

  it('回执里绝不出现 cookie 值或 extra 的值（它会进日志和 debug bus）', async () => {
    const res = await exportSession(
      spec({ extras: { validatekey: { url: 'https://jywg.example.com/Trade/Buy', selector: 'input[name="em_validatekey"]', attr: 'value' } } }),
      deps(),
    )
    const dumped = JSON.stringify(res)
    expect(dumped).not.toContain('KEY-123')
    expect(dumped).not.toContain('abc')
    expect(res.cookieCount).toBe(2)
  })
})
