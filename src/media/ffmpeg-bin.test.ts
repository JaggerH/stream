import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HOST_AGENT_PACKAGES } from '../../capabilities/desktop/src/host-agent/binary.ts'
import {
  resolveMediaTool,
  FFMPEG_PLATFORM_PACKAGES,
  FFPROBE_PLATFORM_PACKAGES,
  MEDIA_TOOL_ENV,
  type MediaToolLookup,
} from './ffmpeg-bin.ts'

/** 一份全空的探测面：默认什么都找不到，每条用例只把自己关心的那一格填上。 */
function look(over: Partial<MediaToolLookup> = {}): MediaToolLookup {
  return {
    platform: 'linux',
    arch: 'x64',
    env: {},
    isExecutableFile: () => false,
    resolvePackageJson: () => undefined,
    ...over,
  }
}

describe('resolveMediaTool — 优先级', () => {
  /**
   * 顺序本身就是被钉的那件事：显式配置 > PATH > 随包出货。三档同时可用时只有第一档能赢，
   * 把顺序改成任意别的排列，这条当场红。
   */
  it('三档都在时按 config > path > bundled 取', () => {
    const l = look({
      env: { [MEDIA_TOOL_ENV.ffmpeg]: '/opt/mine/ffmpeg', PATH: '/usr/bin' },
      isExecutableFile: () => true,
      resolvePackageJson: () => '/n/@ffmpeg-installer/linux-x64/package.json',
    })
    expect(resolveMediaTool('ffmpeg', l)).toEqual({ ok: true, path: '/opt/mine/ffmpeg', source: 'config' })

    // 去掉配置 → PATH 赢，随包那份还在场却不该被选中。
    const noConfig = look({ ...l, env: { PATH: '/usr/bin' } })
    expect(resolveMediaTool('ffmpeg', noConfig)).toEqual({ ok: true, path: '/usr/bin/ffmpeg', source: 'path' })
  })

  /**
   * **PATH 排在随包那份前面**，这条不是随手定的：随包那份是 ffmpeg 4.1，不带 chromaprint
   * muxer，而 `audio-fingerprint.ts` 的引擎探测正是问它。把 bundled 提到 PATH 前面，等于在每台
   * 本来装了完整 ffmpeg 的机器上把声学指纹静默降级掉。
   */
  it('PATH 上有就不碰随包那份（不拿旧版本换掉用户自己的）', () => {
    const resolvePackageJson = vi.fn(() => '/n/@ffmpeg-installer/linux-x64/package.json')
    const r = resolveMediaTool('ffmpeg', look({
      env: { PATH: '/usr/local/bin:/usr/bin' },
      isExecutableFile: (p) => p === '/usr/bin/ffmpeg',
      resolvePackageJson,
    }))
    expect(r).toEqual({ ok: true, path: '/usr/bin/ffmpeg', source: 'path' })
    expect(resolvePackageJson).not.toHaveBeenCalled()
  })

  it('PATH 全空时落到随包那份，并且补执行位', () => {
    const ensureExecutable = vi.fn()
    const chmodded = new Set<string>()
    const r = resolveMediaTool('ffmpeg', look({
      env: { PATH: '/usr/bin' },
      // 只有 chmod 跑过之后才「可执行」——上游平台子包的执行位靠 postinstall，
      // 而 npm 11 默认拦 install scripts，所以这一步必须由我们自己做。
      isExecutableFile: (p) => chmodded.has(p),
      resolvePackageJson: (spec) => {
        expect(spec).toBe('@ffmpeg-installer/linux-x64/package.json')
        return '/n/@ffmpeg-installer/linux-x64/package.json'
      },
      ensureExecutable: (p) => { ensureExecutable(p); chmodded.add(p) },
    }))
    expect(r).toEqual({ ok: true, path: '/n/@ffmpeg-installer/linux-x64/ffmpeg', source: 'bundled' })
    expect(ensureExecutable).toHaveBeenCalledWith('/n/@ffmpeg-installer/linux-x64/ffmpeg')
  })

  it('win32 认 .exe，PATH 按分号切', () => {
    const r = resolveMediaTool('ffprobe', look({
      platform: 'win32',
      env: { PATH: 'C:\\Windows;C:\\tools\\ffmpeg\\bin' },
      isExecutableFile: (p) => p === 'C:\\tools\\ffmpeg\\bin\\ffprobe.exe',
    }))
    expect(r).toEqual({ ok: true, path: 'C:\\tools\\ffmpeg\\bin\\ffprobe.exe', source: 'path' })

    const bundled = resolveMediaTool('ffprobe', look({
      platform: 'win32',
      resolvePackageJson: () => 'C:\\n\\@ffprobe-installer\\win32-x64\\package.json',
      isExecutableFile: (p) => p.endsWith('ffprobe.exe'),
    }))
    expect(bundled.ok && bundled.path.endsWith('ffprobe.exe')).toBe(true)
  })
})

