import { describe, expect, it } from 'vitest'
import { DEVICE_WIRE_OPS, wireActionOf, wireArgsFor, wireNamesFor, wireOpName, windowIdentity } from './android-driver.ts'

describe('device wire names', () => {
  it('sends the first spelling the device declared, preferring the Android alias', () => {
    expect(wireOpName('tap', ['click', 'tap'])).toBe('click')
    expect(wireOpName('tap', new Set(['tap']))).toBe('tap')
    expect(wireOpName('tap', ['invoke'])).toBeUndefined()
    expect(wireOpName('setText', ['setText'])).toBe('setText')
    expect(wireOpName('openApp', ['focusApp'])).toBe('focusApp')
    expect(wireOpName('openApp', ['openApp'])).toBe('openApp')
  })

  it('without a declaration returns the preferred spelling (raw ops pass through); an undeclared raw op is refused', () => {
    expect(wireOpName('tap')).toBe('click')
    expect(wireOpName('setText')).toBe('setValue')
    expect(wireOpName('openApp')).toBe('focusApp')
    expect(wireOpName('not-an-action')).toBe('not-an-action')
    expect(wireOpName('not-an-action', ['tap'])).toBeUndefined()
  })

  it('passes a raw op name outside the normalized table through, and still refuses it when undeclared', () => {
    expect(wireOpName('invoke', ['invoke', 'tap'])).toBe('invoke')
    expect(wireOpName('status', ['status'])).toBe('status')
    expect(wireOpName('invoke')).toBe('invoke')
    expect(wireOpName('clearInput', ['tap'])).toBeUndefined()
    expect(wireOpName('invoke', ['tap'])).toBeUndefined()
    expect(wireNamesFor('invoke')).toEqual([])
  })

  it('accepts either vocabulary as the action name', () => {
    expect(wireActionOf('tap')).toBe('tap')
    expect(wireActionOf('click')).toBe('tap')
    expect(wireActionOf('setValue')).toBe('setText')
    expect(wireActionOf('openApp')).toBe('openApp')
    expect(wireActionOf('focusApp')).toBe('openApp')
    expect(wireActionOf('scroll')).toBe('scroll')
    expect(wireActionOf('nope')).toBeUndefined()
    expect(wireActionOf('toString')).toBeUndefined()
    expect(wireOpName('click', ['click'])).toBe('click')
    expect(wireOpName('setValue', ['setText'])).toBe('setText')
    expect(wireOpName('focusApp', ['openApp'])).toBe('openApp')
  })

  it('lists every spelling, preferred first, for either vocabulary', () => {
    expect(wireNamesFor('tap')).toEqual(['click', 'tap'])
    expect(wireNamesFor('click')).toEqual(['click', 'tap'])
    expect(wireNamesFor('openApp')).toEqual(['focusApp', 'openApp'])
    expect(wireNamesFor('scroll')).toEqual(['scroll'])
    expect(wireNamesFor('nope')).toEqual([])
    expect(DEVICE_WIRE_OPS.tap).toEqual(['click', 'tap'])
  })

  it('adapts the open-app argument shape to the chosen spelling and leaves other actions alone', () => {
    expect(wireArgsFor('openApp', 'openApp', { match: { process: 'com.example.app' }, fresh: true })).toEqual({
      package: 'com.example.app',
      fresh: true,
    })
    expect(wireArgsFor('focusApp', 'openApp', { match: { process: 'com.example.app' } })).toEqual({ package: 'com.example.app' })
    expect(wireArgsFor('openApp', 'focusApp', { match: { process: 'com.example.app' } })).toEqual({ match: { process: 'com.example.app' } })
    expect(wireArgsFor('tap', 'tap', { rect: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({ rect: { x: 1, y: 2, w: 3, h: 4 } })
    expect(wireArgsFor('openApp', 'openApp', undefined)).toBeUndefined()
    const args = { match: { process: 'com.example.app' } }
    wireArgsFor('openApp', 'openApp', args)
    expect(args).toEqual({ match: { process: 'com.example.app' } })
  })
})

describe('window identity across surfaces', () => {
  it('reads the Android spelling (process / foreground)', () => {
    expect(windowIdentity({ process: 'com.android.settings', title: 'Settings', foreground: true })).toEqual({
      app: 'com.android.settings',
      foreground: true,
    })
    expect(windowIdentity({ process: 'com.android.settings', foreground: false })).toEqual({
      app: 'com.android.settings',
      foreground: false,
    })
  })

  it('reads the iOS spelling (app / focused)', () => {
    expect(windowIdentity({ app: 'com.apple.Preferences', title: 'Settings', focused: true })).toEqual({
      app: 'com.apple.Preferences',
      foreground: true,
    })
    expect(windowIdentity({ app: 'com.apple.Preferences', focused: false })).toEqual({
      app: 'com.apple.Preferences',
      foreground: false,
    })
  })

  it('does not trust focused on a row that also has a process (an Android row)', () => {
    expect(windowIdentity({ process: 'com.android.settings', focused: true })).toEqual({
      app: 'com.android.settings',
      foreground: false,
    })
  })

  it('tolerates junk', () => {
    expect(windowIdentity(null)).toEqual({ app: undefined, foreground: false })
    expect(windowIdentity({})).toEqual({ app: undefined, foreground: false })
    expect(windowIdentity({ process: '', app: 'com.example' })).toEqual({ app: 'com.example', foreground: false })
  })
})
