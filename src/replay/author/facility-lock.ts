import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processExitHooks, type ExitHooks } from '../../exit-hooks.ts'

interface LockPayload {
  pid: number
  startedAt: string
}

export interface FacilityLock {
  readonly path: string
  release(): Promise<void>
}

class FacilityLockImpl implements FacilityLock {
  released = false
  /** 进程要走时也删掉锁文件（经调用方递的 exit hooks；runtime 的那份随 runtime 关）。 */
  unhook: () => void = () => {}

  constructor(readonly path: string) {}

  async release(): Promise<void> {
    this.releaseSync()
  }

  releaseSync(): void {
    if (this.released) return
    this.released = true
    this.unhook()
    try {
      unlinkSync(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readPayload(path: string): LockPayload | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockPayload
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

/**
 * `exitHooks`：进程要走时谁来删这把锁。实例从自己的 runtime 递（库入口不挂进程信号，runtime 关时收）；
 * 缺省 = 挂在真进程上的那一份（authoring CLI 的行为）。
 */
export async function acquireFacilityLock(
  profilesRoot: string,
  facility: string,
  exitHooks: ExitHooks = processExitHooks(),
): Promise<FacilityLock> {
  mkdirSync(profilesRoot, { recursive: true })
  const path = join(profilesRoot, `${facility}.lock`)
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)

  while (true) {
    try {
      writeFileSync(path, payload, { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const existing = readPayload(path)
      if (existing?.pid && isPidAlive(existing.pid)) {
        throw new Error(`Facility ${facility} is already locked by pid ${existing.pid}`)
      }
      if (existing?.pid) {
        console.warn(`Facility ${facility} lock is stale (pid ${existing.pid}); stealing lock`)
      }
      unlinkSync(path)
    }
  }

  const lock = new FacilityLockImpl(path)
  lock.unhook = exitHooks.add(() => lock.releaseSync())
  return lock
}

export function isFacilityLocked(profilesRoot: string, facility: string): boolean {
  const path = join(profilesRoot, `${facility}.lock`)
  const existing = readPayload(path)
  return Boolean(existing?.pid && isPidAlive(existing.pid))
}