describe('resolveMediaTool — 说不出话的失败一律换成能指路的话', () => {
  /**
   * 这一整条改动的起点就是一句 `spawn ffmpeg ENOENT`：用户等了 88 秒，拿到三个字母，
   * 不知道该装什么、装在哪。所以「找不到」这句话必须自带三条出路。
   */
  it('都找不到时，reason 里有装法、有 env 名、有平台子包名', () => {
    const r = resolveMediaTool('ffmpeg', look({ env: { PATH: '/usr/bin' } }))
    expect(r.ok).toBe(false)
    const reason = (r as { reason: string }).reason
    expect(reason).toContain('找不到 ffmpeg')
    expect(reason).toContain('STREAM_FFMPEG_PATH')
    expect(reason).toContain('apt install ffmpeg')
    expect(reason).toContain('@ffmpeg-installer/linux-x64')
    expect(reason).not.toContain('ENOENT')
  })

  it('没出过货的平台：如实说没有随包那份，而不是让用户去等一个不存在的包', () => {
    const r = resolveMediaTool('ffmpeg', look({ platform: 'linux', arch: 'arm64' }))
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('linux-arm64')
    expect((r as { reason: string }).reason).toContain('我们没出随包的二进制')
  })

  /**
   * 显式配置指错了就**当场失败**，绝不静默退回 PATH：用户明说了用哪一个，偷偷换一个的后果是
   * 他拿着一份用别的版本跑出来的结果去下结论。
   */
  it('STREAM_FFMPEG_PATH 指向不存在的路径 → 直接失败，不回落 PATH', () => {
    const r = resolveMediaTool('ffmpeg', look({
      env: { [MEDIA_TOOL_ENV.ffmpeg]: '/nope/ffmpeg', PATH: '/usr/bin' },
      isExecutableFile: (p) => p === '/usr/bin/ffmpeg',
    }))
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('/nope/ffmpeg')
  })
})

describe('平台矩阵', () => {
  /**
   * 两族包必须覆盖同一批平台：只出 ffmpeg 不出 ffprobe 的那台机器上，转写能切块却量不到时长，
   * 而两处失败离得很远、看起来毫不相干。
   */
  it('ffmpeg 与 ffprobe 覆盖同一批平台，且就是我们出货的那四个', () => {
    const expected = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']
    expect(Object.keys(FFMPEG_PLATFORM_PACKAGES).sort()).toEqual(expected)
    expect(Object.keys(FFPROBE_PLATFORM_PACKAGES).sort()).toEqual(expected)
  })

  /**
   * 表和 `cli/package.json` 的 optionalDependencies 是同一份名单的两半：表说"这个平台该去哪个
   * 包里找"，package.json 说"npm 该装哪些包"。两边分家的症状极安静——npm 照常装完、
   * `/api/conversion-kinds` 照常回话，只有那个平台的用户永远拿不到随包的兜底。
   *
   * 仓库根从本文件位置推，不从 `process.cwd()`：worktree 里 cwd 会漂到别人那棵树。
   */
  it('两张表里的每个包都在 cli/package.json 的 optionalDependencies 里（且钉死版本）', () => {
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
    const pkg = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8')) as {
      optionalDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
    const opt = pkg.optionalDependencies ?? {}
    // 第三张表是 host-agent 的平台包（后端自己养 agent，见 src/host-agent/mount.ts）：同一份
    // "npm 按平台挑二进制" 的名单，同样只许出现在 optionalDependencies 里。
    const wanted = [
      ...Object.values(FFMPEG_PLATFORM_PACKAGES),
      ...Object.values(FFPROBE_PLATFORM_PACKAGES),
      ...Object.values(HOST_AGENT_PACKAGES),
      // 没有平台选择，但也必须随 CLI 出货：内置 recipe 的 compute 段动态加载它。
      'isolated-vm',
    ].sort()
    expect(Object.keys(opt).sort()).toEqual(wanted)
    // 两族上游都停更了（2022 / 2023），`^` 只会让一个二进制依赖凭空浮动。
    for (const [name, range] of Object.entries(opt)) {
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+$/)
    }
    // **optionalDependencies 不是 dependencies**：写进 dependencies 时，平台不匹配的那七个包会
    // 让 npm 报 EBADPLATFORM，整个 `npm i @streamapp/stream` 当场失败。
    for (const name of wanted) expect(pkg.dependencies ?? {}).not.toHaveProperty(name)
  })
})
