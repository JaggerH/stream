import { describe, expect, it, vi, afterEach } from 'vitest'
import { Serving } from './serving.ts'

const LZ = { match: '.lz.fm', label: '荔枝 FM', hosts: ['cdn1.lz.fm'] }

describe('Serving.refererFor — 「这台主机的字节要带哪个 Referer 才给」', () => {
  it('声明了 referer 的主机（含子域）→ 那个 Referer；没声明 / 表外 / 非法 URL → undefined', () => {
    const serving = new Serving(() => [
      { match: '.img.example', label: 'A', referer: 'https://www.example/' },
      LZ,
    ])
    expect(serving.refererFor('https://p1.img.example/a.jpg')).toBe('https://www.example/')
    expect(serving.refererFor('https://img.example/a.jpg')).toBe('https://www.example/')
    expect(serving.refererFor('http://cdn5.lz.fm/a.mp3')).toBeUndefined()
    expect(serving.refererFor('https://cdn.other.com/a.jpg')).toBeUndefined()
    expect(serving.refererFor('not a url')).toBeUndefined()
  })
})

describe('Serving.policyFor — 按 host 查「这条直链该怎么送」', () => {
  it('点开头的 match 是后缀匹配：子域命中', () => {
    const serving = new Serving(() => [LZ])
    expect(serving.policyFor('http://cdn5.lz.fm/audio/9_hd.mp3')?.label).toBe('荔枝 FM')
  })
  it('后缀匹配也覆盖 apex 本身', () => {
    const serving = new Serving(() => [LZ])
    expect(serving.policyFor('https://lz.fm/x.mp3')?.label).toBe('荔枝 FM')
  })
  it('不匹配「以它结尾的别的域名」——evil-lz.fm 必须落空', () => {
    const serving = new Serving(() => [LZ])
    expect(serving.policyFor('http://evil-lz.fm/x.mp3')).toBeUndefined()
  })
  it('表外的 host → undefined（调用方保持现状的 302）', () => {
    const serving = new Serving(() => [LZ])
    expect(serving.policyFor('https://cdn.other.com/a.m4a')).toBeUndefined()
  })
  it('不是合法 URL → undefined，不抛', () => {
    const serving = new Serving(() => [LZ])
    expect(serving.policyFor('not a url')).toBeUndefined()
    expect(serving.policyFor('')).toBeUndefined()
  })
  it('策略表是调用时现取的：包晚到也跟得上', () => {
    let policies: Array<typeof LZ> = []
    const serving = new Serving(() => policies)
    expect(serving.policyFor('http://cdn5.lz.fm/a.mp3')).toBeUndefined()
    policies = [LZ]                 // "包装上了"
    expect(serving.policyFor('http://cdn5.lz.fm/a.mp3')?.label).toBe('荔枝 FM')
  })
  it('没有任何来源时表是空的（不是某个写死的默认）', () => {
    const serving = new Serving(() => [])
    expect(serving.policyFor('http://cdn5.lizhi.fm/a.mp3')).toBeUndefined()
  })
})

describe('Serving.cooldown — 上游拒绝后的负缓存', () => {
  afterEach(() => vi.useRealTimers())

  it('记下之后同一条 url 在窗口内直接读到，不必再打上游', () => {
    const serving = new Serving()
    serving.cooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    expect(serving.cooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBe(403)
  })

  it('只对同一条 url 生效，别的 url 不受牵连', () => {
    const serving = new Serving()
    serving.cooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    expect(serving.cooldown.get('http://cdn5.lizhi.fm/b.mp3')).toBeUndefined()
  })

  it('窗口过了就失效——冷却是暂时的,不是永久拉黑', () => {
    vi.useFakeTimers()
    const serving = new Serving()
    serving.cooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    vi.advanceTimersByTime(59_000)
    expect(serving.cooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBe(403)
    vi.advanceTimersByTime(2_000)
    expect(serving.cooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBeUndefined()
  })
})

describe('一个实例一份', () => {
  it('两个实例各按自己的包声明查，互读不到对方的冷却与测速', () => {
    const a = new Serving(() => [LZ])
    const b = new Serving(() => [])
    expect(a.policyFor('http://cdn5.lz.fm/a.mp3')?.label).toBe('荔枝 FM')
    expect(b.policyFor('http://cdn5.lz.fm/a.mp3')).toBeUndefined()
    // A 被上游拒过进入冷却；B 没有这段记忆
    a.cooldown.remember('http://cdn5.lizhi.fm/a.mp3', 403)
    expect(a.cooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBe(403)
    expect(b.cooldown.get('http://cdn5.lizhi.fm/a.mp3')).toBeUndefined()
    // A 实测过某台主机快；B 看不到
    a.stats.note('cdn1.lz.fm', 1024 * 1024)
    expect(a.stats.speedOf('cdn1.lz.fm')).toBeDefined()
    expect(b.stats.speedOf('cdn1.lz.fm')).toBeUndefined()
  })
})
