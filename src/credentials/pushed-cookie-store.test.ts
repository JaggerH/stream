import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceCookieStores, PushedCookieStore, cookieFileName } from './pushed-cookie-store.ts'
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
    expect(statSync(join(dir, 'cookies', 'local.json')).mode & 0o777).toBe(0o600)
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
    const raw = JSON.parse(readFileSync(join(dir, 'cookies', 'local.json'), 'utf8')) as { cookies: unknown }
    expect(raw.cookies).toEqual({ 'a.com': [cookie('x', '2')] })
  })
})

const c = (name: string) => ({ name, value: 'v', domain: 'eastmoneysec.com' }) as never

describe('per-device cookie snapshots', () => {
  it('两台设备各写各的文件', async () => {
    const stores = new DeviceCookieStores(dir)
    stores.forDevice('linux:nas').replace({ 'eastmoneysec.com': [c('nas')] })
    expect(await stores.fetch('linux:nas')).toEqual({ 'eastmoneysec.com': [c('nas')] })
    expect(await stores.fetch('local')).toEqual({})
    expect(existsSync(join(dir, 'cookies', cookieFileName('linux:nas')))).toBe(true)
  })

  it('设备 id 里的冒号与斜杠不会逃出 cookies 目录', () => {
    expect(cookieFileName('linux:3f2a')).toBe('linux_3f2a.json')
    expect(cookieFileName('../../etc')).not.toContain('/')
  })

  it('旧 cookies.json 迁为 local，内容不变', async () => {
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ updatedAt: 1, cookies: { 'eastmoneysec.com': [c('old')] } }))
    const s = new PushedCookieStore(dir, 'local')
    expect(await s.fetch()).toEqual({ 'eastmoneysec.com': [c('old')] })
    expect(existsSync(join(dir, 'cookies.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'cookies', 'local.json'), 'utf8')).cookies['eastmoneysec.com'][0].name).toBe('old')
  })

  it('新旧都在时不覆盖新的', async () => {
    new PushedCookieStore(dir, 'local').replace({ b: [c('new')] })
    // 迁移跑过之后旧文件又出现了（有人从备份放回来）：不能用它盖掉新的。
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ updatedAt: 1, cookies: { a: [c('old')] } }))
    expect(await new PushedCookieStore(dir, 'local').fetch()).toEqual({ b: [c('new')] })
    expect(existsSync(join(dir, 'cookies.json'))).toBe(true)
  })

  it('改名失败时 local 仍读得到旧文件（升级不掉登录）', async () => {
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ updatedAt: 1, cookies: { a: [c('old')] } }))
    // 让 cookies 目录建不出来：同名普通文件挡路，迁移必然失败
    writeFileSync(join(dir, 'cookies'), 'x')
    const logs: string[] = []
    const s = new PushedCookieStore(dir, 'local', (l) => logs.push(l))
    expect(logs.some((l) => l.includes('WARN'))).toBe(true)
    expect(await s.fetch()).toEqual({ a: [c('old')] })
    expect(existsSync(join(dir, 'cookies.json'))).toBe(true)
  })

  it('非 local 设备不碰旧文件', async () => {
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ updatedAt: 1, cookies: { a: [c('old')] } }))
    expect(await new PushedCookieStore(dir, 'linux:nas').fetch()).toEqual({})
    expect(existsSync(join(dir, 'cookies.json'))).toBe(true)
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

// browser-identity D10：一个节点一份，落在设备同名目录下；按设备的那份只留给老扩展。
describe('per-node snapshots', () => {
  it('local/node_a → cookies/local/node_a.json，0600；local 仍是 cookies/local.json', () => {
    const stores = new DeviceCookieStores(dir, () => {})
    stores.forSlot('local/node_a').replace({ 'quark.cn': [cookie('__pus', 'a')] })
    stores.forSlot('local').replace({ 'quark.cn': [cookie('__pus', 'legacy')] })
    const f = join(dir, 'cookies', 'local', 'node_a.json')
    expect(existsSync(f)).toBe(true)
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir, 'cookies', 'local.json'))).toBe(true)
    expect(existsSync(join(dir, 'cookies', 'linux_nas', 'node_n.json'))).toBe(false)
    stores.forSlot('linux:nas/node_n').replace({})
    expect(existsSync(join(dir, 'cookies', 'linux_nas', 'node_n.json'))).toBe(true)
  })

  it('【核心】同一台电脑两个 profile 的快照互不覆盖', async () => {
    const stores = new DeviceCookieStores(dir, () => {})
    stores.forSlot('local/node_w').replace({ 'xiaohongshu.com': [cookie('web_session', 'work')] })
    stores.forSlot('local/node_p').replace({ 'xiaohongshu.com': [cookie('web_session', 'personal')] })
    const fresh = new DeviceCookieStores(dir, () => {})
    expect((await fresh.fetch('local/node_w'))['xiaohongshu.com']?.[0]).toMatchObject({ value: 'work' })
    expect((await fresh.fetch('local/node_p'))['xiaohongshu.com']?.[0]).toMatchObject({ value: 'personal' })
  })

  it('current() 跟着回填的槽位解析器走', async () => {
    const stores = new DeviceCookieStores(dir, () => {})
    stores.forSlot('local/node_w').replace({ 'quark.cn': [cookie('__pus', 'w')] })
    expect(await stores.current().fetch()).toEqual({})
    stores.setSlotResolver(() => 'local/node_w')
    expect((await stores.current().fetch())['quark.cn']).toHaveLength(1)
  })

  it('CookieProvider 按槽位缓存：解析器换了节点，读到的是另一份', async () => {
    const stores = new DeviceCookieStores(dir, () => {})
    stores.forSlot('local/node_w').replace({ 'quark.cn': [cookie('__pus', 'w')] })
    stores.forSlot('local/node_p').replace({ 'quark.cn': [cookie('__pus', 'p')] })
    const provider = new CookieProvider(stores)
    let slot = 'local/node_w'
    provider.setSlotResolver(() => slot)
    expect(await provider.cookieString('quark.cn')).toBe('__pus=w')
    slot = 'local/node_p'
    expect(await provider.cookieString('quark.cn')).toBe('__pus=p')
  })
})

