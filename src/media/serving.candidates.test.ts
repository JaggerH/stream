// 荔枝那批 CDN 主机：可用性与速度都在剧烈波动，写死任何一台都会翻车。
// 实测（2026-08-05，同一时刻、同一个文件 /audio/2026/07/26/3225196661670744070_hd.mp3）：
//   cdn5.lizhi.fm    → 403（换三集测又全 206 → 不是主机死了,是「每台主机对每个文件各有各的状态」）
//   cdn101.lizhi.fm  → 206, 12.96 MB/s
//   cdn.gzlzfm.com   → 206, 104 KB/s
//   cdn102.lizhi.fm  → 206, 997 B/s（180s 拉不完 4MB）
// 差一万三千倍。荔枝 App 自己每次播放前都用 /audio_cover/cesu_hd.mp3 挨个测速挑主机。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hostStats, rejectionCooldown, serveWithPolicy, servingPolicyFor, setServingPolicySource } from './serving.ts'

const P = '/audio/2026/07/26/3225196661670744070_hd.mp3'
const ORIGIN = `http://cdn5.lizhi.fm${P}`

setServingPolicySource(() => [{
  match: '.lizhi.fm', label: '荔枝 FM',
  hosts: ['cdn101.lizhi.fm', 'cdn102.lizhi.fm', 'cdn.gzlzfm.com', 'cdn101.gzlzfm.com'],
}])

