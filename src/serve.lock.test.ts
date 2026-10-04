import { describe, it, expect } from 'vitest'
import { lockPidIsServe, pidStartTime, lockIsSameProcess } from './serve.ts'

describe('lockPidIsServe', () => {
  it('returns true when cmdline contains serve.ts', () => {
    const readCmdline = (pid: number) => `node /path/to/serve.ts`
    expect(lockPidIsServe(1234, readCmdline)).toBe(true)
  })

  it('returns false when cmdline is another process', () => {
    const readCmdline = (pid: number) => `nginx: master process`
    expect(lockPidIsServe(1234, readCmdline)).toBe(false)
  })

  it('returns true when readCmdline throws an error', () => {
    const readCmdline = (pid: number) => {
      throw new Error('ENOENT')
    }
    expect(lockPidIsServe(1234, readCmdline)).toBe(true)
  })
})

describe('pidStartTime', () => {
  // field 2 (comm) can contain spaces and parens — everything must be parsed after the LAST ')'
  const stat = (start: string) =>
    `60 (node (weird)) S 1 60 60 0 -1 4194304 1 2 3 4 5 6 7 8 20 0 11 0 ${start} 12345 678`

  it('reads the start time (field 22) past a comm containing spaces and parens', () => {
    expect(pidStartTime(60, () => stat('998877'))).toBe('998877')
  })

  it('returns null when /proc is unreadable', () => {
    expect(pidStartTime(60, () => { throw new Error('ENOENT') })).toBeNull()
  })
})

describe('lockIsSameProcess', () => {
  it('is NOT the same process when the pid was reused (different start time)', () => {
    // the exact docker-restart case: the lock recorded pid 60, and pid 60 is live again — but as a
    // different process. Treating it as the live owner is what made serve refuse to start.
    expect(lockIsSameProcess(60, '111', () => '999')).toBe(false)
  })

  it('is the same process when the start time matches', () => {
    expect(lockIsSameProcess(60, '111', () => '111')).toBe(true)
  })

  it('falls back to assuming same-process for a legacy lock with no start time', () => {
    expect(lockIsSameProcess(60, undefined, () => '999')).toBe(true)
  })

  it('falls back to assuming same-process when /proc is unreadable', () => {
    expect(lockIsSameProcess(60, '111', () => null)).toBe(true)
  })
})
