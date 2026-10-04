/**
 * 排期编辑器：钉的是「所见即所存」——屏幕上那句人话、那串表达式、那三个时刻，说的必须是
 * 保存下去的同一件事。这层一旦漂移，用户会照着一句对的话得到一条错的排期，而且不报错。
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ScheduleEditor } from './ScheduleEditor.tsx'

function open(schedule: string, onSave = vi.fn()) {
  render(<ScheduleEditor taskId="t" schedule={schedule} onCancel={vi.fn()} onSave={onSave} />)
  return onSave
}

describe('ScheduleEditor', () => {
  it('打开时停在这条表达式对应的那一档，并把值填好', () => {
    open('0 15 4 1 * *')
    expect(screen.getByTestId('sched-day')).toHaveProperty('value', '1')
    expect(screen.getByTestId('sched-hour')).toHaveProperty('value', '4')
    expect(screen.getByTestId('sched-minute')).toHaveProperty('value', '15')
    expect(screen.getByTestId('sched-sentence').textContent).toBe('每月 1 日 04:15')
  })

  it('读不回预设的表达式 ⇒ 落到自定义档，原文照抄进输入框（不假装是某一档）', () => {
    open('0 0 9-15/2 * * 1-5')
    expect(screen.getByTestId('sched-raw')).toHaveProperty('value', '0 0 9-15/2 * * 1-5')
    // 合法但翻不成人话：如实说，并让人照触发时刻自己确认
    expect(screen.getByTestId('sched-sentence').textContent).toContain('超出了能翻成人话的范围')
    expect(screen.getByTestId('sched-next').textContent).toContain('下次')
  })

  // 逃生口的另一半：写坏了要当场说，并且**不许把坏值报给宿主表单**（嵌入档只在解析得出来
  // 时才回报）。这样整行草稿里永远没有过非法排期——比"塞进去再靠保存时校验拦下"稳一档。
  it('自定义档：非法表达式当场报错，什么都不预览，也不回报给宿主', () => {
    const onChange = vi.fn()
    render(<ScheduleEditor taskId="t" schedule="0 55 14 * * 1-5" onChange={onChange} />)
    fireEvent.click(screen.getByTestId('sched-kind-raw'))
    fireEvent.change(screen.getByTestId('sched-raw'), { target: { value: '0 45 9 * *' } })
    expect(screen.getByTestId('sched-error').textContent).toContain('6 段')
    // 校验没过时**什么都不预览**——一句照着半截表达式编出来的人话比没有更坏
    expect(screen.queryByTestId('sched-sentence')).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(null)
    // 改成合法的 ⇒ 人话立刻跟上，宿主也拿到新值
    fireEvent.change(screen.getByTestId('sched-raw'), { target: { value: '0 0 9-15/2 * * 1-5' } })
    expect(screen.queryByTestId('sched-error')).toBeNull()
    expect(screen.getByTestId('sched-next').textContent).toContain('下次')
    expect(onChange).toHaveBeenLastCalledWith('0 0 9-15/2 * * 1-5')
  })

  it('换档留住已经填好的时刻——选完 09:45 再改成「每周」不该把它抹掉', () => {
    open('0 45 9 * * *')
    fireEvent.click(screen.getByTestId('sched-kind-weekly'))
    expect(screen.getByTestId('sched-hour')).toHaveProperty('value', '9')
    expect(screen.getByTestId('sched-minute')).toHaveProperty('value', '45')
    expect(screen.getByTestId('sched-expr').textContent).toBe('0 45 9 * * 1,2,3,4,5')
  })

  it('周几是可切的，一个都不选就存不出去', () => {
    open('0 45 9 * * 1,5')
    for (const d of [1, 5]) fireEvent.click(screen.getByTestId(`sched-weekday-${d}`))
    expect(screen.getByTestId('sched-error').textContent).toContain('至少选一个')
    expect((screen.getByTestId('sched-save-t') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('sched-weekday-6'))
    expect(screen.getByTestId('sched-expr').textContent).toBe('0 45 9 * * 6')
  })

  it('保存回吐的是编译好的 cron 字符串——后端契约仍然是 cron，没变', () => {
    const onSave = open('0 45 9 * * 1-5')
    fireEvent.click(screen.getByTestId('sched-kind-everyMinutes'))
    fireEvent.change(screen.getByTestId('sched-n'), { target: { value: '15' } })
    expect(screen.getByTestId('sched-sentence').textContent).toBe('每 15 分钟')
    fireEvent.click(screen.getByTestId('sched-save-t'))
    expect(onSave).toHaveBeenCalledWith('0 */15 * * * *')
  })

  it('没改就存不出去——一次白写会把整行重新 upsert 一遍', () => {
    open('0 45 9 * * *')
    expect((screen.getByTestId('sched-save-t') as HTMLButtonElement).disabled).toBe(true)
  })

  it('把数字删空不当成 0——0 是个合法时刻，会悄悄把排期改成整点', () => {
    open('0 45 9 * * *')
    fireEvent.change(screen.getByTestId('sched-minute'), { target: { value: '' } })
    expect(screen.getByTestId('sched-error').textContent).toContain('分钟必须是')
    expect((screen.getByTestId('sched-save-t') as HTMLButtonElement).disabled).toBe(true)
  })
})
