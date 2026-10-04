import { describe, it, expect, afterEach } from 'vitest'
import { normalize } from './normalize.ts'
import { extractTrackRef } from '../audio/ref.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { Item } from './types.ts'

// 镜像站的歌单条目：recipe 映射没给 track_id，但每条的链接指向**另一个平台**的歌曲页。
// 曲目身份必须从链接认领里补上——否则下载一律报 "Item has no track reference"
//（活体 2026-09-27，Mac 上订阅的一份镜像站歌单，17 首全挂）。
const OWNER: LinkTableEntry = {
  package: '@x/songsite',
  hosts: [{ host: 'songsite.com', platform: 'songsite' }],
  shortHosts: [],
  patterns: [{ kind: 'track', pattern: '^https?://songsite\\.com/song\\?id=(?<id>\\d+)', platform: 'songsite' }],
}

const mirrorManifest = {
  id: 'mirror-playlist', adapter: 'replay', type: 'post', normalizer: 'rsshub',
  facility: { key: 'mirror', label: 'mirror' },
} as unknown as SourceManifest

const rawSong = {
  title: '某首歌', author: '某歌手', description: '某专辑',
  link: 'https://songsite.com/song?id=12345', image: 'https://img.example.com/cover.jpg',
}

afterEach(() => setLinkDeclarationSource(() => []))

describe('默认 normalizer：链接被某包认领为曲目 → 条目带上曲目身份', () => {
  it('补出 (platform, track_id)，平台归链接的主人而不是产出条目的镜像站', () => {
    setLinkDeclarationSource(() => [OWNER])
    const content = normalize(rawSong, mirrorManifest)
    expect(content.archetype).toBe('audio')
    const ref = extractTrackRef({ title: rawSong.title, author: rawSong.author, content } as unknown as Item)
    expect(ref).toMatchObject({ platform: 'songsite', id: '12345' })
    // 封面还在（歌单行要显示它）
    expect(content.media?.[0]).toMatchObject({ poster: rawSong.image })
  })

  it('链接没人认领 → 行为不变（仍是图集，不编造身份）', () => {
    setLinkDeclarationSource(() => [])
    const content = normalize(rawSong, mirrorManifest)
    expect(content.archetype).toBe('gallery')
    expect(extractTrackRef({ title: rawSong.title, content } as unknown as Item)).toBeNull()
  })

  it('recipe 映射给了 track_id 时以它为准（链接认领只补缺）', () => {
    setLinkDeclarationSource(() => [OWNER])
    const content = normalize({ ...rawSong, track_id: '999' }, mirrorManifest)
    const ref = extractTrackRef({ title: rawSong.title, content } as unknown as Item)
    expect(ref).toMatchObject({ platform: 'mirror', id: '999' })
  })
})
