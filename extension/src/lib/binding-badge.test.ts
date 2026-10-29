import { describe, expect, it } from 'vitest'
import { bindingBadge, isActiveBinding, type BindingOnlineState } from './binding-badge.ts'

const b = (p: Partial<BindingOnlineState> = {}): BindingOnlineState => ({
  baseUrl: 'http://127.0.0.1:8900', connected: true, ...p,
})

describe('bindingBadge：右上角徽标按全部绑定汇总', () => {
  it('还在查 ⇒ checking…，不默认画成 connected', () => {
    expect(bindingBadge(null)).toEqual({ label: 'checking…', tone: 'warn' })
  })

  it('本机 + 已配对全在线 ⇒ 「N connected」', () => {
    expect(bindingBadge([b(), b({ baseUrl: 'https://nas.example' })])).toEqual({ label: '2 connected', tone: 'ok' })
  })

  it('部分在线 ⇒ 「X connected · Y offline」', () => {
    expect(bindingBadge([b(), b({ baseUrl: 'https://nas.example', connected: false })]))
      .toEqual({ label: '1 connected · 1 offline', tone: 'warn' })
  })

  it('全不在线 ⇒ offline', () => {
    expect(bindingBadge([b({ connected: false }), b({ baseUrl: 'https://nas.example', connected: false })]))
      .toEqual({ label: 'offline', tone: 'bad' })
  })

  it('没有可连的绑定 ⇒ offline（不是 checking…）', () => {
    expect(bindingBadge([])).toEqual({ label: 'offline', tone: 'bad' })
  })

  it('本机还没填地址 ⇒ 不计入分母，避免「1 connected · 1 offline」的假告警', () => {
    expect(bindingBadge([b({ baseUrl: '', connected: false }), b({ baseUrl: 'https://nas.example' })]))
      .toEqual({ label: '1 connected', tone: 'ok' })
  })

  it('被实例撤销 / 属于别的 profile 的绑定不计入分母', () => {
    expect(bindingBadge([b(), b({ baseUrl: 'https://nas.example', connected: false, revoked: true })]))
      .toEqual({ label: '1 connected', tone: 'ok' })
    expect(bindingBadge([b(), b({ baseUrl: 'https://nas.example', connected: false, foreignNode: true })]))
      .toEqual({ label: '1 connected', tone: 'ok' })
    expect(bindingBadge([b({ connected: false, revoked: true })])).toEqual({ label: 'offline', tone: 'bad' })
  })
})

describe('isActiveBinding', () => {
  it('有地址、没撤销、不是别的 profile 才算数', () => {
    expect(isActiveBinding(b())).toBe(true)
    expect(isActiveBinding(b({ baseUrl: '' }))).toBe(false)
    expect(isActiveBinding(b({ revoked: true }))).toBe(false)
    expect(isActiveBinding(b({ foreignNode: true }))).toBe(false)
  })
})
