/**
 * 「路由真的挂上了吗」——这条测试**真的把后端启动一次**，然后去问它。
 *
 * 为什么非要起进程：`/api/tasks` 曾经**在任何模式下都没被挂载**（守卫在 ~:518 求值，而它读的
 * 变量 ~:708 才赋值，恒为 undefined）。那个 bug 躲过了 tsc、躲过了当时全部 920 条测试、躲过了
 * 两轮人工评审。让它躲过去的缺口是：`app.tasks.test.ts` 自己 `new Hono()` 再 `mountTaskRoutes`,
 * 验的是"这几块拼起来不炸"——它**永远不会失败**，因为根本不经过 `serve.ts` 的接线。
 * **路由挂没挂上是 main() 的事**，而在这条测试之前没有任何测试跑过 main()。
 *
 * `main()` 没有导出、且被 `if (!process.env.VITEST)` 挡着，所以只能起子进程——这不是绕路，
 * 起子进程本身就是"走一遍真实入口"这个判据。
 *
 * **代价实测 2.3s**（空 packages_dir + 查询档），全量后端约 100s，也就是 +2%。当年为它开脱的
 * 那句"真启动太贵"没有量过。
 *
 * ## 两个判据上的坑，改这条测试之前先读
 *
 * 1. **一条挂上了但资源不存在的路由，和一条根本没挂的路由，返回的都是 404。**
 *    所以断言必须挑「挂上了就一定不返回 404」的路由 + 输入组合，别随手挑一条。
 *    （`/api/sources/affected?id=x` 就是反例：活体上用真 id 查是 200，喂一个不存在的 id 是 404。）
 * 2. **必须有反向对照**：一条不存在的 `/api/*` 必须是 404。少了它，任何一个兜底 handler
 *    都会让上面那串断言全绿——那正是这类测试最容易变成的样子：看着在验，其实什么都没验。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 随机高位口：活体那份钉死 8900，别的会话也可能起着自己那份。 */
const PORT = 21000 + Math.floor(Math.random() * 9000)
const BOOT_TIMEOUT_MS = 90_000

let child: ChildProcess | undefined

/**
 * 隔离三件套，少一件都会伤到别人（`docs/DEVELOPMENT.md`「另起一份后端做冒烟」）：
 * 端口、data dir、**`packages_dir` 指空目录**——不指的话这份后端的 standby 管家会 `adopt()`
 * 用户正在跑的容器，退出时把它们 stop 掉，而活体那份的 cell 还记着 awake，再也不会拉回来。
 */
