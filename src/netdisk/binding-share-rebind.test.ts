import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MappingStore } from './mapping-store.ts'
import { openNetdiskDb } from './db.ts'
import { NetdiskService, type LeftEntry } from './sync.ts'
import { UserStore } from '../store/user-store.ts'
import { importBundle } from '../sharing/import-bundle.ts'
import { STREAM_BUNDLE_FORMAT, type StreamBundleV1 } from '../sharing/bundle-format.ts'

const fakeFiles = [
  { name: '第一集.mkv', size: 111, isDir: false },
  { name: '第二集.mkv', size: 222, isDir: false },
]
const fakeAlist = {
  listDir: async () => fakeFiles,
  listDirRecursive: async () => fakeFiles,
} as never

function importDeps(store: UserStore) {
  return {
    store,
    installedPlugins: new Set<string>(),
    installedRecipes: new Map<string, { version?: string }>(),
    installRecipePackage: vi.fn(),
  }
}

describe('pending binding → rebind → sync 复用（零 AI）', () => {
  it('导入的 pending 集 rebind 到含同名文件目录后，matchSpec 确定性重算命中，且 invokeLlm 未被调用', async () => {
    const mappingStore = new MappingStore(openNetdiskDb(':memory:'))
    const us = new UserStore(':memory:')
    const left: LeftEntry[] = [{ leftKey: 'k1', title: '第一集' }, { leftKey: 'k2', title: '第二集' }]
    const invokeLlm = vi.fn(async () => { throw new Error('AI must not run') })
    const svc = new NetdiskService({ store: mappingStore, alist: fakeAlist, listLeft: async () => left, invokeLlm, log: () => {} } as never)

    // 1) 导入建 pending（携带 matchSpec，generatedBy 才被 resolveSpec 冻结生效）
    const bundle: StreamBundleV1 = {
      format: STREAM_BUNDLE_FORMAT, meta: { title: 'B', created: '2026-07-19', revision: '1.0.0' },
      channels: [], streams: [], providers: [],
      requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] }, embedded: { recipes: {} },
      netdiskBindings: [{
        left: { kind: 'tmdb', id: '1', media: 'tv', title: '某剧' },
        matchSpec: { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.5, margin: 0.0 }], generatedBy: 'shared' } as never,
      }],
    }
    const r = importBundle(bundle, { ...importDeps(us), mappingStore, genMappingId: () => 'map_int' })
    const id = r.netdiskBindings[0].id
    expect(mappingStore.get(id)!.right.path).toBe('') // 导入后 pending

    // 2) 对方转存后走既有 rebind → 内部 sync 用包内 matchSpec 确定性重算
    const rebound = await svc.rebind(id, '/我的转存/某剧')
    expect(rebound.right.path).toBe('/我的转存/某剧')
    expect(rebound.rightHistory[0].path).toBe('') // pending 空串进 history（无害 cosmetic，既有 inherit 不炸）
    const byKey = new Map(rebound.entries.map((e) => [e.leftKey, e.rightFile]))
    expect(byKey.get('k1')).toBe('第一集.mkv')
    expect(byKey.get('k2')).toBe('第二集.mkv')
    expect(invokeLlm).not.toHaveBeenCalled() // 零 AI
    us.close()
  })
})
