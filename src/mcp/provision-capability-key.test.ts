import { describe, it, expect, vi } from 'vitest'
import { toolCatalog, type McpExtras } from './tool-catalog.ts'
import type { StreamServiceLike } from './tools.ts'
import { provisionConfigSlot } from '../credentials/provision-slot.ts'

const PROVISIONER = {
  sourceId: '@streamapp/groq/groq-create-key',
  field: 'apiKey',
  entryUrl: 'https://console.groq.com/keys',
  label: 'Groq',
  paramsSchema: { name: { type: 'string', required: true } },
}

const fakeService = {} as unknown as StreamServiceLike

function toolWith(over: Partial<McpExtras> = {}) {
  const provisionConfigSlotSpy = vi.fn(async () => ({ status: 'done', ref: 'groq', field: 'apiKey', label: 'Groq', receipt: {} }) as never)
  const extras = {
    configProvisionerFor: () => PROVISIONER,
    provisionConfigSlot: provisionConfigSlotSpy,
    ...over,
  } as unknown as McpExtras
  const entry = toolCatalog(fakeService, extras).find((e) => e.name === 'provision_capability_key')!
  return { entry, provisionConfigSlotSpy }
}

describe('provision_capability_key 的二次确认', () => {
  /**
   * 判据是**底层一步都没被调到**，不是回执里写着 needs-confirmation ——后者是它自己说的话，
   * 而这里要证的正是「说了什么」与「做了什么」分得开（docs/AGENT-TOOLING.md §1/§2）。
   */
  it('不带 confirmed → 一步都不执行', async () => {
    const { entry, provisionConfigSlotSpy } = toolWith()
    const out = (await entry.run({ ref: 'groq' })) as { status: string; effects: string[]; params: Record<string, unknown> }
    expect(provisionConfigSlotSpy).not.toHaveBeenCalled()
    expect(out.status).toBe('needs-confirmation')
    // 账户级副作用要在确认回执里说清，否则用户点头的是一句他没听懂的话。
    expect(out.effects.join('\n')).toContain('他的账号')
    expect(out.effects.join('\n')).toContain('不幂等')
    expect(out.effects.join('\n')).toContain(PROVISIONER.entryUrl)
    // key 名自带随机后缀（建 key 不幂等，同名会在账号里堆成一排看不出区别的条目）。
    expect(String(out.params.name)).toMatch(/^stream-auto-[0-9a-f]{4,6}$/)
  })

  it('confirmed:true → 真去跑，params 原样透传', async () => {
    const { entry, provisionConfigSlotSpy } = toolWith()
    await entry.run({ ref: 'groq', params: { name: 'stream-auto-abc123' }, confirmed: true })
    expect(provisionConfigSlotSpy).toHaveBeenCalledWith('groq', { name: 'stream-auto-abc123' })
  })

  it('confirmed 只认 true —— 字符串 "yes" 之类不算点头', async () => {
    const { entry, provisionConfigSlotSpy } = toolWith()
    const out = (await entry.run({ ref: 'groq', confirmed: 'yes' as unknown as boolean })) as { status: string }
    expect(provisionConfigSlotSpy).not.toHaveBeenCalled()
    expect(out.status).toBe('needs-confirmation')
  })

  it('这一格没人能帮忙 → 直接说清，不去跑也不假装能跑', async () => {
    const { entry, provisionConfigSlotSpy } = toolWith({ configProvisionerFor: () => null })
    const out = (await entry.run({ ref: 'nobody', confirmed: true })) as { status: string }
    expect(provisionConfigSlotSpy).not.toHaveBeenCalled()
    expect(out.status).toBe('no-provisioner')
  })
})

/**
 * 这一档是整条链存在的理由：这类 recipe `allowEmpty`、不产 item，「建成功了」和「抽取一处
 * 没命中」在 runner 的回执里一字不差。不回头核对就等于报了个假成功，而模型会把它转述成
 * 「我已经帮你申请好了」。
 */
describe('provisionConfigSlot：跑完必须回头核对', () => {
  const deps = (configuredAfter: boolean, run = async () => {}) => ({
    provisioner: () => PROVISIONER,
    run,
    statusOf: () => ({ secrets: { apiKey: { configured: configuredAfter } } }),
  })

  it('跑完那一格真的填上了 → done，带回刷新过的 status', async () => {
    const out = await provisionConfigSlot(deps(true), 'groq', {})
    expect(out).toMatchObject({ status: 'done', ref: 'groq', field: 'apiKey' })
  })

  it('跑完了没抛、那一格还是空的 → ran-but-empty，并指路 failures/', async () => {
    const out = await provisionConfigSlot(deps(false), 'groq', {})
    expect(out.status).toBe('ran-but-empty')
    expect(out.status === 'ran-but-empty' && out.error).toContain('failures/')
    expect(out.status === 'ran-but-empty' && out.error).toContain('Groq')
  })

  it('跑的时候抛了（登录墙 / 人机验证 / 站点改版）→ failed，带原文', async () => {
    const out = await provisionConfigSlot(deps(true, async () => { throw new Error('需要先登录 Groq') }), 'groq', {})
    expect(out.status).toBe('failed')
    expect(out.status === 'failed' && out.error).toContain('需要先登录 Groq')
  })

  it('核对读的是跑完之后那一份，不是跑之前那一份', async () => {
    let configured = false
    const out = await provisionConfigSlot(
      {
        provisioner: () => PROVISIONER,
        run: async () => { configured = true },
        statusOf: () => ({ secrets: { apiKey: { configured } } }),
      },
      'groq',
      {},
    )
    expect(out.status).toBe('done')
  })

  it('没有反查到 recipe → no-provisioner，绝不去跑', async () => {
    const run = vi.fn()
    const out = await provisionConfigSlot({ provisioner: () => null, run, statusOf: () => ({}) }, 'groq', {})
    expect(out.status).toBe('no-provisioner')
    expect(run).not.toHaveBeenCalled()
  })
})
