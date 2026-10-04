import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { loadPlugins } from './loader.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

/** 在 base 下写一个 `<id>/package.json` 形态的 Stream 包，返回包目录。 */
function writePkg(base: string, id: string, stream: Record<string, unknown>) {
  const d = join(base, id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ stream: { id, ...stream } }))
  return d
}

describe('loadPlugins', () => {
  it('loads descriptors from a directory', () => {
    const plugins = loadPlugins(fixtures)
    const byId = Object.fromEntries(plugins.map((p) => [p.id, p]))
    expect(Object.keys(byId).sort()).toEqual(['Douyin_TikTok_Download_API', 'pansou'])
  })

  it('parses a full backend + credentials + normalizer descriptor', () => {
    const douyin = loadPlugins(fixtures).find((p) => p.id === 'Douyin_TikTok_Download_API')!
    expect(douyin.backend).toEqual({
      image: 'ghcr.io/jaggerh/video-service:latest',
      service: 'douyin-tiktok-download-api',
      port: 80,
      health: '/docs',
    })
    expect(douyin.credentials).toEqual(['douyin.com'])
    expect(douyin.normalizer).toBe('douyin')
    expect(douyin.sourceGrouping).toEqual({ enabled: true, resolver: 'manifest.facility' })
    expect(douyin).toMatchObject({
      name: 'Douyin_TikTok_Download_API',
      tagline: '视频平台搜索与解析服务',
      description: '抖音搜索、用户作品、关注流、合集与视频媒体解析。',
    })
  })

  it('parses a search-only backend with no credentials and default service name', () => {
    const pansou = loadPlugins(fixtures).find((p) => p.id === 'pansou')!
    expect(pansou.backend?.image).toBe('ghcr.io/fish2018/pansou:latest')
    expect(pansou.backend?.service).toBeUndefined() // defaults to id at compose time
    expect(pansou.credentials).toBeUndefined()
    expect(pansou).toMatchObject({
      name: 'PanSou',
      tagline: '网盘资源聚合搜索',
      description: 'Telegram 频道、网盘分享与资源索引的关键词搜索。',
      repository: 'https://github.com/fish2018/pansou',
    })
  })

  it('returns an empty set for a missing directory', () => {
    expect(loadPlugins(join(fixtures, 'does-not-exist'))).toEqual([])
  })

  it('parses manifest.facility grouping and rejects invalid resolver references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-loader-'))
    try {
      writePkg(dir, 'grouped', {
        name: 'Grouped',
        sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
        sources: [
          {
            id: 'a',
            adapter: 'rsshub',
            description: 'A',
            topics: [],
            example_queries: [],
            capabilities: ['timeline'],
            auth: { type: 'none' },
            params_schema: {},
            cadence_hint_seconds: 1800,
            discoverable: true,
            facility: { key: 'a', label: 'A' },
          },
        ],
      })
      const plugins = loadPlugins(dir)
      expect(plugins[0]?.sourceGrouping).toEqual({ enabled: true, resolver: 'manifest.facility' })

      writePkg(dir, 'bad', {
        name: 'Bad',
        sourceGrouping: { enabled: true, resolver: 'adapter.missingFn' },
        sources: [
          {
            id: 'a',
            adapter: 'rsshub',
            description: 'A',
            topics: [],
            example_queries: [],
            capabilities: ['timeline'],
            auth: { type: 'none' },
            params_schema: {},
            cadence_hint_seconds: 1800,
            discoverable: true,
          },
        ],
      })
      expect(() => loadPlugins(dir)).toThrow(
        /Invalid plugin sourceGrouping resolver|Missing plugin sourceGrouping resolver/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses backend.standby and rejects invalid values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-loader-standby-'))
    try {
      writePkg(dir, 'x', { backend: { image: 'i', port: 80, standby: { idleMinutes: 10 } } })
      const ok = loadPlugins(dir).find((p) => p.id === 'x')!
      expect(ok.backend?.standby).toEqual({ idleMinutes: 10 })
      rmSync(join(dir, 'x'), { recursive: true, force: true })

      writePkg(dir, 'bad-idle', { backend: { image: 'i', port: 80, standby: { idleMinutes: 0 } } })
      expect(() => loadPlugins(dir)).toThrow() // idleMinutes < 1 → 整个 descriptor 拒绝
      rmSync(join(dir, 'bad-idle'), { recursive: true, force: true })

      writePkg(dir, 'bad-timeout', {
        backend: { image: 'i', port: 80, standby: { idleMinutes: 10, startTimeoutSeconds: 3 } },
      })
      expect(() => loadPlugins(dir)).toThrow() // startTimeoutSeconds < 5 → 拒绝
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a leftover flat yaml descriptor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-loader-legacy-'))
    try {
      writeFileSync(join(dir, 'legacy.yaml'), 'id: legacy\n')
      expect(() => loadPlugins(dir)).toThrow(/package\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('folder-form packages', () => {
    it('loads <id>/package.json as a descriptor', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
      writePkg(dir, 'demo', { name: 'Demo', normalizer: 'demo' })
      const out = loadPlugins(dir)
      expect(out).toHaveLength(1)
      expect(out[0].id).toBe('demo')
    })

    // 内置包目录并轨后这一层混住着 recipe 包：它们一个插件槽位都不填，不该出现在插件目录里
    // （前端会拿到一堆没名字没内容的"插件"）。判据见 fillsPluginSlot。
    it('一个插件槽位都不填的包（纯 recipe 包的形状）不投影成插件', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
      writePkg(dir, 'recipe-only', { facility: 'recipe-only', cookieDomain: 'example.com' })
      writePkg(dir, 'has-backend', { backend: { image: 'x:1', port: 8080 } })
      expect(loadPlugins(dir).map((p) => p.id)).toEqual(['has-backend'])
    })

    it('merges manifests.yaml (top-level list) as sources with pluginId stamped', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
      const pkgDir = writePkg(dir, 'demo', {})
      writeFileSync(
        join(pkgDir, 'manifests.yaml'),
        '- id: demo-src\n  adapter: builtin\n  description: A\n  topics: []\n  example_queries: []\n  capabilities: [timeline]\n  auth: { type: none }\n  params_schema: {}\n  cadence_hint_seconds: 1800\n  discoverable: true\n',
      )
      const out = loadPlugins(dir)
      // yaml 里写的是局部名；全名前缀由装载期合成。这个夹具的 package.json 没有 npm `name`，
      // 所以走 `local/<目录名>` 那一档（见 packageNamespace）。
      expect(out[0].sources?.[0].id).toBe('local/demo/demo-src')
      expect(out[0].sources?.[0].pluginId).toBe('demo')
    })

    it('throws when sources declared in both package.json and manifests.yaml', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
      const pkgDir = writePkg(dir, 'demo', {
        sources: [
          {
            id: 'a',
            adapter: 'builtin',
            description: 'A',
            topics: [],
            example_queries: [],
            capabilities: ['timeline'],
            auth: { type: 'none' },
            params_schema: {},
            cadence_hint_seconds: 1800,
            discoverable: true,
          },
        ],
      })
      writeFileSync(
        join(pkgDir, 'manifests.yaml'),
        '- id: b\n  adapter: builtin\n  description: B\n  topics: []\n  example_queries: []\n  capabilities: [timeline]\n  auth: { type: none }\n  params_schema: {}\n  cadence_hint_seconds: 1800\n  discoverable: true\n',
      )
      expect(() => loadPlugins(dir)).toThrow(/declares sources in both/)
    })

    it('skips directories without package.json', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
      mkdirSync(join(dir, 'not-a-plugin'))
      writePkg(dir, 'real', { normalizer: 'real' })
      const out = loadPlugins(dir)
      expect(out.map((p) => p.id)).toEqual(['real'])
    })
  })
})

// 能力槽位（`stream.capability`）也是「宿主要替这个包做点什么」的一格：装载器要动态 import 它、
// 把它的工具挂进 /api/mcp。漏进 fillsPluginSlot 的代价与前四次同形——包装了、界面上找不到，
// 而没有任何一处会喊（AGENTS.md「加了一份名单 → 名字就是你的回补清单」）。
describe('capability 槽位计入插件槽位', () => {
  it('只声明 capability 的包也投影成插件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugins-cap-'))
    writePkg(dir, 'cap-only', { capability: 'dist/index.js' })
    writePkg(dir, 'nothing', { facility: 'nothing', cookieDomain: 'example.com' })
    expect(loadPlugins(dir).map((p) => p.id)).toEqual(['cap-only'])
  })

  it('投影里带着 capability 那一格', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugins-cap2-'))
    writePkg(dir, 'cap-only', { capability: 'dist/index.js' })
    expect(loadPlugins(dir)[0].capability).toBe('dist/index.js')
  })
})
