import { describe, it, expect, afterEach } from 'vitest'
import { trackRefFromUrl } from './track-url.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

// 曲目文法来自包的 links.patterns（kind track，命名组 id）；认领函数在 src/links/recognize.ts。
const entry = (pkg: string, platform: string, ...patterns: string[]): LinkTableEntry => ({
  package: pkg,
  hosts: [],
  shortHosts: [],
  patterns: patterns.map((pattern) => ({ kind: 'track' as const, pattern, platform })),
})
const MUSIC = entry('@x/music', 'music',
  '^https?://tunes\\.example/(?:#/)?song\\?id=(?<id>\\d+)',
  '^https?://tunes\\.example/song/(?<id>\\d+)')

afterEach(() => setLinkDeclarationSource(() => []))

describe('trackRefFromUrl', () => {
  it('命中 → platform 是声明它的包给的平台，track_id 是命名组 id', () => {
    setLinkDeclarationSource(() => [MUSIC])
    expect(trackRefFromUrl('https://tunes.example/song?id=123')).toEqual({ platform: 'music', track_id: '123' })
    expect(trackRefFromUrl('https://tunes.example/#/song?id=456')).toEqual({ platform: 'music', track_id: '456' })
    expect(trackRefFromUrl('https://tunes.example/song/789')).toEqual({ platform: 'music', track_id: '789' })
  })
  it('同一站的非曲目页不命中（歌单 / 用户主页）', () => {
    setLinkDeclarationSource(() => [MUSIC])
    expect(trackRefFromUrl('https://tunes.example/user/home?id=60168357')).toBeNull()
    expect(trackRefFromUrl('https://tunes.example/playlist?id=1')).toBeNull()
  })
  it('没有任何包声明时恒 null（不是某个写死的默认）', () => {
    expect(trackRefFromUrl('https://tunes.example/song?id=1')).toBeNull()
  })
  it('声明表是调用时现取的：包晚到也跟得上', () => {
    let decls: LinkTableEntry[] = []
    setLinkDeclarationSource(() => decls)
    expect(trackRefFromUrl('https://tunes.example/song?id=1')).toBeNull()
    decls = [MUSIC]
    expect(trackRefFromUrl('https://tunes.example/song?id=1')).toEqual({ platform: 'music', track_id: '1' })
  })
  it('空 / 非字符串输入 → null，不抛', () => {
    setLinkDeclarationSource(() => [MUSIC])
    expect(trackRefFromUrl('')).toBeNull()
    expect(trackRefFromUrl(undefined as unknown as string)).toBeNull()
  })
  it('先声明的先赢（结果稳定，不随磁盘顺序漂）', () => {
    setLinkDeclarationSource(() => [entry('a', 'a', '^https://x\\.com/(?<id>\\d+)'), entry('b', 'b', '^https://x\\.com/(?<id>\\d+)')])
    expect(trackRefFromUrl('https://x.com/7')?.platform).toBe('a')
  })
})
