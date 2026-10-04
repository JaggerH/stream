import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHttpApp, type HealthInfo } from '../app.ts'
import { StreamService } from '../../mcp/tools.ts'
import { Registry } from '../../registry/registry.ts'
import { sealManifests } from '../../registry/seal.ts'
import type { PluginDescriptor } from '../../plugins/types.ts'
import { Scheduler } from '../../scheduler.ts'
import { DedupStore } from '../../dedup-store.ts'
import { ItemStore } from '../../item-store.ts'
import { UserStore } from '../../store/user-store.ts'
import type { Adapter } from '../../adapters/types.ts'
import type { SourceManifest } from '../../manifest/types.ts'
import type { Stream } from '../../streams/types.ts'
import type { StreamItem } from '../../types.ts'

/**
 * `createHttpApp` 的共享测试夹具。
 *
 * 存在的理由:app.test.ts 曾经是一个 2575 行、139 条的单文件——所有这些 fixture 和 build() 都是
 * 它内部的闭包,于是任何想复用它们的测试只能继续往那个文件里加,文件继续变肥(单跑 50 秒),
 * 循环自我强化。抽出来之后按路由域分文件(app.works / app.resources / app.providers / …),
 * 每个文件都能单独跑。
 *
 * 形状上刻意让**调用方保留裸变量名**(dir/store/dedup/build):每个 beforeEach 拿一份新夹具,
 * build 闭包绑的就是那一轮的 dir/store,所以搬运过来的测试体一个字都不用改。
 * 换成 `h.dir` / `h.build()` 那种访问器写法就得逐处改写几百个引用——那是白白给自己造一次
 * "静默改错一处也没人发现"的机会。
 */

export function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}

export function item(id: string, stream: string): StreamItem {
  return { id, stream_id: stream, source_type: 'rsshub-bridge', source_route: '/x',
    fetched_at: '2026-06-08T00:00:00.000Z', timestamp: '2026-06-08T00:00:00.000Z', title: id, raw: {} }
}

export const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [] }

export const manifests: SourceManifest[] = [
  mk({ id: 'hn', description: 'hacker news', topics: ['tech'], categories: ['news'] }),
  mk({
    id: 'bili',
    description: 'bilibili dynamic',
    topics: ['bilibili'],
    categories: ['social-media'],
    facility: { key: 'bilibili', label: '哔哩哔哩' },
    params_schema: { uid: { type: 'string', required: true, description: '用户 id' } },
    runtime_config: {
      ref: 'tmdb', fields: {
        apiKey: { type: 'secret', label: 'TMDb API Key', required: true },
        language: { type: 'string', label: '语言', default: 'zh-CN' },
      },
    },
    notes: 'Bilibili dynamic docs',
    docsMarkdown: '## 路由说明\nBilibili dynamic docs',
  }),
  mk({
    id: 'bili-following',
    description: 'bilibili following',
    topics: ['bilibili'],
    categories: ['social-media'],
    facility: { key: 'bilibili', label: '哔哩哔哩' },
  }),
]

export const stream: Stream = { id: 'my-tech', description: 'tech', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'tech' }

export const health: () => Promise<HealthInfo> = async () => ({ cookies: { domains: ['bilibili.com'], updatedAt: 1 }, manifests: 2, streams: 1 })

export type BuildApp = (token?: string, extra?: Partial<Parameters<typeof createHttpApp>[0]>) => ReturnType<typeof createHttpApp>

export interface HttpApiFixture {
  dir: string
  dedup: DedupStore
  store: ItemStore
  build: BuildApp
  close(): void
}

/** 一份全新的夹具(临时目录 + 两个 store + 一个绑好它们的 build)。每个 beforeEach 调一次,
 *  afterEach 调 close()。 */
export function createHttpApiFixture(): HttpApiFixture {
  const dir = mkdtempSync(join(tmpdir(), 'http-'))
  const dedup = new DedupStore(join(dir, 'd.db'))
  const store = new ItemStore(join(dir, 'i.db'))
  store.add(item('i1', 'my-tech'), 'post')
  store.add(item('i2', 'other'), 'post')

  const build: BuildApp = (token, extra = {}) => {
    const descriptors: PluginDescriptor[] = [{
      id: 'fake',
      name: 'Fake Plugin',
      tagline: '测试插件副标题',
      description: '新闻和社交媒体测试源。',
      homepage: 'https://example.com',
      repository: 'https://example.com/repo',
      docsUrl: 'https://example.com/docs',
      sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    }]
    const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const service = new StreamService({
      registry: new Registry(sealManifests(manifests, descriptors)),
      scheduler,
      channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)),
      plugins: descriptors,
    })
    // 第一参历史上叫 token（"配了就全员要 Bearer"）。门换成"本机免密 + 外来要 token"之后
    // 它就是 accessGuard 的 token；进程内 app.request 没有对端地址，按外来处理。
    return createHttpApp({ service, itemStore: store, health, accessGuard: token ? { token } : undefined, ...extra })
  }

  return {
    dir, dedup, store, build,
    close() {
      dedup.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
