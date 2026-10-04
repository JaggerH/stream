import { describe, it, expect } from 'vitest'
import { parseTitle, parseCoverage, parseSeason, parseQuality, classifyLink, parseSize, parseShow, dedupeKey, parseShareLink } from './parse.ts'

const GB = 1024 ** 3

describe('parseTitle — real btbtla rows', () => {
  it('full-season pack 2160p with codec + group', () => {
    const p = parseTitle('上载新生.第三季[全8集][简繁英字幕].Upload.S03.REPACK.2160p.Amazon.WEB-DL.DDP5.1.H.265-BlackTV')
    expect(p.quality).toBe('2160p')
    expect(p.season).toBe(3)
    expect(p.coverage).toEqual({ kind: 'pack', from: 1, to: 8, total: 8 })
    expect(p.codec).toBe('H265')
    expect(p.group).toBe('BlackTV')
  })

  it('single episode with size', () => {
    const p = parseTitle('Upload.S03E07.2160p.WEB.H265-NHTFS [3.71GB]')
    expect(p.quality).toBe('2160p')
    expect(p.season).toBe(3)
    expect(p.coverage).toEqual({ kind: 'single', episode: 7 })
    expect(p.codec).toBe('H265')
    expect(p.group).toBe('NHTFS')
    expect(p.sizeBytes).toBe(Math.round(3.71 * GB))
  })

  it('CN episode range', () => {
    const p = parseTitle('上载新生 第三季[第03-04集][简繁英字幕].Upload.S03.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-FLUX')
    expect(p.coverage).toEqual({ kind: 'range', from: 3, to: 4 })
    expect(p.season).toBe(3)
    expect(p.quality).toBe('2160p')
    expect(p.hdr).toBe('HDR')
  })

  it('HDR single', () => {
    const p = parseTitle('Upload.S03E01.HDR.2160p.WEB.H265-NHTFS [5.33GB]')
    expect(p.coverage).toEqual({ kind: 'single', episode: 1 })
    expect(p.hdr).toBe('HDR')
  })
})

describe('coverage parsing', () => {
  it('1080p CN full pack + CN season numeral', () => {
    expect(parseSeason('上载新生 第二季')).toBe(2)
    expect(parseQuality('上载新生 第二季 全10集 1080p')).toBe('1080p')
    expect(parseCoverage('上载新生 第二季 全10集 1080p')).toEqual({ kind: 'pack', from: 1, to: 10, total: 10 })
  })
  it('SxxExx-Eyy range', () => {
    expect(parseCoverage('Show.S02E01-E12.1080p')).toEqual({ kind: 'range', from: 1, to: 12 })
  })
  it('EP range', () => {
    expect(parseCoverage('[Group] Anime EP01-08 720p')).toEqual({ kind: 'range', from: 1, to: 8 })
  })
  it('movie / no episode → unknown', () => {
    expect(parseCoverage('某电影 2023 1080p BluRay x265')).toEqual({ kind: 'unknown' })
  })
  it('whole-season pack with no episode count → complete', () => {
    expect(parseCoverage('Upload.S03.COMPLETE.720p.AMZN.WEBRip.x264-Gal')).toEqual({ kind: 'complete' })
    expect(parseCoverage('Upload.S03.720p.x265-T0PAZ [2.35GB]')).toEqual({ kind: 'complete' })
    expect(parseCoverage('某剧 全8集 1080p')).toEqual({ kind: 'pack', from: 1, to: 8, total: 8 }) // 全N集 → pack
    expect(parseCoverage('某剧 全集 1080p')).toEqual({ kind: 'complete' }) // 全集 (no count) → complete
  })
  it('Sxx with an episode is NOT complete (stays single)', () => {
    expect(parseCoverage('Upload.S03E08.720p.WEB.x265-MiNX')).toEqual({ kind: 'single', episode: 8 })
  })
  it('does not mistake codec H.264 for an episode', () => {
    expect(parseCoverage('Movie.2021.1080p.H.264-GRP')).toEqual({ kind: 'unknown' })
  })
})

describe('nyaa-style coverage', () => {
  it('parenthesized batch range (01-10)', () => {
    expect(parseCoverage('[SubsPlease] Sousou no Frieren S2 (01-10) (1080p) [Batch]')).toEqual({ kind: 'range', from: 1, to: 10 })
  })
  it('dash single "Show - 12"', () => {
    expect(parseCoverage('[Erai-raws] Some Anime - 12 [1080p]')).toEqual({ kind: 'single', episode: 12 })
  })
  it('4-digit year is not an episode', () => {
    expect(parseCoverage('某电影 - 2024 1080p').kind).toBe('unknown')
  })
})

describe('parseShow', () => {
  it('strips group + cuts at season marker', () => {
    expect(parseShow('[SubsPlease] Sousou no Frieren S2 (01-10) (1080p) [Batch]')).toBe('Sousou no Frieren')
    expect(parseShow('[SubsPlease] Sousou no Frieren (01-28) (1080p) [V2] [Batch]')).toBe('Sousou no Frieren')
  })
  it('CN dub prefix + alt-name parens → CN name', () => {
    expect(parseShow('中配 - 葬送的芙莉莲 (Sousou no Frieren) (Season 2) (Mainland Mandarin Chinese Dub)')).toBe('葬送的芙莉莲')
  })
  it('null when nothing usable', () => {
    expect(parseShow('[1080p][HEVC]')).toBeNull()
  })
})

