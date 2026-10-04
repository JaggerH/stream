#!/usr/bin/env node
/**
 * 冒烟：managed 档在这台机器上走不走得通——不需要 Stream 后端，造一个最小的 `CapabilityContext`
 * 调 `capability.mount()`，然后真调一次 `netdisk_play_link`（它是唯一会触发「判归属 → 拉容器 →
 * 接管 → 挂载」整条链的动词）。
 *
 * 这里刻意 import **产物**而不是 `src/index.ts`：装到用户机器上被后端 import 的就是这一个文件，
 * 而它必须自包含（`<dataDir>/recipes/<包>/` 下没有 node_modules）。跑源码验不到"打漏了一个
 * 相对 import"这件事，那正是这条冒烟最该抓的。
 *
 *   node_modules/.bin/tsdown                                   # 先构建 dist/（脚本跑的是产物）
 *   node scripts/smoke-managed.mjs [--data-dir <dir>] [--path </quark/x.mkv>] [--idle-minutes <n>]
 *
 * 读结果看两处：`[stream-netdisk]` 那几行日志（归属 / 容器 / 接管 / 挂载各一句），以及最后打出的
 * 动词返回值。**同机跑着 Stream 时预期就是让位**（reason 里点名 Stream 的容器）——那不是失败，是阶段 6。
 *
 * ⚠️ 没有 Stream 的机器上跑它会**真的拉镜像、建容器、改 admin 密码、往 `<data-dir>/openlist.json` 写凭证**。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i === -1 ? dflt : args[i + 1]
}
const dataDir = flag('--data-dir', join(process.env.HOME ?? '.', '.stream-netdisk-plugin'))
const path = flag('--path', '/')
const idleMinutes = Number(flag('--idle-minutes', '240'))
// `--ignore-owner`：同机跑着 Stream 也不让位，真走一遍拉容器 → 接管 → 挂载。会在本机多出一个
// `stream-netdisk-openlist` 容器 + `netdisk-openlist-data` 卷，验完自己 `docker rm -f` / `docker volume rm`。
const ignoreOwner = args.includes('--ignore-owner')

const here = dirname(fileURLToPath(import.meta.url))
const { capability } = await import(join(here, '..', 'dist', 'index.js'))

const tools = new Map()
const disposers = []
/** 最小 `CapabilityContext`（`shared/capability/types.ts` 的七格），够跑一遍 mount。 */
const ctx = {
  dataDir,
  log: {
    info: (m) => console.error(`[stream-netdisk] ${m}`),
    warn: (m) => console.error(`[stream-netdisk] ${m}`),
  },
  // streamBrowserCookies：这台最小宿主没有后端挂的那份服务，`require` 永远回 undefined——
  // 能力体必须照常挂动词，要登录态的那几个回「失败 + 指路」。
  require: () => undefined,
  provide: () => {},
  registerTools: (defs) => {
    for (const def of defs) tools.set(def.name, def)
  },
  destructiveGate: 'none',
  onDispose: (fn) => disposers.push(fn),
}

await capability.mount(ctx, { dataDir, managed: { idleMinutes, ...(ignoreOwner ? { ignoreOwner: true } : {}) } })
console.log(`[smoke] 挂上的动词：${[...tools.keys()].join(', ') || '（一个都没有）'}`)
const verb = tools.get('netdisk_play_link')
if (!verb) {
  console.log('[smoke] netdisk_play_link 没挂上（看上面的日志）')
  process.exit(2)
}
console.log(`[smoke] 调 netdisk_play_link { path: ${JSON.stringify(path)} } ——这一步会走完 managed 档整条链`)
const result = await verb.execute({ path })
console.log('[smoke] 返回：', JSON.stringify(result, null, 2))
for (let i = disposers.length - 1; i >= 0; i--) await disposers[i]()
process.exit(result && result.ok === false ? 1 : 0)
