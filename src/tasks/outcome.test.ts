import { describe, it, expect } from 'vitest'
import { parseOutcome } from './outcome.ts'

describe('parseOutcome', () => {
  it('取 stdout 里最后一行 ::outcome::，解析成 TaskOutcome', () => {
    const r = parseOutcome({
      stdout: 'downloading...\n::outcome:: {"summary":"补了 3 天","detail":{"days":3}}\n',
      stderr: '', exitCode: 0, signal: null,
    })
    expect(r.ok).toBe(true)
    expect(r.outcome).toEqual({ summary: '补了 3 天', detail: { days: 3 } })
  })

  it('有多行 ::outcome:: 时取最后一行——任务可以边跑边报进度', () => {
    const r = parseOutcome({
      stdout: '::outcome:: {"summary":"第一步"}\n::outcome:: {"summary":"最终"}\n',
      stderr: '', exitCode: 0, signal: null,
    })
    expect(r.outcome.summary).toBe('最终')
  })

  it('没有 outcome 行且退出码 0 ⇒ 成功，但摘要如实说没报', () => {
    const r = parseOutcome({ stdout: 'done\n', stderr: '', exitCode: 0, signal: null })
    expect(r.ok).toBe(true)
    expect(r.outcome.summary).toBe('exit 0（任务没报 ::outcome::）')
  })

  it('退出码非 0 ⇒ 失败，摘要带 stderr 末尾', () => {
    const r = parseOutcome({
      stdout: '', stderr: 'line1\nTraceback: boom\n', exitCode: 2, signal: null,
    })
    expect(r.ok).toBe(false)
    expect(r.outcome.summary).toContain('exit 2')
    expect(r.outcome.summary).toContain('Traceback: boom')
  })

  it('被信号杀死（超时）⇒ 失败，摘要点名信号', () => {
    const r = parseOutcome({ stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL' })
    expect(r.ok).toBe(false)
    expect(r.outcome.summary).toContain('SIGKILL')
  })

  it('outcome 行是坏 JSON ⇒ 不当成功也不吞：退化成原文摘要', () => {
    const r = parseOutcome({ stdout: '::outcome:: {不是JSON\n', stderr: '', exitCode: 0, signal: null })
    expect(r.ok).toBe(true)
    expect(r.outcome.summary).toContain('::outcome:: 行解析失败')
  })

  it('summary 缺失或非字符串 ⇒ 退化，不让 undefined 进账本', () => {
    const r = parseOutcome({ stdout: '::outcome:: {"detail":{"a":1}}\n', stderr: '', exitCode: 0, signal: null })
    expect(typeof r.outcome.summary).toBe('string')
    expect(r.outcome.summary.length).toBeGreaterThan(0)
  })
})
