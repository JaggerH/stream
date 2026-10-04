import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface LockPayload {
  pid: number
  startedAt: string
}

export interface FacilityLock {
  readonly path: string
  release(): Promise<void>
}

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const activeLocks = new Set<FacilityLockImpl>()
let handlersInstalled = false

class FacilityLockImpl implements FacilityLock {
  released = false

  constructor(readonly path: string) {}

  async release(): Promise<void> {
    this.releaseSync()
  }

  releaseSync(): void {
    if (this.released) return
    this.released = true
    activeLocks.delete(this)
    try {
      unlinkSync(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

function installSignalHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true
  for (const sig of signals) {
    process.once(sig, () => {
      for (const lock of [...activeLocks]) lock.releaseSync()
    })
  }
  process.once('exit', () => {
    for (const lock of [...activeLocks]) lock.releaseSync()
  })
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

export async function acquireFacilityLock(profilesRoot: string, facility: string): Promise<FacilityLock> {
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
  activeLocks.add(lock)
  installSignalHandlers()
  return lock
}

export function isFacilityLocked(profilesRoot: string, facility: string): boolean {
  const path = join(profilesRoot, `${facility}.lock`)
  const existing = readPayload(path)
  return Boolean(existing?.pid && isPidAlive(existing.pid))
}
