import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Schema from 'schemastery'
import { SettingsStore } from '../settings-store.ts'
import type { ConfigRowSpec } from './config-rows.ts'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'config-rows-')), 'settings.json')

function storeWith(spec?: Partial<ConfigRowSpec>, seed?: Record<string, unknown>) {
  const path = tmpFile()
  if (seed) writeFileSync(path, JSON.stringify(seed))
  const s = new SettingsStore(path)
  s.rows.register({
    id: 'demo',
    schema: Schema.object({
      apiKey: Schema.string().role('secret').description('key'),
      language: Schema.string().default('zh-CN'),
      note: Schema.string(),
    }),
    ...spec,
  })
  return s
}

describe('ConfigRowRegistry 分层合并', () => {
  it('schema 默认 < deployDefaults < 用户值', async () => {
    const s = storeWith({ deployDefaults: () => ({ language: 'ja-JP', note: 'deploy' }) })
    expect(s.rows.resolve('demo')).toMatchObject({ language: 'ja-JP', note: 'deploy' })
    await s.rows.put('demo', { language: 'en-US' })
    expect(s.rows.resolve('demo')).toMatchObject({ language: 'en-US', note: 'deploy' })
  })

  it('空串 = 用户主动清空，不回落默认（withRuntimeDefaults 的既有判据）', async () => {
    const s = storeWith()
    await s.rows.put('demo', { language: '' })
    expect(s.rows.resolve('demo').language).toBe('')
  })

  it('legacy 投影按键垫底；PUT 只写发过的键，legacy 不复制进 rows；退役字段不穿透', async () => {
    const s = storeWith(
      { legacy: (raw) => (raw as { videoSources?: Record<string, unknown> }).videoSources },
      { videoSources: { apiKey: 'old-key', language: 'en-US', connections: ['dead'] } }
    )
    const resolved = s.rows.resolve('demo')
    expect(resolved).toMatchObject({ apiKey: 'old-key', language: 'en-US' })
    expect(resolved.connections).toBeUndefined()
    // PUT 只落发过的键——legacy 一直在底下垫着，复制进 rows 就是第二份真相
    await s.rows.put('demo', { note: 'hi' })
    expect(s.rowValues('demo')).toEqual({ note: 'hi' })
    expect(s.rows.resolve('demo')).toMatchObject({ apiKey: 'old-key', language: 'en-US', note: 'hi' })
  })

  it('按键垫底：rows 只有一个键、legacy 有另一个键 → 两个都读得到（AList 接管场景）', async () => {
    const s = storeWith(
      { legacy: (raw) => (raw as { alist?: Record<string, unknown> }).alist },
      { alist: { note: 'http://legacy-url' }, rows: { demo: { apiKey: 'fresh-jwt' } } }
    )
    expect(s.rows.resolve('demo')).toMatchObject({ apiKey: 'fresh-jwt', note: 'http://legacy-url' })
    // rows 里的空串按键盖掉 legacy（主动清空仍成立）
    await s.rows.put('demo', { note: '' })
    expect(s.rows.resolve('demo').note).toBe('')
  })

  it('schema 默认值不落盘——默认改了要追得上，不能被冻成"用户的选择"', async () => {
    const s = storeWith()
    await s.rows.put('demo', { note: 'x' })
    expect(s.rowValues('demo')).toEqual({ note: 'x' }) // 没有 language: 'zh-CN'
    expect(s.rows.resolve('demo').language).toBe('zh-CN') // 读侧仍补默认
  })
})

describe('ConfigRowRegistry 密文语义（四处手写收成一处的那条规则）', () => {
  it('GET 永不回显：values 里没有密文，只有 configured 布尔', async () => {
    const s = storeWith()
    await s.rows.put('demo', { apiKey: 'sk-secret' })
    const status = s.rows.status('demo')
    expect(status.values.apiKey).toBeUndefined()
    expect(status.secrets).toEqual({ apiKey: { configured: true } })
    expect(JSON.stringify(status)).not.toContain('sk-secret')
  })

  it('PUT 空串 = 保留存量；非空 = 覆盖', async () => {
    const s = storeWith()
    await s.rows.put('demo', { apiKey: 'first' })
    await s.rows.put('demo', { apiKey: '', language: 'en-US' })
    expect(s.rows.resolve('demo')).toMatchObject({ apiKey: 'first', language: 'en-US' })
    await s.rows.put('demo', { apiKey: 'second' })
    expect(s.rows.resolve('demo').apiKey).toBe('second')
  })

  it('没有存量时空串不落盘（configured 保持 false）', async () => {
    const s = storeWith()
    await s.rows.put('demo', { apiKey: '' })
    expect(s.rows.status('demo').secrets.apiKey.configured).toBe(false)
  })
})

describe('ConfigRowRegistry 钩子', () => {
  it('schema 类型错抛错，不落盘', async () => {
    const s = storeWith()
    await expect(s.rows.put('demo', { language: 42 })).rejects.toThrow(/expected string/)
    expect(s.rowValues('demo')).toBeUndefined()
  })

  it('validate 钩子拒绝 → 抛错不落盘', async () => {
    const s = storeWith({
      validate: (v) => {
        if (v.note === 'bad') throw new Error('note rejected')
      },
    })
    await expect(s.rows.put('demo', { note: 'bad' })).rejects.toThrow('note rejected')
    expect(s.rowValues('demo')).toBeUndefined()
  })

  it('apply 钩子收到四层合并后的值；抛错则回滚已落的盘', async () => {
    const seen: unknown[] = []
    let boom = false
    const s = storeWith({
      apply: (v) => {
        if (boom) throw new Error('apply failed')
        seen.push(v)
      },
    })
    await s.rows.put('demo', { note: 'ok' })
    expect(seen[0]).toMatchObject({ note: 'ok', language: 'zh-CN' }) // 合并后含 schema 默认
    boom = true
    await expect(s.rows.put('demo', { note: 'later' })).rejects.toThrow('apply failed')
    expect(s.rowValues('demo')).toEqual({ note: 'ok' }) // 回滚到上一次
  })
})

