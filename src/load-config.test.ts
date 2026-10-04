import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './bootstrap.ts'

/**
 * config.yaml → AppConfig 的**传递**本身要有人守。漏传一个字段不会报错、不会有类型错
 * （字段在 `AppConfig` 上是可选的），只是运行时永远读到 undefined——真发生过：`alist_url`/
 * `alist_token` 声明了、四处在读、loadConfig 从来没往外传，config.yaml 里写什么都静默无效。
 */
describe('loadConfig：显式地址/凭证要真的从 config.yaml 传到 AppConfig', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stream-cfg-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (yaml: string): string => {
    const p = join(dir, 'config.yaml')
    writeFileSync(p, yaml)
    return p
  }

  it('alist_url / alist_token 原样传出', () => {
    const cfg = loadConfig(write('alist_url: http://127.0.0.1:45848\nalist_token: tok-abc\n'))
    expect(cfg.alist_url).toBe('http://127.0.0.1:45848')
    expect(cfg.alist_token).toBe('tok-abc')
  })

  it('没写就是 undefined（由各自的 env / 插件目标回落，不许在这里编一个默认值）', () => {
    const cfg = loadConfig(write('vault_enabled: false\n'))
    expect(cfg.alist_url).toBeUndefined()
    expect(cfg.alist_token).toBeUndefined()
  })

  it('browser_lanes 原样传出（不写就是 undefined —— 默认值归 RecipeSessionManager，不在这里编一份）', () => {
    // 同一个上限写进两个地方，迟早会漂：这里只负责把用户写的那份原样递过去。
    const cfg = loadConfig(write('browser_lanes:\n  per_facility: 6\n  global: 12\n'))
    expect(cfg.browser_lanes).toEqual({ per_facility: 6, global: 12 })
    expect(loadConfig(write('vault_enabled: false\n')).browser_lanes).toBeUndefined()
  })

  it('browser_lanes 只写一半 → 只覆盖那一半（另一半仍走管理器的默认）', () => {
    const cfg = loadConfig(write('browser_lanes:\n  global: 12\n'))
    expect(cfg.browser_lanes?.global).toBe(12)
    expect(cfg.browser_lanes?.per_facility).toBeUndefined()
  })
})

/**
 * 内置包目录并轨：两个字段（plugins_dir / recipes_dir）收成一个 packages_dir。
 * 旧字段必须仍然受理——别人的部署里可能写着，而"配置里那行被静默忽略"既不报错也不生效，
 * 是最难查的一类故障。
 */
describe('loadConfig：packages_dir 与两个旧字段', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stream-cfg-pkg-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (yaml: string): string => {
    const p = join(dir, 'config.yaml')
    writeFileSync(p, yaml)
    return p
  }

  it('没写 → ./packages', () => {
    expect(loadConfig(write('vault_enabled: false\n')).packages_dir).toBe('./packages')
  })

  it('写了 packages_dir → 原样传出', () => {
    expect(loadConfig(write('packages_dir: /srv/stream-packages\n')).packages_dir).toBe('/srv/stream-packages')
  })

  it('只写旧的 plugins_dir → 仍然按它读', () => {
    expect(loadConfig(write('plugins_dir: /srv/old-plugins\n')).packages_dir).toBe('/srv/old-plugins')
  })

  it('只写旧的 recipes_dir → 仍然按它读', () => {
    expect(loadConfig(write('recipes_dir: /srv/old-recipes\n')).packages_dir).toBe('/srv/old-recipes')
  })

  it('新字段在场时旧字段不参与（不用猜谁赢）', () => {
    expect(loadConfig(write('packages_dir: /srv/new\nplugins_dir: /srv/old\n')).packages_dir).toBe('/srv/new')
  })

  it('两个旧字段指向不同目录 → 抛，别替他挑一个', () => {
    expect(() => loadConfig(write('plugins_dir: /srv/a\nrecipes_dir: /srv/b\n'))).toThrow(/packages_dir/)
  })

  it('desktop 原样传出 —— 这一格漏了整整一段时间，症状是那个上限永远是代码默认值', () => {
    expect(loadConfig(write('desktop:\n  session_wait_ms: 60000\n')).desktop).toEqual({ session_wait_ms: 60_000 })
    expect(loadConfig(write('vault_enabled: false\n')).desktop).toBeUndefined()
  })

  // 能力包的配置（`capabilities: { <能力名>: {...} }`）——宿主原样透传给 mount，自己不解释
  // 里面一个字。漏传的表现是「config.yaml 里写了、包收到的是空对象」，两边都不报错。
  it('capabilities 原样传出（不写 = 每个能力都拿空对象）', () => {
    const cfg = loadConfig(write('capabilities:\n  netdisk:\n    tier: external\n'))
    expect(cfg.capabilities).toEqual({ netdisk: { tier: 'external' } })
    expect(loadConfig(write('vault_enabled: false\n')).capabilities).toBeUndefined()
  })

  it('session_exports 原样传出（不写 = 整条能力不装配）', () => {
    const cfg = loadConfig(write(
      'session_exports:\n' +
      '  - name: broker\n' +
      '    alias: alice\n' +
      '    domain: example.com\n' +
      '    out_dir: /srv/consumer/data\n' +
      '    extras:\n' +
      '      validatekey:\n' +
      '        url: https://jywg.example.com/Trade/Buy\n' +
      '        selector: input[name="k"]\n' +
      '        attr: value\n',
    ))
    expect(cfg.session_exports).toEqual([{
      name: 'broker', alias: 'alice', domain: 'example.com', out_dir: '/srv/consumer/data',
      extras: { validatekey: { url: 'https://jywg.example.com/Trade/Buy', selector: 'input[name="k"]', attr: 'value' } },
    }])
    expect(loadConfig(write('vault_enabled: false\n')).session_exports).toBeUndefined()
  })
})

