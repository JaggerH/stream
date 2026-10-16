import { describe, it, expect } from 'vitest'
import {
  DeviceFetchQueueTimeout, DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed,
  failureDisposition,
} from './errors.ts'
import { HostAbortedByUser } from '../http/host-relay.ts'

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

  it('错误信息点名设备，device-lost 说明状态未知', () => {
    expect(new DeviceOffline('linux:nas').message).toContain('linux:nas')
    expect(new DeviceLost('linux:nas').message).toContain('状态未知')
    expect(new DeviceLost('linux:nas').code).toBe('device-lost')
  })
})
