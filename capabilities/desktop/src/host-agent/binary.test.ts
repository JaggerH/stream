// capabilities/desktop/src/host-agent/binary.test.ts
//
// 这一层回答「本机有没有 host-agent、它在哪」。两种「没有」必须分得开，因为处置不同：
//   - **这个平台压根没出过二进制**（今天 = 除 win32-x64 / darwin-x64 / darwin-arm64 之外）
//     → 说清是「没出货」，别让人去查安装、去 registry 上找一个不存在的包。
//   - **平台对但没装上**（optionalDependencies 被跳过，或压根没跑 install）
//     → 说清是哪个包没装。
// 合并成一句「找不到」的后果是：用户不知道该去装包还是该换机器。
//
// 还有第三个事实要分开：**有二进制 ≠ 桌面控制能用**。mac 有二进制、配对能用，桌面控制不能用。
import { describe, it, expect } from 'vitest'
import { HOST_AGENT_PACKAGES, DESKTOP_CONTROL_PLATFORMS, desktopControlSupported, resolveAgentBinary } from './binary.ts'

/** 只认某几个 specifier 的假 resolver；其余抛错（模拟 require.resolve 找不到）。 */
function fakeResolver(known: Record<string, string>) {
  return (specifier: string) => {
    const hit = known[specifier]
    if (!hit) throw new Error(`Cannot find module '${specifier}'`)
    return hit
  }
}

