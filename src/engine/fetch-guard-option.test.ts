// createStream 的 callerFetchGuard 选项（openspec/changes/private-fetch-guard 的嵌入入口）：
// 嵌入方不经 config.yaml 也能把「调用方传网址」抓取路径的私网拒绝打开——选项按字段覆盖
// config.caller_fetch_guard，没给的字段沿用配置。开关是进程级策略位：只开不关。
// 防护本体与地址判定在 src/net/caller-fetch-guard.test.ts，这里只测选项的接线。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { createStream, callerFetchGuardConfigured, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { safeFetchText } from '../adapters/safe-fetch.ts'
import { withCallerFetchGuard } from '../net/caller-fetch-guard.ts'

function tempRoot(): { root: string; config: ReturnType<typeof readConfig> } {
  const root = mkdtempSync(join(tmpdir(), 'stream-engine-guard-'))
  const packages = join(root, 'packages')
  mkdirSync(packages)
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  const config = { ...base, packages_dir: packages, rsshub_catalog: '', deployment: { ...base.deployment, scheduler: false } }
  return { root, config }
}

describe('createStream 的 callerFetchGuard 选项', () => {
  const roots: string[] = []
  const open: Stream[] = []
  const servers: Server[] = []
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close()
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
    for (const s of servers.splice(0)) s.close()
  })

  it('缺省关闭：不带选项、配置里也没有时策略位不出现', async () => {
    expect(callerFetchGuardConfigured()).toBe(false)
    const { root, config } = tempRoot(); roots.push(root)
    await createStream({ dataDir: root, config, log: () => {} }).then((s) => open.push(s))
    expect(callerFetchGuardConfigured()).toBe(false)
  })

  it('选项打开：守卫对受作用的抓取路径生效，回环被拒', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    await createStream({ dataDir: root, config, callerFetchGuard: { reject_private: true }, log: () => {} }).then((s) => open.push(s))
    expect(callerFetchGuardConfigured()).toBe(true)
    await expect(withCallerFetchGuard(() => safeFetchText('http://127.0.0.1:9/x'))).rejects.toThrow(/内网地址/)
  })

  it('config 里的配置单独也认（选项只是另一个入口）', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    config.caller_fetch_guard = { reject_private: true }
    await createStream({ dataDir: root, config, log: () => {} }).then((s) => open.push(s))
    expect(callerFetchGuardConfigured()).toBe(true)
  })

  it('字段按格合并：选项给解析器、config 给开关与例外名单，各取各的；名单主机放行到本地假服务', async () => {
    const body = '<html><body>allowed page</body></html>'
    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(body) })
    servers.push(server)
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))

    const { root, config } = tempRoot(); roots.push(root)
    config.caller_fetch_guard = { reject_private: true, allow: ['local.test'] }
    await createStream({
      dataDir: root,
      config,
      callerFetchGuard: { resolve: async (h) => (h === 'local.test' ? [{ address: '127.0.0.1', family: 4 }] : []) },
      log: () => {},
    }).then((s) => open.push(s))
    // 名单主机名跳过 IP 判定 → 注入解析给出的 127.0.0.1 直连本地假服务，抓回正文
    await expect(withCallerFetchGuard(() => safeFetchText(`http://local.test:${port}/`))).resolves.toMatchObject({ finalUrl: `http://local.test:${port}/` })
    // 名单外同类地址照拒：config 的 reject_private 在起作用
    await expect(withCallerFetchGuard(() => safeFetchText('http://10.1.2.3/x'))).rejects.toThrow(/内网地址/)
  })

  it('只开不关：后建的实例不带选项，也不能把已打开的守卫关掉', async () => {
    const one = tempRoot(); const two = tempRoot(); roots.push(one.root, two.root)
    await createStream({ dataDir: one.root, config: one.config, callerFetchGuard: { reject_private: true }, log: () => {} }).then((s) => open.push(s))
    await createStream({ dataDir: two.root, config: two.config, log: () => {} }).then((s) => open.push(s))
    expect(callerFetchGuardConfigured()).toBe(true)
  })
})
