/**
 * 数据目录锁（design D2）：一个数据目录同一时刻只许一份内核在写。
 *
 * 两层判据，各管一件事：
 * - **本进程**：`held` 记着本进程已经拿下的目录（按 realpath）。同进程第二次 `createStream` 同一个目录直接抛——
 *   两棵内核开同一组 sqlite，WAL 不会替你吵，表现只是数据被交错写坏。这张表是进程级的，而它本来就该是：它答的正是
 *   「这个进程里有没有别人」。
 * - **跨进程**：`<dir>/engine.lock` 记 `<pid> <starttime>`。持有者还活着（pid 在、出生时刻对得上）就抛；
 *   持有者已经死了（崩溃没来得及删）就接管——锁文件残留不该让下一次启动起不来。
 *
 * 释放只删自己写的那一份（比 pid），别把接管了它的下一任的锁删掉。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pidAlive, pidStartTime } from '../proc-identity.ts'

export const LOCK_NAME = 'engine.lock'

const held = new Set<string>()

/** 锁文件里那个 pid 还是不是当初写它的那个进程。读不到出生时刻（老格式 / 非 Linux）就只看活不活。 */
function ownerAlive(raw: string): number | undefined {
  const [pidStr, recordedStart] = raw.trim().split(/\s+/)
  const pid = Number(pidStr)
  if (!pid || pid === process.pid || !pidAlive(pid)) return undefined
  if (recordedStart) {
    const live = pidStartTime(pid)
    if (live != null && live !== recordedStart) return undefined
  }
  return pid
}

/** 拿下 `dir` 的锁；回一个释放函数（幂等）。拿不到就抛，说清是谁占着。 */
export function lockDataDir(dir: string): () => void {
  mkdirSync(dir, { recursive: true })
  const real = realpathSync(dir)
  if (held.has(real)) {
    throw new Error(`数据目录 ${dir} 已被本进程里的另一个 Stream 实例占用：一个数据目录只能有一个实例，给每个实例一个自己的目录`)
  }
  const file = join(real, LOCK_NAME)
  const stamp = `${process.pid} ${pidStartTime(process.pid) ?? ''}`.trim()
  try {
    const fd = openSync(file, 'wx')
    try { writeSync(fd, stamp) } finally { closeSync(fd) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    let raw = ''
    try { raw = readFileSync(file, 'utf8') } catch { /* 读不到就当残留 */ }
    const owner = ownerAlive(raw)
    if (owner !== undefined) {
      throw new Error(`数据目录 ${dir} 已被进程 ${owner} 里的 Stream 实例占用（${file}）`)
    }
    // 持有者已经不在了：残留的锁，接管。
    writeFileSync(file, stamp)
  }
  held.add(real)
  let released = false
  return () => {
    if (released) return
    released = true
    held.delete(real)
    try {
      if (existsSync(file) && Number(readFileSync(file, 'utf8').trim().split(/\s+/)[0]) === process.pid) unlinkSync(file)
    } catch { /* 尽力 */ }
  }
}
