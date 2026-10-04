import { describe, it, expect } from 'vitest'
import { xhsNormalizer } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const manifest = { id: '@streamapp/xhs/xhs-home', normalizer: 'xhs' } as unknown as SourceManifest
const ENRICH = { source: 'xhs-detail', params: { noteId: 'n1', xsec_token: 'tok' } }

describe('xhsNormalizer', () => {
  it('photo note → gallery with the cover image', () => {
    const c = xhsNormalizer({ noteId: 'n1', xsec_token: 'tok', title: '短发女', cover: 'http://c/1.jpg', note_type: 'normal', link: 'http://x/n1' }, manifest)
    expect(c.archetype).toBe('gallery')
    expect(c.title).toBe('短发女')
    expect(c.media).toEqual([{ kind: 'image', url: 'http://c/1.jpg' }])
    expect(c.enrich).toEqual(ENRICH)
  })

  // 视频笔记：`provider: 'xhs'` + `vid = noteId`，播放走通用 `(provider, vid)` 解析（本包的
  // xhs-resolve 成员）；feed 里没有流地址，所以没有 url / embed，海报就是封面。
  it('video note → video media { provider: xhs, vid: noteId, poster: cover }, no url/embed', () => {
    const c = xhsNormalizer({ noteId: 'n1', xsec_token: 'tok', title: 'v', cover: 'http://c/2.jpg', note_type: 'video', link: 'http://x/n2' }, manifest)
    expect(c.archetype).toBe('video')
    expect(c.media).toEqual([
      { kind: 'video', provider: 'xhs', vid: 'n1', poster: 'http://c/2.jpg', page_url: 'http://x/n2' },
    ])
    expect(c.enrich).toEqual(ENRICH)
  })

  it('no cover → keeps the caption as text rather than dropping the note', () => {
    const c = xhsNormalizer({ title: 'just text', note_type: 'normal' }, manifest)
    expect(c.archetype).toBe('text')
    expect(c.title).toBe('just text')
    expect(c.media).toBeUndefined()
  })

  it('never throws on a garbage/empty raw item', () => {
    expect(() => xhsNormalizer({}, manifest)).not.toThrow()
    expect(xhsNormalizer({}, manifest).archetype).toBe('text')
  })

  describe('enrich 描述（打开时去哪现取）', () => {
    it('xsec_token 字段缺席时从 link 的 query 里抠', () => {
      const c = xhsNormalizer({
        noteId: 'n7', title: 't', cover: 'http://c/7.jpg', note_type: 'normal',
        link: 'https://www.xiaohongshu.com/explore/n7?xsec_token=ABC%3D%3D&xsec_source=pc_feed',
      }, manifest)
      expect(c.enrich).toEqual({ source: 'xhs-detail', params: { noteId: 'n7', xsec_token: 'ABC==' } })
    })

    it('noteId 缺席 → 不写 enrich（没有东西可取）', () => {
      const c = xhsNormalizer({ title: 't', cover: 'http://c/1.jpg', xsec_token: 'tok', link: 'http://x/n1' }, manifest)
      expect(c.enrich).toBeUndefined()
    })

    it('xsec_token 既没有字段、link 里也没有 → 不写 enrich', () => {
      const c = xhsNormalizer({ noteId: 'n1', title: 't', cover: 'http://c/1.jpg', link: 'https://www.xiaohongshu.com/explore/n1' }, manifest)
      expect(c.enrich).toBeUndefined()
    })

    it('非字符串的 noteId / xsec_token 不当真', () => {
      const c = xhsNormalizer({ noteId: 123, xsec_token: { a: 1 }, title: 't' }, manifest)
      expect(c.enrich).toBeUndefined()
    })
  })

  // xhs-detail (enrich) has a DIFFERENT raw shape than the feed: it carries the full photo
  // list (`imageList`) and the caption (`desc`), and no `cover` at all. Before this, both were
  // dropped — a detail note fell through to the bare `{archetype:'text', title}` fallback, so
  // an 8-image note rendered with zero media and no caption.
  const detailManifest = { id: '@streamapp/xhs/xhs-detail', normalizer: 'xhs' } as unknown as SourceManifest

  it('detail note → gallery with the FULL imageList + desc as text', () => {
    const c = xhsNormalizer({
      noteId: 'n1',
      title: '怡乐播客下架合集汇总大全',
      desc: '怡乐播客为什么这么多经典节目都下架了，太遗憾了',
      note_type: 'normal',
      imageList: [
        { urlDefault: 'http://img/1.webp', width: 1440, height: 2164 },
        { urlDefault: 'http://img/2.webp', width: 1206, height: 1825 },
        { urlDefault: 'http://img/3.webp', width: 1206, height: 1825 },
      ],
    }, detailManifest)
    expect(c.archetype).toBe('gallery')
    expect(c.title).toBe('怡乐播客下架合集汇总大全')
    expect(c.text).toBe('怡乐播客为什么这么多经典节目都下架了，太遗憾了')
    expect(c.media).toEqual([
      { kind: 'image', url: 'http://img/1.webp' },
      { kind: 'image', url: 'http://img/2.webp' },
      { kind: 'image', url: 'http://img/3.webp' },
    ])
  })

  it('detail video note → video media + desc as text (poster falls back to first image)', () => {
    const c = xhsNormalizer({
      noteId: 'n9', title: 'v', desc: '视频笔记正文', note_type: 'video', link: 'http://x/n9',
      imageList: [{ urlDefault: 'http://img/cover.webp' }],
    }, detailManifest)
    expect(c.archetype).toBe('video')
    expect(c.text).toBe('视频笔记正文')
    expect(c.media).toEqual([
      { kind: 'video', provider: 'xhs', vid: 'n9', poster: 'http://img/cover.webp', page_url: 'http://x/n9' },
    ])
  })

  it('detail text-only note (desc, no images) → text archetype but keeps the caption', () => {
    const c = xhsNormalizer({ title: 't', desc: '只有正文', note_type: 'normal' }, detailManifest)
    expect(c.archetype).toBe('text')
    expect(c.text).toBe('只有正文')
  })

  it('imageList entries missing urlDefault are skipped, not emitted as broken media', () => {
    const c = xhsNormalizer({
      title: 'x', note_type: 'normal',
      imageList: [{ urlDefault: 'http://img/ok.webp' }, { width: 100 }, null],
    }, detailManifest)
    expect(c.media).toEqual([{ kind: 'image', url: 'http://img/ok.webp' }])
  })

  it('feed shape is unchanged when desc/imageList are absent (no regression)', () => {
    const c = xhsNormalizer({ title: '短发女', cover: 'http://c/1.jpg', note_type: 'normal' }, manifest)
    expect(c.archetype).toBe('gallery')
    expect(c.text).toBeUndefined()
    expect(c.media).toEqual([{ kind: 'image', url: 'http://c/1.jpg' }])
  })
})
