import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_LAYER_SCAN, loadRecipePackages, providerDeclarationsOf } from '../replay/recipe-package.ts'
import { loadPlugins } from '../plugins/loader.ts'
import { identityOf, setPackageIdentities } from '../providers/identities.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { PROVIDER_CALLSITES, providerCallsite } from '../providers/callsites.ts'
import { callSitesOf } from '../providers/seed.ts'
import { NETDISK_SAVE_DEST } from '../../shared/netdisk/save-dest.ts'

/**
 * 夸克 / 百度网盘的 Provider 行住在各自的包里（`packages/{quark,baidu}/package.json#stream.providers`），
 * 宿主静态表里不再有点名网盘的行。这里对**真实出货的 `packages/`** 钉住：行由包出、身份与搬家前
 * 逐字段一致（存量库里那几条行因此被认成同一条系统行，不会被当成"代码删了"清退）、调用点的默认行
 * 与搬家前一致、成员指的源真实存在。
 *
 * 成员仍指 `@streamapp/builtin/quark-{save,play,folder}`：那三个 mode 是宿主对网盘能力的通用实现
 * （逻辑本体住 `shared/netdisk/`，包不能 import 它），搬的只是"哪条行、什么调用点、什么默认成员"。
 */
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))
const loaded = loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN)
const pkgs = loaded.descriptors
const knownSources = new Set<string>([
  ...loaded.recipes.keys(),
  ...pkgs.flatMap((d) => d.sources.map((s) => s.id)),
  ...loadPlugins(PACKAGES_DIR).flatMap((p) => (p.sources ?? []).map((s) => s.id)),
])

/** 搬家前宿主静态表里的五条行（逐字段抄下来，作为"同一条行"的判据）。 */
const BEFORE = [
  {
    id: 'netdisk-verify-quark', declaredBy: '@streamapp/quark', serveKeys: ['quark-verify'], callsite: 'netdisk.share.verify',
    label: '夸克分享验活',
    description: '夸克分享 id → 是否存活 + 文件列表（文件名是判断"是不是我要的"的最强信号）',
    members: [{ source: '@streamapp/quark/quark-share', params: { pwd_id: '$input' } }],
  },
  {
    id: 'netdisk-verify-baidu', declaredBy: '@streamapp/baidu', serveKeys: ['baidu-verify'], callsite: 'netdisk.share.verify',
    label: '百度分享验活',
    description: '百度分享 id → 是否存活 + 文件列表（带提取码匿名解锁）',
    members: [{ source: '@streamapp/baidu/baidu-share', params: { pwd_id: '$input' } }],
  },
  {
    id: 'netdisk-save-quark', declaredBy: '@streamapp/quark', serveKeys: ['quark-save'], callsite: 'netdisk.share.save',
    label: '夸克分享转存',
    description: '夸克分享 id → 转存进落点目录（默认 From Stream）',
    members: [{ source: '@streamapp/builtin/quark-save', params: { pwd_id: '$input', dest: NETDISK_SAVE_DEST } }],
  },
  {
    id: 'netdisk-play-quark', declaredBy: '@streamapp/quark', serveKeys: ['quark-play'], callsite: 'netdisk.play',
    label: '夸克视频转码播放',
    description: '夸克文件 fid → 转码后的 H.264+AAC 播放流地址（有声）',
    members: [{ source: '@streamapp/builtin/quark-play', params: { fid: '$input' } }],
  },
  {
    id: 'netdisk-folder-quark', declaredBy: '@streamapp/quark', serveKeys: ['quark-folder'], callsite: 'netdisk.folder',
    label: '夸克文件夹跳转',
    description: '网盘内路径段 → 夸克网页文件夹 URL',
    members: [{ source: '@streamapp/builtin/quark-folder', params: {} }],
  },
] as const

afterEach(() => { setPackageIdentities([]) })

describe('网盘 Provider 行的包声明（真实 packages/）', () => {
  it('宿主静态表里不再有网盘行', () => {
    for (const { id } of BEFORE) expect(SYSTEM_IDENTITIES.has(id), id).toBe(false)
  })

  it('五条行由包出，被身份表接受，身份与搬家前逐字段一致', () => {
    expect(setPackageIdentities(providerDeclarationsOf(pkgs))).toEqual([])
    for (const b of BEFORE) {
      expect(identityOf(b.id), b.id).toEqual({
        id: b.id,
        category: 'resolve',
        serveKeys: b.serveKeys,
        fallback: false,
        strategy: 'sequential',
        contract: null,
        defaultLabel: b.label,
        defaultDescription: b.description,
        defaultMembers: b.members,
        declaredBy: b.declaredBy,
      })
    }
  })

  it('成员指的源真实存在', () => {
    for (const b of BEFORE) for (const m of b.members) expect(knownSources.has(m.source), m.source).toBe(true)
  })

  it('调用点的默认行由包的 callsites 填，与搬家前一致（验活另收百度那条）', () => {
    setPackageIdentities(providerDeclarationsOf(pkgs))
    // 顺序随包扫描序；dispatch 按键挑行，两条键不同，所以顺序不构成语义。
    expect([...providerCallsite('netdisk.share.verify')!.defaultProviderIds].sort()).toEqual(['netdisk-verify-baidu', 'netdisk-verify-quark'])
    expect(providerCallsite('netdisk.share.save')!.defaultProviderIds).toEqual(['netdisk-save-quark'])
    expect(providerCallsite('netdisk.play')!.defaultProviderIds).toEqual(['netdisk-play-quark'])
    expect(providerCallsite('netdisk.folder')!.defaultProviderIds).toEqual(['netdisk-folder-quark'])
    for (const b of BEFORE) expect(callSitesOf(b.id), b.id).toEqual([providerCallsite(b.callsite)!.label])
  })

  it('包未挂上时，四个网盘调用点宿主默认为空（宿主不认识任何网盘）', () => {
    for (const id of ['netdisk.share.verify', 'netdisk.share.save', 'netdisk.play', 'netdisk.folder']) {
      expect(PROVIDER_CALLSITES.find((c) => c.id === id)!.defaultProviderIds, id).toEqual([])
    }
  })
})
