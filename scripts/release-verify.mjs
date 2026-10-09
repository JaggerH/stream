#!/usr/bin/env node
/**
 * 发版验收：在一台**干净的真机**上确认「发到 npm 的那个 @streamapp/stream 装得上、起得来、功能是通的」。
 *
 * 它回答的问题和单元测试不同：单测证明源码逻辑对；这里证明**发出去的产物**在别人的机器上成立——
 * 打包漏文件、原生依赖在 Windows/mac 上装不上、宿主版本注入错了，这些只有真装一次才看得见。
 *
 * **在测试机上跑**（零依赖，只用 Node 自带模块；Windows / mac 同一份）：
 *
 *   node release-verify.mjs --version 0.0.26 [--old 0.0.23] [--probe @streamapp/bilibili@1.1.0] [--keep]
 *
 * 开发机上经 ssh 喂给测试机跑：`scripts/release-verify-remote.sh`（连法写在它的头注里）。
 *
 * 怎么做到「不碰机器上正在用的那份安装」：新旧两个版本都 `npm i --prefix` 进一个临时目录，各起一份
 * **独立端口 + 独立数据目录 + STREAM_NO_DESKTOP=1** 的后端（后端是本脚本的子进程，不需要登录会话、
 * 不需要计划任务），测完连同临时目录一起收掉。全局安装、用户正在跑的 8900、Stream Desktop 的配对
 * 指针，一样都不动。
 *
 * 判据只认**副作用**：接口回来的真数据（认出的平台、真实的视频标题），不认「没报错」。
 * `--old` 给出时额外跑**负对照**：旧版必须拒装 `--probe` 那个包（宿主版本闸门），新版必须放行——
 * 只看新版放行证明不了闸门有牙（闸门没生效也会放行）。
 *
 * **加检查的规矩**：一个发版让用户多了一件能做的事，就在 CHECKS 里加一条——走用户会走的入口，
 * 断言它回来的真东西。检查失败时 `detail` 要写清楚看到的是什么，别只写「不对」。
 *
 * 退出码：0 全部通过；1 有检查失败；2 环境没备齐（装不上 / 起不来），检查根本没开跑。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const IS_WIN = process.platform === 'win32'
const REGISTRY = 'https://registry.npmjs.org/'

// ─── 参数 ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { probe: '@streamapp/bilibili@1.1.0', port: 8931, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') o.version = argv[++i]
    else if (a === '--old') o.old = argv[++i]
    else if (a === '--probe') o.probe = argv[++i]
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--keep') o.keep = true
    else throw new Error(`不认识的参数 ${a}`)
  }
  if (!o.version) throw new Error('必须给 --version <要验的 @streamapp/stream 版本>')
  return o
}

// ─── 装包 / 起后端 / 收后端 ──────────────────────────────────────

// 非交互 ssh 不读用户的 shell 配置：mac 上 node 装在 ~/node/bin，PATH 里根本没有它（`npm` 找不到、
// `exit null`——活体 2026-09-27）。npm 永远和正在跑的这个 node 装在同一个 bin 目录，就用它；这个目录
// 也要进子进程的 PATH（npm 脚本、node-gyp 现编 isolated-vm 都要找得到 node）。
const NODE_BIN_DIR = dirname(process.execPath)
const CHILD_ENV = { ...process.env, PATH: NODE_BIN_DIR + (IS_WIN ? ';' : ':') + (process.env.PATH ?? process.env.Path ?? '') }
const NPM = [join(NODE_BIN_DIR, IS_WIN ? 'npm.cmd' : 'npm')].find((p) => existsSync(p)) ?? 'npm'

function npmInstall(prefix, spec) {
  mkdirSync(prefix, { recursive: true })
  const args = ['i', '--prefix', prefix, spec, '--registry', REGISTRY, '--no-audit', '--no-fund']
  // Windows 上 npm 是 npm.cmd，必须经 shell 才起得来；经 shell 时给**一整条命令字符串**（数组 + shell 会报
  // DEP0190）。参数只有路径、包名、版本号，路径加引号防空格。
  const q = (a) => (/\s/.test(a) ? `"${a}"` : a)
  const r = IS_WIN
    ? spawnSync([NPM, ...args].map(q).join(' '), { shell: true, encoding: 'utf8', timeout: 600_000, env: CHILD_ENV })
    : spawnSync(NPM, args, { encoding: 'utf8', timeout: 600_000, env: CHILD_ENV })
  const installed = join(prefix, 'node_modules', '@streamapp', 'stream', 'package.json')
  if (!existsSync(installed)) {
    // status 为 null 时要么没起来（r.error），要么被超时杀了（r.signal）——两者都得说出来，别只给一个 null。
    const why = r.error ? `起不来：${r.error.message}` : r.signal ? `被 ${r.signal} 终止（超时？）` : `exit ${r.status}`
    throw new Error(`npm i ${spec} 没装上（${why}，用的是 ${NPM}）：${(r.stderr || r.stdout || '').slice(-600)}`)
  }
  return JSON.parse(readFileSync(installed, 'utf8')).version
}

async function startBackend(prefix, port, dataDir, logFile) {
  mkdirSync(dataDir, { recursive: true })
  const bin = join(prefix, 'node_modules', '@streamapp', 'stream', 'bin', 'stream.mjs')
  const log = openSync(logFile, 'w')
  const child = spawn(process.execPath, [bin, '--port', String(port), '--data', dataDir], {
    env: { ...CHILD_ENV, STREAM_NO_DESKTOP: '1', STREAM_DATA_DIR: dataDir },
    stdio: ['ignore', log, log],
    detached: !IS_WIN, // posix：自成进程组，收的时候连子孙一起收
  })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) return { child, base }
    } catch { /* 还没起来 */ }
    await new Promise((res) => setTimeout(res, 2000))
  }
  stopBackend(child)
  const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-1500) : ''
  throw new Error(`后端没起来（${child.exitCode !== null ? `进程已退出 ${child.exitCode}` : '4 分钟内 health 不应答'}）。日志尾：\n${tail}`)
}

