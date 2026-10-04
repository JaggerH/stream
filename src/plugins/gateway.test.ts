import { describe, expect, it } from 'vitest'
import { pluginGatewayUrl } from './gateway.ts'

describe('pluginGatewayUrl', () => {
  it('返回根相对、同源、无 host —— 客户端拿到的形态', () => {
    expect(pluginGatewayUrl('alist')).toBe('/_p/alist')
    expect(pluginGatewayUrl('mineru')).toBe('/_p/mineru')
  })
  it('不含任何内部 host（不泄漏 gateway/容器名）', () => {
    expect(pluginGatewayUrl('pansou')).not.toMatch(/http|gateway|:\d+/)
  })
})
