import { describe, it, expect } from 'vitest'
import {
  DeviceFetchQueueTimeout, DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed,
  failureDisposition,
} from './errors.ts'
import { HostAbortedByUser } from '../http/host-relay.ts'
import { EnvironmentUnavailableError, isEnvironmentUnavailable } from '../../shared/failure/environment.ts'

describe('failureDisposition', () => {
  it.each([
    [new DeviceOffline('linux:nas'), 'retry'],
    [new DeviceFetchQueueTimeout('linux:nas'), 'retry'],
    [new DeviceLost('linux:nas'), 'final'],
    [new DeviceIncapable('linux:nas', 'browser'), 'final'],
    [new HostNotAllowed('linux:nas', 'example.com'), 'final'],
    [new DeviceRefused('linux:nas', 'private-target', '192.168.1.1'), 'final'],
    [new HostAbortedByUser('hotkey'), 'final'],
    [new Error('boom'), 'retry'],
  ] as const)('%s → %s', (e, d) => expect(failureDisposition(e)).toBe(d))

  it('顺着 cause 链找：包把 DeviceLost 包成普通 Error 也不重试', () => {
    expect(failureDisposition(new Error('申购失败', { cause: new DeviceLost('linux:nas') }))).toBe('final')
    expect(failureDisposition(new Error('a', { cause: new Error('b', { cause: new HostAbortedByUser('x') }) }))).toBe('final')
    expect(failureDisposition(new Error('a', { cause: new DeviceOffline('linux:nas') }))).toBe('retry')
    expect(failureDisposition(new Error('a', { cause: 'str' }))).toBe('retry')
  })

  it('cause 成环不死循环', () => {
    const a = new Error('a'); const b = new Error('b', { cause: a })
    Object.assign(a, { cause: b })
    expect(failureDisposition(a)).toBe('retry')
  })

  it('错误信息点名设备，device-lost 说明状态未知', () => {
    expect(new DeviceOffline('linux:nas').message).toContain('linux:nas')
    expect(new DeviceLost('linux:nas').message).toContain('状态未知')
    expect(new DeviceLost('linux:nas').code).toBe('device-lost')
  })
})

describe('isEnvironmentUnavailable（采集侧：本轮跳过而不是判源故障）', () => {
  it.each([
    [new DeviceOffline('linux:nas'), true],
    [new DeviceFetchQueueTimeout('linux:nas'), true],
    [new DeviceLost('linux:nas'), false],
    [new DeviceIncapable('linux:nas', 'browser'), false],
    [new HostNotAllowed('linux:nas', 'example.com'), false],
    [new DeviceRefused('linux:nas', 'network', 'x'), false],
  ] as const)('%s → %s', (e, d) => expect(isEnvironmentUnavailable(e)).toBe(d))

  it('靠声明的标记，不是继承 EnvironmentUnavailableError', () => {
    expect(new DeviceOffline('linux:nas')).not.toBeInstanceOf(EnvironmentUnavailableError)
  })
})
