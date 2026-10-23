// 握手自报字段里的节点那三格（browser-identity D1）。
import { describe, expect, it } from 'vitest'
import { cleanNodeId, parseExtHandshake, sanitizeHandshake } from './handshake.ts'

describe('handshake node fields', () => {
  it('nodeId / profileDir / profileName 从升级 URL 的 query 里取', () => {
    const q = new URLSearchParams({ nodeId: 'node_c1ea2200-1111-4222-8333-444455556666', profileDir: 'Profile 1', profileName: '工作' })
    expect(parseExtHandshake(`/api/ext?${q}`)).toEqual({
      nodeId: 'node_c1ea2200-1111-4222-8333-444455556666',
      profileDir: 'Profile 1',
      profileName: '工作',
    })
  })

  it('不是扩展生成的那个形状就当没带——它要拼进绑定 id 与文件路径', () => {
    for (const bad of ['../etc', 'node_', 'node_a/b', 'x_node_1', 'node_' + 'a'.repeat(60)]) expect(cleanNodeId(bad)).toBeUndefined()
    expect(parseExtHandshake('/api/ext?nodeId=..%2Fx&profileDir=Default')).toEqual({})
  })

  it('老扩展什么都不带', () => {
    expect(parseExtHandshake('/api/ext')).toEqual({})
  })

  it('能力缓存那一份不收节点字段', () => {
    expect(sanitizeHandshake({ extVersion: '1.0', nodeId: 'node_a' })).toEqual({ extVersion: '1.0' })
  })
})
