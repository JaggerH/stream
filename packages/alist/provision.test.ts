import { describe, expect, it, vi } from 'vitest'
import { alistLogin, dockerAdminSet, fetchPermanentToken, provisionAlist, type AlistCredentials, type ExecFileLike, type ProvisionDeps } from './provision.ts'

/** login 成功的 fetch mock（记录密码以便断言用的是哪个密码登录）。 */
function loginOk(token = 'jwt-1'): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ code: 200, message: 'success', data: { token } }), { status: 200 }),
  ) as unknown as typeof fetch
}

function loginFail(code = 400): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ code, message: 'password is incorrect' }), { status: 200 }),
  ) as unknown as typeof fetch
}

function makeDeps(overrides: Partial<ProvisionDeps> & { stored?: Partial<AlistCredentials> } = {}) {
  let stored: Partial<AlistCredentials> = overrides.stored ?? {}
  const execAdminSet = vi.fn(async () => {})
  const deps: ProvisionDeps = {
    baseUrl: 'http://alist:5244',
    getStored: () => stored,
    save: (c) => { stored = c },
    execAdminSet,
    fetchFn: loginOk(),
    genPassword: () => 'generated-pw',
    ...overrides,
  }
  return { deps, execAdminSet, readStored: () => stored }
}

describe('fetchPermanentToken（给 DSH 网盘插件递的必须是永久 token，不是 48h JWT——netdisk spec §5.3）', () => {
  it('GET /api/admin/setting/get?key=token，JWT 裸放 Authorization 头，回 value', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = []
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization })
      return new Response(JSON.stringify({ code: 200, message: 'success', data: { key: 'token', value: 'alist-perm-1' } }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(fetchPermanentToken('http://alist:5244/', 'jwt-1', fetchFn)).resolves.toBe('alist-perm-1')
    expect(calls).toEqual([{ url: 'http://alist:5244/api/admin/setting/get?key=token', auth: 'jwt-1' }])
  })

  it('code 非 200（JWT 过期 → 401）→ throw 带 code，调用方据此决定要不要重登', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ code: 401, message: 'expired' }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchPermanentToken('http://alist:5244', 'jwt-old', fetchFn)).rejects.toThrow(/401/)
  })
})

describe('provisionAlist', () => {
  it('全新容器：生成密码 → admin set → login → 持久化', async () => {
    const { deps, execAdminSet, readStored } = makeDeps()
    const token = await provisionAlist(deps)
    expect(execAdminSet).toHaveBeenCalledExactlyOnceWith('generated-pw')
    expect(token).toBe('jwt-1')
    expect(readStored()).toEqual({ password: 'generated-pw', token: 'jwt-1' })
  })

  it('幂等：已有密码 → 不重设密码，只刷新 token', async () => {
    const { deps, execAdminSet, readStored } = makeDeps({
      stored: { password: 'old-pw', token: 'stale' },
      fetchFn: loginOk('jwt-2'),
    })
    const token = await provisionAlist(deps)
    expect(execAdminSet).not.toHaveBeenCalled()
    expect(token).toBe('jwt-2')
    expect(readStored()).toEqual({ password: 'old-pw', token: 'jwt-2' })
  })

  it('密码漂移（volume 重建）：login 失败 → 用存储密码重设 → 再 login', async () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return calls === 1
        ? new Response(JSON.stringify({ code: 400, message: 'password is incorrect' }), { status: 200 })
        : new Response(JSON.stringify({ code: 200, data: { token: 'jwt-3' } }), { status: 200 })
    }) as unknown as typeof fetch
    const { deps, execAdminSet, readStored } = makeDeps({ stored: { password: 'old-pw' }, fetchFn })
    const token = await provisionAlist(deps)
    expect(execAdminSet).toHaveBeenCalledExactlyOnceWith('old-pw') // 密码保持稳定，不换新
    expect(token).toBe('jwt-3')
    expect(readStored()).toEqual({ password: 'old-pw', token: 'jwt-3' })
  })

  it('重设后仍登录失败 → throw（调用方决定降级）', async () => {
    const { deps } = makeDeps({ fetchFn: loginFail() })
    await expect(provisionAlist(deps)).rejects.toThrow(/login 失败/)
  })
})

describe('dockerAdminSet', () => {
  it('按 compose service 标签找容器，再 exec 进那个 id（不猜容器名）', async () => {
    const calls: string[][] = []
    const exec: ExecFileLike = async (_cmd, args) => {
      calls.push(args)
      return { stdout: args[0] === 'ps' ? 'abc123\n' : '' }
    }
    await dockerAdminSet('alist', exec)('pw-1')
    expect(calls).toEqual([
      ['ps', '-q', '--filter', 'label=com.docker.compose.service=alist'],
      ['exec', 'abc123', './openlist', 'admin', 'set', 'pw-1'],
    ])
  })

  it('没有运行中的容器 → throw 说清是哪个 service，不去 exec', async () => {
    const calls: string[][] = []
    const exec: ExecFileLike = async (_cmd, args) => { calls.push(args); return { stdout: '\n' } }
    await expect(dockerAdminSet('alist', exec)('pw')).rejects.toThrow(/service=alist/)
    expect(calls).toHaveLength(1)
  })
})

describe('alistLogin', () => {
  it('成功返回 token', async () => {
    await expect(alistLogin('http://alist:5244/', 'pw', loginOk('t'))).resolves.toBe('t')
  })
  it('code 非 200 → throw 带 message', async () => {
    await expect(alistLogin('http://alist:5244', 'pw', loginFail(401))).rejects.toThrow(/401/)
  })
})
