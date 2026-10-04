import { expect, test } from 'vitest'
import { backendUrl } from './backendUrl.ts'

const BACKEND = 'http://127.0.0.1:8900'

// 这一条就是面板里视频播不了的那个形状：后端把网盘条目的媒体地址存成根相对
// （packages/alist/normalizer.ts），交给浏览器之前不吃 baseUrl 就会按**页面**的源解析。
test('根相对的后端路由吃 baseUrl', () => {
  expect(backendUrl(BACKEND, '/api/media/netdisk-play?path=%2Fa.mp4'))
    .toBe(`${BACKEND}/api/media/netdisk-play?path=%2Fa.mp4`)
})

test('已经指名了源的地址原样返回', () => {
  expect(backendUrl(BACKEND, 'https://cdn.example.com/a.mp4')).toBe('https://cdn.example.com/a.mp4')
  expect(backendUrl(BACKEND, 'blob:http://x/y')).toBe('blob:http://x/y')
  // 协议相对：源由页面的协议补齐，不是我们该改的（此前 audioTrack 那份内联实现按
  // `startsWith('/')` 判，会把它拼成 `http://127.0.0.1:8900//host/a.mp4`）。
  expect(backendUrl(BACKEND, '//host/a.mp4')).toBe('//host/a.mp4')
})
