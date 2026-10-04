import { describe, expect, it } from 'vitest'
import { notificationCopyText } from './notification-copy.ts'
import type { UiEvent } from './EventsProvider.tsx'

const e = (over: Partial<UiEvent> = {}): UiEvent => ({
  id: 1,
  type: 'plugin.target-miss',
  at: new Date(2026, 7, 19, 14, 32, 5).getTime(), // 本地时间 2026-08-19 14:32:05
  title: '插件后端没被唤醒：voiceprint',
  severity: 'error',
  ...over,
})

describe('notificationCopyText', () => {
  it('给的是绝对时间，不是"两分钟前"', () => {
    // 复制出来是贴给 AI 的：相对时间脱离了复制那一刻就不可解。
    expect(notificationCopyText(e())).toContain('2026-08-19 14:32:05')
  })

  it('severity / type / 标题都在，且一眼看得出严重程度', () => {
    const t = notificationCopyText(e())
    expect(t).toContain('error')
    expect(t).toContain('plugin.target-miss')
    expect(t).toContain('插件后端没被唤醒：voiceprint')
  })

  it('正文整段不截断 —— UI 里那行是 truncate 的，复制的不能是', () => {
    const body = '这个插件的容器明明在运行，' + '很长的一段。'.repeat(40)
    expect(notificationCopyText(e({ body }))).toContain(body)
  })

  it('有 detail 就带上，没有就不留一个空标题', () => {
    expect(notificationCopyText(e({ detail: 'reason=not-awake\n容器=running' })))
      .toMatch(/详情：[\s\S]*reason=not-awake[\s\S]*容器=running/)
    expect(notificationCopyText(e())).not.toContain('详情')
  })

  it('ref 也带上 —— 它是回到那条 item/facility 的唯一线索', () => {
    expect(notificationCopyText(e({ ref: { kind: 'item', id: 'xhs:abc' } }))).toContain('xhs:abc')
  })
})
