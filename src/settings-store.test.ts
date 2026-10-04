import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, migrateLlmSettings, type LlmSettings } from './settings-store.ts'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'stream-settings-')), 'settings.json')

/** 存量 `settings.json` 里的 llm 块可能是三代形状之一，但只有 prompt 还有效。 */
const legacyV2 = {
  connections: [{ id: 'default', label: '默认', baseUrl: 'https://r/v1', apiKey: 'sek' }],
  tasks: { summarize: { connectionId: 'default', model: 'm' } },
  prompt: 'p',
}

describe('migrateLlmSettings', () => {
  // 连接已经是 `llm` Provider 行的成员，settings 这块只剩摘要 prompt。所以读的时候不必分代：
  // 三代形状里 prompt 的位置都一样，其余字段一律不读（读到 inert 的旧字段是正常的）。
  it('三代形状都只取 prompt，其余字段一概不读', () => {
    expect(migrateLlmSettings({ baseUrl: 'https://r/v1', apiKey: 'sek', model: 'm', prompt: 'p' })).toEqual({ prompt: 'p' })
    expect(migrateLlmSettings(legacyV2)).toEqual({ prompt: 'p' })
    expect(migrateLlmSettings({ prompt: 'p' })).toEqual({ prompt: 'p' })
  })

  it('没有 prompt 可取 → undefined（空/不认识的输入同理）', () => {
    expect(migrateLlmSettings(undefined)).toBeUndefined()
    expect(migrateLlmSettings({})).toBeUndefined()
    expect(migrateLlmSettings('garbage')).toBeUndefined()
    expect(migrateLlmSettings({ connections: legacyV2.connections })).toBeUndefined()
  })
})

describe('SettingsStore.get migration', () => {
  it('存量旧形状读出来只剩 prompt——连接不再从这里来', () => {
    const path = tmpFile()
    writeFileSync(path, JSON.stringify({ llm: { baseUrl: 'b', apiKey: 'k', model: 'm', prompt: '旧 prompt' } }))
    const s = new SettingsStore(path)
    expect(s.get().llm).toEqual({ prompt: '旧 prompt' })
  })
})

// 摘要 prompt / 影视凭证的写路径已收进配置 row 引擎（settings/config-rows.ts，语义测试在
// settings/config-rows.test.ts）；本文件只剩落盘面（rowValues/setRowValues/clearRowValues）。
describe('SettingsStore 配置 row 落盘面', () => {
  it('setRowValues 持久化且不碰兄弟块', () => {
    const s = new SettingsStore(tmpFile())
    s.setRowValues('alist', { url: 'http://alist:5244' })
    s.setRowValues('summary-prompt', { prompt: 'p' })
    expect(s.rowValues('summary-prompt')).toEqual({ prompt: 'p' })
    expect(s.rowValues('alist')?.url).toBe('http://alist:5244')
  })

  it('clearRowValues 只删指定 row', () => {
    const s = new SettingsStore(tmpFile())
    s.setRowValues('a', { x: 1 })
    s.setRowValues('b', { y: 2 })
    s.clearRowValues('a')
    expect(s.rowValues('a')).toBeUndefined()
    expect(s.rowValues('b')).toEqual({ y: 2 })
  })
})

describe('SettingsStore.setPluginEnabled', () => {
  it('persists per-plugin flags without clobbering siblings', () => {
    const s = new SettingsStore(tmpFile())
    s.setPluginEnabled('alist', false)
    s.setPluginEnabled('mineru', true)
    expect(s.get().plugins).toEqual({ alist: false, mineru: true })
    s.setPluginEnabled('alist', true) // flip back
    expect(s.get().plugins).toEqual({ alist: true, mineru: true })
  })

  it('does not clobber an existing llm block', () => {
    const path = tmpFile()
    writeFileSync(path, JSON.stringify({ llm: legacyV2 }))
    const s = new SettingsStore(path)
    s.setPluginEnabled('pansou', false)
    expect(s.get().llm?.prompt).toBe('p')
    expect(s.get().plugins?.pansou).toBe(false)
  })
})

describe('SettingsStore.setAlistCredentials（bootstrap 接管写入）', () => {
  it('token 写进 rows.alist（与 UI 同一条写路径），adminPassword 留在 legacy 块，url 不动', () => {
    const path = tmpFile()
    writeFileSync(path, JSON.stringify({ alist: { url: 'http://user-url' } }))
    const s = new SettingsStore(path)
    s.setAlistCredentials({ password: 'admin-pw', token: 'fresh-jwt' })
    expect(s.rowValues('alist')).toEqual({ token: 'fresh-jwt' })
    expect(s.get().alist).toEqual({ url: 'http://user-url', adminPassword: 'admin-pw' })
  })

  it('用户 row 里已有 url 时接管刷新 token 不碰它', () => {
    const s = new SettingsStore(tmpFile())
    s.setRowValues('alist', { url: 'http://row-url', token: 'old' })
    s.setAlistCredentials({ password: 'pw', token: 'new-jwt' })
    expect(s.rowValues('alist')).toEqual({ url: 'http://row-url', token: 'new-jwt' })
  })
})

