// src/agent/search/netdisk-hits.test.ts
import { describe, it, expect } from 'vitest'
import { hitsFromVideoResult } from './netdisk-hits.ts'
import type { Release, VideoSearchResult } from '../../video/types.ts'

// minimal Release factory — only the fields the adapter reads
const rel = (over: Partial<Release>): Release =>
  ({
    source: 'pansou',
    title: '怡楽播客',
    quality: 'unknown',
    sourceType: 'quark',
    coverage: { kind: 'unknown' },
    link: 'https://pan.quark.cn/s/x',
    parsed: false,
    ...over,
  }) as Release

const result = (over: Partial<VideoSearchResult>): VideoSearchResult => ({
  shows: [],
  loose: [],
  sources: [],
  ...over,
})

describe('hitsFromVideoResult', () => {
  it('flattens loose releases into hits with netdisk = sourceType + source + password', () => {
    const r = result({
      loose: [
        rel({ title: '怡楽播客 合集', link: 'https://pan.quark.cn/s/x', sourceType: 'quark', password: 'ab12' }),
        rel({ title: '怡楽播客 备份', link: 'https://pan.baidu.com/s/y', sourceType: 'baidu', source: 'pansou' }),
      ],
    })
    const hits = hitsFromVideoResult(r)
    expect(hits.map((h) => h.netdisk)).toEqual(['quark', 'baidu'])
    expect(hits[0].link).toBe('https://pan.quark.cn/s/x')
    expect(hits[0].title).toContain('怡楽')
    expect(hits[0].password).toBe('ab12')
    expect(hits[0].sourceId).toBe('pansou')
  })

  it('flattens show → quality → release, and skips releases with no link and no links[]', () => {
    const r = result({
      shows: [
        {
          source: 'pansou',
          title: '怡楽播客',
          season: null,
          total: null,
          qualities: [
            {
              quality: 'unknown',
              coverage: { total: null, episodes: [], missing: [], hasPack: false },
              releases: [
                rel({ link: 'https://pan.quark.cn/s/z', sourceType: 'quark' }),
                rel({ link: '', links: undefined, sourceType: 'baidu' }), // no link, no links → skipped
              ],
            },
          ],
        },
      ],
    })
    const hits = hitsFromVideoResult(r)
    expect(hits).toHaveLength(1)
    expect(hits[0].netdisk).toBe('quark')
    expect(hits[0].title).toBe('怡楽播客')
  })

  it('expands a multi-share release (links[]) so a quark share is not masked by a baidu-first link', () => {
    const r = result({
      loose: [
        rel({
          link: 'https://pan.baidu.com/s/first', // mirror = baidu (first)
          sourceType: 'baidu',
          links: [
            { url: 'https://pan.baidu.com/s/first', type: 'baidu', password: 'b1' },
            { url: 'https://pan.quark.cn/s/second', type: 'quark', password: 'q2' },
          ],
        }),
      ],
    })
    const hits = hitsFromVideoResult(r)
    expect(hits.map((h) => h.netdisk)).toEqual(['baidu', 'quark'])
    expect(hits.find((h) => h.netdisk === 'quark')?.password).toBe('q2')
  })
})