/**
 * 验收后端会加载全部内置包，它的 standby 管家会 `adopt()` 机器上**正在跑**的同名插件容器、退出时 stop
 * 掉——那台机器自己那份 Stream 的容器就这样静默死了（docs/DEVELOPMENT.md "Start a Separate Backend for Smoke Tests/Verification"）。
 * 冒烟那条路的解法是把 packages_dir 指空，这里不行：验的正是内置包。所以有 `stream-*` 容器在跑就不开跑。
 * docker 不在 / 没起 → 没有可被 adopt 的东西，放行。
 */
function runningStreamContainers() {
  // docker 在 Windows 上是 docker.exe，不需要 shell。
  const r = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 20_000 })
  if (r.status !== 0) return []
  return (r.stdout || '').split(/\r?\n/).filter((n) => n.startsWith('stream-'))
}

function stopBackend(child) {
  if (!child || child.exitCode !== null) return
  // 后端会带出子进程（RSSHub worker、sidequest），只杀它自己会留孤儿。
  if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { encoding: 'utf8' })
  else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
}

// ─── 请求小工具 ───────────────────────────────────────────────────

async function getJson(base, path, timeoutMs = 60_000) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) })
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}

async function postJson(base, path, payload, timeoutMs = 120_000) {
  const r = await fetch(base + path, {
    method: 'POST',
    // 访问控制按 Origin 判同源，本机页面发的请求就带这个。
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}

function splitSpec(spec) {
  const at = spec.lastIndexOf('@')
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: undefined }
}

// JSON.stringify(undefined) 是 undefined 不是字符串——缺字段时照样要能写进 detail。
const short = (v) => String(JSON.stringify(v) ?? v).slice(0, 240)

// ─── 检查清单（新版） ─────────────────────────────────────────────
// 每条：name（一句话说验什么）、network（true = 要打外网，失败时报告里单独标出来）、run → { ok, detail }。

const CHECKS = [
  {
    name: '后端健康',
    run: async (ctx) => {
      const { body } = await getJson(ctx.base, '/api/health')
      return { ok: body?.ok === true, detail: short(body) }
    },
  },
  {
    name: '装上的就是要验的版本',
    run: async (ctx) => ({ ok: ctx.installedVersion === ctx.opts.version, detail: `装上的 ${ctx.installedVersion}，要验的 ${ctx.opts.version}` }),
  },
  {
    name: '原生依赖能加载（better-sqlite3 / sharp）',
    run: async (ctx) => {
      const probe = join(ctx.newPrefix, 'native-probe.cjs')
      writeFileSync(probe, [
        "const D = require('better-sqlite3'); const db = new D(':memory:');",
        "const x = db.prepare('select 1 as x').get().x;",
        "const s = typeof require('sharp');",
        "console.log(JSON.stringify({ sqlite: x, sharp: s }))",
      ].join('\n'))
      const r = spawnSync(process.execPath, [probe], { cwd: ctx.newPrefix, encoding: 'utf8', timeout: 60_000 })
      const out = (r.stdout || '').trim()
      return { ok: r.status === 0 && out.includes('"sqlite":1') && out.includes('"sharp":"function"'), detail: out || (r.stderr || '').slice(-300) }
    },
  },
  {
    // 内置 recipe 的 compute 段（音乐搜索 / 下载 / 歌单、网盘分享验活）全靠它；它只被动态 import，缺了后端
    // 照样起、这一格照样静默失败——0.0.26 就这样漏出去过（活体 2026-09-27，Mac 订歌单报错）。
    // 单列一条：Intel Mac / Node 20 没有预编译件，现编失败时报告里直接点名是它。
    name: 'recipe 沙箱能跑（isolated-vm）',
    run: async (ctx) => {
      const probe = join(ctx.newPrefix, 'ivm-probe.cjs')
      writeFileSync(probe, [
        "const ivm = require('isolated-vm');",
        'const iso = new ivm.Isolate({ memoryLimit: 16 });',
        'const v = iso.compileScriptSync("[1,2,3].map(x => x * 2).join(\',\')").runSync(iso.createContextSync());',
        'console.log(JSON.stringify({ ran: v }))',
      ].join('\n'))
      // 从发行包自己的目录解析：它是 @streamapp/stream 的依赖，装在它的 node_modules 里。
      const pkgDir = join(ctx.newPrefix, 'node_modules', '@streamapp', 'stream')
      const r = spawnSync(process.execPath, [probe], { cwd: pkgDir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_PATH: join(pkgDir, 'node_modules') + (IS_WIN ? ';' : ':') + join(ctx.newPrefix, 'node_modules') } })
      const out = (r.stdout || '').trim()
      return { ok: r.status === 0 && out.includes('"ran":"2,4,6"'), detail: out || (r.stderr || '').split('\n').find((l) => /Error|Cannot find/.test(l)) || (r.stderr || '').slice(-300) }
    },
  },
  {
    name: '宿主版本闸门放行新包（预检安装）',
    network: true,
    run: async (ctx) => {
      const { name, version } = splitSpec(ctx.opts.probe)
      const { status, body } = await postJson(ctx.base, '/api/recipes/packages/preview', { name, ...(version ? { version } : {}) })
      return { ok: status === 200 && typeof body?.confirm === 'string', detail: `HTTP ${status} ${short(body?.error ?? { name: body?.name, version: body?.version })}` }
    },
  },
  {
    name: '链接认领：视频链接认出平台',
    run: async (ctx) => {
      const url = 'https://www.bilibili.com/video/BV1GJ411x7h7'
      const { body } = await getJson(ctx.base, `/api/links/recognize?url=${encodeURIComponent(url)}`)
      return { ok: body?.platform === 'bilibili', detail: short(body) }
    },
  },
  {
    name: '链接认领：曲目链接认出类型与 id',
    run: async (ctx) => {
      const url = 'https://music.163.com/#/song?id=186016'
      const { body } = await getJson(ctx.base, `/api/links/recognize?url=${encodeURIComponent(url)}`)
      return { ok: body?.kind === 'track' && body?.id === '186016', detail: short(body) }
    },
  },
  {
    name: '贴链接取媒体（按认领结果派发给包）',
    network: true,
    run: async (ctx) => {
      const url = 'https://www.bilibili.com/video/BV1GJ411x7h7'
      const { body } = await getJson(ctx.base, `/api/media/from-url?url=${encodeURIComponent(url)}`, 90_000)
      const n = Array.isArray(body?.media) ? body.media.length : 0
      return { ok: n > 0 && !!body?.title, detail: `media ${n} 条，title=${body?.title ?? '—'}${body?.error ? `，error=${body.error}` : ''}` }
    },
  },
  {
    name: '网盘底座包带 role',
    run: async (ctx) => {
      const { body } = await getJson(ctx.base, '/api/packages')
      const list = Array.isArray(body) ? body : (body?.packages ?? [])
      const base = list.filter((p) => p?.role === 'netdisk-base').map((p) => p.id)
      return { ok: base.length === 1, detail: `role=netdisk-base 的包：${base.join(',') || '无'}` }
    },
  },
  {
    name: '归包后的成员都解析得到',
    run: async (ctx) => {
      const { body } = await getJson(ctx.base, '/api/providers')
      const text = JSON.stringify(body)
      const want = ['@streamapp/omdb/omdb-metadata', '@streamapp/cloudflare/cf-whisper', '@streamapp/xunlei/xunlei-subtitle', '@streamapp/shooter/shooter-subtitle']
      const missing = want.filter((id) => !text.includes(`"id":"${id}"`))
      const subtitleRow = text.includes('"id":"subtitle-search"')
      return { ok: missing.length === 0 && subtitleRow, detail: `缺：${missing.join(', ') || '无'}；subtitle-search 行：${subtitleRow ? '在' : '不在'}` }
    },
  },
  {
    name: '转换能力口应答',
    run: async (ctx) => {
      const { status, body } = await getJson(ctx.base, '/api/conversion-kinds')
      const kinds = Array.isArray(body?.items) ? body.items.map((k) => k?.kind ?? k?.id).filter(Boolean) : []
      return { ok: status === 200 && kinds.length > 0, detail: `HTTP ${status}，能力：${kinds.join(', ') || short(body)}` }
    },
  },
]

