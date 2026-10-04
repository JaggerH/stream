import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeFormat } from './format-probe.ts'

const execFileP = promisify(execFile)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'format-probe-test-'))
}, 20000)

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('probeFormat', () => {
  it('detects a flac file correctly regardless of what its extension claims', async () => {
    // 文件名故意叫 .mp3——探测认内容不认后缀,这正是要验证的行为
    const path = join(dir, 'fake.mp3')
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'flac', '-f', 'flac', path])
    expect(await probeFormat(path)).toBe('flac')
  })

  it('detects an mp3 file correctly', async () => {
    const path = join(dir, 'real.mp3')
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'libmp3lame', path])
    expect(await probeFormat(path)).toBe('mp3')
  })

  it('normalizes MP4-family container candidate lists down to m4a', async () => {
    const path = join(dir, 'test.m4a')
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'aac', path])
    expect(await probeFormat(path)).toBe('m4a')
  })

  it('returns null for a nonexistent file instead of throwing', async () => {
    expect(await probeFormat(join(dir, 'nope.flac'))).toBeNull()
  })

  it('returns null for a file that is not valid audio', async () => {
    const path = join(dir, 'garbage.flac')
    await execFileP('bash', ['-c', `echo "not audio" > "${path}"`])
    expect(await probeFormat(path)).toBeNull()
  })
})
