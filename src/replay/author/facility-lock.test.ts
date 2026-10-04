import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { acquireFacilityLock, isFacilityLocked } from './facility-lock.ts'

describe('facility lock', () => {
  async function tmpRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'stream-facility-lock-'))
  }

  it('acquires and releases a facility lock', async () => {
    const root = await tmpRoot()
    const lock = await acquireFacilityLock(root, 'xhs')
    const payload = JSON.parse(await readFile(join(root, 'xhs.lock'), 'utf8'))
    expect(payload.pid).toBe(process.pid)
    expect(typeof payload.startedAt).toBe('string')
    expect(isFacilityLocked(root, 'xhs')).toBe(true)

    await lock.release()
    expect(isFacilityLocked(root, 'xhs')).toBe(false)
  })

  it('fails loudly when a live pid owns the lock', async () => {
    const root = await tmpRoot()
    const first = await acquireFacilityLock(root, 'xhs')
    await expect(acquireFacilityLock(root, 'xhs')).rejects.toThrow(String(process.pid))
    await first.release()
  })

  it('steals a stale lock and warns', async () => {
    const root = await tmpRoot()
    await writeFile(join(root, 'xhs.lock'), JSON.stringify({ pid: 999_999_999, startedAt: new Date(0).toISOString() }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const lock = await acquireFacilityLock(root, 'xhs')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale'))
    expect(isFacilityLocked(root, 'xhs')).toBe(true)
    await lock.release()
    warn.mockRestore()
  })

  it('makes release idempotent', async () => {
    const root = await tmpRoot()
    const lock = await acquireFacilityLock(root, 'xhs')

    await lock.release()
    await lock.release()

    expect(isFacilityLocked(root, 'xhs')).toBe(false)
  })
})
