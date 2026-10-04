import { describe, it, expect } from 'vitest'
import { pickCodeLayer, pickLayers, applyLayerPick } from './pick-layer.ts'
import type { StreamPackage } from './scan.ts'

const pkg = (over: Partial<StreamPackage> & { id: string }): StreamPackage =>
  ({ dir: `/x/${over.id}`, ...over }) as StreamPackage

const CODE = { entry: 'dist/index.js', enrichers: ['e'] }

describe('pickLayers（同 npm 名两层都在：整包只留版本高的一层——代码 / manifests / recipe / 声明同一把尺）', () => {
  it('用户层严格更高 → 内置进 skipBuiltinNames；更低 / 相等 / 缺版本 → 用户层进 skipUserNames；每对只报一行', () => {
    const logs: string[] = []
    const pick = pickLayers(
      [
        { pkgName: '@s/high', pkgVersion: '1.0.0' },
        { pkgName: '@s/low', pkgVersion: '2.0.0' },
        { pkgName: '@s/eq', pkgVersion: '1.0.0' },
        { pkgName: '@s/nover' },
        { pkgName: '@s/alone', pkgVersion: '1.0.0' },
      ],
      [
        { pkgName: '@s/high', pkgVersion: '1.2.0' },
        { pkgName: '@s/low', pkgVersion: '1.9.9' },
        { pkgName: '@s/eq', pkgVersion: '1.0.0' },
        { pkgName: '@s/nover', pkgVersion: '9.0.0' },
        { pkgName: '@t/other', pkgVersion: '9.0.0' },
        { pkgVersion: '9.0.0' },   // 没有 npm 名的本地包：不参与
      ],
      (m) => logs.push(m),
    )
    expect([...pick.skipBuiltinNames]).toEqual(['@s/high'])
    expect([...pick.skipUserNames].sort()).toEqual(['@s/eq', '@s/low', '@s/nover'])
    expect(logs).toEqual([
      '[stream] package @s/high: user layer 1.2.0 supersedes builtin 1.0.0',
      '[stream] package @s/low: builtin 2.0.0 kept, user layer 1.9.9 skipped',
      '[stream] package @s/eq: builtin 1.0.0 kept, user layer 1.0.0 skipped',
      '[stream] package @s/nover: builtin (none) kept, user layer 9.0.0 skipped',
    ])
  })

  it('不传 log 就一个字不说（sources 域那两遍算的是同一份结论）', () => {
    expect(() => pickLayers([{ pkgName: '@s/a', pkgVersion: '1.0.0' }], [{ pkgName: '@s/a', pkgVersion: '2.0.0' }])).not.toThrow()
  })

  it('applyLayerPick 按结论把两层过一遍：被跳过的整包剔除，其余原样', () => {
    const b1 = { pkgName: '@s/high', pkgVersion: '1.0.0', id: 'b1' }
    const b2 = { pkgName: '@s/low', pkgVersion: '2.0.0', id: 'b2' }
    const u1 = { pkgName: '@s/high', pkgVersion: '1.2.0', id: 'u1' }
    const u2 = { pkgName: '@s/low', pkgVersion: '1.0.0', id: 'u2' }
    const u3 = { pkgVersion: '1.0.0', id: 'u3' }
    const pick = pickLayers([b1, b2], [u1, u2, u3])
    expect(applyLayerPick(pick, [b1, b2], [u1, u2, u3])).toEqual({ builtin: [b2], user: [u1, u3] })
  })
})

