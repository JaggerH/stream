import { describe, it, expect } from 'vitest'
import type { PluginBackend } from '../plugins/types.ts'
import {
  THIRD_PARTY_LIMITS,
  DEFAULT_STANDBY_IDLE_MINUTES,
  assignedServiceName,
  prefixedVolume,
  clampThirdPartyBackend,
  summarizeBackend,
} from './container-policy.ts'

/** 一份合规的最小声明；每个用例只改自己要测的那一格。 */
function ok(over: Partial<PluginBackend> = {}): PluginBackend {
  return { image: 'ghcr.io/someone/thing:1.0', port: 8080, mem: '1G', ...over }
}

describe('assignedServiceName', () => {
  it('service 名恒等于包 id（包不许自己选）', () => {
    expect(assignedServiceName('acme-scraper')).toBe('acme-scraper')
  })
})

describe('prefixedVolume', () => {
  it('给命名卷加包前缀，挂载点原样保留', () => {
    expect(prefixedVolume('acme', 'data:/var/lib/data')).toBe('acme_data:/var/lib/data')
  })

  it('保留挂载选项段（:ro）', () => {
    expect(prefixedVolume('acme', 'cache:/cache:ro')).toBe('acme_cache:/cache:ro')
  })

  it('两个不同包的同名卷改写后不相等（不该变成共享存储）', () => {
    expect(prefixedVolume('acme', 'data:/x')).not.toBe(prefixedVolume('globex', 'data:/x'))
  })
})

