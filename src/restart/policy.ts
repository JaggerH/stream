import { spawn as nodeSpawn } from 'node:child_process'
import { utimesSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 有监护者时用它退出：systemd `Restart=always` 什么码都拉起，`stream mcp` 壳只认这个码（崩溃不该循环拉起）。 */
export const RESTART_EXIT_CODE = 75
/** `supervised`：优雅关后以 75 退出，监护者拉起；`reexec`：前台跑的自己再起一份；
 *  `watch`：`tsx watch` 之类的文件监视器养着——它**不看退出码**（子进程退了就不再拉起、直到下一次文件改动），
 *  所以不能自己退，只能碰一下哨兵文件、让监视器按"文件变了"那条路来重启。 */
export type RestartMode = 'supervised' | 'reexec' | 'watch'
const RESTART_MODES: readonly RestartMode[] = ['supervised', 'reexec', 'watch']

/** 谁拉起的我。显式 `STREAM_RESTART_MODE` 优先（值不认识就当没设）；否则自动判：systemd 注入 INVOCATION_ID、
 *  `stream mcp` 壳与其他 supervisor 传 STREAM_SUPERVISED=1 → supervised；都没有 = 用户前台跑的 → reexec。
 *  为什么要有显式一档：`INVOCATION_ID` 会被 systemd 用户服务拉起的 scope / 终端**继承**——`systemd-run --user --scope`
 *  里跑 `pnpm dev` 就会被误判成 supervised，退 75 之后 `tsx watch` 不拉起，后端就死到下一次改文件为止。 */
export function classifyLauncher(env: NodeJS.ProcessEnv): RestartMode {
  const explicit = env.STREAM_RESTART_MODE
  if (explicit && (RESTART_MODES as readonly string[]).includes(explicit)) return explicit as RestartMode
  if (env.INVOCATION_ID || env.STREAM_SUPERVISED === '1') return 'supervised'
  return 'reexec'
}

/** `watch` 档的哨兵：仓库根下的 `restart-sentinel`（`scripts/dev.sh` 用 `--include` 把它交给 `tsx watch`）。
 *  **不能是 dotfile**：tsx 的 watcher 固定 `ignored: ['**\/.*', ...]`，`.restart-sentinel` 即使写进 `--include`
 *  碰了也没反应（实测 2026-09-21）。路径按源码位置算——watch 档只在 dev.sh 下有意义，打进 dist 的那份用不到它。 */
export const RESTART_SENTINEL = fileURLToPath(new URL('../../restart-sentinel', import.meta.url))

/** 碰一下哨兵：有就改 mtime，没有就建（chokidar 的 add 与 change 都触发重启，实测一样）。 */
export function touchRestartSentinel(path: string = RESTART_SENTINEL): void {
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    writeFileSync(path, `${now.toISOString()}\n`)
  }
}

/** 前台跑的自己再起一份：同一个 node、同一串 execArgv（dev 是 `tsx`，丢了它裸 node 起不了 .ts）、
 *  同一串参数、继承终端；detached + unref，父进程退了它还活着。
 *  这里**不负责**释放锁和端口——那是调用方的事：必须放在 `shutdownThen` 的 finale 里，
 *  即 HTTP server 的 effect 已 close、`releaseLock()` 已跑之后，否则新的一份撞 acquireLock / EADDRINUSE。 */
export function reexecSelf(deps: { spawn?: typeof nodeSpawn; execPath?: string; execArgv?: string[]; argv?: string[]; env?: NodeJS.ProcessEnv } = {}): void {
  const spawn = deps.spawn ?? nodeSpawn
  const argv = deps.argv ?? process.argv
  const execArgv = deps.execArgv ?? process.execArgv
  const child = spawn(deps.execPath ?? process.execPath, [...execArgv, ...argv.slice(1)], { detached: true, stdio: 'inherit', env: deps.env ?? process.env })
  child.unref()
}
