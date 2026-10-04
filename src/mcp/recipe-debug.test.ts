import { describe, it, expect } from 'vitest'
import { createRecipeDebugSessions } from './recipe-debug.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { DesktopRunOutcome } from '../replay/desktop-runner.ts'

function recipe(): DesktopRecipe {
  return {
    version: 1,
    kind: 'desktop',
    sourceId: 'wechat-send',
    app: { process: 'Weixin.exe' },
    steps: [
      { kind: 'focus' },
      { kind: 'branch', when: { see: { text: '{contact}' } }, skip: 1, label: '会话已经是他？' },
      { kind: 'type', text: '{message}', label: '打正文', _why: '不该出现在 spec 里' } as never,
    ],
    observer: { itemQuery: { role: 'Text' }, fields: {}, dedupeBy: 'content' },
    read: { dedupeBy: 'content', targetCount: 1 },
    meta: {
      description: '发消息',
      action: true,
      params_schema: { contact: { type: 'string', required: true }, message: { type: 'string', required: true } },
    },
  }
}

const DRIVER = {} as DesktopDriver

/**
 * 假 runner：照着真 runner 的形状，每一步之前问一次 `stepGate`、每步吐一行探针。
 * 这里验的是会话状态机（停 / 放行 / 中止 / 结束），runner 里闸怎么接由 desktop-runner.test 钉。
 */
function fakeRunDesktop(seen: string[]) {
  const run: typeof import('../replay/desktop-runner.ts').runDesktopRecipe = async (r, params, _d, opts) => {
    for (const [i, step] of r.steps.entries()) {
      opts?.onProbe?.(`#${i} ${step.kind}`)
      const v = await opts!.stepGate!({ index: i, step, total: r.steps.length })
      if (v === 'abort') return { outcome: 'drift', driftReason: `aborted-by-debugger@${i}`, items: [] } as DesktopRunOutcome
      seen.push(`${i}:${step.kind}:${step.kind === 'type' ? params.message : ''}`)
      opts?.onProbe?.(`#${i} done`)
    }
    return { outcome: 'ok', items: [] } as unknown as DesktopRunOutcome
  }
  return run
}

describe('recipe_debug 单步会话', () => {
  it('start 停在第 0 步之前；next 放行一步、停在下一步之前；跑完 finished 且带 outcome', async () => {
    const seen: string[] = []
    const dbg = createRecipeDebugSessions({ findRecipe: () => recipe(), desktopDriver: () => DRIVER, runDesktop: fakeRunDesktop(seen) })
    const s0 = await dbg.start({ sourceId: 'wechat-send', params: { contact: '文件传输助手', message: 'hi' } })
    if (!('state' in s0)) throw new Error('should start')
    expect(s0.state).toBe('paused')
    expect(s0.step).toMatchObject({ index: 0, total: 3, kind: 'focus' })
    expect(seen).toEqual([]) // 一步都没做
    expect(s0.probes).toEqual(['#0 focus'])

    const s1 = await dbg.next(s0.sessionId)
    expect(s1.state).toBe('paused')
    expect(s1.step).toMatchObject({ index: 1, kind: 'branch', label: '会话已经是他？' })
    expect(seen).toEqual(['0:focus:'])
    // 探针只给"这次回执之后新攒的"，不重复
    expect(s1.probes).toEqual(['#0 done', '#1 branch'])

    const s2 = await dbg.next(s0.sessionId)
    // spec 是 recipe 里写的原文，去掉 label / kind / _why*
    expect(s2.step).toMatchObject({ index: 2, kind: 'type', label: '打正文', spec: { text: '{message}' } })
    expect(s2.step!.spec).not.toHaveProperty('_why')

    const s3 = await dbg.next(s0.sessionId)
    expect(s3.state).toBe('finished')
    expect(s3.outcome?.outcome).toBe('ok')
    // 参数走了和整跑一样的那条路：{message} 已经是字符串 hi
    expect(seen[2]).toBe('2:type:hi')
    // 结束的会话被回收
    expect((await dbg.next(s0.sessionId)).reason).toMatch(/没有这个会话/)
  })

  it('abort：停着的那一步不跑，整轮以 aborted-by-debugger 收场', async () => {
    const seen: string[] = []
    const dbg = createRecipeDebugSessions({ findRecipe: () => recipe(), desktopDriver: () => DRIVER, runDesktop: fakeRunDesktop(seen) })
    const s0 = await dbg.start({ sourceId: 'wechat-send', params: { contact: 'a', message: 'b' } })
    if (!('state' in s0)) throw new Error('should start')
    await dbg.next(s0.sessionId) // 放行 #0，停在 #1 之前
    const a = await dbg.abort(s0.sessionId)
    expect(a.state).toBe('aborted')
    expect(a.outcome?.driftReason).toMatch(/aborted-by-debugger@1/)
    expect(seen).toEqual(['0:focus:'])
  })

  it('参数闸与整跑同一套：没声明的键 / 缺必填 → invalid-params，一步都不起', async () => {
    const seen: string[] = []
    const dbg = createRecipeDebugSessions({ findRecipe: (id) => (id === 'wechat-send' ? recipe() : undefined), desktopDriver: () => DRIVER, runDesktop: fakeRunDesktop(seen) })
    expect(await dbg.start({ sourceId: 'wechat-send', params: { contact: 'a', message: 'b', extra: 1 } })).toMatchObject({ status: 'invalid-params' })
    expect(await dbg.start({ sourceId: 'wechat-send', params: { contact: 'a' } })).toMatchObject({ status: 'invalid-params' })
    expect(await dbg.start({ sourceId: 'nope', params: {} })).toMatchObject({ status: 'not-found' })
    const noDesk = createRecipeDebugSessions({ findRecipe: () => recipe(), desktopDriver: () => undefined, runDesktop: fakeRunDesktop(seen) })
    expect(await noDesk.start({ sourceId: 'wechat-send', params: { contact: 'a', message: 'b' } })).toMatchObject({ status: 'no-desktop' })
    expect(seen).toEqual([])
  })

  it('没人放行 → 到点自己中止（停着的那一趟占着桌面会话租约）', async () => {
    const seen: string[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const dbg = createRecipeDebugSessions({
      findRecipe: () => recipe(),
      desktopDriver: () => DRIVER,
      runDesktop: fakeRunDesktop(seen),
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h },
      clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1) },
    })
    const s0 = await dbg.start({ sourceId: 'wechat-send', params: { contact: 'a', message: 'b' } })
    if (!('state' in s0)) throw new Error('should start')
    const idle = timers.find((t) => t.ms === 10 * 60_000)!
    expect(idle).toBeTruthy()
    idle.fn()
    const after = await dbg.next(s0.sessionId)
    expect(after.state).toBe('aborted')
    expect(after.reason).toMatch(/没人放行/)
    expect(seen).toEqual([])
  })
})
