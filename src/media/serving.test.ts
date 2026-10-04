import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { refererForUrl, rejectionCooldown, servingPolicyFor, setServingPolicySource } from './serving.ts'

const LZ = { match: '.lz.fm', label: '荔枝 FM', hosts: ['cdn1.lz.fm'] }

describe('refererForUrl — 「这台主机的字节要带哪个 Referer 才给」', () => {
  afterEach(() => setServingPolicySource(() => []))
  it('声明了 referer 的主机（含子域）→ 那个 Referer；没声明 / 表外 / 非法 URL → undefined', () => {
    setServingPolicySource(() => [
      { match: '.img.example', label: 'A', referer: 'https://www.example/' },
      LZ,
    ])
    expect(refererForUrl('https://p1.img.example/a.jpg')).toBe('https://www.example/')
    expect(refererForUrl('https://img.example/a.jpg')).toBe('https://www.example/')
    expect(refererForUrl('http://cdn5.lz.fm/a.mp3')).toBeUndefined()
    expect(refererForUrl('https://cdn.other.com/a.jpg')).toBeUndefined()
    expect(refererForUrl('not a url')).toBeUndefined()
  })
})

describe('servingPolicyFor — 按 host 查「这条直链该怎么送」', () => {
  beforeEach(() => setServingPolicySource(() => [LZ]))
  afterEach(() => setServingPolicySource(() => []))

  it('点开头的 match 是后缀匹配：子域命中', () => {
    expect(servingPolicyFor('http://cdn5.lz.fm/audio/9_hd.mp3')?.label).toBe('荔枝 FM')
  })
  it('后缀匹配也覆盖 apex 本身', () => {
    expect(servingPolicyFor('https://lz.fm/x.mp3')?.label).toBe('荔枝 FM')
  })
  it('不匹配「以它结尾的别的域名」——evil-lz.fm 必须落空', () => {
    expect(servingPolicyFor('http://evil-lz.fm/x.mp3')).toBeUndefined()
  })
  it('表外的 host → undefined（调用方保持现状的 302）', () => {
    expect(servingPolicyFor('https://cdn.other.com/a.m4a')).toBeUndefined()
  })
  it('不是合法 URL → undefined，不抛', () => {
    expect(servingPolicyFor('not a url')).toBeUndefined()
    expect(servingPolicyFor('')).toBeUndefined()
  })
  it('策略表是调用时现取的：包晚到也跟得上', () => {
    let policies: Array<typeof LZ> = []
    setServingPolicySource(() => policies)
    expect(servingPolicyFor('http://cdn5.lz.fm/a.mp3')).toBeUndefined()
    policies = [LZ]                 // "包装上了"
    expect(servingPolicyFor('http://cdn5.lz.fm/a.mp3')?.label).toBe('荔枝 FM')
  })
  it('没有任何来源时表是空的（不是某个写死的默认）', () => {
    setServingPolicySource(() => [])
    expect(servingPolicyFor('http://cdn5.lizhi.fm/a.mp3')).toBeUndefined()
  })
})

describe('rejectionCooldown — 上游拒绝后的负缓存', () => {
  afterEach(() => {
    vi.useRealTimers()
    rejectionCooldown.clear()
  })

  it('记下之后同一条 url 在窗口内直接读到，不必再打上游', () => {
    rejectionCooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    expect(rejectionCooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBe(403)
  })

  it('只对同一条 url 生效，别的 url 不受牵连', () => {
    rejectionCooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    expect(rejectionCooldown.get('http://cdn5.lizhi.fm/b.mp3')).toBeUndefined()
  })

  it('窗口过了就失效——冷却是暂时的,不是永久拉黑', () => {
    vi.useFakeTimers()
    rejectionCooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    vi.advanceTimersByTime(59_000)
    expect(rejectionCooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBe(403)
    vi.advanceTimersByTime(2_000)
    expect(rejectionCooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBeUndefined()
  })
})