describe('pickCodeLayer（代码那条路吃 pickLayers 的结论；出去的用户层只剩带 code 的）', () => {
  it('用户层严格更高 → 内置那份剔除、用户层进；日志说 supersedes', () => {
    const logs: string[] = []
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.2.0', code: CODE, dir: '/user/@streamapp__xhs' })
    const other = pkg({ id: 'alpha', pkgName: '@streamapp/alpha', normalizer: 'n' })
    const out = pickCodeLayer([b, other], [u], (m) => logs.push(m))
    expect(out.builtin).toEqual([other])
    expect(out.user).toEqual([u])
    expect(logs).toEqual(['[stream] package @streamapp/xhs: user layer 1.2.0 supersedes builtin 1.0.0'])
  })

  it('用户层更低 → 内置留住、用户层跳过；日志说 kept / skipped', () => {
    const logs: string[] = []
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.2.0', code: CODE })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.1.9', code: CODE, dir: '/user/x' })
    const out = pickCodeLayer([b], [u], (m) => logs.push(m))
    expect(out.builtin).toEqual([b])
    expect(out.user).toEqual([])
    expect(logs).toEqual(['[stream] package @streamapp/xhs: builtin 1.2.0 kept, user layer 1.1.9 skipped'])
  })

  it('版本相等 → 内置', () => {
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE, dir: '/user/x' })
    const out = pickCodeLayer([b], [u], () => {})
    expect(out.builtin).toEqual([b])
    expect(out.user).toEqual([])
  })

  it('任一层缺版本 / 版本不合法 → 内置（看不懂的版本号不许赢），日志把缺席写成 (none)', () => {
    const logs: string[] = []
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE })
    const noVer = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', code: CODE, dir: '/user/a' })
    const badVer = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: 'v9.9.9', code: CODE, dir: '/user/b' })
    expect(pickCodeLayer([b], [noVer], (m) => logs.push(m)).user).toEqual([])
    expect(pickCodeLayer([b], [badVer], () => {}).user).toEqual([])
    expect(logs).toEqual(['[stream] package @streamapp/xhs: builtin 1.0.0 kept, user layer (none) skipped'])
    // 内置缺版本、用户层再高也不赢
    const bNoVer = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', code: CODE })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '9.0.0', code: CODE, dir: '/user/c' })
    const out = pickCodeLayer([bNoVer], [u], () => {})
    expect(out.builtin).toEqual([bNoVer])
    expect(out.user).toEqual([])
  })

  it('判据是 npm 名不是 stream.id：id 撞上、npm 名不同 → 两层都进（撞名由 activatePackages 自己拒）', () => {
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE })
    const u = pkg({ id: 'xhs', pkgName: '@third/xhs', pkgVersion: '9.0.0', code: CODE, dir: '/user/x' })
    const out = pickCodeLayer([b], [u], () => {})
    expect(out.builtin).toEqual([b])
    expect(out.user).toEqual([u])
  })

  it('没有 npm 名的那侧（手放的本地开发包）不参与比对', () => {
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE })
    const local = pkg({ id: 'xhs', pkgVersion: '9.0.0', code: CODE, dir: '/user/xhs' })
    const out = pickCodeLayer([b], [local], () => {})
    expect(out.builtin).toEqual([b])
    expect(out.user).toEqual([local])
  })

  it('内置同名但不带 code（纯 recipe 包）且版本更高 → 用户层整包跳过，它的代码也不进（判"谁高"看整个包，不只看带 code 的）', () => {
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '9.0.0', facility: 'xhs' })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE, dir: '/user/x' })
    const out = pickCodeLayer([b], [u], () => {})
    expect(out.builtin).toEqual([b])
    expect(out.user).toEqual([])
    expect([...out.pick.skipUserNames]).toEqual(['@streamapp/xhs'])
  })

  it('用户层带 code 的新版顶掉一个不带 code 的内置 → 内置整包剔除、结论在 pick 里（curated 投影靠它摘内置的 manifests.yaml）', () => {
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', facility: 'xhs' })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '2.0.0', code: CODE, dir: '/user/x' })
    const out = pickCodeLayer([b], [u], () => {})
    expect(out.builtin).toEqual([])
    expect(out.user).toEqual([u])
    expect([...out.pick.skipBuiltinNames]).toEqual(['@streamapp/xhs'])
  })

  it('用户层不带 code 的包不进激活名单，但不带 code 也不影响它把内置顶掉', () => {
    const b = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '1.0.0', code: CODE })
    const u = pkg({ id: 'xhs', pkgName: '@streamapp/xhs', pkgVersion: '2.0.0', facility: 'xhs', dir: '/user/x' })
    const out = pickCodeLayer([b], [u], () => {})
    expect(out.builtin).toEqual([])
    expect(out.user).toEqual([])
  })

  it('无同名 → 两层原样', () => {
    const b = pkg({ id: 'a', pkgName: '@s/a', pkgVersion: '1.0.0', code: CODE })
    const u = pkg({ id: 'b', pkgName: '@t/b', pkgVersion: '1.0.0', code: CODE, dir: '/user/b' })
    const logs: string[] = []
    const out = pickCodeLayer([b], [u], (m) => logs.push(m))
    expect(out.builtin).toEqual([b])
    expect(out.user).toEqual([u])
    expect(logs).toEqual([])
  })
})
