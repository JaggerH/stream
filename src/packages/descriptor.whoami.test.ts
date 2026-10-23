import { describe, expect, it } from 'vitest'
import { parseStreamDescriptor } from './descriptor.ts'

const parse = (stream: Record<string, unknown>) =>
  parseStreamDescriptor({ name: '@x/bili', version: '1.0.0', stream: { id: 'bili', facility: 'bili', ...stream } }, 'test')

describe('stream.whoami', () => {
  it('三种形状都收；http 的 signedIn 与 format 可选', () => {
    expect(parse({
      credentials: ['bilibili.com'],
      whoami: { kind: 'http', url: 'https://api.bilibili.com/x/web-interface/nav', id: 'data.mid', name: 'data.uname', signedIn: 'data.isLogin' },
    }).whoami).toMatchObject({ kind: 'http', id: 'data.mid' })
    expect(parse({
      network: { hosts: ['xiaohongshu.com'] },
      whoami: { kind: 'page', url: 'https://www.xiaohongshu.com/explore', id: '__INITIAL_STATE__.user.userInfo.userId', signedIn: '__INITIAL_STATE__.user.loggedIn' },
    }).whoami).toMatchObject({ kind: 'page' })
    expect(parse({ whoami: { kind: 'login', param: 'zjzh' } }).whoami).toEqual({ kind: 'login', param: 'zjzh' })
  })

  it('不认识的形状、缺 id、login 形状多写一格都拒', () => {
    expect(() => parse({ whoami: { kind: 'cookie', url: 'https://a.com' } })).toThrow(/stream\.whoami/)
    expect(() => parse({ credentials: ['a.com'], whoami: { kind: 'http', url: 'https://a.com/me' } })).toThrow(/stream\.whoami\.id/)
    expect(() => parse({ whoami: { kind: 'login', param: 'zjzh', signedIn: 'x' } })).toThrow(/stream\.whoami/)
  })

  it('HTML 形状的 id 要是带捕获组的正则', () => {
    const w = (id: string) => ({ credentials: ['a.com'], whoami: { kind: 'http', format: 'html', url: 'https://a.com/me', id } })
    expect(() => parse(w('uid=\\d+'))).toThrow(/stream\.whoami\.id — 要带一个捕获组/)
    expect(() => parse(w('uid=(\\d+'))).toThrow(/不是合法的正则/)
    expect(parse(w('uid=(\\d+)')).whoami).toMatchObject({ format: 'html' })
  })

  it('url 主机不在允许主机内 → 指出是 whoami.url 越界', () => {
    expect(() => parse({ credentials: ['bilibili.com'], whoami: { kind: 'http', url: 'https://evil-bilibili.com/me', id: 'id' } }))
      .toThrow(/stream\.whoami\.url — 主机 evil-bilibili\.com 不在包声明的允许主机内/)
    // network.hosts 优先于 credentials（同 packageNetwork）。
    expect(() => parse({ credentials: ['a.com'], network: { hosts: ['b.com'] }, whoami: { kind: 'page', url: 'https://www.a.com/', id: 'x.y' } }))
      .toThrow(/stream\.whoami\.url/)
    // 一个允许主机都没有：越界。
    expect(() => parse({ whoami: { kind: 'page', url: 'https://www.a.com/', id: 'x.y' } })).toThrow(/stream\.whoami\.url/)
  })
})