function bootFixture(): { env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'stream-routes-'))
  const pkgs = join(root, 'pkgs')
  mkdirSync(pkgs, { recursive: true })
  // `/api/plugins` 的断言要有东西可断——空目录下它回 `[]`，一条「每项都有 tools」的用例
  // 就永远是空转（vacuously true）。这个包只填一格最无害的槽位（空的 Source 清单）。
  mkdirSync(join(pkgs, 'demo'), { recursive: true })
  writeFileSync(join(pkgs, 'demo', 'package.json'), JSON.stringify({ stream: { id: 'demo', name: 'Demo', sources: [] } }))
  // 用户层放一个**真的能力包**。这条不是布景：`slots.tools` 的数据源是活着的能力宿主，
  // 而可选能力包住 `<dataDir>/recipes/`——它们**不在** `service.plugins()` 里，所以
  // `/api/plugins` 那一格永远看不到任何能力包，拿它当判据等于什么都没验。
  // 判据只能是 `/api/packages`（用户看的那一页），而且要真装载一次才谈得上"有没有工具"。
  // `<dataDir>/recipes`，而 dataDir 是 `dirname(item_db)` = `<root>/data`（`item_db` 默认
  // `./data/items.db`，被 STREAM_DATA_DIR 垫了前缀）——**不是 root 本身**。写错一层的表现是
  // 装载器和目录两边都安静地扫到空目录。
  const capDir = join(root, 'data', 'recipes', 'demo-cap')
  mkdirSync(join(capDir, 'dist'), { recursive: true })
  writeFileSync(
    join(capDir, 'package.json'),
    // 凭证域申报在**包描述符**这一格（`stream.credentials`），不在模块上——它过
    // `credentialsSchema` 与安装确认页，所以后端读到的正是用户批准过的那份名单。
    JSON.stringify({
      name: '@t/demo-cap',
      version: '1.0.0',
      stream: { id: 'demo-cap', name: 'Demo Cap', capability: 'dist/index.js', credentials: ['demo-cap.test'] },
    }),
  )
  writeFileSync(
    join(capDir, 'dist', 'index.js'),
    `export const capability = {
  name: 'demo-cap',
  async mount(ctx) {
    ctx.registerTools([{
      name: 'demo_cap_verb',
      description: 'demo',
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({ ok: true }),
    }])
  },
}
`,
  )
  writeFileSync(join(root, 'config.yaml'), `packages_dir: ${pkgs}\nmanage_containers: false\n`)
  const env: NodeJS.ProcessEnv = { ...process.env, STREAM_PORT: String(PORT), STREAM_DATA_DIR: root, CONFIG_PATH: join(root, 'config.yaml'), STREAM_NO_SCHEDULER: '1' }
  // 子进程必须**不带** VITEST，否则 serve.ts 底部那个 `if (!process.env.VITEST)` 会让 main() 不跑，
  // 于是端口上没人听、这条测试超时——而症状看起来像"启动很慢"，会把人带去查性能。
  delete env.VITEST
  delete env.VITEST_WORKER_ID
  return { env }
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return { status: res.status, body: await res.text() }
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`后端启动即退出 (exit=${child.exitCode})：\n${logs}`)
    try {
      const r = await get('/api/health')
      if (r.status === 200) return
      last = `HTTP ${r.status}`
    } catch (e) { last = (e as Error).message }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${BOOT_TIMEOUT_MS}ms 内没起来（最后一次：${last}）：\n${logs}`)
}

let logs = ''

/**
 * **health 一变 200 就立刻问的那一次** `tools/list`。
 *
 * 判据必须钉在这一瞬：`stream mcp` 探到 health 通了就整面转发，宿主随即把那一刻的工具表
 * 缓起来。放到后面的 `it` 里再问就永远是绿的——那时装载早已结束，测的是"最终会装上"，
 * 而缺陷恰恰是"listen 与装载之间那个窗口期里它不在表上"。
 */
let firstToolNames: string[] = []

async function listToolsOnce(): Promise<string[]> {
  const client = new Client({ name: 'serve-routes-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/api/mcp`)))
  try {
    return (await client.listTools()).tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}

