import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadPlugins } from './loader.ts'

// Guard the REAL shipped `packages/` directory against package.json drift.
//
// loader.test.ts only exercises __fixtures__ and hand-built tmp dirs — it never loads the
// actual packages/ tree. That gap got sharper when plugin descriptors moved from
// package.yaml to package.json (this migration): a trailing comma or a missing required
// field is now a JSON.parse/schema throw at BOOT (scanPackages → loadPlugins, called from
// bootstrap), not a lint warning — and nothing in the existing suite would catch it before
// the backend actually failed to start. This test closes that gap the same way
// recipe-package.real.test.ts does for the recipe slot.
//
// 目录并轨后这里住着一批包（22 个填插件槽 + 其余纯 recipe 包），所以下面那个 22 同时也是
// `fillsPluginSlot` 这条判据的守卫：判据放宽了，数字立刻不对。
//
// 那 22 个里最容易看漏的是 `replay`：它只声明了 `normalizer`，没有清单、没有 recipe、没有代码、
// 没有容器——目录看上去是空的，但 `fillsPluginSlot` 认 normalizer，所以它在名单里。第二类是
// `eastmoney` / `xhs`：既有 recipe 数据又有代码槽位（eastmoney 还有凭证域），两个投影里都出现
// ——那正是"按槽位判而不是按目录判"的意义。别照"目录里有什么文件"去数这个数字。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

describe('shipped plugins load (real packages/ directory)', () => {
  // 22 = `packages/` 里填了插件类槽位（代码 / 容器 / 能力 / normalizer…）的包数。
  // 加或删一个填槽位的包就改这里；纯 recipe 数据包不算在内（`fillsPluginSlot` 不认它们）。
  // xueqiu / telegram 原本是纯 recipe 包，normalizer（及 xueqiu 的 detail enricher）归包后开了代码槽位。
  // groq / firecrawl 原本是纯 recipe 包，转写源 / 抓正文源从 builtin 搬进来后填了 Source 清单槽位（firecrawl 还有代码槽位）。
  // btbtla 同理：磁力中转页解析源从 builtin 搬进来，填了 Source 清单槽位。
  // hackernews / v2ex 是新建的纯代码包：宿主的评论富化分支搬进来，只填代码槽位（normalizer + enricher）。
  // cloudflare 是新建的代码包：cf-whisper 转写源从 builtin 搬进来（Source 清单 + 代码槽位，第八批 2026-09-26）。
  // xunlei / shooter 同批新建：字幕搜刮的两家站从宿主搬进来（Source 清单 + 代码槽位）。
  // omdb 是新建的代码包：影视详情的 OMDb 两个源从 builtin 搬进来（Source 清单 + 代码槽位，第九批 2026-09-26）。
  it('loads all 22 shipped plugin packages without throwing', () => {
    const plugins = loadPlugins(PACKAGES_DIR)
    expect(plugins).toHaveLength(22)
  })

  it('has exactly the expected set of plugin ids', () => {
    const ids = loadPlugins(PACKAGES_DIR).map((p) => p.id)
    expect(ids.slice().sort()).toEqual([
      'Douyin_TikTok_Download_API',
      'alist',
      'bilibili',
      'browser',
      'btbtla',
      'builtin',
      'cloudflare',
      'eastmoney',
      'firecrawl',
      'groq',
      'hackernews',
      'netease',
      'omdb',
      'pansou',
      'replay',
      'rsshub',
      'shooter',
      'telegram',
      'v2ex',
      'xhs',
      'xueqiu',
      'xunlei',
    ])
  })

  it('every declared backend has both image and port', () => {
    const plugins = loadPlugins(PACKAGES_DIR)
    const withBackend = plugins.filter((p) => p.backend)
    expect(withBackend.length).toBeGreaterThan(0)
    for (const p of withBackend) {
      expect(p.backend?.image, `${p.id}: backend.image`).toBeTruthy()
      expect(p.backend?.port, `${p.id}: backend.port`).toBeTruthy()
    }
  })

  it('pins the self-built PanSou image by immutable digest', () => {
    const pansou = loadPlugins(PACKAGES_DIR).find((p) => p.id === 'pansou')
    expect(pansou?.backend?.image).toMatch(/^ghcr\.io\/jaggerh\/pansou@sha256:[0-9a-f]{64}$/)
  })

  it('every nested source manifest carries pluginId matching its package', () => {
    const plugins = loadPlugins(PACKAGES_DIR)
    for (const p of plugins) {
      for (const src of p.sources ?? []) {
        expect(src.pluginId, `${p.id}: source ${src.id}`).toBe(p.id)
      }
    }
  })

  // 每个插件包的 package.json 必须自己声明 "type": "module" —— 不能靠仓库根的那份。
  //
  // 只管**填了插件槽位**的那些包（宿主会 import 它们的代码：静态 import 表或 `stream.code`）。
  // 纯 recipe 包盘上只有 `*.recipe.json`，没有任何模块被 Node 解析，这条规则对它无意义。
  //
  // Node 找的是**最近的** package.json：`packages/<id>/package.json` 一存在，根上的
  // `"type": "module"` 就够不到这棵子树了，缺字段 = 整个 `packages/<id>/**` 按 CommonJS 解析。
  // 后果不是报错，是**静默分裂**：插件代码里 `import ... from '../../../src/...'` 被转成
  // require()，走 CJS 的模块缓存，于是 src/ 那些**模块级单例**各自多出一份副本 ——
  // bootstrap 在 ESM 那份上 setPluginTargetResolver()/setStandbyManager()，插件读到的却是
  // 另一份、永远没接线的副本。表现：host 档下 `pluginTarget()` 恒 null（base 变空串 → fetch
  // 一个相对 URL → "Failed to parse URL"）、`withAwake()` 变 no-op、`standbyOrigin()` 恒 null。
  // 真事故：抖音解析 502 `Failed to parse URL from /api/hybrid/video_data?...`。
  // 单测抓不到（测试进程里两份副本都没接线，行为一致），只有活体 host 档才炸。
  it('every plugin package declares "type": "module" (nearest-package.json rule)', () => {
    const pluginIds = new Set(loadPlugins(PACKAGES_DIR).map((p) => p.id))
    const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
    expect(dirs.length).toBeGreaterThan(0)
    let checked = 0
    for (const d of dirs) {
      const pkgPath = join(PACKAGES_DIR, d.name, 'package.json')
      if (!existsSync(pkgPath)) continue
      if (!pluginIds.has(d.name)) continue // 内置这一层目录名 = 包 id
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: string }
      checked++
      expect(pkg.type, `packages/${d.name}/package.json needs "type": "module"`).toBe('module')
    }
    expect(checked).toBe(pluginIds.size)
  })
})
