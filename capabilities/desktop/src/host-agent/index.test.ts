// capabilities/desktop/src/host-agent/index.test.ts
//
// 入口这一层只有一个职责：**在起不来的时候，起不来得说人话，而且不许把工作台带崩**。
// 三种起不来（缺 baseUrl / 缺 dataDir / 没有二进制）各有各的处置提示，合成一句就等于让人猜。
// 缺 dataDir 那条尤其要紧：agent 会「起来然后握手失败」，和「根本没装」长得一模一样。
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  mountHostAgent,
  attachStreamErrorGuards,
  type ApplyDeps,
} from './index.ts'
import { isWslVersionString, buildWindowsAgentEnv } from '../wsl.ts'
import { STREAM_EXTENSION_ID } from '../extension-id.ts'
import type { AgentDeps, AgentProcess } from './agent.ts'
import { fakeCapabilityContext } from '../../../../shared/capability/test-ctx.ts'

function ctxHarness() {
  return fakeCapabilityContext()
}

function depsHarness(
  resolvePath: (s: string) => string,
  registerResult: { ok: boolean; stderr: string } = { ok: true, stderr: '' },
  opts: { wsl?: boolean; platform?: string; arch?: string; translateToWindowsPath?: (p: string) => string | undefined } = {},
): {
  deps: ApplyDeps
  spawned: string[]
  spawnedEnvs: Array<Record<string, string>>
  killed: number
  registered: Array<{ bin: string; extensionId: string; dataDir: string }>
} {
  const spawned: string[] = []
  const spawnedEnvs: Array<Record<string, string>> = []
  let killed = 0
  const registered: Array<{ bin: string; extensionId: string; dataDir: string }> = []
  const agent: AgentDeps = {
    spawn(bin, env): AgentProcess {
      spawned.push(bin)
      spawnedEnvs.push(env)
      return { kill: () => { killed += 1 }, onExit: () => {} }
    },
    setTimer: () => undefined,
    clearTimer: () => {},
    now: () => 0,
    log: () => {},
  }
  return {
    spawned,
    spawnedEnvs,
    get killed() { return killed },
    registered,
    deps: {
      // 平台跟着 wsl 走，别写死一个：WSL 下 `process.platform` 真的是 `'linux'`（这正是
      // wsl 标志存在的理由），非 WSL 场景则必须是 win32——出货平台只有 Windows，拿 linux
      // 当默认会让每条用例都停在「这个平台没有后端」，测不到 mount() 本身。
      lookup: {
        platform: opts.platform ?? (opts.wsl ? 'linux' : 'win32'),
        arch: opts.arch ?? 'x64',
        wsl: opts.wsl ?? false,
        resolvePath,
      },
      agent,
      register: (bin, extensionId, dataDir) => {
        registered.push({ bin, extensionId, dataDir })
        return registerResult
      },
      // exactOptionalPropertyTypes：可选字段只能「省略」或「给一个真实函数」，不能显式赋 undefined。
      ...(opts.translateToWindowsPath ? { translateToWindowsPath: opts.translateToWindowsPath } : {}),
    },
  }
}

const OK_RESOLVER = (s: string) => `/p/${s}`
const GOOD = { streamBaseUrl: 'http://127.0.0.1:8900', streamDataDir: '/data', extensionId: 'a'.repeat(32) }

