import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PushedCookieStore } from './pushed-cookie-store.ts'
import { CookieProvider } from './cookie-provider.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pushed-cookies-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const cookie = (name: string, value: string) => ({ name, value, domain: '.quark.cn', path: '/' } as never)

describe('PushedCookieStore', () => {
  it('还没推过 = 空，不是故障', async () => {
    const s = new PushedCookieStore(dir)
    expect(await s.fetch()).toEqual({})
    expect(s.status()).toEqual({ domains: [], updatedAt: null })
  })

  it('推进来的能读回去，并落成 0600 的文件', async () => {
    const s = new PushedCookieStore(dir)
    s.replace({ '.quark.cn': [cookie('__pus', 'v')] })
    expect(await s.fetch()).toEqual({ '.quark.cn': [cookie('__pus', 'v')] })
    expect(s.status().domains).toEqual(['.quark.cn'])
    expect(s.status().updatedAt).toBeTypeOf('number')
    // 不加密，所以文件权限就是唯一的那道保护
    expect(statSync(join(dir, 'cookies.json')).mode & 0o777).toBe(0o600)
  })

  it('重启后（新实例）读得到上一次推的', async () => {
    new PushedCookieStore(dir).replace({ 'xhs.com': [cookie('a', '1')] })
    expect(await new PushedCookieStore(dir).fetch()).toEqual({ 'xhs.com': [cookie('a', '1')] })
  })

  it('整份替换：用户去掉一个域，那个域就该消失', async () => {
    const s = new PushedCookieStore(dir)
    s.replace({ 'a.com': [cookie('x', '1')], 'b.com': [cookie('y', '2')] })
    s.replace({ 'a.com': [cookie('x', '9')] })
    // 按域合并的话 b.com 会变成永不过期的僵尸登录态
    expect(await s.fetch()).toEqual({ 'a.com': [cookie('x', '9')] })
  })

  it('文件坏了当作"还没推过"，绝不抛', async () => {
    writeFileSync(join(dir, 'cookies.json'), '{ this is not json')
    const s = new PushedCookieStore(dir)
    // 抛出去就是整条采集链路起不来，而修复动作（等扩展再推一次）本来自动会发生
    expect(await s.fetch()).toEqual({})
    s.replace({ 'a.com': [cookie('x', '1')] })
    expect(await new PushedCookieStore(dir).fetch()).toEqual({ 'a.com': [cookie('x', '1')] })
  })

  it('写入是原子的：读到的要么是旧的整份，要么是新的整份', () => {
    const s = new PushedCookieStore(dir)
    s.replace({ 'a.com': [cookie('x', '1')] })
    s.replace({ 'a.com': [cookie('x', '2')] })
    // 半份 JSON 会让采集把"解析失败"当成"没登录"——所以先写 tmp 再 rename
    const raw = JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')) as { cookies: unknown }
    expect(raw.cookies).toEqual({ 'a.com': [cookie('x', '2')] })
  })
})

describe('接进现有的 provider（消费侧一行都不用改）', () => {
  it('CookieProvider 拿它当 source，cookieString 照常工作', async () => {
    const store = new PushedCookieStore(dir)
    store.replace({ '.quark.cn': [cookie('__pus', 'p'), cookie('__puus', 'u')] })
    const provider = new CookieProvider(store)
    // 域名归一 + 后缀匹配都是 provider 已有的行为，换来源不改变它
    expect(await provider.cookieString('quark.cn')).toBe('__pus=p; __puus=u')
    expect(await provider.cookieString('drive.quark.cn')).toBe(null)
    expect(await provider.availableDomains()).toEqual(['quark.cn'])
  })
})