describe('serve.ts 真启动一次：关键路由确实挂上了', () => {
  afterAll(async () => {
    if (!child || child.exitCode != null) return
    child.kill('SIGTERM')
    await new Promise((r) => { child!.once('exit', r); setTimeout(r, 5000) })
    if (child.exitCode == null) child.kill('SIGKILL')
  })

  it('启动到 /api/health 200', async () => {
    const { env } = bootFixture()
    child = spawn(join(REPO, 'node_modules/.bin/tsx'), [join(REPO, 'src/serve.ts')], { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (b) => { logs += String(b) })
    child.stderr?.on('data', (b) => { logs += String(b) })
    await waitHealthy()
    // 紧接着、不给它任何喘息时间——这一次的答案就是宿主会缓起来的那一份。
    firstToolNames = await listToolsOnce()
  }, BOOT_TIMEOUT_MS)

  // 可选能力包必须在 listen 之前装完。装在 listen 之后就有一个窗口期，窗口里 `stream mcp`
  // 已经在整面转发、宿主已经把工具表缓起来了，而用户刚装的那个包一件工具都不在上面——
  // `/api/packages` 那一列却照常列着它，没有任何一处会喊。
  it('health 一通、第一次 tools/list 就含可选能力包的工具', () => {
    expect(firstToolNames, `第一次 tools/list：${firstToolNames.join(', ')}\n后端日志：\n${logs}`)
      .toContain('demo_cap_verb')
  })

  // 挑的都是「挂上了就一定不返回 404」的组合：空库也回 200 + 空集合，不依赖任何数据。
  // `/api/tasks` 是当年真出事的那一条，排第一。
  it.each([
    ['/api/tasks', '当年在所有模式下都没挂，920 条测试无一发现'],
    ['/api/channels', ''],
    ['/api/plugins', ''],
    ['/api/streams', ''],
    // 扩展安装引导那一格：dep 没接上时这条恒 404，而前端的表现只是"横幅永远不出现"——
    // 没有任何一处会喊。空 settings 也回 200 `{}`，所以它满足"挂上了就一定不是 404"。
    ['/api/extension/onboarding', '安装引导的接线：漏了只表现为横幅永远不出现'],
  ])('%s 挂上了', async (path) => {
    const r = await get(path)
    expect(r.status, `${path} → ${r.status}；后端日志：\n${logs}`).toBe(200)
  })

  // 能力包给了哪些工具，是「包」页那一列的数据源。这一条走**整条真链路**：装载器扫到夹具里
  // 那个包 → 动态 import → `host.mount()` 注册工具 → HttpDeps 那条 thunk → `/api/packages`。
  // 断掉其中任何一环（少一格类型、忘了注入、mount 排在读之后）都只表现为"那一列永远空着"，
  // 没有任何一处会喊。
  it('/api/packages 上那个能力包报出它注册的工具', async () => {
    const r = await get('/api/packages')
    expect(r.status, `后端日志：\n${logs}`).toBe(200)
    const rows = (JSON.parse(r.body) as { packages: Array<{ id: string; slots: { capability?: string; tools?: string[] } }> }).packages
    const row = rows.find((p) => p.id === 'demo-cap')
    expect(row, `目录里没有 demo-cap；后端日志：\n${logs}`).toBeTruthy()
    expect(row!.slots.capability).toBe('dist/index.js')
    expect(row!.slots.tools).toEqual(['demo_cap_verb'])
  })

  // 能力包是**一等的登录态消费者**：它经 `streamBrowserCookies` 取用户浏览器里的 cookie，
  // 和一份 manifest 的 `auth` 同级，只是申报点是包描述符的 `stream.credentials` 那一格。
  // 漏掉它 = 扩展根本不去读那个域，而包拿到的空 cookie 和"用户没登录"一字不差，
  // 没有任何一处会喊。
  //
  // 这一条走的也是整条真链路：`package.json#stream.credentials` → 扫描器 → `load.ts` →
  // `host.credentialDomains()` → bootstrap 的 `extraCookieDomains` → `requiredCookieDomains`
  // → 扩展读到的这个端点。
  it('能力包申报的登录态域进了扩展的同步名单', async () => {
    const r = await get('/api/ext/sync-config')
    expect(r.status, `后端日志：\n${logs}`).toBe(200)
    const cfg = JSON.parse(r.body) as { configured: boolean; requiredDomains?: string[] }
    expect(cfg.requiredDomains, `后端日志：\n${logs}`).toContain('demo-cap.test')
  })

  // 反向对照：不填能力槽位的包**不该**长出这两格。恒发一个空数组的话，上面那条断言就分不出
  // "真装载了" 和 "路由给每一行都塞了个默认值"。
  it('不填能力槽位的包既没有 capability 也没有 tools', async () => {
    const r = await get('/api/packages')
    const rows = (JSON.parse(r.body) as { packages: Array<{ id: string; slots: Record<string, unknown> }> }).packages
    const plain = rows.find((p) => p.id === 'demo')
    expect(plain, `目录里没有 demo；后端日志：\n${logs}`).toBeTruthy()
    expect(plain!.slots.capability).toBeUndefined()
    expect(plain!.slots.tools).toBeUndefined()
  })

  // 反向对照：没有这一条，任何兜底 handler 都会让上面那串 200 全绿——那正是这类测试最容易
  // 变成的样子：看着在验，其实什么都没验。
  //
  // **断言的是"不是 200"，不是某个具体码**：未被 Stream 路由认领的路径会往下落给独立正门
  // （`src/http/standalone-page.ts`），它对 /api 前缀一律 404；换个环境落空形态又不一样。
  // **具体码是环境的性质，"没人用 200 兜底"才是这条要钉的性质。**
  it('不存在的 /api/* 不返回 200——证明上面那串 200 不是兜底 handler 给的', async () => {
    const r = await get('/api/definitely-not-a-real-route')
    expect(r.status, `落空路径回了 ${r.status}；后端日志：\n${logs}`).not.toBe(200)
  })
})
