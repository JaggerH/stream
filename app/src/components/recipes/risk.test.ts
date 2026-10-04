import { describe, expect, it } from 'vitest'
import { assessInstallRisk } from './risk.ts'
import type { RecipePackagePreview } from '../../lib/types.ts'

const recipe = (id: string, effects: string[] = []) => ({
  id, description: `${id} 的描述`, capabilities: ['timeline'], effects, params: [],
})

const preview = (over: Partial<RecipePackagePreview> = {}): RecipePackagePreview => ({
  name: '@third/pack', version: '1.0.0', facility: 'xhs',
  rateLimit: { burst: 2, perMinute: 6 },
  recipes: [recipe('xhs-home')],
  providers: [],
  overrides: [],
  confirm: 'sha512-abc',
  ...over,
})

describe('assessInstallRisk 四象限', () => {
  it('只读且不覆盖 → plain，无理由', () => {
    const risk = assessInstallRisk(preview(), '@third/pack')
    expect(risk).toEqual({ level: 'plain', reasons: [] })
  })

  it('任一 recipe 带 write 副作用 → elevated，理由点名到具体 recipe id', () => {
    const p = preview({ recipes: [recipe('xhs-home'), recipe('xhs-like', ['write'])] })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('elevated')
    expect(risk.reasons).toEqual([{ kind: 'write', recipeIds: ['xhs-like'] }])
  })

  // sourceId 全名以包名打头，覆盖的归并键就是全名 —— 所以「覆盖」只发生在同名包的两层之间，
  // 永远是一次自我升级。`shadow-builtin` 这条判据因此**永不触发**：它不是死代码，是一条仍然
  // 正确的不变量，写成断言。真触发了说明前缀合成或 preview 出了问题，要大声报。
  it('第三方包报称覆盖了别人的源 → 抛（这个状态在全名模型下不可能出现）', () => {
    const p = preview({ overrides: ['@streamapp/xhs/xhs-home', '@streamapp/xhs/xhs-search'] })
    expect(() => assessInstallRisk(p, '@third/pack')).toThrow(/@streamapp\/xhs\/xhs-home/)
    expect(() => assessInstallRisk(p, '@third/pack')).toThrow(/自相矛盾/)
  })

  it('官方包覆盖自己的内置版本不罚站（正常升级路径）', () => {
    const p = preview({ name: '@streamapp/xhs', overrides: ['@streamapp/xhs/xhs-home'] })
    expect(assessInstallRisk(p, '@streamapp/xhs')).toEqual({ level: 'plain', reasons: [] })
  })

  it('官方包若带写副作用，照样 elevated（前缀只豁免覆盖那一条判据）', () => {
    const p = preview({ name: '@streamapp/xhs', overrides: ['@streamapp/xhs/xhs-home'], recipes: [recipe('xhs-like', ['write'])] })
    const risk = assessInstallRisk(p, '@streamapp/xhs')
    expect(risk.reasons).toEqual([{ kind: 'write', recipeIds: ['xhs-like'] }])
  })

  it('一个包内多条 recipe 带 write 副作用 → reasons 收全部 recipe id，不只第一条', () => {
    const p = preview({
      recipes: [recipe('xhs-like', ['write']), recipe('xhs-home'), recipe('xhs-comment', ['write'])],
    })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('elevated')
    expect(risk.reasons).toEqual([{ kind: 'write', recipeIds: ['xhs-like', 'xhs-comment'] }])
  })

  // 仿冒名 `@streamapp-evil/xhs` 拿不到官方豁免。它覆盖的只可能是**它自己**的内置版本
  // （全名以它自己的包名打头），所以这里的 elevated 是"非官方 scope 的自我升级"这一档。
  it('前缀判据是「以 @streamapp/ 开头」，仿冒名不豁免', () => {
    const p = preview({ name: '@streamapp-evil/xhs', overrides: ['@streamapp-evil/xhs/xhs-home'] })
    const risk = assessInstallRisk(p, '@streamapp-evil/xhs')
    expect(risk.level).toBe('elevated')
    expect(risk.reasons).toEqual([{ kind: 'shadow-builtin', sourceIds: ['@streamapp-evil/xhs/xhs-home'] }])
  })
})

