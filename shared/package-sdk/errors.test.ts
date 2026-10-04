import { describe, it, expect } from 'vitest'
import { ContentUnavailableError, isUnavailable, ValidationError, isValidationError } from './errors.ts'

describe('ValidationError / isValidationError', () => {
  it('类实例带 validation 自述标记，且是个正常的 Error', () => {
    const e = new ValidationError('缺 id')
    expect(e).toBeInstanceOf(Error)
    expect(e.validation).toBe(true)
    expect(e.message).toBe('缺 id')
    expect(e.name).toBe('ValidationError')
    expect(isValidationError(e)).toBe(true)
  })

  it('普通 Error 不算', () => {
    expect(isValidationError(new Error('boom'))).toBe(false)
  })

  // 包被打成自包含 bundle 后带着自己那份 ValidationError 类——宿主 instanceof 判不出，
  // 只有鸭子字段能跨 bundle 认出来。这条红了 = 包抛的 400 会全变 502。
  it('鸭子对象 {validation:true} 算（跨 bundle 不共享类实例时也认得出）', () => {
    expect(isValidationError({ validation: true })).toBe(true)
    expect(isValidationError(Object.assign(new Error('x'), { validation: true }))).toBe(true)
    class ForeignValidationError extends Error { readonly validation = true as const }
    expect(new ForeignValidationError('y')).not.toBeInstanceOf(ValidationError)
    expect(isValidationError(new ForeignValidationError('y'))).toBe(true)
  })

  it('非 true 的 validation、null、基元一律不算', () => {
    expect(isValidationError({ validation: 'yes' })).toBe(false)
    expect(isValidationError({ validation: 1 })).toBe(false)
    expect(isValidationError(null)).toBe(false)
    expect(isValidationError(undefined)).toBe(false)
    expect(isValidationError('validation')).toBe(false)
  })

  it('两种错误互不相认', () => {
    expect(isValidationError(new ContentUnavailableError('gone'))).toBe(false)
    expect(isUnavailable(new ValidationError('bad'))).toBe(false)
  })
})

describe('ContentUnavailableError / isUnavailable', () => {
  it('类实例带 unavailable 自述标记，且是个正常的 Error', () => {
    const e = new ContentUnavailableError('作品已被删除')
    expect(e).toBeInstanceOf(Error)
    expect(e.unavailable).toBe(true)
    expect(e.message).toBe('作品已被删除')
    expect(e.name).toBe('ContentUnavailableError')
    expect(isUnavailable(e)).toBe(true)
  })

  it('普通 Error 不算', () => {
    expect(isUnavailable(new Error('boom'))).toBe(false)
  })

  it('鸭子对象 {unavailable:true} 算（跨包不共享类实例时也认得出）', () => {
    expect(isUnavailable({ unavailable: true })).toBe(true)
    expect(isUnavailable(Object.assign(new Error('x'), { unavailable: true }))).toBe(true)
  })

  it('非 true 的 unavailable、null、基元一律不算', () => {
    expect(isUnavailable({ unavailable: 'yes' })).toBe(false)
    expect(isUnavailable({ unavailable: 1 })).toBe(false)
    expect(isUnavailable(null)).toBe(false)
    expect(isUnavailable(undefined)).toBe(false)
    expect(isUnavailable('unavailable')).toBe(false)
  })
})
