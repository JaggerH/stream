import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { DiagnosticsSettings } from './DiagnosticsSettings.tsx'
import { openRepo } from '../lib/diagnostics/repository.ts'
import type { DiagnosticSession } from '../lib/diagnostics/types.ts'

const crashed: DiagnosticSession = {
  id: 'crashed', startedAt: 1, lastWriteAt: 2, appVersion: 't', ua: 'Chrome/131', status: 'suspected-abnormal',
}

const seed = async (session: DiagnosticSession) => {
  const repo = await openRepo(globalThis.indexedDB)
  await repo.startSession(session)
  repo.close()
}

// Radix Switch（面板统一的控件）报 role="switch"，开关态在 aria-checked 上——不是原生
// checkbox 的 .checked。改用 Switch 是为了和「调试」一节里并排的 Debug 面板开关一致。
const toggle = () => screen.findByRole('switch', { name: /诊断记录/ })
const isOn = async () => (await toggle()).getAttribute('aria-checked') === 'true'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
})

describe('DiagnosticsSettings', () => {
  it('默认关闭', async () => {
    render(<DiagnosticsSettings />)
    expect(await isOn()).toBe(false)
  })

  it('打开开关会写入 localStorage', async () => {
    render(<DiagnosticsSettings />)
    fireEvent.click(await toggle())
    expect(window.localStorage.getItem('stream.diagnostics')).toBe('1')
    expect(await isOn()).toBe(true)
  })

  it('存在疑似异常终止的会话时给出提示与导出按钮', async () => {
    await seed(crashed)
    render(<DiagnosticsSettings />)
    expect(await screen.findByText(/疑似异常终止/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: /导出上次异常终止记录/ })).toBeTruthy()
  })

  it('没有异常会话时不显示提示', async () => {
    render(<DiagnosticsSettings />)
    await toggle()
    await waitFor(() => expect(screen.queryByText(/疑似异常终止/)).toBeNull())
  })

  it('清除按钮清空诊断数据并让提示消失', async () => {
    await seed(crashed)
    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /清除诊断数据/ }))
    await waitFor(() => expect(screen.queryByText(/疑似异常终止/)).toBeNull())
  })

  it('不支持 IndexedDB 时降级提示，不报错', async () => {
    vi.stubGlobal('indexedDB', undefined)
    render(<DiagnosticsSettings />)
    expect(await screen.findByText(/不支持 IndexedDB/)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /诊断记录/ })).toBeNull()
  })
})