describe('clampThirdPartyBackend — 拒绝清单', () => {
  it('声明了 service → 拒，消息说清由宿主指派 = 包 id', () => {
    expect(() => clampThirdPartyBackend('acme', ok({ service: 'whatever' }))).toThrow(/service/)
    expect(() => clampThirdPartyBackend('acme', ok({ service: 'whatever' }))).toThrow(/acme/)
  })

  it('没声明 mem → 拒（不限制 = 可以吃满宿主内存）', () => {
    const b = ok()
    delete b.mem
    expect(() => clampThirdPartyBackend('acme', b)).toThrow(/mem/)
  })

  it('mem 多大都放行，值原样（装包 = 信任作者，不设上限）', () => {
    expect(clampThirdPartyBackend('acme', ok({ mem: '16G' })).mem).toBe('16G')
  })

  it('mem 解析不了 → 拒（绝不静默当成不限制）', () => {
    expect(() => clampThirdPartyBackend('acme', ok({ mem: 'lots' }))).toThrow()
  })

  it.each([
    ['绝对路径', '/etc:/etc'],
    ['相对路径', './data:/data'],
    ['上级目录', '../secrets:/s'],
    ['环境变量插值', '${HOME}/x:/x'],
    ['Windows 盘符', 'C:\\Users\\me:/x'],
    ['反斜杠路径', 'C:\\x:/x'],
  ])('volumes 里有宿主路径 bind（%s）→ 拒', (_label, mount) => {
    expect(() => clampThirdPartyBackend('acme', ok({ volumes: [mount] }))).toThrow(/卷|volume/i)
  })

  it('volumes 条数超上限 → 拒', () => {
    const many = Array.from({ length: THIRD_PARTY_LIMITS.maxVolumes + 1 }, (_, i) => `v${i}:/m${i}`)
    expect(() => clampThirdPartyBackend('acme', ok({ volumes: many }))).toThrow(
      new RegExp(String(THIRD_PARTY_LIMITS.maxVolumes)),
    )
  })

  it('env 条数超上限 → 拒', () => {
    const env: Record<string, string> = {}
    for (let i = 0; i <= THIRD_PARTY_LIMITS.maxEnvEntries; i++) env[`K${i}`] = 'v'
    expect(() => clampThirdPartyBackend('acme', ok({ env }))).toThrow(/env/)
  })

  it('env 单值超长 → 拒', () => {
    const env = { BIG: 'x'.repeat(THIRD_PARTY_LIMITS.maxEnvValueLength + 1) }
    expect(() => clampThirdPartyBackend('acme', ok({ env }))).toThrow(/BIG/)
  })

  it('env 用 STREAM_ 前缀（宿主命名空间）→ 拒', () => {
    expect(() => clampThirdPartyBackend('acme', ok({ env: { STREAM_PORT: '1' } }))).toThrow(/STREAM_/)
  })

  it('声明了 publish → 拒（第三方不该有额外的宿主管理口）', () => {
    expect(() => clampThirdPartyBackend('acme', ok({ publish: 5244 }))).toThrow(/publish/)
  })

  it('声明了 dev → 拒（bind-mount 源码的开发期覆盖）', () => {
    expect(() =>
      clampThirdPartyBackend('acme', ok({ dev: { image: 'python:3.11', mount: '/home/me/src', command: 'x' } })),
    ).toThrow(/dev/)
  })

  it('卷格式不是 name:/path → 拒', () => {
    expect(() => clampThirdPartyBackend('acme', ok({ volumes: ['data'] }))).toThrow(/name:\/path/)
    expect(() => clampThirdPartyBackend('acme', ok({ volumes: ['data:relative'] }))).toThrow(/name:\/path/)
  })

  it('包 id 本身不是合法卷名前缀（含路径分隔符）→ 拒，不静默造出一个 bind', () => {
    expect(() => clampThirdPartyBackend('@scope/pkg', ok({ volumes: ['data:/x'] }))).toThrow()
  })

  it('声明了 gpu → 放行，原样落盘（要不要显卡是包作者的诚实声明，安装门不替用户拒）', () => {
    expect(clampThirdPartyBackend('acme', ok({ gpu: true })).gpu).toBe(true)
  })

  it.each([
    ['没有 tag', 'ghcr.io/someone/thing'],
    [':latest', 'ghcr.io/someone/thing:latest'],
  ])('image %s → 拒：stream update 靠换 tag 触发重建，浮动 tag 永远重建不了', (_label, image) => {
    expect(() => clampThirdPartyBackend('acme', ok({ image }))).toThrow(/latest|tag/)
    expect(() => clampThirdPartyBackend('acme', ok({ image }))).toThrow(/stream update/)
  })

  it('image 钉了版本 tag 或 digest → 放行', () => {
    expect(clampThirdPartyBackend('acme', ok({ image: 'ghcr.io/someone/thing:1.2.3' })).image).toBe('ghcr.io/someone/thing:1.2.3')
    expect(clampThirdPartyBackend('acme', ok({ image: 'ghcr.io/someone/thing@sha256:abc' })).image).toBe('ghcr.io/someone/thing@sha256:abc')
    // registry 带端口不是 tag：`host:5000/x` 没有 tag，`host:5000/x:1.0` 有。
    expect(() => clampThirdPartyBackend('acme', ok({ image: 'registry.local:5000/thing' }))).toThrow(/tag/)
    expect(clampThirdPartyBackend('acme', ok({ image: 'registry.local:5000/thing:1.0' })).image).toBe('registry.local:5000/thing:1.0')
  })

  it('声明了 user → 拒（第三方容器跑成谁由镜像自己定，root 这一格只给内置包）', () => {
    expect(() => clampThirdPartyBackend('acme', ok({ user: '0:0' }))).toThrow(/user/)
    expect(() => clampThirdPartyBackend('acme', ok({ user: '0:0' }))).toThrow(/镜像/)
  })

  it('gpu: false 不算声明 GPU → 放行', () => {
    expect(clampThirdPartyBackend('acme', ok({ gpu: false })).service).toBe('acme')
  })
})