describe('mountHostAgent', () => {
  it('配齐了：注册 native messaging，然后经 onDispose 起 agent', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER)
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.registered).toHaveLength(1)
    expect(d.registered[0]).toEqual({
      bin: '/p/@streamapp/desktop-win32-x64/bin/stream-desktop.exe',
      extensionId: GOOD.extensionId,
      // 非 WSL：原样，与常驻 agent 拿到的是同一个目录。
      dataDir: '/data',
    })
    expect(d.spawned).toHaveLength(1)
    expect(c.disposers).toHaveLength(1)
    expect(c.logs.warn).toEqual([])
  })

  it('行 config 不给 extensionId：用包内自带的默认值 --register（不再跳过）', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER)
    await mountHostAgent(c, { streamBaseUrl: GOOD.streamBaseUrl, streamDataDir: GOOD.streamDataDir }, d.deps)
    expect(d.registered).toHaveLength(1)
    expect(d.registered[0]!.extensionId).toBe(STREAM_EXTENSION_ID)
    expect(d.spawned).toHaveLength(1)
    expect(c.logs.warn.join()).not.toContain('extensionId')
  })

  it('--register 返回非 0：警告带上 stderr，但不阻止 agent 起（C2）', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER, { ok: false, stderr: '必须给 --extension-id' })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.registered).toHaveLength(1)
    expect(d.spawned).toHaveLength(1)
    expect(c.logs.warn.join()).toContain('--register 失败')
    expect(c.logs.warn.join()).toContain('必须给 --extension-id')
  })

  it('没有 streamBaseUrl：警告点名这个字段，不 spawn，不抛', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER)
    await expect(mountHostAgent(c, { streamDataDir: '/data' }, d.deps)).resolves.not.toThrow()
    expect(d.spawned).toHaveLength(0)
    expect(c.logs.warn.join()).toContain('streamBaseUrl')
  })

  it('没有 streamDataDir：警告点名这个字段，不 spawn（起来了握不上手最难查）', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER)
    await mountHostAgent(c, { streamBaseUrl: 'http://127.0.0.1:8900' }, d.deps)
    expect(d.spawned).toHaveLength(0)
    expect(c.logs.warn.join()).toContain('streamDataDir')
  })

  it('二进制没有：把解析层给的那句原因照登，不 spawn，不抛', async () => {
    const c = ctxHarness()
    const d = depsHarness(() => { throw new Error('nope') })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.spawned).toHaveLength(0)
    expect(c.logs.warn.join()).toContain('@streamapp/desktop-win32-x64')
  })

  it('二进制没有时也不注册 native messaging（登记一个不存在的路径比不登记更坏）', async () => {
    const c = ctxHarness()
    const d = depsHarness(() => { throw new Error('nope') })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.registered).toHaveLength(0)
  })

  // 后端每次重启都会 dispose 再重装。所以 dispose 之后必须是个干净状态：不留活着的 agent，
  // 也不因为这一次 dispose 去动 Chrome 的登记（撤了再写会留下一段扩展握不上手的窗口）。
  it('dispose：真的 kill 掉 agent 子进程，且不再多出一次 native messaging 登记', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER)
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.registered).toHaveLength(1)
    expect(d.killed).toBe(0) // dispose 之前不许提前 kill
    await c.dispose()
    expect(d.killed).toBe(1) // Minor-2：过去这条用例名叫「收掉 agent」但只验了不多注册/不再 spawn，没验 kill 真被调用
    expect(d.registered).toHaveLength(1)
    expect(d.spawned).toHaveLength(1) // dispose 之后不许再起
  })
})

// 这只手是**两半**，平台可以只有一半。
//
// **2026-09-07：mac 长出了第二半**（`app/host-agent/src/macos.rs` 的 AX 后端，代装扩展整条
// 在真机上跑通，见 `docs/superpowers/reports/2026-09-07-mac-desktop-install-verify.md`），
// 所以 mac 从「只配对」挪到了「两半都做」，下面两条跟着改。
//
// **「只配对」那条分支本身没删，只是今天没有平台走得到它**（出货表里的 win32/darwin 都有
// 后端了）。它是给下一个平台留的：某个平台先出了二进制、AT-SPI 之类的后端还没写时，
// 必须仍然跑 `--register`。两个方向当初都自证过真红（把 index.ts 里
// `if (!found.desktopControl) { … return }` 整段删掉 → spawned 变 1 那条红；把它提到
// `deps.register(...)` 之前 → registered 变 0 那条红）——那次自证的价值不随 mac 长出后端而消失，
// 但**它现在没有活的用例守着**，下一个加平台的人要把这一组按当时的形状补回来。
//
// 为什么当初非钉不可：少了「register 跑了」这一半，有人写成「不支持就整个 return」不会红，
// 而那正是干净装机上实测撞到的坏结局——指针没人写 → 扩展拿不到 relay token → 永远
// never-seen → 要登录态的源全是游客态，**一处都不喊**。
describe('mountHostAgent：mac 现在两半都做', () => {
  const MAC = { platform: 'darwin', arch: 'x64' as const }
  const MAC_RESOLVER = (s: string) => `/p/${s}`

  it('mac：既跑 --register（配对），也起常驻 agent（桌面控制）', async () => {
    const c = ctxHarness()
    const d = depsHarness(MAC_RESOLVER, undefined, MAC)
    await mountHostAgent(c, GOOD, d.deps)
    // 配对那一半：manifest 与 ~/.stream/datadir 指针都由这一次 --register 写下。
    expect(d.registered).toHaveLength(1)
    expect(d.registered[0]).toEqual({
      // 无扩展名——mac 的产物不叫 .exe。
      bin: '/p/@streamapp/desktop-darwin-x64/bin/stream-desktop',
      extensionId: GOOD.extensionId,
      dataDir: '/data',
    })
    // 桌面控制那一半：常驻进程起来了，disposer 也登记了。
    expect(d.spawned).toHaveLength(1)
    expect(c.disposers).toHaveLength(1)
  })

  it('mac：起 agent 用的是解出来的那个 mac 二进制，不是 .exe', async () => {
    const c = ctxHarness()
    const d = depsHarness(MAC_RESOLVER, undefined, MAC)
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.spawned[0]).toBe('/p/@streamapp/desktop-darwin-x64/bin/stream-desktop')
    // 不是故障，不该有 warn。
    expect(c.logs.warn).toEqual([])
  })

  it('win32：仍然两半都做——这条是上面那条的反向对照', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER)
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.registered).toHaveLength(1)
    expect(d.spawned).toHaveLength(1)
  })
})

