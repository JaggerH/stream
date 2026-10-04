import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import Schema from 'schemastery'
import { SettingsStore } from '../settings-store.ts'
import { mountConfigRows } from './config-rows-routes.ts'

function appWith() {
  const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), 'config-routes-')), 'settings.json'))
  store.rows.register({
    id: 'demo',
    schema: Schema.object({
      apiKey: Schema.string().role('secret'),
      language: Schema.string().default('zh-CN'),
    }),
    validate: (v) => {
      if (v.language === 'no') throw new Error('language rejected')
    },
  })
  const app = new Hono()
  mountConfigRows(app, { rows: store.rows })
  return { app, store }
}

const put = (app: Hono, id: string, body: unknown) =>
  app.request(`/api/config/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('GET/PUT /api/config/:rowId', () => {
  it('GET 回 schema(可复原) + values + secrets；密文不出现', async () => {
    const { app } = appWith()
    await put(app, 'demo', { apiKey: 'sk-hidden' })
    const res = await app.request('/api/config/demo')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schema: unknown; values: Record<string, unknown>; secrets: Record<string, { configured: boolean }> }
    expect(body.values).toEqual({ language: 'zh-CN' })
    expect(body.secrets.apiKey.configured).toBe(true)
    expect(JSON.stringify(body)).not.toContain('sk-hidden')
    // 序列化的 schema 客户端可复原且行为一致（契约：两端同库同版本）
    const revived = new Schema(body.schema as never)
    expect((revived({}) as { language: string }).language).toBe('zh-CN')
    expect(revived.dict?.apiKey?.meta.role).toBe('secret')
  })

  it('PUT 落盘并回新 status', async () => {
    const { app, store } = appWith()
    const res = await put(app, 'demo', { language: 'en-US' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { values: Record<string, unknown> }).values.language).toBe('en-US')
    expect(store.rowValues('demo')).toEqual({ language: 'en-US' })
  })

  it('未注册的 rowId → 404', async () => {
    const { app } = appWith()
    expect((await app.request('/api/config/nope')).status).toBe(404)
    expect((await put(app, 'nope', {})).status).toBe(404)
  })

  it('schema 类型错 / validate 钩子拒 → 400 带原文', async () => {
    const { app } = appWith()
    const bad = await put(app, 'demo', { language: 42 })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/expected string/)
    const rejected = await put(app, 'demo', { language: 'no' })
    expect(rejected.status).toBe(400)
    expect(((await rejected.json()) as { error: string }).error).toBe('language rejected')
  })

  it('body 不是 JSON 对象 → 400', async () => {
    const { app } = appWith()
    const res = await app.request('/api/config/demo', { method: 'PUT', body: 'not-json' })
    expect(res.status).toBe(400)
  })

  /**
   * 严格输入闸（docs/API.md §2）。合法键不是手抄的名单，是这一行 schema 声明的键——
   * 引擎本来就只认这些，多出来的以前被静默丢掉：写错一个字段名拿到 200 + 一份
   * "看起来存进去了"的 status。
   */
  it('不认识的键 → 400 指出该写哪个，且一个字节都没落盘', async () => {
    const { app, store } = appWith()
    const res = await put(app, 'demo', { langauge: 'en-US' })
    expect(res.status).toBe(400)
    const message = ((await res.json()) as { error: string }).error
    // 必须是**这道闸**说的话，不是碰巧撞上 schema 的类型错。
    expect(message).toContain('不认识的字段')
    expect(message).toContain('langauge')
    expect(message).toContain('language')
    expect(store.rowValues('demo')).toBeUndefined()
  })

  it('闸的合法键随 schema 走：改名一个字段，旧名字当场变成 400', async () => {
    const { app, store } = appWith()
    // apiKey 是这一行声明过的密文字段 → 放行；api_key 没有 → 400。
    expect((await put(app, 'demo', { apiKey: 'sk-1' })).status).toBe(200)
    const res = await put(app, 'demo', { api_key: 'sk-2' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('apiKey')
    expect(store.rowValues('demo')).toEqual({ apiKey: 'sk-1' })
  })
})
