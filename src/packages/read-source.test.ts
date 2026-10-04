import { describe, it, expect, vi } from 'vitest'
import { qualifyOwnSourceId, makePackageReadSource, type ReadSourceImpl } from './read-source.ts'

const npmPkg = { pkgName: '@t/alpha', dir: '/tmp/alpha' }
const localPkg = { dir: '/tmp/handmade' }

describe('qualifyOwnSourceId', () => {
  it('裸名按本包的 npm 名限定——与 recipe `meta.uses` 同一条规矩', () => {
    expect(qualifyOwnSourceId(npmPkg, 'alpha-detail')).toBe('@t/alpha/alpha-detail')
  })

  it('没有 npm 名的手放包，前缀是 local/<目录名>（和装载期给它的全名一致）', () => {
    expect(qualifyOwnSourceId(localPkg, 'x')).toBe('local/handmade/x')
  })

  it('本包前缀的全名原样放行', () => {
    expect(qualifyOwnSourceId(npmPkg, '@t/alpha/alpha-detail')).toBe('@t/alpha/alpha-detail')
  })

  it('别家包的全名一律抛——一个包只许跑自己的源', () => {
    expect(() => qualifyOwnSourceId(npmPkg, '@t/beta/beta-detail')).toThrow(/只能运行自己声明的源/)
    // 前缀只差一段也不行：`@t/alpha-x/…` 不是 `@t/alpha/…`。
    expect(() => qualifyOwnSourceId(npmPkg, '@t/alpha-x/detail')).toThrow(/只能运行自己声明的源/)
  })

  it('不合法的局部名（含 `:` / 空串）按 sourceId 文法拒', () => {
    expect(() => qualifyOwnSourceId(npmPkg, '')).toThrow()
    expect(() => qualifyOwnSourceId(npmPkg, 'a:b')).toThrow(/':'/)
  })
})

describe('makePackageReadSource', () => {
  it('实现还没回填时调用就抛"还没接线"，不静默回空', async () => {
    const readSource = makePackageReadSource(npmPkg, () => undefined)
    await expect(readSource('alpha-detail', {})).rejects.toThrow(/还没接线/)
  })

  it('回填后按限定过的全名转发，params / signal 原样带过去，且不带 userInitiated', async () => {
    const impl = vi.fn<ReadSourceImpl>(async () => [{ ok: 1 }])
    let current: ReadSourceImpl | undefined
    const readSource = makePackageReadSource(npmPkg, () => current)
    current = impl
    const ac = new AbortController()
    const items = await readSource('alpha-detail', { noteId: 'n1' }, { signal: ac.signal })
    expect(items).toEqual([{ ok: 1 }])
    expect(impl).toHaveBeenCalledWith('@t/alpha/alpha-detail', { noteId: 'n1' }, { signal: ac.signal })
    const opts = impl.mock.calls[0]![2] as Record<string, unknown>
    expect('userInitiated' in opts).toBe(false)
  })

  it('别家的源在转发之前就被拒，实现一次都不会被叫', async () => {
    const impl = vi.fn(async () => [])
    const readSource = makePackageReadSource(npmPkg, () => impl)
    await expect(readSource('@t/beta/x', {})).rejects.toThrow(/只能运行自己声明的源/)
    expect(impl).not.toHaveBeenCalled()
  })
})