describe('ConfigRowRegistry 注册面', () => {
  it('重复 id 硬拒；注销后可重注册（域重挂不撞车）', () => {
    const s = storeWith()
    expect(() => s.rows.register({ id: 'demo', schema: Schema.object({}) })).toThrow(/duplicate/)
    const dispose = s.rows.register({ id: 'other', schema: Schema.object({ x: Schema.number() }) })
    dispose()
    expect(s.rows.has('other')).toBe(false)
    s.rows.register({ id: 'other', schema: Schema.object({ x: Schema.number() }) })
    expect(s.rows.has('other')).toBe(true)
  })

  it('非扁平 object schema 拒绝注册（本片边界）', () => {
    const s = new SettingsStore(tmpFile())
    expect(() => s.rows.register({ id: 'x', schema: Schema.string() as never })).toThrow(/flat object/)
  })

  it('未知 row：has false，resolve/put 抛错', async () => {
    const s = new SettingsStore(tmpFile())
    expect(s.rows.has('nope')).toBe(false)
    expect(() => s.rows.resolve('nope')).toThrow(/unknown row/)
    await expect(s.rows.put('nope', {})).rejects.toThrow(/unknown row/)
  })
})

describe('ConfigRowRegistry row family（slice3）', () => {
  function familyStore() {
    const s = new SettingsStore(tmpFile())
    const records: Record<string, Record<string, unknown>> = {}
    s.rows.registerFamily({
      prefix: 'source',
      resolve: (rest) => {
        if (rest !== 'tmdb' && !rest.startsWith('llm:')) return undefined // 护栏：认不出 = 404
        return {
          schema: Schema.object({
            apiKey: Schema.string().role('secret').description('key'),
            language: Schema.string().default('zh-CN'),
          }),
          user: () => records[rest],
          raw: () => records[rest],
          write: (r) => { records[rest] = r },
          clear: () => { delete records[rest] },
        }
      },
    })
    return { s, records }
  }

  it('family row 走自己的存储；has/status/put 与静态 row 同一套语义', async () => {
    const { s, records } = familyStore()
    expect(s.rows.has('source:tmdb')).toBe(true)
    expect(s.rows.has('source:nope')).toBe(false) // 写入护栏：任意 ref 打不开
    expect(s.rows.has('nocolon')).toBe(false)
    await s.rows.put('source:tmdb', { apiKey: 'k1' })
    expect(records.tmdb).toEqual({ apiKey: 'k1' })
    const status = s.rows.status('source:tmdb')
    expect(status.values).toEqual({ language: 'zh-CN' }) // 默认打底、密文剔除
    expect(status.secrets.apiKey.configured).toBe(true)
  })

  it('per-instance 形状的 rest 各存各的，密文空串保留同样生效', async () => {
    const { s, records } = familyStore()
    await s.rows.put('source:llm:kimi', { apiKey: 'a' })
    await s.rows.put('source:llm:qwen', { apiKey: 'b' })
    expect(records['llm:kimi']).toEqual({ apiKey: 'a' })
    expect(records['llm:qwen']).toEqual({ apiKey: 'b' })
    await s.rows.put('source:llm:kimi', { apiKey: '', language: 'en-US' })
    expect(records['llm:kimi']).toEqual({ apiKey: 'a', language: 'en-US' })
  })

  it('前缀撞车硬拒；注销后可重注册', () => {
    const { s } = familyStore()
    expect(() => s.rows.registerFamily({ prefix: 'source', resolve: () => undefined })).toThrow(/duplicate/)
    const dispose = s.rows.registerFamily({ prefix: 'other', resolve: () => undefined })
    dispose()
    s.rows.registerFamily({ prefix: 'other', resolve: () => undefined })
  })
})

describe('runtimeConfig 的 tmdb/omdb 投影走 row（注册了才走）', () => {
  it('row 注册后，新表单写的 key 立刻流进 Source 侧', async () => {
    const s = new SettingsStore(tmpFile())
    s.rows.register({
      id: 'video-sources',
      schema: Schema.object({
        tmdbApiKey: Schema.string().role('secret'),
        omdbApiKey: Schema.string().role('secret'),
        language: Schema.string().default('zh-CN'),
      }),
      legacy: (raw) => raw.videoSources as Record<string, unknown> | undefined,
    })
    await s.rows.put('video-sources', { tmdbApiKey: 'row-key', language: 'en-US' })
    expect(s.runtimeConfig('tmdb')).toEqual({ apiKey: 'row-key', language: 'en-US' })
  })

  it('row 注册但用户没写过 → 不投影（保持既有 {} 行为）', () => {
    const s = new SettingsStore(tmpFile())
    s.rows.register({
      id: 'video-sources',
      schema: Schema.object({ tmdbApiKey: Schema.string().role('secret'), language: Schema.string().default('zh-CN') }),
    })
    expect(s.runtimeConfig('tmdb')).toEqual({})
  })
})
