import { describe, it, expect } from 'vitest'
import { harvestBrowserStatus } from './harvest-browser.ts'
import type { ChromeCandidate } from './discover-chrome.ts'

const win: ChromeCandidate = { exe: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', side: 'windows', source: 'standard' }
const linux: ChromeCandidate = { exe: '/usr/bin/google-chrome', side: 'linux', source: 'path' }

describe('harvestBrowserStatus', () => {
  it('两个候选、还没选过 → 必须问用户（绝不替他挑）', () => {
    const s = harvestBrowserStatus({ candidates: [win, linux] })
    expect(s.selected).toBeNull()
    expect(s.mustChoose).toBe(true)
    expect(s.candidates.map((c) => c.side)).toEqual(['windows', 'linux'])
  })

  it('只有一个候选 → 不打扰（没有可选错的余地）', () => {
    expect(harvestBrowserStatus({ candidates: [win] }).mustChoose).toBe(false)
  })

  it('一个都没有 → 不问「选哪个」（那是「装 Chrome」的引导）', () => {
    expect(harvestBrowserStatus({ candidates: [] }).mustChoose).toBe(false)
  })

  it('settings 覆盖 config；选过之后不再问', () => {
    const s = harvestBrowserStatus({ settingsExe: linux.exe, configExe: win.exe, candidates: [win, linux] })
    expect(s.selected).toBe(linux.exe)
    expect(s.origin).toBe('settings')
    expect(s.mustChoose).toBe(false)
  })

  it('只有 config.yaml 写了 → 也算选过', () => {
    const s = harvestBrowserStatus({ configExe: win.exe, candidates: [win, linux] })
    expect(s.origin).toBe('config')
    expect(s.mustChoose).toBe(false)
  })

  it('选中的不在候选里也照样生效——自定义安装路径是合法的', () => {
    const s = harvestBrowserStatus({ settingsExe: '/opt/weird/chrome', candidates: [win] })
    expect(s.selected).toBe('/opt/weird/chrome')
    expect(s.mustChoose).toBe(false)
  })

  it('空串不算选择（配置写了个空字段 ≠ 选过）', () => {
    const s = harvestBrowserStatus({ settingsExe: '  ', configExe: '', candidates: [win, linux] })
    expect(s.selected).toBeNull()
    expect(s.mustChoose).toBe(true)
  })
})
