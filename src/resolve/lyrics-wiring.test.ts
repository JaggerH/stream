import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../registry/registry.ts'
import { sealManifests } from '../registry/seal.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { ResolveEngine } from './engine.ts'
import { loadPlugins } from '../plugins/loader.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'

// 绝对路径：`loadPlugins('packages')` 那种相对写法按 cwd 找目录，多 worktree 并行时会扫到
// 另一棵树上去（见 AGENTS.md）。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

/** 歌词源的清单**住在它自己的包里**（`packages/netease/manifests.yaml`），经插件路径挂载，
 *  id 加了包名前缀。这里读真文件而不是捏一份：这条用例守的就是"清单上的 key_param 还在"。 */
function realLyricsManifest(): SourceManifest {
  const pkg = loadPlugins(PACKAGES_DIR).find((p) => p.id === 'netease')
  const entry = pkg?.sources?.find((s) => s.id === '@streamapp/netease/netease-lyrics')
  if (!entry) {
    throw new Error(
      'netease-lyrics entry not found in packages/netease/manifests.yaml — was it renamed or removed?',
    )
  }
  return entry
}

describe('lyrics resolve wiring (GET /api/resolutions?type=lyrics)', () => {
  it('the resolve key reaches the package adapter as `params.input` verbatim — proves key_param:"input" is required', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-'))
    try {
      const manifest = realLyricsManifest()
      const registry = new Registry(sealManifests([manifest], [{ id: 'netease', name: '网易云音乐' }]))

      // 包 adapter 收的是**一个 params 对象**（不是 BuiltinFn 的第一个位置参数）：订阅键由
      // `buildParams` 灌进 `manifest.key_param`，本包写的是 `input`。
      let sawParams: Record<string, unknown> | undefined
      const adapter: Adapter = {
        id: 'netease-lyrics',
        async init() {},
        async fetch(params) {
          sawParams = params
          return [{ matched: true, songId: '1', lrc: 'x' }]
        },
      }

      const health = new SourceHealthStore(join(dir, 'h.json'))
      const engine = new ResolveEngine({
        registry, adapters: new Map([[manifest.adapter, adapter]]), health, resolveCreds: async () => ({}),
        buildParams: (m, key) => ({ ...(m.fixed_params ?? {}), [m.key_param ?? 'url']: key }),
        // 成员寻址键 = manifest 的 id = 全名。
        providerRows: { order: () => [{ name: '@streamapp/netease/netease-lyrics' }], count: () => {} },
      })

      const result = await engine.resolve('lyrics', 'netease:186016')
      expect(sawParams?.input).toBe('netease:186016')
      expect(result).toEqual({
        source: '@streamapp/netease/netease-lyrics',
        items: [{ matched: true, songId: '1', lrc: 'x' }],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
