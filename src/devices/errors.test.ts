import { describe, it, expect } from 'vitest'
import {
  DeviceFetchQueueTimeout, DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed,
  IdentityMismatch, IdentityOffline, IdentitySignedOut, deviceErrorOf, failureDisposition,
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
    // browser-identity D11：没找到节点可重试；换号 / 登出是确定的事实，不重试
    [new IdentityOffline('xhs', '身份 xhs:u1', '都离线'), 'retry'],
    [new IdentityMismatch('xhs', '身份 xhs:u1', 'node_a', '个人号A', '「工作」'), 'final'],
    [new IdentitySignedOut('xhs', '身份 xhs:u1', 'node_a', '「工作」'), 'final'],
  ] as const)('%s → %s', (e, d) => expect(failureDisposition(e)).toBe(d))

  it('顺着 cause 链找：包把 DeviceLost 包成普通 Error 也不重试', () => {
    expect(failureDisposition(new Error('申购失败', { cause: new DeviceLost('linux:nas') }))).toBe('final')
    expect(failureDisposition(new Error('a', { cause: new Error('b', { cause: new HostAbortedByUser('x') }) }))).toBe('final')
    expect(failureDisposition(new Error('a', { cause: new DeviceOffline('linux:nas') }))).toBe('retry')
    expect(failureDisposition(new Error('a', { cause: 'str' }))).toBe('retry')
  })

  it('身份错误包在包自己的 Error 里也认得；identity-offline 是「环境没就绪」，登出是 auth', () => {
    expect(failureDisposition(new Error('x', { cause: new IdentityMismatch('xhs', 't', 'n', 'b', 'w') }))).toBe('final')
    expect(isEnvironmentUnavailable(new IdentityOffline('xhs', 't', 'r'))).toBe(true)
    expect(isEnvironmentUnavailable(new IdentityMismatch('xhs', 't', 'n', 'b', 'w'))).toBe(false)
    expect(new IdentitySignedOut('xhs', 't', 'n', 'w').failureCategory).toBe('auth')
    expect(new IdentityOffline('xhs', 't', 'r').code).toBe('identity-offline')
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

describe('deviceErrorOf（工具结果的结构化错误摘要：嵌入方按它分诊，不解析文字）', () => {
  it('设备错误给出码与设备', () => {
    expect(deviceErrorOf(new DeviceOffline('linux:nas'))).toEqual({ code: 'device-offline', deviceId: 'linux:nas' })
    expect(deviceErrorOf(new DeviceLost('linux:nas'))).toEqual({ code: 'device-lost', deviceId: 'linux:nas' })
  })

  it('包在 cause 链里也认得出', () => {
    const wrapped = new Error('工具执行失败', { cause: new DeviceOffline('linux:nas') })
    expect(deviceErrorOf(wrapped)).toEqual({ code: 'device-offline', deviceId: 'linux:nas' })
  })

  it('普通错误与身份错误给 undefined（没有「哪台设备」可说）', () => {
    expect(deviceErrorOf(new Error('x'))).toBeUndefined()
    expect(deviceErrorOf(new IdentityOffline('xhs', 't', 'r'))).toBeUndefined()
  })

  it('cause 成环不死循环', () => {
    const a = new Error('a'); const b = new Error('b', { cause: a })
    Object.assign(a, { cause: b })
    expect(deviceErrorOf(a)).toBeUndefined()
  })
})