const ok = (body = 'bytes') =>
  new Response(body, { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-4/9` } })
const denied = () => new Response('<html>ACCESS DENIED</html>', { status: 403 })

function policy() {
  const p = servingPolicyFor(ORIGIN)
  if (!p) throw new Error('lizhi 应该命中策略表')
  return p
}

/** 把 fetch 换成「按 host 给不同答案」的假上游，并记录调用顺序。 */
function stubUpstream(byHost: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = new URL(String(input))
    calls.push(url.host)
    const make = byHost[url.host]
    if (!make) throw new Error(`ECONNREFUSED ${url.host}`)
    return make()
  })
  return calls
}

beforeEach(() => { rejectionCooldown.clear(); hostStats.clear() })
afterEach(() => vi.restoreAllMocks())

describe('候选主机：一台拒了就换下一台', () => {
  it('原主机 403 → 自动换候选,把成功那台的字节端出去', async () => {
    const calls = stubUpstream({ 'cdn5.lizhi.fm': denied, 'cdn101.lizhi.fm': () => ok('good') })
    const res = await serveWithPolicy(ORIGIN, policy(), 'bytes=0-4')
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('good')
    expect(calls[0]).toBe('cdn5.lizhi.fm')       // 先试接口给的那台
    expect(calls).toContain('cdn101.lizhi.fm')   // 拒了才换
  })

  it('路径与查询串原样搬到新主机上——只换 host,别的一个字符不动', async () => {
    const urls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      urls.push(String(input))
      return new URL(String(input)).host === 'cdn5.lizhi.fm' ? denied() : ok()
    })
    await serveWithPolicy(`${ORIGIN}?a=1&b=%E4%B8%AD`, policy(), undefined)
    const swapped = urls.find((u) => !u.includes('cdn5.'))!
    expect(swapped).toContain(`${P}?a=1&b=%E4%B8%AD`)
  })

  it('全部候选都拒 → 502 + 说人话,且进冷却(不再打上游)', async () => {
    const calls = stubUpstream({
      'cdn5.lizhi.fm': denied, 'cdn101.lizhi.fm': denied, 'cdn102.lizhi.fm': denied,
      'cdn.gzlzfm.com': denied, 'cdn101.gzlzfm.com': denied,
    })
    const res = await serveWithPolicy(ORIGIN, policy(), undefined)
    expect(res.status).toBe(502)
    expect((await res.json() as { detail: string }).detail).toContain('荔枝 FM')
    const n = calls.length
    expect(n).toBeGreaterThan(1)                 // 确实挨个试过
    const again = await serveWithPolicy(ORIGIN, policy(), undefined)
    expect(again.status).toBe(502)
    expect(calls.length).toBe(n)                 // 冷却窗口内一发都不再发
  })

  it('某台连不上(抛错)也只是换下一台,不算全盘失败', async () => {
    stubUpstream({ 'cdn101.lizhi.fm': () => ok('via101') })  // 其余 host 一律抛
    const res = await serveWithPolicy(ORIGIN, policy(), undefined)
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('via101')
  })
})

describe('hostStats：记住哪台快,下次优先用它', () => {
  it('实测够快的排最前;没测过的次之;实测很慢的垫后', () => {
    hostStats.note('cdn.gzlzfm.com', 104_000)      // 慢（低于 1 MB/s 的门槛）
    hostStats.note('cdn101.lizhi.fm', 12_960_000)  // 够快
    const ranked = hostStats.rank(['cdn5.lizhi.fm', 'cdn.gzlzfm.com', 'cdn101.lizhi.fm'])
    expect(ranked[0]).toBe('cdn101.lizhi.fm')
    expect(ranked[1]).toBe('cdn5.lizhi.fm')        // 没测过 → 值得探,压住已知很慢的
    expect(ranked[2]).toBe('cdn.gzlzfm.com')
  })

  it('刚失败过的主机沉到最后——但不是永久拉黑', () => {
    hostStats.fail('cdn5.lizhi.fm')
    hostStats.note('cdn102.lizhi.fm', 997)
    const ranked = hostStats.rank(['cdn5.lizhi.fm', 'cdn102.lizhi.fm'])
    expect(ranked[0]).toBe('cdn102.lizhi.fm')    // 再慢也比刚拒过的强
    expect(ranked[1]).toBe('cdn5.lizhi.fm')
  })

  // 活体撞出来的（2026-08-05）：cdn5 恢复到 206 之后速度稳定钉在 103 KB/s 不动。
  // 因为候选是「成功就停」地试，第一台能给就再也不会碰后面那台 12.9 MB/s 的。
  it('实测很慢的主机要排在「没测过」的后面——否则永远学不到更快的那台', () => {
    hostStats.note('cdn5.lizhi.fm', 103_000)     // 能用,但只有 103 KB/s
    const ranked = hostStats.rank(['cdn5.lizhi.fm', 'cdn101.lizhi.fm'])
    expect(ranked[0]).toBe('cdn101.lizhi.fm')    // 没测过的先上,去探
    expect(ranked[1]).toBe('cdn5.lizhi.fm')
  })

  it('一旦探到够快的那台,就稳住不再乱探', () => {
    hostStats.note('cdn5.lizhi.fm', 103_000)
    hostStats.note('cdn101.lizhi.fm', 12_960_000)
    const ranked = hostStats.rank(['cdn5.lizhi.fm', 'cdn101.lizhi.fm', 'cdn102.lizhi.fm'])
    expect(ranked[0]).toBe('cdn101.lizhi.fm')    // 够快 → 压住没测过的 cdn102
    expect(ranked[1]).toBe('cdn102.lizhi.fm')
    expect(ranked[2]).toBe('cdn5.lizhi.fm')
  })

  it('慢归慢,先后仍按速度排——同为「慢」时快的先试', () => {
    hostStats.note('cdn102.lizhi.fm', 997)
    hostStats.note('cdn.gzlzfm.com', 104_000)
    expect(hostStats.rank(['cdn102.lizhi.fm', 'cdn.gzlzfm.com'])[0]).toBe('cdn.gzlzfm.com')
  })

  it('记录会过期——主机状态本来就在波动,不能长期钉死在一台上', () => {
    vi.useFakeTimers()
    try {
      hostStats.note('cdn101.lizhi.fm', 12_960_000)
      expect(hostStats.rank(['cdn5.lizhi.fm', 'cdn101.lizhi.fm'])[0]).toBe('cdn101.lizhi.fm')
      vi.advanceTimersByTime(11 * 60 * 1000)
      expect(hostStats.speedOf('cdn101.lizhi.fm')).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('真实播放的字节顺带就是测速——不额外发探测请求', async () => {
    stubUpstream({ 'cdn5.lizhi.fm': () => ok('x'.repeat(200_000)) })
    const res = await serveWithPolicy(ORIGIN, policy(), undefined)
    await res.text()                              // 读完才有速度
    expect(hostStats.speedOf('cdn5.lizhi.fm')).toBeGreaterThan(0)
  })

  it('排序结果真的影响下一次的尝试顺序', async () => {
    hostStats.note('cdn101.lizhi.fm', 12_960_000)
    const calls = stubUpstream({ 'cdn101.lizhi.fm': () => ok(), 'cdn5.lizhi.fm': () => ok() })
    await serveWithPolicy(ORIGIN, policy(), undefined)
    expect(calls[0]).toBe('cdn101.lizhi.fm')      // 已知最快的先上,不再从接口给的那台开始
  })
})

describe('没有候选主机的策略：行为与从前一致', () => {
  it('policy 不声明 hosts → 只打原主机一次', async () => {
    const calls = stubUpstream({ 'cdn.example.com': () => ok('single') })
    const res = await serveWithPolicy('http://cdn.example.com/a.mp3', { match: '.example.com', label: '示例' }, undefined)
    expect(res.status).toBe(206)
    expect(calls).toEqual(['cdn.example.com'])
  })
})
