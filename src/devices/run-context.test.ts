import { describe, it, expect } from 'vitest'
import { LOCAL_DEVICE, currentDeviceId, currentPlacement, hostAllowed, runOnDevice } from './run-context.ts'

const nas = { deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }

describe('run context', () => {
  it('没有上下文就是 local，允许清单为空', () => {
    expect(currentDeviceId()).toBe(LOCAL_DEVICE)
    expect(currentPlacement().allowHosts).toEqual([])
  })

  it('跨 await 与定时器保持', async () => {
    await runOnDevice(nas, async () => {
      await new Promise((r) => setTimeout(r, 5))
      expect(currentDeviceId()).toBe('linux:nas')
    })
    expect(currentDeviceId()).toBe(LOCAL_DEVICE)
  })

  it('并发的两次执行互不串台', async () => {
    const seen: string[] = []
    const one = (id: string) => runOnDevice({ deviceId: id, allowHosts: [] }, async () => {
      await new Promise((r) => setTimeout(r, id === 'a' ? 10 : 1))
      seen.push(`${id}:${currentDeviceId()}`)
    })
    await Promise.all([one('a'), one('b')])
    expect(seen.sort()).toEqual(['a:a', 'b:b'])
  })

  it('内层覆盖外层', async () => {
    await runOnDevice(nas, () => runOnDevice({ deviceId: 'android:p', allowHosts: [] }, async () => {
      expect(currentDeviceId()).toBe('android:p')
    }))
  })
})

describe('hostAllowed', () => {
  const allow = ['eastmoneysec.com']
  it.each([
    ['jywg.eastmoneysec.com', true],
    ['eastmoneysec.com', true],
    ['EASTMONEYSEC.COM.', true],
    ['evil-eastmoneysec.com', false],
    ['eastmoneysec.com.evil.io', false],
    ['eastmoney.com', false],
  ])('%s → %s', (host, ok) => expect(hostAllowed(host, allow)).toBe(ok))

  it('空清单什么都不放行', () => expect(hostAllowed('example.com', [])).toBe(false))
  it('清单项带前导点也按后缀', () => expect(hostAllowed('a.b.cn', ['.b.cn'])).toBe(true))
})
