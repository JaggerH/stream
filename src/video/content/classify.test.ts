import { describe, it, expect } from 'vitest'
import { classifyNetdisk, isDownloadUrl, toSourceType } from './classify.ts'

describe('classifyNetdisk', () => {
  it.each([
    ['magnet:?xt=urn:btih:abc', 'magnet'],
    ['ed2k://|file|x|1|H|/', 'ed2k'],
    ['https://pan.quark.cn/s/abc', 'quark'],
    ['https://drive.uc.cn/s/abc', 'uc'],
    ['https://cloud.189.cn/t/abc', 'tianyi'],
    ['https://pan.baidu.com/s/abc', 'baidu'],
    ['https://www.alipan.com/s/abc', 'aliyun'],
    ['https://pan.xunlei.com/s/abc', 'xunlei'],
    ['https://www.123684.com/s/abc', 'pan123'],
    ['https://www.123pan.com/s/abc', 'pan123'],
    ['https://115cdn.com/s/abc', 'p115'],
    ['https://example.org/x', 'unknown'],
  ] as const)('%s → %s', (url, kind) => {
    expect(classifyNetdisk(url)).toBe(kind)
  })
})

describe('toSourceType — finer kinds collapse to unknown, known ones pass', () => {
  it.each([
    ['quark', 'quark'],
    ['baidu', 'baidu'],
    ['aliyun', 'aliyun'],
    ['magnet', 'magnet'],
    ['ed2k', 'ed2k'],
    ['uc', 'unknown'],
    ['tianyi', 'unknown'],
    ['xunlei', 'unknown'],
    ['pan123', 'unknown'],
    ['p115', 'unknown'],
  ] as const)('%s → %s', (kind, st) => {
    expect(toSourceType(kind)).toBe(st)
  })
})

describe('isDownloadUrl — drop group/index links', () => {
  it.each([
    ['https://pan.quark.cn/s/abc', true],
    ['magnet:?xt=urn:btih:abc', true],
    ['https://t.me/tianyiDrive', false],
    ['https://docs.qq.com/smartsheet/xyz', false],
    ['https://kdocs.cn/l/abc', false],
  ] as const)('%s → %s', (url, ok) => {
    expect(isDownloadUrl(url)).toBe(ok)
  })
})