describe('clampThirdPartyBackend — standby 兜底（不拒，宿主补默认值）', () => {
  it('没声明 standby → 补一个默认值（闲置 30 分钟回收），而不是拒', () => {
    expect(clampThirdPartyBackend('acme', ok()).standby).toEqual({ idleMinutes: DEFAULT_STANDBY_IDLE_MINUTES })
  })

  it('默认值是 30 分钟', () => {
    expect(DEFAULT_STANDBY_IDLE_MINUTES).toBe(30)
  })

  it('自己声明了 standby → 原样保留，不被默认值顶掉', () => {
    const out = clampThirdPartyBackend('acme', ok({ standby: { idleMinutes: 5, startTimeoutSeconds: 120 } }))
    expect(out.standby).toEqual({ idleMinutes: 5, startTimeoutSeconds: 120 })
  })

  it('兜底值进的是钳制后的声明本身（= 落盘 / preview 看到的那一份）', () => {
    const out = clampThirdPartyBackend('acme', ok())
    expect(summarizeBackend(out).standby.idleMinutes).toBe(DEFAULT_STANDBY_IDLE_MINUTES)
  })
})

describe('summarizeBackend', () => {
  it('env 只给键名，值不外泄', () => {
    const out = clampThirdPartyBackend('acme', ok({ env: { API_TOKEN: 'super-secret', LANG: 'C' } }))
    const summary = summarizeBackend(out)
    expect(summary.envKeys).toEqual(['API_TOKEN', 'LANG'])
    expect(JSON.stringify(summary)).not.toContain('super-secret')
  })

  it('给的是钳制后的 service 名与加了前缀的卷名', () => {
    const out = clampThirdPartyBackend('acme', ok({ volumes: ['data:/x'] }))
    expect(summarizeBackend(out)).toMatchObject({
      image: 'ghcr.io/someone/thing:1.0',
      service: 'acme',
      port: 8080,
      mem: '1G',
      volumes: ['acme_data:/x'],
      envKeys: [],
    })
  })

  it('拿原始声明（未钳制）来做摘要 → 抛，绝不给出一份与落盘不一致的摘要', () => {
    expect(() => summarizeBackend(ok())).toThrow(/clampThirdPartyBackend/)
  })

  it('gpu 只在声明了 gpu: true 时出现；没声明的没有这一格（不是 false）', () => {
    expect(summarizeBackend(clampThirdPartyBackend('mineru', ok({ gpu: true }))).gpu).toBe(true)
    expect('gpu' in summarizeBackend(clampThirdPartyBackend('mineru', ok()))).toBe(false)
    expect('gpu' in summarizeBackend(clampThirdPartyBackend('acme', ok({ gpu: false })))).toBe(false)
  })
})

describe('clampThirdPartyBackend — 合规时的钳制', () => {
  it('指派 service = 包 id，卷加包前缀，其余原样', () => {
    const out = clampThirdPartyBackend(
      'acme',
      ok({ volumes: ['data:/var/lib/data', 'cache:/cache'], env: { LANG: 'C' }, health: '/healthz' }),
    )
    expect(out.service).toBe('acme')
    expect(out.volumes).toEqual(['acme_data:/var/lib/data', 'acme_cache:/cache'])
    expect(out.env).toEqual({ LANG: 'C' })
    expect(out.health).toBe('/healthz')
    expect(out.image).toBe('ghcr.io/someone/thing:1.0')
    expect(out.port).toBe(8080)
  })

  it('不改原声明（返回新对象）', () => {
    const input = ok({ volumes: ['data:/x'] })
    const out = clampThirdPartyBackend('acme', input)
    expect(input.service).toBeUndefined()
    expect(input.volumes).toEqual(['data:/x'])
    expect(out).not.toBe(input)
  })

  it('钳制只做一次：返回值再喂回来会被拒（service 已被指派，卷不会被二次加前缀）', () => {
    const once = clampThirdPartyBackend('acme', ok({ volumes: ['data:/x'] }))
    expect(() => clampThirdPartyBackend('acme', once)).toThrow(/service/)
  })

  it('没有 volumes / env 时不凭空造出这两格', () => {
    const out = clampThirdPartyBackend('acme', ok())
    expect(out.volumes).toBeUndefined()
    expect(out.env).toBeUndefined()
  })
})