/**
 * 已退役的容器地址键（<容器>_api_url / <容器>_service_url）：写了不生效也不报错，是最难查的一类
 * 故障——loadConfig 要喊一声。只 warn 不 throw：一条陈旧的键不该拦住整个后端起来。
 */
describe('loadConfig：已退役的容器地址键要喊一声', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stream-cfg-stale-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  const write = (yaml: string): string => {
    const p = join(dir, 'config.yaml')
    writeFileSync(p, yaml)
    return p
  }

  it('douyin_api_url / video_service_url → console.warn 一次，点名两个键，仍正常返回配置', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = loadConfig(write('douyin_api_url: http://10.0.0.21:3007\nvideo_service_url: http://x\nvault_enabled: false\n'))
    expect(cfg.vault_enabled).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('douyin_api_url')
    expect(msg).toContain('video_service_url')
    expect(msg).toMatch(/不再被读取/)
  })

  // 归包之后宿主不再替某个包读专用地址键：一条 `<包>_url` 同样写了不生效也不报错。
  // 判据是「loadConfig 读不读这个键」，不是后缀——键名里的包名宿主不认识。
  it('宿主不读的 <x>_url 键（归包后的旧地址键）→ 一样喊；宿主读的 alist_url / mineru_url 不喊', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = loadConfig(write('somepkg_url: http://10.0.0.9:8888\nalist_url: http://a\nmineru_url: http://m\nvault_enabled: false\n'))
    expect(cfg.alist_url).toBe('http://a')
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toContain('somepkg_url')
    expect(msg).not.toContain('alist_url')
    expect(msg).not.toContain('mineru_url')
  })

  it('没有这类键 → 不喊', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadConfig(write('alist_url: http://127.0.0.1:45848\nvault_enabled: false\n'))
    expect(warn).not.toHaveBeenCalled()
  })
})

/**
 * 默认位置一律落在 Stream 的根目录（STREAM_DATA_DIR，发行形态是 ~/.stream）下面；只有用户自己
 * 设置了（config.yaml / 环境变量）才去别处。音乐下载目录曾经缺省到 ~/nas-music——开发机挂 NAS 的
 * 习惯，放到用户的 Mac 上就是家目录里凭空多一个怪名字的文件夹（2026-09-27 用户拍板）。
 */
describe('loadConfig：音乐下载目录缺省落在 Stream 根目录下', () => {
  let dir: string
  const saved = { data: process.env.STREAM_DATA_DIR, root: process.env.AUDIO_ARCHIVE_ROOT }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stream-cfg-'))
    process.env.STREAM_DATA_DIR = join(dir, 'root')
    delete process.env.AUDIO_ARCHIVE_ROOT
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (saved.data === undefined) delete process.env.STREAM_DATA_DIR; else process.env.STREAM_DATA_DIR = saved.data
    if (saved.root === undefined) delete process.env.AUDIO_ARCHIVE_ROOT; else process.env.AUDIO_ARCHIVE_ROOT = saved.root
  })
  const write = (yaml: string): string => { const p = join(dir, 'config.yaml'); writeFileSync(p, yaml); return p }

  it('没设置 → <STREAM_DATA_DIR>/music', () => {
    expect(loadConfig(write('vault_enabled: true\n')).audio_archive_root).toBe(join(dir, 'root', 'music'))
  })
  it('config.yaml 写了 → 原样用', () => {
    expect(loadConfig(write('audio_archive_root: /mnt/nas/music\n')).audio_archive_root).toBe('/mnt/nas/music')
  })
  it('环境变量设了 → 用环境变量', () => {
    process.env.AUDIO_ARCHIVE_ROOT = '/srv/music'
    expect(loadConfig(write('vault_enabled: true\n')).audio_archive_root).toBe('/srv/music')
  })
})
