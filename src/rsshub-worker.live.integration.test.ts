import { describe, expect, it } from 'vitest'
import { RsshubClient } from './rsshub-client.ts'

/**
 * End-to-end over the REAL RSSHub checkout (RSSHUB_PKG, default ~/projects/RSSHub): boots RSSHub
 * inside the worker, runs a route, and gets its Data object back across the MessagePort. Proves the
 * worker boundary carries a genuine RSSHub feed — the in-process import is really gone.
 *
 * Network + external checkout — opt in with STREAM_LIVE=1. Asserts structure, not content (the
 * upstream site may be empty/blocked; that's not what this test is about).
 */
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('rsshub worker over real RSSHub (live)', () => {
  live('runs a public route and returns a real feed across the port', async () => {
    const client = new RsshubClient()
    try {
      const data = (await client.request('36kr/newsflashes')) as { title?: string; item?: unknown[] }
      expect(data.title).toContain('36')
      expect(Array.isArray(data.item)).toBe(true)
      expect(data.item!.length).toBeGreaterThan(0)
    } finally {
      await client.dispose()
    }
  }, 60_000)

  live('cookie hot-reload via init() does not throw and a route still runs', async () => {
    const client = new RsshubClient()
    try {
      await client.init({ GITHUB_ACCESS_TOKEN: '' }) // any RSSHub config key; empty is fine for the smoke
      const data = (await client.request('zhihu/daily')) as { item?: unknown[] }
      expect(Array.isArray(data.item)).toBe(true)
      expect(data.item!.length).toBeGreaterThan(0)
    } finally {
      await client.dispose()
    }
  }, 60_000)
})