describe('clampThirdPartyBackend — health 是拼进 URL 的，必须是本机绝对路径（终审 Important 1）', () => {
  it("health: '@evil.com/' → 拒。放行的话 host 档拼出 http://127.0.0.1:34567@evil.com/，host 是 evil.com", () => {
    expect(() => clampThirdPartyBackend('acme', ok({ health: '@evil.com/' }))).toThrow(/health/)
    // 这条判据的全部理由：拼接后 URL 解析出来的 host 不是本机。
    expect(new URL(`http://127.0.0.1:34567${'@evil.com/'}`).host).toBe('evil.com')
  })

  it("health: '//evil.com/' → 拒（带前导斜杠也不行：协议相对 URL 同样换 host）", () => {
    expect(() => clampThirdPartyBackend('acme', ok({ health: '//evil.com/' }))).toThrow(/health/)
    expect(new URL('//evil.com/', 'http://127.0.0.1:34567').host).toBe('evil.com')
  })

  it("health: 'healthz'（漏了斜杠）→ 拒，消息说清要写成 /healthz", () => {
    expect(() => clampThirdPartyBackend('acme', ok({ health: 'healthz' }))).toThrow(/\/healthz/)
  })

  it("health: '/healthz' 原样放行", () => {
    expect(clampThirdPartyBackend('acme', ok({ health: '/healthz' })).health).toBe('/healthz')
  })
})

describe('clampThirdPartyBackend — 时间那两格有上界（终审 Important 2）', () => {
  it(`startTimeoutSeconds 超过 ${THIRD_PARTY_LIMITS.maxStartTimeoutSeconds}s → 拒（provision 是 bootstrap 里 await 的串行循环，它就是开机时长）`, () => {
    expect(() =>
      clampThirdPartyBackend('acme', ok({ standby: { idleMinutes: 30, startTimeoutSeconds: 86_400 } })),
    ).toThrow(/startTimeoutSeconds/)
  })

  it('上界内的 startTimeoutSeconds 原样保留', () => {
    const out = clampThirdPartyBackend('acme', ok({ standby: { idleMinutes: 30, startTimeoutSeconds: 120 } }))
    expect(out.standby?.startTimeoutSeconds).toBe(120)
  })

  it(`idleMinutes 超过 ${THIRD_PARTY_LIMITS.maxIdleMinutes} 分钟 → 拒（等于声明常驻）`, () => {
    expect(() => clampThirdPartyBackend('acme', ok({ standby: { idleMinutes: 60 * 24 * 30 } }))).toThrow(/idleMinutes/)
  })
})

describe('clampThirdPartyBackend — 包 id 的文法（终审 Minor 4）', () => {
  it('大写 id → 拒：撞名闸门是精确比较，Alist 挡不住、却会另建一个容器和 /_p 路由', () => {
    expect(() => clampThirdPartyBackend('Alist', ok())).toThrow(/id/)
  })

  it.each(['acme scraper', 'acme.scraper', '@scope/acme', '-acme', '_acme'])('非法 id %j → 拒', (id) => {
    expect(() => clampThirdPartyBackend(id, ok())).toThrow(/id/)
  })

  it.each(['acme', 'acme-scraper', 'acme_scraper', 'a1'])('合法 id %j → 放行', (id) => {
    expect(clampThirdPartyBackend(id, ok()).service).toBe(id)
  })
})

describe('clampThirdPartyBackend — 放行 gpu / 大 mem 不等于放行一切', () => {
  it('gpu: true + mem 10G 的 GPU 包装得上，service / dev / user 仍拒', () => {
    const b = clampThirdPartyBackend('mineru', ok({ gpu: true, mem: '10G' }))
    expect(b.gpu).toBe(true)
    expect(b.mem).toBe('10G')
    expect(() => clampThirdPartyBackend('mineru', ok({ gpu: true, service: 'x' }))).toThrow(/service/)
    expect(() => clampThirdPartyBackend('mineru', ok({ gpu: true, dev: { image: 'i', mount: './x', workdir: '/src', command: 'c' } }))).toThrow(/dev/)
    expect(() => clampThirdPartyBackend('mineru', ok({ gpu: true, user: '0:0' }))).toThrow(/user/)
  })
})