describe('assessInstallRisk：容器排在 elevated 与 code 之间', () => {
  const backend = (over: Partial<NonNullable<RecipePackagePreview['backend']>> = {}) => ({
    image: 'ghcr.io/someone/thing:1.0',
    service: 'xhs',
    port: 8080,
    mem: '1G',
    volumes: ['xhs_data:/var/lib/data'],
    envKeys: ['API_TOKEN'],
    standby: { idleMinutes: 30 },
    ...over,
  })

  it('带容器 → level 提到 container，理由带上镜像全名与它申报的凭证域', () => {
    const p = preview({ backend: backend(), credentials: ['douyin.com'] })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('container')
    expect(risk.reasons).toEqual([
      { kind: 'container', image: 'ghcr.io/someone/thing:1.0', credentials: ['douyin.com'] },
    ])
  })

  it('容器比 write / shadow 重：两者同在时 level 是 container，且容器那条排在前面', () => {
    const p = preview({
      backend: backend(),
      overrides: ['@third/pack/xhs-home'],
      recipes: [recipe('xhs-like', ['write'])],
    })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('container')
    expect(risk.reasons.map((r) => r.kind)).toEqual(['container', 'write', 'shadow-builtin'])
  })

  it('容器比代码轻：两者同在时 level 仍是 code，代码那条排在容器之前', () => {
    const p = preview({ backend: backend(), code: { entry: 'dist/index.js', adapters: [], normalizers: [] } })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('code')
    expect(risk.reasons.map((r) => r.kind)).toEqual(['code', 'container'])
  })

  it('官方 scope 不豁免容器——前缀只豁免覆盖那一条判据', () => {
    const p = preview({ name: '@streamapp/xhs', backend: backend() })
    expect(assessInstallRisk(p, '@streamapp/xhs').level).toBe('container')
  })

  it('没申报凭证域时理由里的域名单为空（不能凭空造一个）', () => {
    const risk = assessInstallRisk(preview({ backend: backend() }), '@third/pack')
    expect(risk.reasons).toEqual([
      { kind: 'container', image: 'ghcr.io/someone/thing:1.0', credentials: [] },
    ])
  })

  it('纯数据包不被容器判据波及：仍是 plain，一条理由都没有', () => {
    const risk = assessInstallRisk(preview(), '@third/pack')
    expect(risk).toEqual({ level: 'plain', reasons: [] })
    expect(risk.reasons.some((r) => r.kind === 'container')).toBe(false)
  })
})

describe('assessInstallRisk：含代码是最高一档', () => {
  it('带 code 的包 → level 提到 code，理由带上申报的注册名', () => {
    const p = preview({ code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: ['xhs-note'] } })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('code')
    expect(risk.reasons).toEqual([
      { kind: 'code', entry: 'dist/index.js', adapters: ['xhs'], normalizers: ['xhs-note'] },
    ])
  })

  it('code 理由排在最前（确认按钮先读到最重的那条）', () => {
    const p = preview({
      overrides: ['@third/pack/xhs-home'],
      recipes: [recipe('xhs-like', ['write'])],
      code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: [] },
    })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('code')
    expect(risk.reasons[0]).toEqual({ kind: 'code', entry: 'dist/index.js', adapters: ['xhs'], normalizers: [] })
    expect(risk.reasons.map((r) => r.kind)).toEqual(['code', 'write', 'shadow-builtin'])
  })

  it('官方 scope 不豁免代码——前缀只豁免覆盖那一条判据', () => {
    const p = preview({ name: '@streamapp/xhs', code: { entry: 'dist/index.js', adapters: [], normalizers: [] } })
    expect(assessInstallRisk(p, '@streamapp/xhs').level).toBe('code')
  })

  // 能力包不声明 `stream.code`（它导出的是一个 `Capability`，不注册 adapter/normalizer），
  // 所以只认 `code` 的话它会被判成 plain —— 一份在后端进程内以完整权限运行、能取用户浏览器
  // 登录态的包，安装时和一份纯数据 recipe 包长得一模一样。这是这道门最不该漏的那一类。
  it('带 capability 的包 → 同样是最高档 code，理由点名入口', () => {
    const p = preview({ capability: { entry: 'dist/index.js' } })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.level).toBe('code')
    expect(risk.reasons).toEqual([{ kind: 'capability', entry: 'dist/index.js', tools: [] }])
  })

  it('拿得到工具名就一并点名（拿不到是常态，不是"没有工具"）', () => {
    const p = preview({ capability: { entry: 'dist/index.js', tools: ['netdisk_save'] } })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.reasons[0]).toEqual({ kind: 'capability', entry: 'dist/index.js', tools: ['netdisk_save'] })
  })

  it('官方 scope 同样不豁免能力槽位', () => {
    const p = preview({ name: '@streamapp/netdisk', capability: { entry: 'dist/index.js' } })
    expect(assessInstallRisk(p, '@streamapp/netdisk').level).toBe('code')
  })

  it('两格都填时两条理由都摆出来（同一个文件，但注册的东西不同）', () => {
    const p = preview({
      code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: [] },
      capability: { entry: 'dist/index.js' },
    })
    const risk = assessInstallRisk(p, '@third/pack')
    expect(risk.reasons.map((r) => r.kind)).toEqual(['code', 'capability'])
  })

  it('只有清单 / recipe 的包档位原样不变（分级不能把所有包吓一遍）', () => {
    expect(assessInstallRisk(preview(), '@third/pack')).toEqual({ level: 'plain', reasons: [] })
    const w = assessInstallRisk(preview({ recipes: [recipe('xhs-like', ['write'])] }), '@third/pack')
    expect(w.level).toBe('elevated')
    expect(w.reasons.some((r) => r.kind === 'code')).toBe(false)
  })
})
