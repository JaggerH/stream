import { describe, it, expect } from 'vitest'
import { diagnoseCapabilities, slotOf, type CapabilityReaders, type CapabilitySpec, type ConfigSlotView } from './capability-gaps.ts'

const SPEC: CapabilitySpec[] = [
  { id: 'transcribe', label: '语音转文字（转写）', branch: 'stt', row: 'transcribe', tools: ['ffmpeg'], does: '把视频/音频转成文字稿' },
]

const slot = (over: Partial<ConfigSlotView> = {}): ConfigSlotView => ({
  ref: 'groq', label: 'Groq API Key', field: 'apiKey', configured: false,
  help_url: 'https://console.groq.com/keys',
  provisioner: { sourceId: '@x/groq/groq-create-key', label: 'Groq', entryUrl: 'https://console.groq.com/keys', field: 'apiKey', paramsSchema: {} },
  ...over,
})

const readers = (over: Partial<CapabilityReaders> = {}): CapabilityReaders => ({
  branchAvailable: () => false,
  slotsOf: () => [slot()],
  toolAvailable: () => true,
  ...over,
})

const only = (r: CapabilityReaders) => diagnoseCapabilities(r, SPEC).capabilities[0]!

/**
 * 三种状态各一条 —— 它们是**三个不同的下一步**，压成一个布尔就等于把「我能替你申请」
 * 和「你得自己去拿」讲成同一句话。
 */
describe('capability_status 的三种状态', () => {
  it('能用 → ready，不给任何 blocker（别在能用的时候提申请）', () => {
    const v = only(readers({ branchAvailable: () => true }))
    expect(v.state).toBe('ready')
    expect(v.available).toBe(true)
    expect(v.blockers).toEqual([])
  })

  it('缺 key 且有 recipe 能产出 → needs-key-self-serve，blocker 带得上 ref（那是写工具的入参）', () => {
    const v = only(readers())
    expect(v.state).toBe('needs-key-self-serve')
    const b = v.blockers.find((x) => x.kind === 'config')!
    expect(b).toMatchObject({ kind: 'config', ref: 'groq', can_provision: true })
    // 二选一的另一半：自己去拿的地址必须在回执里，否则模型只会推荐"我来帮你"。
    expect(b.kind === 'config' && b.help_url).toBe('https://console.groq.com/keys')
  })

  it('缺 key 但没人能产出 → needs-key-manual（绝不能报成能替他申请）', () => {
    const v = only(readers({ slotsOf: () => [slot({ provisioner: null })] }))
    expect(v.state).toBe('needs-key-manual')
    expect(v.blockers.every((b) => b.kind !== 'config' || !b.can_provision)).toBe(true)
    expect(v.why).toContain('只能给他链接自己配')
  })
})

/**
 * 第四种：**不是缺钥匙**。这一档报成 self-serve 就是指错路——模型会替用户申请一把 key，
 * 跑成功了，能力还是用不了，而没有任何一处会报错（`docs/AGENT-TOOLING.md` §8）。
 */
describe('capability_status 的「不是缺钥匙」那一档', () => {
  it('机器上没有 ffmpeg → blocked-other，哪怕 key 也缺', () => {
    const v = only(readers({ toolAvailable: () => false }))
    expect(v.state).toBe('blocked-other')
    expect(v.blockers.some((b) => b.kind === 'tool' && b.tool === 'ffmpeg')).toBe(true)
    // 全部拦路虎照列，state 只是头条——缺的那把 key 不能因为 ffmpeg 就消失。
    expect(v.blockers.some((b) => b.kind === 'config')).toBe(true)
  })

  it('key 已经配上了却仍不可用 → restart，一句「再申请一把」都不许出现', () => {
    const v = only(readers({ slotsOf: () => [slot({ configured: true })] }))
    expect(v.state).toBe('blocked-other')
    expect(v.blockers).toHaveLength(1)
    expect(v.blockers[0]!.kind).toBe('restart')
    expect(v.blockers[0]!.message).toContain('重启')
  })

  it('梯子上一格配置都没有 → no-members，别把它讲成缺 key', () => {
    const v = only(readers({ slotsOf: () => [] }))
    expect(v.state).toBe('blocked-other')
    expect(v.blockers.some((b) => b.kind === 'no-members')).toBe(true)
  })
})

describe('slotOf：manifest → 一格配置', () => {
  const rc = { ref: 'groq', fields: { apiKey: { type: 'secret', label: 'Groq API Key', helpUrl: 'https://x.test' } } }

  it('secret 字段 + 取得到层 → 一格；stored/env 都算已配', () => {
    expect(slotOf(rc, 'groq', 'stored', () => null)).toMatchObject({ ref: 'groq', field: 'apiKey', configured: true })
    expect(slotOf(rc, 'groq', 'env', () => null)).toMatchObject({ configured: true })
    expect(slotOf(rc, 'groq', 'missing', () => null)).toMatchObject({ configured: false })
  })

  it('没有 secret 声明 / 取不到 ref → null（不该被算成"缺 key"）', () => {
    expect(slotOf({ ref: 'x', fields: { a: { type: 'string' } } }, 'x', 'missing', () => null)).toBeNull()
    // perInstance 成员没有 tokenName 时 keyRefOf 给 null——拿 rc.ref 顶替就是那条假读数。
    expect(slotOf(rc, null, 'missing', () => null)).toBeNull()
    expect(slotOf(rc, 'groq', null, () => null)).toBeNull()
  })

  it('ref 用调用方给的那个，不是 rc.ref（perInstance 的 key 在成员的 tokenName 上）', () => {
    expect(slotOf(rc, 'llm:zhipu', 'missing', () => null)!.ref).toBe('llm:zhipu')
  })
})
