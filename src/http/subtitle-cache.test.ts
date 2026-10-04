import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCachedSubtitle, writeCachedSubtitle } from './subtitle-cache.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sub-cache-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('subtitle cache', () => {
  it('returns null on a cold cache', async () => {
    expect(await readCachedSubtitle(dir, '/quark/a.mkv:2')).toBeNull()
  })

  it('writes then reads back the same bytes for the same key', async () => {
    await writeCachedSubtitle(dir, '/quark/a.mkv:2', Buffer.from('WEBVTT\n\nhello'))
    const hit = await readCachedSubtitle(dir, '/quark/a.mkv:2')
    expect(hit?.toString('utf8')).toBe('WEBVTT\n\nhello')
  })

  it('keys cache entries by the full key — no cross-contamination between tracks or files', async () => {
    await writeCachedSubtitle(dir, '/quark/a.mkv:2', Buffer.from('chi'))
    await writeCachedSubtitle(dir, '/quark/a.mkv:3', Buffer.from('eng'))
    await writeCachedSubtitle(dir, '/quark/Subs/a.chs.srt:vtt', Buffer.from('sibling'))
    expect((await readCachedSubtitle(dir, '/quark/a.mkv:2'))?.toString('utf8')).toBe('chi')
    expect((await readCachedSubtitle(dir, '/quark/a.mkv:3'))?.toString('utf8')).toBe('eng')
    expect((await readCachedSubtitle(dir, '/quark/Subs/a.chs.srt:vtt'))?.toString('utf8')).toBe('sibling')
  })

  it('treats an entry older than 10 days as a miss', async () => {
    await writeCachedSubtitle(dir, '/quark/a.mkv:2', Buffer.from('stale'))
    const elevenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000)
    // writeCachedSubtitle already created the file; backdate its mtime to simulate age.
    const file = join(dir, await (async () => {
      const { createHash } = await import('node:crypto')
      return `${createHash('sha256').update('/quark/a.mkv:2').digest('hex')}.vtt`
    })())
    await utimes(file, elevenDaysAgo, elevenDaysAgo)
    expect(await readCachedSubtitle(dir, '/quark/a.mkv:2')).toBeNull()
  })
})
