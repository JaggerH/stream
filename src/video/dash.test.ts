import { describe, it, expect } from 'vitest'
import { rememberSegHosts, isAllowedSegHost, segHeadersFor, buildDashMpd, type DashResult } from './dash.ts'
import { mediaPlayUrl } from './play.ts'

const stream = (over: Partial<DashResult['video'][0]> = {}) => ({
  id: 80, codecs: 'avc1.640032', mimeType: 'video/mp4',
  width: 1920, height: 1080, frameRate: '30', bandwidth: 1000,
  url: 'https://cdn.example.test/v.m4s', backupUrls: ['https://backup.example.test/v.m4s'],
  init: '0-100', indexRange: '101-200', ...over,
})

describe('分片主机信任表', () => {
  it('没登记过的主机一律拒——静态站名白名单已经不存在', () => {
    expect(isAllowedSegHost('https://never-seen.example.test/x.m4s')).toBe(false)
  })
  it('解析器登记过的主机放行，并且拿得回它要的请求头', () => {
    rememberSegHosts(['https://cdn-a.example.test/v.m4s'], { Referer: 'https://site.example', Cookie: 'k=v' })
    expect(isAllowedSegHost('https://cdn-a.example.test/other.m4s')).toBe(true)
    expect(segHeadersFor('https://cdn-a.example.test/other.m4s')).toEqual({ Referer: 'https://site.example', Cookie: 'k=v' })
  })
  it('登记的是主机不是整条 URL，未登记主机取不到头', () => {
    expect(segHeadersFor('https://never-seen.example.test/x.m4s')).toBeUndefined()
  })
  it('登记过的主机换成 http 也不放行——Cookie 不许明文出门', () => {
    rememberSegHosts(['https://cdn-plain.example.test/v.m4s'], { Cookie: 'k=v' })
    expect(isAllowedSegHost('https://cdn-plain.example.test/other.m4s')).toBe(true)
    expect(isAllowedSegHost('http://cdn-plain.example.test/other.m4s')).toBe(false)
    expect(segHeadersFor('http://cdn-plain.example.test/other.m4s')).toBeUndefined()
  })
  it('解析不出主机的串既不放行也不给头（SSRF 闸门）', () => {
    expect(isAllowedSegHost('not a url')).toBe(false)
    expect(segHeadersFor('not a url')).toBeUndefined()
  })
})

describe('buildDashMpd', () => {
  const dash: DashResult = { durationS: 42, video: [stream()], audio: [stream({ id: 30280, codecs: 'mp4a.40.2', width: undefined, height: undefined })] }
  it('每条流的 BaseURL 指向通用分片路由，主备都带上', () => {
    const mpd = buildDashMpd(dash)
    expect(mpd).toContain('/api/media/seg?u=')
    expect(mpd).toContain('&amp;b=') // XML 转义后的 &b=
    expect(mpd).toContain('&amp;m=video')
    expect(mpd).toContain('&amp;m=audio')
    expect(mpd).not.toMatch(/api\/media\/[a-z]+\/seg/) // 路由里不许再有平台段
  })
  it('时长与 SegmentBase 照搬', () => {
    const mpd = buildDashMpd(dash)
    expect(mpd).toContain('mediaPresentationDuration="PT42S"')
    expect(mpd).toContain('<SegmentBase indexRange="101-200"><Initialization range="0-100"/></SegmentBase>')
  })
  it('备节点最多带两个，MPD 不无限长', () => {
    const backupUrls = ['https://b1.example.test/v', 'https://b2.example.test/v', 'https://b3.example.test/v']
    const mpd = buildDashMpd({ durationS: 10, video: [stream({ backupUrls })], audio: [] })
    expect(mpd).toContain(`b=${encodeURIComponent(backupUrls[1])}`)
    expect(mpd).not.toContain(encodeURIComponent(backupUrls[2]))
  })
  it('没有备节点就只带主 URL', () => {
    const mpd = buildDashMpd({ durationS: 10, video: [stream({ backupUrls: [] })], audio: [] })
    expect(mpd).toContain('u=')
    expect(mpd).not.toContain('&amp;b=')
  })
})

describe('mediaPlayUrl', () => {
  it('平台 + vid → 通用播放路由', () => {
    expect(mediaPlayUrl({ platform: 'x', vid: 'ID1' })).toBe('/api/media/play?platform=x&vid=ID1')
  })
  it('dl=1 是下载那一档', () => {
    expect(mediaPlayUrl({ platform: 'x', vid: 'ID1', dl: true })).toBe('/api/media/play?platform=x&vid=ID1&dl=1')
  })
  it('vid 与 platform 都转义（vid 里可能有 / 和 &）', () => {
    expect(mediaPlayUrl({ platform: 'x', vid: 'a/b&c' })).toBe('/api/media/play?platform=x&vid=a%2Fb%26c')
  })
})
