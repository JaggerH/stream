import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeStreams, extractStream } from './extract.ts'

const execFileP = promisify(execFile)

let dir: string
let fixture: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'extract-test-'))
  const srtPath = join(dir, 'sub.srt')
  await writeFile(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nhello world\n', 'utf8')
  fixture = join(dir, 'fixture.mkv')
  await execFileP('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=1',
    '-f', 'lavfi', '-i', 'sine=duration=1',
    '-i', srtPath,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng',
    '-metadata:s:s:0', 'title=Test Subs',
    fixture,
  ])
}, 20000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('probeStreams', () => {
  it('lists video, audio, and subtitle streams with codec/lang/title tags', async () => {
    const result = await probeStreams(fixture)
    expect(result.video).toMatchObject([{ index: 0, codec: 'h264' }])
    // audio carries channels/bitrate too — that is what picks the cheap track to pull
    expect(result.audio).toMatchObject([{ index: 1, codec: 'aac', channels: 1 }])
    expect(result.subtitle).toMatchObject([{ index: 2, codec: 'subrip', lang: 'eng', title: 'Test Subs' }])
  })
})

describe('extractStream', () => {
  it('extracts the subtitle stream as WebVTT text', async () => {
    const { bytes, mime } = await extractStream(fixture, { index: 2, kind: 'subtitle' })
    expect(mime).toBe('text/vtt')
    const text = bytes.toString('utf8')
    expect(text).toContain('WEBVTT')
    expect(text).toContain('hello world')
  })

  it('extracts the audio stream via stream copy (no re-encode)', async () => {
    const { bytes, mime } = await extractStream(fixture, { index: 1, kind: 'audio' })
    expect(mime).toBe('audio/x-matroska')
    expect(bytes.byteLength).toBeGreaterThan(0)
  })

  it('rejects when the ffmpeg process times out', async () => {
    await expect(extractStream(fixture, { index: 1, kind: 'audio', timeoutMs: 1 })).rejects.toThrow('timed out')
  })
})