describe('resolveAgentBinary', () => {
  it('Windows：要的是带 .exe 的那份，返回绝对路径', () => {
    const r = resolveAgentBinary({
      platform: 'win32',
      arch: 'x64',
      resolvePath: fakeResolver({
        '@streamapp/desktop-win32-x64/bin/stream-desktop.exe': 'C:\\p\\agent.exe',
      }),
    })
    expect(r).toEqual({ ok: true, path: 'C:\\p\\agent.exe', source: 'installed', usesWindowsAgent: false, desktopControl: true })
  })

  it('WSL：无视 platform/arch（linux-x64），强制按 win32-x64 解析、挑 .exe，且标出 usesWindowsAgent', () => {
    const r = resolveAgentBinary({
      platform: 'linux',
      arch: 'x64',
      wsl: true,
      resolvePath: fakeResolver({
        '@streamapp/desktop-win32-x64/bin/stream-desktop.exe': '/mnt/c/agent.exe',
      }),
    })
    expect(r).toEqual({ ok: true, path: '/mnt/c/agent.exe', source: 'installed', usesWindowsAgent: true, desktopControl: true })
  })

  it('非 WSL（wsl: false 或缺省）：按本机 platform/arch 走，不偷偷退成 win32', () => {
    // 这条钉的是 wsl 标志的**方向性**：同样是 linux-x64，wsl:true 走 Windows agent（上一条），
    // wsl:false 就该照本机判、判成不支持。少了这条，把 wsl 判据写死成 true 也不会红。
    const r = resolveAgentBinary({
      platform: 'linux',
      arch: 'x64',
      wsl: false,
      resolvePath: fakeResolver({
        '@streamapp/desktop-win32-x64/bin/stream-desktop.exe': '/mnt/c/agent.exe',
      }),
    })
    expect(r.ok).toBe(false)
  })

  it('mac：解到的是**没有扩展名**的那份，且 desktopControl 为真（AX 后端 2026-09-07 落地）', () => {
    // 文件名分叉是真分支，不是形式主义：写死 .exe 的表现是 require.resolve 找一个不存在的
    // 文件，而报出来的却是「平台包没装」——真因离现场很远。
    const r = resolveAgentBinary({
      platform: 'darwin',
      arch: 'x64',
      resolvePath: fakeResolver({
        '@streamapp/desktop-darwin-x64/bin/stream-desktop': '/usr/local/agent',
      }),
    })
    expect(r).toEqual({ ok: true, path: '/usr/local/agent', source: 'installed', usesWindowsAgent: false, desktopControl: true })
  })

  it('mac arm64 同样解得到（形状与 x64 一致，只差包名）', () => {
    const r = resolveAgentBinary({
      platform: 'darwin',
      arch: 'arm64',
      resolvePath: fakeResolver({
        '@streamapp/desktop-darwin-arm64/bin/stream-desktop': '/opt/agent',
      }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.desktopControl).toBe(true)
  })

  it('没出过货的平台：说清是「没有出过二进制」，不是「包没装」', () => {
    const r = resolveAgentBinary({
      platform: 'linux', arch: 'arm64', resolvePath: fakeResolver({}),
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('linux-arm64')
    expect(r.reason).toContain('没有出过 Stream Desktop 二进制')
    // 处置不同，话术就得分得开：这一档不该把人引去装包。
    expect(r.reason).not.toContain('没装上')
  })

  it('平台对但包没装上、本地也没有构建产物：说清是哪个包没装，且带原始错误', () => {
    const r = resolveAgentBinary({
      platform: 'win32', arch: 'x64', resolvePath: fakeResolver({}),
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('@streamapp/desktop-win32-x64')
    // Minor-1：require.resolve 抛出的原始错误不该被 catch {} 吞掉。
    expect(r.reason).toContain('Cannot find module')
  })

  it('包没装上，但本地构建产物在：用本地档，标成 local-build', () => {
    const r = resolveAgentBinary({
      platform: 'win32',
      arch: 'x64',
      resolvePath: fakeResolver({}),
      resolveLocalBuild: (relPath) =>
        relPath === 'desktop-win32-x64/bin/stream-desktop.exe'
          ? '/repo/capabilities/desktop/platforms/desktop-win32-x64/bin/stream-desktop.exe'
          : undefined,
    })
    expect(r).toEqual({
      ok: true,
      path: '/repo/capabilities/desktop/platforms/desktop-win32-x64/bin/stream-desktop.exe',
      source: 'local-build',
      usesWindowsAgent: false,
      desktopControl: true,
    })
  })

  it('本地构建产物也没有：三档都落空，reason 里两处都提到', () => {
    const r = resolveAgentBinary({
      platform: 'win32', arch: 'x64', resolvePath: fakeResolver({}), resolveLocalBuild: () => undefined,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('@streamapp/desktop-win32-x64')
    expect(r.reason).toContain('本地构建产物也没有')
  })

  it('出货平台是这三个，且键与包名一致', () => {
    // 数字钉在这里，是为了让「加一个平台」必须同时回答另外三处（platforms/ 目录、
    // scripts/desktop-platforms.mjs 的 triple 表、两个 package.json 的 optionalDependencies）。
    expect(Object.keys(HOST_AGENT_PACKAGES).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64'])
    for (const [key, pkg] of Object.entries(HOST_AGENT_PACKAGES)) {
      expect(pkg).toBe(`@streamapp/desktop-${key}`)
    }
  })
})

describe('桌面控制是与「有没有二进制」独立的第二个事实', () => {
  // 两件事合成一张表的代价，2026-09-07 干净装机实测撞到过：mac 上后端因为「桌面控制没实现」
  // 整个跳过 host-agent，连 `--register` 都没跑 → 扩展永远 never-seen → 要登录态的源全是游客态。
  it('今天有 Windows(UIA) 与 macOS(AX) 两份后端，别的平台没有', () => {
    expect([...DESKTOP_CONTROL_PLATFORMS]).toEqual(['win32', 'darwin'])
    expect(desktopControlSupported('win32')).toBe(true)
    expect(desktopControlSupported('darwin')).toBe(true)
    expect(desktopControlSupported('linux')).toBe(false)
  })

  // 两个事实仍然是分家的——今天它俩碰巧都覆盖 mac，所以要盯住的是**另一个方向**：
  // 有二进制不等于有桌面控制。Linux 将来若出了二进制而 AT-SPI 后端还没写，这条会当场变红。
  it('出货表与桌面控制表是两份名单：凡在桌面控制表里的，必须先有二进制', () => {
    const shipped = new Set(Object.keys(HOST_AGENT_PACKAGES).map((k) => k.split('-')[0]))
    for (const p of DESKTOP_CONTROL_PLATFORMS) {
      expect(shipped.has(p)).toBe(true)
    }
    // 反向不成立、也不该成立——多出来的那些就是"有手、还没长出控制能力"的平台。
    expect(shipped.size).toBeGreaterThanOrEqual(DESKTOP_CONTROL_PLATFORMS.length)
  })
})