// Minor-3：child.stdin/child.stderr 是裸的 EventEmitter，管道被异常拆掉时的流级 error
// 走的是同一条「没人接 → throw → 带走整个引擎」的路——child.on('error') 接不住它。
describe('attachStreamErrorGuards', () => {
  it('挂了监听之后，stdin/stderr 上的 error 不会抛出去，且被记进日志', () => {
    const logs: string[] = []
    const child = { stdin: new EventEmitter(), stderr: new EventEmitter() }
    attachStreamErrorGuards(child, (m) => logs.push(m))
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    expect(() => child.stderr.emit('error', new Error('boom'))).not.toThrow()
    expect(logs.some((l) => l.includes('stdin') && l.includes('EPIPE'))).toBe(true)
    expect(logs.some((l) => l.includes('stderr') && l.includes('boom'))).toBe(true)
  })

  it('stdin/stderr 缺席（null）不报错', () => {
    expect(() => attachStreamErrorGuards({ stdin: null, stderr: null }, () => {})).not.toThrow()
  })
})

// 运维日志的落点与前缀（`[stream-<能力名>]`）归宿主那一层（`src/capabilities/host.test.ts`
// 已经通用地钉住了），mountHostAgent() 这一层只管调用 ctx.log 一次，不重复验证。

describe('isWslVersionString（判据必须与 register.rs 的 is_wsl 一致——同抄一条，别自己发明）', () => {
  it('本机实测的 WSL2 内核字符串 → true', () => {
    expect(isWslVersionString('Linux version 5.15.167.4-microsoft-standard-WSL2 (...)')).toBe(true)
  })
  it('普通 Linux 内核字符串 → false', () => {
    expect(isWslVersionString('Linux version 6.8.0-generic (...)')).toBe(false)
  })
})

describe('buildWindowsAgentEnv（WSLENV 名单必须与实际传给 spawn 的 env 同源）', () => {
  it('把 env 的所有 key 拼进 WSLENV，原 env 的值不变', () => {
    const env = { STREAM_HOST_URL: 'ws://x', STREAM_DATA_DIR: '/data', STREAM_HOST_PARENT_WATCH: '1' }
    const out = buildWindowsAgentEnv(env)
    expect(out.STREAM_HOST_URL).toBe('ws://x')
    expect(out.STREAM_DATA_DIR).toBe('/data')
    expect(out.STREAM_HOST_PARENT_WATCH).toBe('1')
    expect(out.WSLENV!.split(':').sort()).toEqual(
      ['STREAM_HOST_URL', 'STREAM_DATA_DIR', 'STREAM_HOST_PARENT_WATCH'].sort(),
    )
    // STREAM_HOST_TOKEN 从没被塞进过这份 env，WSLENV 里天然不会出现——token 不经插件的手。
    expect(out.WSLENV).not.toContain('TOKEN')
  })

  it('不改原对象（纯函数）', () => {
    const env = { A: '1' }
    buildWindowsAgentEnv(env)
    expect(env).toEqual({ A: '1' })
  })
})

