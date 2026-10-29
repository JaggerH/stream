/**
 * 测试里起一台**真** Chromium（不是 mock）：CDP 绑定的行为全在浏览器那一侧，假连接只能测到
 * 我们自己写的那层，测不到 `Target.*` / `Storage.getCookies` 真正的形状。
 *
 * 三条硬规矩（测试结束不许留东西）：
 *
 * - **只监听回环**：`--remote-debugging-address=127.0.0.1`，端口交给浏览器挑（`=0`），实际端口
 *   从 user-data-dir 里的 `DevToolsActivePort` 读——写死端口会在并行的另一个 worker 上撞车。
 * - **独立临时 user-data-dir**：不碰任何人正在用的 profile；`mkdtempSync` 建的目录由
 *   `src/test-setup.ts` 兜底删除，这里另外在 `close()` 里删一次（浏览器还在写的时候删不掉）。
 * - **退出即关**：`close()` 杀进程、等它真的退出、再删目录。
 *
 * 浏览器从 `playwright-core` 的打包路径取（本仓库的依赖）。没有下载浏览器 → 返回 `null`，
 * 调用方跳过并**打印原因**（与 `serve.routes` 那一批同口径）：静默跳过会让人以为跑过了。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestChromium {
  /** `http://127.0.0.1:<port>`——绑定 / 测试都按这个地址连。 */
  cdpUrl: string
  userDataDir: string
  /** 杀浏览器、等它退出、删目录。幂等。 */
  close(): Promise<void>
  /** 浏览器进程自己退出时兑现（被外部杀掉也算）。 */
  exited: Promise<number | null>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 本机有没有可用的 Chromium。没有 → `null`（调用方跳过并打印原因）。 */
export async function chromiumExecutable(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright-core')
    const path = chromium.executablePath()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

/**
 * 起一台 headless Chromium。没有浏览器 → `null`。
 *
 * `--headless=new` 是这一档唯一要的：它照样有合成器（截图能出帧）、照样有 target 事件，
 * 区别只是没有窗口——CDP 绑定不依赖窗口。
 */
export async function launchChromium(): Promise<TestChromium | null> {
  const exe = await chromiumExecutable()
  if (!exe) return null
  const userDataDir = mkdtempSync(join(tmpdir(), 'stream-cdp-chromium-'))
  // 浏览器自己的临时文件（共享内存、socket 之类）也塞进这个目录里：Chrome 用 $TMPDIR 建
  // `org.chromium.Chromium.*`，默认落在系统临时目录——测试跑完那里会剩几个空壳，
  // 而它们不在 `mkdtemp` 的记账里，谁都删不掉。指到这里，`close()` 一次删干净。
  const browserTmp = join(userDataDir, 'tmp')
  mkdirSync(browserTmp, { recursive: true })
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      // 端口 0 = 浏览器自己挑一个空闲端口；实际值写进 user-data-dir 里的 DevToolsActivePort。
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, TMPDIR: browserTmp, TMP: browserTmp, TEMP: browserTmp },
    },
  )
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  let closed = false

  const portFile = join(userDataDir, 'DevToolsActivePort')
  let port = 0
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(first)) {
        port = Number(first)
        break
      }
    }
    if (child.exitCode !== null) {
      rmSync(userDataDir, { recursive: true, force: true })
      throw new Error(`Chromium 启动失败（退出码 ${child.exitCode}）`)
    }
    await sleep(25)
  }
  if (!port) {
    child.kill('SIGKILL')
    await exited
    rmSync(userDataDir, { recursive: true, force: true })
    throw new Error('Chromium 20s 内没写出 DevToolsActivePort')
  }

  const cdpUrl = `http://127.0.0.1:${port}`
  // 端口文件先落、HTTP 口后听：等到 /json/version 真的回话再交出去，别把这段竞态留给调用方。
  let ready = false
  for (let i = 0; i < 400 && !ready; i++) {
    try {
      ready = (await fetch(`${cdpUrl}/json/version`)).ok
    } catch {
      /* 还没听 */
    }
    if (!ready) await sleep(25)
  }
  if (!ready) {
    child.kill('SIGKILL')
    await exited
    rmSync(userDataDir, { recursive: true, force: true })
    throw new Error(`Chromium 的 CDP 口 ${cdpUrl} 没有在 10s 内就绪`)
  }

  return {
    cdpUrl,
    userDataDir,
    exited,
    async close() {
      if (closed) return
      closed = true
      if (child.exitCode === null) child.kill('SIGKILL')
      await Promise.race([exited, sleep(10_000)])
      try {
        // 浏览器刚退出时 profile 里可能还有人在写（ENOTEMPTY/EBUSY）——带重试删。
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        // 真删不掉也不该让用例变红：`src/test-setup.ts` 的 afterAll 还会再删一次。
      }
    },
  }
}
