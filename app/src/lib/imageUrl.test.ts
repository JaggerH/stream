import { describe, it, expect } from 'vitest'
import { imgUrl, imageProxyBypass } from './imageUrl.ts'

const BASE = 'http://127.0.0.1:8900'
const proxied = (u: string) => `${BASE}/api/media/image?url=${encodeURIComponent(u)}`

describe('imgUrl', () => {
  it('把源站原图换成后端图片出口（防盗链图床的封面靠这个才出得来）', () => {
    const src = 'https://p.qpic.cn/1.jpg'
    expect(imgUrl(BASE, src)).toBe(proxied(src))
    expect(imageProxyBypass(src)).toBeNull()
  })

  // 这条是整个设计的支点：判据的消费点有二十多处，漏一处的症状是一张不报错的空白图。
  // 只要"多包一层"是无害的，"拿不准就包上"就永远是安全动作，漏掉才是唯一的失败模式。
  it('幂等——已经是代理地址就原样返回，绝不代理去取自己', () => {
    const once = imgUrl(BASE, 'https://p.qpic.cn/1.jpg')
    expect(imgUrl(BASE, once)).toBe(once)
    expect(imgUrl(BASE, imgUrl(BASE, once))).toBe(once)
    expect(imageProxyBypass(once)).toBe('already-proxied')
  })

  // 后端在另一个源上（工作台面板住 DSH 那一页），所以根相对
  // 地址不能原样交给浏览器；但它已经在我们这一侧，缺的是源不是代理。
  it('根相对 = 后端自己的路由 → 只补源，不代理', () => {
    expect(imgUrl(BASE, '/api/media/netdisk-thumb?p=a')).toBe(`${BASE}/api/media/netdisk-thumb?p=a`)
    expect(imageProxyBypass('/api/media/netdisk-thumb?p=a')).toBe('backend-route')
  })

  it('data: / blob: 原样放行——字节已经在手里，代理无从取起', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    const blob = 'blob:http://127.0.0.1:8900/9f2c-1'
    expect(imgUrl(BASE, data)).toBe(data)
    expect(imgUrl(BASE, blob)).toBe(blob)
    expect(imageProxyBypass(data)).toBe('data')
    expect(imageProxyBypass(blob)).toBe('blob')
  })

  // 协议相对在浏览器里合法，但后端 `new URL('//h/1.jpg')` 解析不了 → 补 scheme 再交出去。
  it('协议相对补上 https: 再代理', () => {
    expect(imgUrl(BASE, '//p.qpic.cn/1.jpg')).toBe(proxied('https://p.qpic.cn/1.jpg'))
  })
})