// WSL 下要控制的桌面在 Windows 一侧：resolveAgentBinary 挑中 win32 agent 之后，mount()
// 必须把 streamDataDir 翻成 Windows 路径、且往 spawn 的 env 里加 WSLENV，否则 Windows
// 那边的 agent 起来了也读不到 STREAM_DATA_DIR 指向的 relay token（症状和「没装」一样）。
describe('mountHostAgent：WSL 下挑中 Windows agent 的分支', () => {
  const WIN_RESOLVER = (s: string) => `/p/${s}`

  it('wsl=true：spawn 的 env 里 STREAM_DATA_DIR 是翻译后的路径，WSLENV 列全，且没有 STREAM_HOST_TOKEN', async () => {
    const c = ctxHarness()
    const d = depsHarness(WIN_RESOLVER, undefined, {
      wsl: true,
      translateToWindowsPath: (p) => (p === '/data' ? '\\\\wsl.localhost\\Ubuntu\\data' : undefined),
    })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.spawned).toHaveLength(1)
    const env = d.spawnedEnvs[0]!
    expect(env.STREAM_DATA_DIR).toBe('\\\\wsl.localhost\\Ubuntu\\data')
    expect(env.WSLENV!.split(':').sort()).toEqual(
      ['STREAM_HOST_URL', 'STREAM_DATA_DIR', 'STREAM_HOST_PARENT_WATCH'].sort(),
    )
    expect(env.STREAM_HOST_TOKEN).toBeUndefined()
    expect(env.WSLENV).not.toContain('TOKEN')
  })

  // `--register` 那次一次性 spawn 和常驻 agent 那次拿到的必须是**同一个目录**。分家的表现
  // 全都不出声：Rust 侧 `write_datadir_pointer()` 按自己进程的环境解析 data 目录再写
  // `~/.stream/datadir` 指针，指针指到 A、token 铸在 B，中继据此拒绝每一次握手，看起来就是
  // 「扩展没装」。所以这一条钉的是"register 收到的是翻译后的那个路径"，不是"register 被调过"。
  it('wsl=true：register 收到的 dataDir 与常驻 agent 的 STREAM_DATA_DIR 是同一个', async () => {
    const c = ctxHarness()
    const d = depsHarness(WIN_RESOLVER, undefined, {
      wsl: true,
      translateToWindowsPath: (p) => (p === '/data' ? '\\\\wsl.localhost\\Ubuntu\\data' : undefined),
    })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.registered).toHaveLength(1)
    expect(d.registered[0]!.dataDir).toBe('\\\\wsl.localhost\\Ubuntu\\data')
    expect(d.registered[0]!.dataDir).toBe(d.spawnedEnvs[0]!.STREAM_DATA_DIR)
  })

  it('wsl=true 但路径翻译失败：不 spawn、也不 register，日志说清原因', async () => {
    const c = ctxHarness()
    const d = depsHarness(WIN_RESOLVER, undefined, { wsl: true, translateToWindowsPath: () => undefined })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.spawned).toHaveLength(0)
    // 登记也不该发生：拿一个解析不了的路径去写指针，比不写更坏——它会把指针指到一个
    // Stream 从没碰过的目录，而那正是「宁可不起」要避免的那个不出声的坏结局。
    expect(d.registered).toHaveLength(0)
    expect(c.logs.warn.join()).toContain('翻译')
  })

  it('wsl=false：维持原样，STREAM_DATA_DIR 是原始 Linux 路径，env 里没有 WSLENV', async () => {
    const c = ctxHarness()
    const d = depsHarness(OK_RESOLVER, undefined, { wsl: false })
    await mountHostAgent(c, GOOD, d.deps)
    expect(d.spawned).toHaveLength(1)
    const env = d.spawnedEnvs[0]!
    expect(env.STREAM_DATA_DIR).toBe('/data')
    expect(env.WSLENV).toBeUndefined()
  })
})