describe('classifyLink', () => {
  it('magnet / ed2k / netdisk', () => {
    expect(classifyLink('magnet:?xt=urn:btih:abc')).toBe('magnet')
    expect(classifyLink('ed2k://|file|x|1|')).toBe('ed2k')
    expect(classifyLink('https://pan.quark.cn/s/abc')).toBe('quark')
    expect(classifyLink('https://pan.baidu.com/s/abc')).toBe('baidu')
    expect(classifyLink('/tdown/123.html')).toBe('unknown')
  })
})

describe('parseSize', () => {
  it('GB / MB / TB', () => {
    expect(parseSize('x [28.50GB].torrent')).toBe(Math.round(28.5 * GB))
    expect(parseSize('x [842MB]')).toBe(Math.round(842 * 1024 ** 2))
    expect(parseSize('no size here')).toBeUndefined()
  })
})

describe('parseShareLink', () => {
  // 消费方（搜索结果 / Agent 抽出的链）手里只有 link，netdisk.share.* 要 (netdisk, pwd_id)。
  it('夸克：抠出网盘与分享 id，忽略 query 与 hash', () => {
    expect(parseShareLink('https://pan.quark.cn/s/0077dae2f9b7?entry=tg#/list')).toEqual({ netdisk: 'quark', pwd_id: '0077dae2f9b7' })
  })
  it('百度 / 阿里：同样抠得出（Provider 还没接不归它管）', () => {
    expect(parseShareLink('https://pan.baidu.com/s/1a_bC-dEf')).toEqual({ netdisk: 'baidu', pwd_id: '1a_bC-dEf' })
    expect(parseShareLink('https://www.alipan.com/s/xY9zAb')).toEqual({ netdisk: 'aliyun', pwd_id: 'xY9zAb' })
  })
  it('非网盘链接 → null（magnet/ed2k 没有分享 id 这回事）', () => {
    expect(parseShareLink('magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
    expect(parseShareLink('ed2k://|file|x.mkv|1|A1B2C3D4E5F60718293A4B5C6D7E8F90|/')).toBeNull()
  })
  it('网盘域名但抠不出 id → null，不猜', () => {
    expect(parseShareLink('https://pan.quark.cn/list#/list/home')).toBeNull()
  })
})

describe('dedupeKey', () => {
  it('magnet: 同 infohash 不同 tracker/dn → 同键', () => {
    const a = 'magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=Show.S01&tr=udp://x:80'
    const b = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&tr=udp://other:99'
    expect(dedupeKey(a, 'magnet')).toBe(dedupeKey(b, 'magnet'))
    expect(dedupeKey(a, 'magnet')).toBe('magnet:c12fe1c06bba254a9dc9f519b335aa7c1367a88a')
  })
  it('magnet: base32 infohash 也归一化', () => {
    const m = 'magnet:?xt=urn:btih:YNH6DQDLXISUVHOJ6UM3GNNKPQJWPKEK&dn=x'
    expect(dedupeKey(m, 'magnet')).toBe('magnet:ynh6dqdlxisuvhoj6um3gnnkpqjwpkek')
  })
  it('magnet: 不同 infohash → 不同键', () => {
    const a = 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const b = 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    expect(dedupeKey(a, 'magnet')).not.toBe(dedupeKey(b, 'magnet'))
  })
  it('ed2k: 抠 file hash', () => {
    const e = 'ed2k://|file|Show.S01E01.mkv|734003200|A1B2C3D4E5F60718293A4B5C6D7E8F90|/'
    expect(dedupeKey(e, 'ed2k')).toBe('ed2k:a1b2c3d4e5f60718293a4b5c6d7e8f90')
  })
  it('quark: 抠分享 ID，丢弃 query 与 hash', () => {
    expect(dedupeKey('https://pan.quark.cn/s/abc123def456?entry=tg#/list', 'quark')).toBe('quark:abc123def456')
    expect(dedupeKey('https://pan.quark.cn/s/abc123def456', 'quark')).toBe('quark:abc123def456')
  })
  it('baidu: 抠分享 ID（含短横线下划线）', () => {
    expect(dedupeKey('https://pan.baidu.com/s/1a-B_cD2?pwd=x1y2', 'baidu')).toBe('baidu:1a-B_cD2')
  })
  it('aliyun: alipan 与 aliyundrive 两个域同等对待', () => {
    expect(dedupeKey('https://www.alipan.com/s/xY9zAb', 'aliyun')).toBe('aliyun:xY9zAb')
    expect(dedupeKey('https://www.aliyundrive.com/s/xY9zAb', 'aliyun')).toBe('aliyun:xY9zAb')
  })
  it('抠不出 ID → 退到归一化 URL（丢 query/hash，host 转小写）', () => {
    expect(dedupeKey('https://PAN.QUARK.CN/weird/path?a=1#f', 'quark')).toBe('quark:https://pan.quark.cn/weird/path')
  })
  it('unknown / 非 URL → 原样兜底，不抛', () => {
    expect(dedupeKey('not a url', 'unknown')).toBe('unknown:not a url')
  })
  it('不同类型的相同 ID 不串味', () => {
    expect(dedupeKey('https://pan.quark.cn/s/same1', 'quark')).not.toBe(dedupeKey('https://pan.baidu.com/s/same1', 'baidu'))
  })
})
