// src/proc-identity.ts
//
// 「pidfile 里那个 pid,还是不是当初那个进程」「这个口是谁占着的」——跨重启认尸的最小判据集。
// 消费者:serve.ts 自己的启动锁(防双开)。判据的要点只有一条:**pid 会被复用,单看 alive 不够**,
// 要配上 /proc/<pid>/stat 的 starttime(field 22)——复用的 pid 一定有不同的出生时刻。
// /proc 不可读的平台(mac/win)退回 null,由调用方决定保守到哪一档。
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

/** 这个 pid 此刻有没有进程活着(信号 0 探测;EPERM 也算活着)。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 进程的出生时刻(开机以来的 clock ticks,/proc/<pid>/stat 第 22 格);/proc 不可读 → null。
 *  comm(第 2 格)自身可含空格与括号,必须从最后一个 ')' 之后再切。 */
export function pidStartTime(pid: number, readStat = (p: number) => readFileSync(`/proc/${p}/stat`, 'utf8')): string | null {
  try {
    const stat = readStat(pid)
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return fields[19] ?? null // 整体第 22 格 = 去掉 pid+comm 之后的下标 19
  } catch {
    return null
  }
}

/**
 * 「这个口是谁占着的」——固定口撞占用时,把占口进程说出来。
 *
 * 存在的理由是**错误消息把人指向了错的方向**:只说「8901 被占用」时,最自然的推断是"被别的
 * 什么东西抢了",于是去翻插件产物、翻配置;而真凶常常就是上一代自己留下的子进程。人能
 * `ss -ltnp` 查出来的东西,错误消息自己完全有能力说清。
 *
 * 纯 /proc,不外调 `ss`(容器里未必有):监听表里按本地口找 socket inode,再扫 `/proc/*​/fd`
 * 找谁持着它。查不到就是 null——**别猜**:非本用户的进程 fd 读不到(EACCES),那时候诚实地
 * 少说一句,好过报一个错的 pid。
 */
export function portHolder(
  port: number,
  read = (p: string) => readFileSync(p, 'utf8'),
  listDirs = (p: string) => readdirSync(p),
  readLink = (p: string) => readlinkSync(p),
): { pid: number; cmdline: string | null } | null {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw: string
    try {
      raw = read(table)
    } catch {
      continue
    }
    for (const line of raw.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      // 0:sl 1:local_address 3:st(0A=LISTEN) 9:inode
      if (f.length < 10 || f[3] !== '0A') continue
      if (!f[1]?.endsWith(`:${hexPort}`)) continue
      if (f[9]) inodes.add(f[9])
    }
  }
  if (inodes.size === 0) return null
  const wanted = new Set([...inodes].map((i) => `socket:[${i}]`))
  let pids: string[]
  try {
    pids = listDirs('/proc').filter((n) => /^\d+$/.test(n))
  } catch {
    return null
  }
  for (const pid of pids) {
    let fds: string[]
    try {
      fds = listDirs(`/proc/${pid}/fd`)
    } catch {
      continue // 别人的进程,读不到——不猜
    }
    for (const fd of fds) {
      let link: string
      try {
        link = readLink(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      if (wanted.has(link)) return { pid: Number(pid), cmdline: pidCmdline(Number(pid)) }
    }
  }
  return null
}

/** 进程的完整 cmdline(NUL 分隔转空格);/proc 不可读 → null。 */
export function pidCmdline(pid: number, readCmdline = (p: number) => readFileSync(`/proc/${p}/cmdline`, 'utf8')): string | null {
  try {
    return readCmdline(pid).replaceAll('\0', ' ')
  } catch {
    return null
  }
}
