import { describe, it, expect } from 'vitest'
import { TokenProvider } from './token-provider.ts'

const map = { cloudflare: 'CLOUDFLARE_WORKERS_AI_TOKEN' }

describe('TokenProvider', () => {
  it('resolves a token auth to envOverrides', async () => {
    const p = new TokenProvider(map, { CLOUDFLARE_WORKERS_AI_TOKEN: 'secret' } as NodeJS.ProcessEnv)
    expect(await p.resolve({ type: 'token', name: 'cloudflare' })).toEqual({
      envOverrides: { CLOUDFLARE_WORKERS_AI_TOKEN: 'secret' },
    })
  })

  it('returns null for unknown name or missing env or non-token auth', async () => {
    const p = new TokenProvider(map, {} as NodeJS.ProcessEnv)
    expect(await p.resolve({ type: 'token', name: 'cloudflare' })).toBeNull() // env missing
    expect(await p.resolve({ type: 'token', name: 'nope' })).toBeNull() // unmapped
    expect(await p.resolve({ type: 'cookie', domain: 'x.com', inject: { kind: 'env', name: 'TWITTER_COOKIE' } })).toBeNull() // wrong type
  })

  it('token() gives direct access for host consumers', () => {
    const p = new TokenProvider(map, { CLOUDFLARE_WORKERS_AI_TOKEN: 'secret' } as NodeJS.ProcessEnv)
    expect(p.token('cloudflare')).toBe('secret')
    expect(p.token('nope')).toBeNull()
  })

  // 两层：runtime_config 存的那份 > env。存的那份赢，是因为它能不重启就变——一把在运行时
  // 才拿到的 key（recipe 自己去建的那种）必须当场生效；env 悄悄压过它，整条"让 recipe 去取 key"
  // 的路看起来就像什么都没发生。
  describe('runtime_config 覆盖层', () => {
    const env = { CLOUDFLARE_WORKERS_AI_TOKEN: 'from-env' } as NodeJS.ProcessEnv

    it('两层都有 → 存的那份赢', async () => {
      const p = new TokenProvider(map, env, () => 'from-store')
      expect(p.token('cloudflare')).toBe('from-store')
      expect(await p.resolve({ type: 'token', name: 'cloudflare' })).toEqual({
        envOverrides: { CLOUDFLARE_WORKERS_AI_TOKEN: 'from-store' },
      })
    })

    it('没存过 → 落回 env（既有部署一行不改照常工作）', async () => {
      const p = new TokenProvider(map, env, () => null)
      expect(p.token('cloudflare')).toBe('from-env')
      expect(await p.resolve({ type: 'token', name: 'cloudflare' })).toEqual({
        envOverrides: { CLOUDFLARE_WORKERS_AI_TOKEN: 'from-env' },
      })
    })

    it('存了空串 → 当作没存，不要把一个空 key 当成"配置好了"', () => {
      expect(new TokenProvider(map, env, () => '').token('cloudflare')).toBe('from-env')
    })

    it('两层都没有 → null', () => {
      expect(new TokenProvider(map, {} as NodeJS.ProcessEnv, () => null).token('cloudflare')).toBeNull()
    })
  })

  // layer() 与 token()/resolve() 同一套两层取值逻辑,但只报"哪一层"不报值——供 keyState
  // 这类"看有没有配"的视图字段用,绝不能把 secret 值本身带出去。
  describe('layer()', () => {
    it('layer: stored 优先于 env,都无为 null', () => {
      const tp = new TokenProvider({ groq: 'GROQ_API_KEY' }, { GROQ_API_KEY: 'e' } as NodeJS.ProcessEnv, (n) => (n === 'groq' ? 's' : null))
      expect(tp.layer('groq')).toBe('stored')
      expect(new TokenProvider({ groq: 'GROQ_API_KEY' }, { GROQ_API_KEY: 'e' } as NodeJS.ProcessEnv, () => null).layer('groq')).toBe('env')
      expect(new TokenProvider({ groq: 'GROQ_API_KEY' }, {} as NodeJS.ProcessEnv, () => null).layer('groq')).toBe(null)
    })
  })
})