describe('SettingsStore runtime source configuration', () => {
  it('migrates legacy video settings into shared Source configuration refs', () => {
    // 裸构造的 store 没注册 video-sources row → 走旧键（videoSources）回落分支。
    const path = tmpFile()
    writeFileSync(path, JSON.stringify({ videoSources: { tmdbApiKey: 'tmdb-secret', omdbApiKey: 'omdb-secret', language: 'zh-CN' } }))
    const s = new SettingsStore(path)

    expect(s.runtimeConfig('tmdb')).toEqual({ apiKey: 'tmdb-secret', language: 'zh-CN' })
    expect(s.runtimeConfig('omdb')).toEqual({ apiKey: 'omdb-secret' })
  })

  it('preserves a stored secret when a Source Config Sheet submits a blank value', () => {
    const s = new SettingsStore(tmpFile())
    s.setRuntimeConfig('tmdb', { apiKey: 'tmdb-secret', language: 'zh-CN' }, ['apiKey'])
    s.setRuntimeConfig('tmdb', { apiKey: '', language: 'en-US' }, ['apiKey'])

    expect(s.runtimeConfig('tmdb')).toEqual({ apiKey: 'tmdb-secret', language: 'en-US' })
  })

  // status 的密文投影已归配置 row 引擎（source family，见 settings/config-rows.test.ts）；
  // 这里只剩裸存量面。
  it('runtimeConfigRecord/setRuntimeConfigRecord/clearRuntimeConfigRecord 是裸存量面', () => {
    const s = new SettingsStore(tmpFile())
    s.setRuntimeConfigRecord('tmdb', { apiKey: 'k', language: 'zh-CN' })
    expect(s.runtimeConfigRecord('tmdb')).toEqual({ apiKey: 'k', language: 'zh-CN' })
    s.clearRuntimeConfigRecord('tmdb')
    expect(s.runtimeConfigRecord('tmdb')).toBeUndefined()
  })
})

describe('SettingsStore trackSync attribution', () => {
  it('bills every whole-file synchronous write to a settings-write span', () => {
    const spans: string[] = []
    const s = new SettingsStore(tmpFile(), (name, fn) => {
      spans.push(name)
      return fn()
    })
    s.setRowValues('summary-prompt', { prompt: 'p' })
    s.setRowValues('alist', { url: 'http://alist:5244', token: 'tok' })
    expect(spans).toEqual(['settings-write', 'settings-write'])
    // the write actually happened inside the span, not just alongside it
    expect(s.rowValues('alist')?.url).toBe('http://alist:5244')
  })

  it('works without a trackSync injected (bystander: attribution never required)', () => {
    const s = new SettingsStore(tmpFile())
    s.setRowValues('alist', { url: 'http://alist:5244' })
    expect(s.rowValues('alist')?.url).toBe('http://alist:5244')
  })
})

describe('SettingsStore 扩展安装引导', () => {
  it('拒绝一次之后记下时刻——启动横幅靠它决定还提不提', () => {
    const path = tmpFile()
    const store = new SettingsStore(path)
    expect(store.extensionOnboarding().declinedAt).toBeUndefined()
    store.declineExtensionOnboarding('2026-08-30T10:00:00.000Z')
    expect(store.extensionOnboarding().declinedAt).toBe('2026-08-30T10:00:00.000Z')
    // 落盘要活过重启：这条记录的全部意义就是"下次别再问了"
    expect(new SettingsStore(path).extensionOnboarding().declinedAt).toBe('2026-08-30T10:00:00.000Z')
  })

  it('记这一条不许把别的设置冲掉（整份重写的经典事故）', () => {
    const store = new SettingsStore(tmpFile())
    store.setRowValues('alist', { url: 'http://alist:5244' })
    store.declineExtensionOnboarding('2026-08-30T10:00:00.000Z')
    expect(store.rowValues('alist')?.url).toBe('http://alist:5244')
  })
})

describe('SettingsStore 落盘权限', () => {
  // settings.json 是凭据存储：`runtimeConfigs` 里躺着各家 API key，recipe 的 secret_params
  // 也从这儿取（东方财富的资金账号/交易密码）。判据跟 data/cookies.json 同一条：0600。
  it('新建的 settings.json 是 0600', () => {
    const path = tmpFile()
    new SettingsStore(path).setRowValues('dfcf', { jymm: 'sek' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  // 存量那份是 644 写出来的，而 writeFileSync 的 mode 只在**新建**时生效——所以必须靠写完
  // 之后的 chmod 掰回来，否则升级之后老文件永远是敞着的，而且没有任何一处会喊。
  it('存量 644 的文件，写一次之后收紧成 0600', () => {
    const path = tmpFile()
    writeFileSync(path, '{}', { mode: 0o644 })
    new SettingsStore(path).setRowValues('dfcf', { jymm: 'sek' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
