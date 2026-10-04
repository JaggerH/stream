import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planAudioWindows, planSttChunks } from './audio-windows.ts'

const execFileP = promisify(execFile)

let dir: string
let sine25s: Uint8Array
let sine5s: Uint8Array

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audio-windows-test-'))
  const p25 = join(dir, 'sine25.wav')
  const p5 = join(dir, 'sine5.wav')
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=25', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', p25])
  await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', p5])
  const { readFile } = await import('node:fs/promises')
  sine25s = await readFile(p25)
  sine5s = await readFile(p5)
}, 30000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** RIFF/WAVE 魔数校验——够用了，不必解析完整 wav 头。 */
function isWav(bytes: Uint8Array): boolean {
  const s = Buffer.from(bytes.slice(0, 12)).toString('ascii')
  return s.startsWith('RIFF') && s.slice(8, 12) === 'WAVE'
}

async function ffprobeDurationS(bytes: Uint8Array, tmpDir: string): Promise<number> {
  const p = join(tmpDir, `probe-${Math.random().toString(36).slice(2)}.wav`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(p, bytes)
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p])
  return Number(stdout.trim())
}

describe('planAudioWindows', () => {
  it('25s @ windowS=10/overlapS=2 → 3 windows with startS=[0,8,16], each ≤10s, valid wav', async () => {
    const { windows, totalS } = await planAudioWindows(sine25s, 'audio/wav', { windowS: 10, overlapS: 2, tmpDir: dir })
    expect(totalS).toBeCloseTo(25, 0)
    expect(windows.map((w) => w.index)).toEqual([0, 1, 2])
    expect(windows.map((w) => w.startS)).toEqual([0, 8, 16])
    for (const w of windows) {
      expect(w.durS).toBeLessThanOrEqual(10)
      expect(isWav(w.bytes)).toBe(true)
      const measured = await ffprobeDurationS(w.bytes, dir)
      expect(measured).toBeCloseTo(w.durS, 1)
    }
    // 最后一窗不足 windowS：16..25 只有 9s
    expect(windows[2].durS).toBeCloseTo(9, 0)
  })

  it('total ≤ windowS → single window, bytes equivalent to whole-track extraction (duration match)', async () => {
    const { windows, totalS } = await planAudioWindows(sine5s, 'audio/wav', { windowS: 10, overlapS: 2, tmpDir: dir })
    expect(windows).toHaveLength(1)
    expect(windows[0].index).toBe(0)
    expect(windows[0].startS).toBe(0)
    expect(isWav(windows[0].bytes)).toBe(true)
    const measured = await ffprobeDurationS(windows[0].bytes, dir)
    expect(measured).toBeCloseTo(totalS, 1)
    expect(totalS).toBeCloseTo(5, 0)
  })

  it('abort signal aborts the run', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      planAudioWindows(sine25s, 'audio/wav', { windowS: 10, overlapS: 2, tmpDir: dir, signal: ctrl.signal }),
    ).rejects.toThrow()
  })
})

/** ffprobe an aac/m4a chunk buffer. */
async function ffprobeM4aDurationS(bytes: Uint8Array, tmpDir: string): Promise<number> {
  const p = join(tmpDir, `probe-${Math.random().toString(36).slice(2)}.m4a`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(p, bytes)
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', p])
  return Number(stdout.trim())
}

describe('planSttChunks', () => {
  it('compressed size ≤ maxBytes → single chunk at startS 0 (m4a, whole duration)', async () => {
    // 25s @ 32kbps m4a ≈ 100KB; a generous maxBytes keeps it a single upload.
    const chunks = await planSttChunks(sine25s, 'audio/wav', { maxBytes: 10 * 1024 * 1024, chunkS: 600, tmpDir: dir })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].startS).toBe(0)
    // the chunk declares what it really is — the uploader builds filename/mime from this
    expect(chunks[0].format).toEqual({ ext: 'm4a', mime: 'audio/mp4' })
    const measured = await ffprobeM4aDurationS(chunks[0].bytes, dir)
    expect(measured).toBeCloseTo(25, 0)
  })

  it('compressed size > maxBytes → non-overlapping chunkS-second chunks with rising startS offsets', async () => {
    // Force the split path with a tiny maxBytes; chunkS=10 over 25s → startS [0,10,20], last is 5s.
    const chunks = await planSttChunks(sine25s, 'audio/wav', { maxBytes: 1, chunkS: 10, tmpDir: dir })
    expect(chunks.map((c) => c.startS)).toEqual([0, 10, 20])
    expect(chunks.every((c) => c.format.ext === 'm4a' && c.format.mime === 'audio/mp4')).toBe(true)
    // no overlap: each chunk covers [startS, startS+chunkS); last is the remainder (~5s)
    const last = await ffprobeM4aDurationS(chunks[2].bytes, dir)
    expect(last).toBeCloseTo(5, 0)
    const first = await ffprobeM4aDurationS(chunks[0].bytes, dir)
    expect(first).toBeCloseTo(10, 0)
  })

  it('abort signal aborts the run', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      planSttChunks(sine25s, 'audio/wav', { maxBytes: 1, chunkS: 10, tmpDir: dir, signal: ctrl.signal }),
    ).rejects.toThrow()
  })
})
