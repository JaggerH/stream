import { describe, it, expect } from 'vitest'
import { RELAY_PROTOCOL, VERIFY_PREFIX } from './wire.ts'

// 这两个值是扩展与后端握手时逐字节比对的字符串。改任一处、另一处没跟上的症状是
// 「扩展永远连不上、两边日志都说没毛病」，没有别的测试抓得住——所以在这里钉死。
describe('browser-relay wire 常量', () => {
  it('协议名收敛后是 browser-relay.v1', () => {
    expect(RELAY_PROTOCOL).toBe('browser-relay.v1')
  })
  it('验证前缀收敛后是 stream-browser-verify:', () => {
    expect(VERIFY_PREFIX).toBe('stream-browser-verify:')
  })
})
