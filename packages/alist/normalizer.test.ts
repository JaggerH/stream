import { describe, it, expect } from 'vitest'
import { alistNormalizer } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const M = {} as SourceManifest

describe('alistNormalizer', () => {
  it('maps a netdisk file to a directly-playable audio item (no cover, no resolveOnly)', () => {
    const c = alistNormalizer({ path: '/quark/怡乐下架/详解.mp3', name: '详解.mp3', title: '详解' } as never, M)
    expect(c.archetype).toBe('audio')
    expect(c.title).toBe('详解')
    expect(c.media).toEqual([
      { kind: 'audio', url: `/api/media/netdisk-play?path=${encodeURIComponent('/quark/怡乐下架/详解.mp3')}` },
    ])
    // 无照片就不给封面：没有 poster、没有 image media
    expect(c.media?.every((m) => !('poster' in m) || !m.poster)).toBe(true)
    expect(c.media?.some((m) => m.kind === 'image')).toBe(false)
    // 不是 resolveOnly（直接可播，不查绑定）
    expect(c.media?.some((m) => m.kind === 'audio' && (m as { resolveOnly?: boolean }).resolveOnly)).toBe(false)
  })

  it('集名自带点号时不被当扩展名剥掉——adapter 已剥过 .mp3,这里只认音频扩展名(活体退化事故)', () => {
    // adapter 传进来的 title 已经没有 .mp3 了,而集名里还有一个点。这里只钉"扩展名别剥过头",
    // 前缀/水印各有自己的用例,所以样本刻意不带前缀。
    const c = alistNormalizer({ path: '/d/455.现代版木仓下留人.mp3', name: '455.现代版木仓下留人.mp3', title: '455.现代版木仓下留人' } as never, M)
    expect(c.title).toBe('455.现代版木仓下留人') // 曾退化成 '455'
  })

  it('title 缺省时用 name,并剥掉真扩展名', () => {
    const c = alistNormalizer({ path: '/d/144.S级黄金大劫案.mp3', name: '144.S级黄金大劫案.mp3' } as never, M)
    expect(c.title).toBe('144.S级黄金大劫案')
  })

  it('剥掉分享者加的电台名前缀——挂进流之后它是冗余', () => {
    const t = (name: string) => alistNormalizer({ path: `/d/${name}`, name } as never, M).title
    expect(t('怡乐·455.现代版木仓下留人.mp3')).toBe('455.现代版木仓下留人')
    expect(t('怡楽播客 - 069.四谈身边灵异事.mp3')).toBe('069.四谈身边灵异事')
    expect(t('怡乐电台—108.鲁荣渔2682重案！.mp3')).toBe('108.鲁荣渔2682重案！')
  })

  it('两位号的子节目前缀**不剥**——两套编号体系不许混判(跳号统计 44 vs 57 的同一条判据)', () => {
    const t = (name: string) => alistNormalizer({ path: `/d/${name}`, name } as never, M).title
    expect(t('玄关笔记 - 07.甲木.mp3')).toBe('玄关笔记 - 07.甲木')
  })

  it('没有前缀的文件名原样保留(集名里的点号/短横不会被误认成分隔符)', () => {
    const t = (name: string) => alistNormalizer({ path: `/d/${name}`, name } as never, M).title
    expect(t('144.S级黄金大劫案.mp3')).toBe('144.S级黄金大劫案')
    expect(t('455.现代版-木仓下留人.mp3')).toBe('455.现代版-木仓下留人')
  })

  it('剥分享者水印', () => {
    const t = (name: string) => alistNormalizer({ path: `/d/${name}`, name } as never, M).title
    expect(t('341.喂，等我一吓啊【耗时整理‖cunlove.cn】.mp3')).toBe('341.喂，等我一吓啊')
    expect(t('【公众号：CunWorkNotes】怡乐·092.穿衣服.mp3')).toBe('092.穿衣服')
  })

  it('empty path → no media (defensive, never throws)', () => {
    const c = alistNormalizer({ path: '', name: '' } as never, M)
    expect(c.archetype).toBe('audio')
    expect(c.media).toEqual([])
  })
})
