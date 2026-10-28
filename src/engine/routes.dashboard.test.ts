/**
 * 面板随路由起（退回 R2，routes 层）：同进程两个实例各自挂路由，各给各的面板口——
 * 两个面板都起、互不撞；走 `/_p/sidequest` 的反代两端都通。随实例起面板的那份旧状
 * （第二个实例必然撞 8678）由这里兜底：routes() 的参数决定端口，缺省 8678。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStream, type Stream } from './index.ts'
import { routes } from './routes.ts'
import { deviceGateway } from './device-gateway.ts'
import { readConfig } from '../bootstrap.ts'
import { WsHub } from '../http/ws.ts'
import { DebugLog } from '../http/debug-log.ts'

const roots: string[] = []
const open: Stream[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const tempRoot = (tag: string): ReturnType<typeof readConfig> => {
  const root = mkdtempSync(join(tmpdir(), `routes-dash-${tag}-`))
  roots.push(root)
  const packages = join(root, 'packages')
  mkdirSync(packages)
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  // 面板读的是调度中心的账本：中心没起（查询档）时 startDashboard 本来就只留一行日志——
  // 所以这条用例开 scheduler（真 sidequest 引擎），面板才有东西可看。
  return { ...base, packages_dir: packages, rsshub_catalog: '', deployment: { ...base.deployment, scheduler: true } }
}

const io = (s: Stream, port: number, dashboardPort: number) => ({
  stream: s,
  hub: new WsHub(),
  debugLog: new DebugLog(),
  track: <T,>(_name: string, fn: () => Promise<T>) => fn(),
  trackSync: <T,>(_name: string, fn: () => T) => fn(),
  port,
  dashboardPort,
  restart: { running: async () => [], trigger: async () => 'reexec' as const },
  gateway: deviceGateway(s, { basePath: '/api', isAdmin: () => true, backendUrls: () => [] }),
})

describe('sidequest 面板随 routes() 起（routes 层）', () => {
  it('两个实例各挂路由、各给各的面板口 → 两个面板都通', async () => {
    const port = 30000 + Math.floor(Math.random() * 8000)
    const a = await createStream({ dataDir: join(tempRoot('a').packages_dir, '..'), config: tempRoot('a'), log: () => {} })
    open.push(a)
    const b = await createStream({ dataDir: join(tempRoot('b').packages_dir, '..'), config: tempRoot('b'), log: () => {} })
    open.push(b)
    await routes(io(a, port, port + 1))
    await routes(io(b, port, port + 2))
    // 两实例的面板各在自己的口上——同进程第二份不再撞 8678。
    for (const p of [port + 1, port + 2]) {
      const res = await fetch(`http://127.0.0.1:${p}/_p/sidequest/`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
      expect(res, `面板 ${p} 应该有 HTTP 响应`).not.toBeNull()
      await res!.arrayBuffer().catch(() => {})
    }
  })
})
