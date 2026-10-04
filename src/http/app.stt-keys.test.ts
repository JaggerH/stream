// 云转写三成员（cf-whisper / groq-whisper / openai-whisper）的 manifest 必须声明
// runtime_config，配置界面才长得出 key 输入框；ref 必须与 bootstrap.ts TokenProvider
// 的逻辑名（cloudflare / groq / openai）逐字一致，stored 层才接得上。
//
// 用真实 packages/builtin、packages/groq 与 packages/cloudflare 的 manifests.yaml（经 loadPlugins→sealManifests→Registry，和生产
// bootstrap.ts 同一条装载路径）而非 app-harness.ts 里的 fake 夹具，因为要验证的正是这份
// YAML 本身有没有声明对——fake 夹具的 manifests 是硬编码在测试里的另一份数据，测不出真相。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createHttpApp } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { sealManifests } from '../registry/seal.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { UserStore } from '../store/user-store.ts'
import { loadPlugins } from '../plugins/loader.ts'
import { health } from './__fixtures__/app-harness.ts'

const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages')

describe('云转写三成员声明 runtime_config —— key 输入框自动长出', () => {
  let dir: string
  let dedup: DedupStore
  let store: ItemStore
  let build: (extra?: Partial<Parameters<typeof createHttpApp>[0]>) => ReturnType<typeof createHttpApp>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stt-keys-'))
    dedup = new DedupStore(join(dir, 'd.db'))
    store = new ItemStore(join(dir, 'i.db'))

    const descriptors = loadPlugins(pluginsDir)
    // openai 那档住 builtin 包；groq / cloudflare 各住自己的包（宿主不认识这两家）。
    const owners = ['builtin', 'groq', 'cloudflare'].map((id) => {
      const d = descriptors.find((x) => x.id === id)
      if (!d) throw new Error(`${id} plugin descriptor not found under ` + pluginsDir)
      return d
    })

    const manifests = sealManifests(owners.flatMap((d) => d.sources ?? []), owners)
    const registry = new Registry(manifests)
    const scheduler = new Scheduler({
      registry, streams: [], adapters: new Map(), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup,
    })

    build = (extra = {}) => {
      const service = new StreamService({ registry, scheduler, channels: new UserStore(join(dir, `svc-${Math.random()}.db`)), plugins: owners })
      return createHttpApp({ service, itemStore: store, health, ...extra })
    }
  })

  afterEach(() => {
    dedup.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['cloudflare', 'cf-whisper', 'cloudflare'],
    ['groq', 'groq-whisper', 'groq'],
    ['builtin', 'openai-whisper', 'openai'],
  ])('%s/%s 声明 runtime_config: ref %s + secret apiKey', async (pluginId, sourceId, ref) => {
    const app = build()
    const detail = await app.request(`/api/plugins/${pluginId}/sources/${sourceId}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()).runtimeConfig).toMatchObject({ ref, fields: { apiKey: { type: 'secret' } } })
  })

  it('groq-whisper 写入 apiKey 后 status 显示已配置', async () => {
    const writes: Array<{ ref: string; values: Record<string, unknown> }> = []
    let configured = false
    const app = build({
      sourceRuntimeConfig: {
        status: () => ({ values: {}, secrets: { apiKey: { configured } } }),
        set: async (ref, values) => { writes.push({ ref, values }); configured = true },
      },
    })

    const before = await app.request('/api/source-runtime-config/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'groq', sourceId: 'groq-whisper' }),
    })
    expect((await before.json()).secrets.apiKey.configured).toBe(false)

    const write = await app.request('/api/source-runtime-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'groq', sourceId: 'groq-whisper', values: { apiKey: 'k-test' } }),
    })
    expect(write.status).toBe(200)
    // 端点只是转发：这里查的是**写去哪个 ref**（groq，非 sourceId）+ 值原样透传给 set()。
    // （哪些字段是密文由 row 引擎按 schema 判，不再随请求传字段名清单。）
    expect(writes).toEqual([{ ref: 'groq', values: { apiKey: 'k-test' } }])

    const status = await app.request('/api/source-runtime-config/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'groq', sourceId: 'groq-whisper' }),
    })
    expect((await status.json()).secrets.apiKey.configured).toBe(true)
  })
})
