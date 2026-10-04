import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'

async function mount(opts: { domains?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stream-credentials-'))
  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, {
    dataDir: dir,
    log: () => {},
    requiredDomains: () => opts.domains ?? [],
  })
  return kernel
}

describe('credentialsPlugin', () => {
  it('挂成 ctx.credentials，dispose 后消失', async () => {
    const kernel = await mount()
    expect(kernel.credentials.cookieProvider).toBeDefined()
    expect(kernel.credentials.resolver).toBeDefined()
    await quiesceKernel(kernel)
    expect(kernel.credentials).toBeUndefined()
  })

  // 这个接口只回答"要哪些域"。密钥一个都不许出现在里面——它没有门的那阵子，任何网页
  // fetch 一下就能拿走整个 cookie 库的钥匙。
  it('sync-config 只有 requiredDomains，不下发任何密钥', async () => {
    const kernel = await mount({ domains: ['quark.cn'] })
    expect(kernel.credentials.extSyncConfig()).toEqual({ requiredDomains: ['quark.cn'] })
    await quiesceKernel(kernel)
  })

  it('cookieHealth 报快照现状：还没取过 → 空域 + updatedAt 为 null', async () => {
    const kernel = await mount()
    expect(await kernel.credentials.cookieHealth()).toEqual({ domains: [], updatedAt: null })
    await quiesceKernel(kernel)
  })

  it('cookieHealth 跟着快照走：取回一轮之后报出那些域', async () => {
    const kernel = await mount()
    kernel.credentials.pushedCookies.replace({ '.Quark.cn': [{ name: 'a', value: '1', domain: '.quark.cn' }] })
    await kernel.credentials.cookieProvider.refresh()
    const health = await kernel.credentials.cookieHealth()
    // 域名归一（剥点 + 小写）由 provider 那一份负责，健康面吃的是同一个答案。
    expect(health.domains).toEqual(['quark.cn'])
    expect(health.updatedAt).toBeTypeOf('number')
    await quiesceKernel(kernel)
  })

  // requiredDomains 是前向引用的 thunk：装载时 registry 还不存在，取值时才成立。
  it('requiredDomains 每次取值时现算，不是装载时的快照', async () => {
    let domains = ['first.com']
    const dir = mkdtempSync(join(tmpdir(), 'stream-credentials-'))
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dir, 'settings.json') })
    await kernel.plugin(credentialsPlugin, { dataDir: dir, log: () => {}, requiredDomains: () => domains })
    domains = ['later.com']
    expect(kernel.credentials.extSyncConfig().requiredDomains).toEqual(['later.com'])
    await quiesceKernel(kernel)
  })
})