// ─── 负对照（旧版） ───────────────────────────────────────────────

async function negativeControl(ctx, oldBase) {
  const { name, version } = splitSpec(ctx.opts.probe)
  const { status, body } = await postJson(oldBase, '/api/recipes/packages/preview', { name, ...(version ? { version } : {}) })
  const msg = typeof body?.error?.message === 'string' ? body.error.message : short(body)
  // 必须是**因为宿主版本**被拒——别的原因（网络、包名打错）拒了不算闸门有牙。
  return { ok: status === 400 && /hostVersion|宿主版本/.test(msg), detail: `HTTP ${status} ${msg}` }
}

// ─── 主流程 ───────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  // 在建任何东西之前判：这里退出不需要收尾。
  const busy = runningStreamContainers()
  if (busy.length) {
    console.error(`这台机器上有 Stream 插件容器在跑（${busy.join(', ')}）：验收后端会接管并在退出时停掉它们。先停掉那份 Stream 或换一台机器。`)
    process.exit(2)
  }
  const work = mkdtempSync(join(tmpdir(), 'stream-release-verify-'))
  const results = []
  const record = (name, r, network = false) => {
    results.push({ name, network, ...r })
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}${network ? '（外网）' : ''}\n      ${r.detail}`)
  }
  let exitCode = 0
  let newChild, oldChild
  try {
    console.log(`# 发版验收 @streamapp/stream@${opts.version}  平台 ${process.platform}-${process.arch}  node ${process.version}`)
    console.log(`# 工作目录 ${work}（${opts.keep ? '保留' : '结束后删除'}）\n`)

    const newPrefix = join(work, 'new')
    let installedVersion
    try {
      installedVersion = npmInstall(newPrefix, `@streamapp/stream@${opts.version}`)
      const started = await startBackend(newPrefix, opts.port, join(work, 'data-new'), join(work, 'new-backend.log'))
      newChild = started.child
      const ctx = { opts, base: started.base, newPrefix, installedVersion }
      for (const c of CHECKS) {
        let r
        try { r = await c.run(ctx) } catch (e) { r = { ok: false, detail: `抛错：${e.message}` } }
        record(c.name, r, !!c.network)
      }
    } catch (e) {
      console.error(`\n环境没备齐：${e.message}`)
      exitCode = 2
    }
    stopBackend(newChild)

    if (opts.old && exitCode !== 2) {
      const oldPrefix = join(work, 'old')
      try {
        npmInstall(oldPrefix, `@streamapp/stream@${opts.old}`)
        const started = await startBackend(oldPrefix, opts.port + 1, join(work, 'data-old'), join(work, 'old-backend.log'))
        oldChild = started.child
        let r
        try { r = await negativeControl({ opts }, started.base) } catch (e) { r = { ok: false, detail: `抛错：${e.message}` } }
        record(`负对照：旧版 ${opts.old} 拒装 ${opts.probe}`, r, true)
      } catch (e) {
        console.error(`\n负对照的旧版没备齐：${e.message}`)
        exitCode = 2
      }
      stopBackend(oldChild)
    }

    const failed = results.filter((r) => !r.ok)
    if (exitCode === 0 && failed.length) exitCode = 1
    console.log(`\n# ${results.length - failed.length}/${results.length} 通过${failed.some((f) => f.network) ? '（失败项里有要打外网的，先排除网络）' : ''}`)
    // 最后一行是机器读的：远端跑时开发机据此判结果。
    console.log(`RESULT ${JSON.stringify({ version: opts.version, platform: `${process.platform}-${process.arch}`, exitCode, results })}`)
  } finally {
    stopBackend(newChild)
    stopBackend(oldChild)
    if (!opts.keep) {
      // Windows 上刚被杀的进程可能还攥着文件句柄，删不掉就留着并说一声，别让清理失败盖掉验收结果。
      try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }) } catch (e) { console.error(`临时目录没删干净：${work}（${e.message}）`) }
    }
  }
  process.exit(exitCode)
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2) })
