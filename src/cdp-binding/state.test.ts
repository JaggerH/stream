/**
 * 状态文件：token + nodeId（+ 非机密的 bindingId），0600，写坏就抛。
 *
 * 它是"重启不再要配对码"的全部依据——所以两件事都要钉住：**权限**（唯一秘密在里头）与
 * **原子写**（半截 JSON = 下次启动重新配对，而那时可能没有码可喂）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newNodeId, readCdpBindingState, writeCdpBindingState, type CdpBindingState } from './state.ts'

const dirs: string[] = []
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'stream-cdp-state-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const state: CdpBindingState = {
  token: 't'.repeat(64),
  nodeId: 'node_0b6a4a3e-1111-4222-8333-444455556666',
  bindingId: 'ext:test',
}

describe('CdpBinding 的状态文件', () => {
  it('写进去再读出来是同一份；文件 0600、目录按需建', () => {
    const file = join(dir(), 'nested', 'cdp-binding.json')
    writeCdpBindingState(file, state)
    expect(readCdpBindingState(file)).toEqual(state)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('已经存在的文件被覆盖后权限仍是 0600（mode 只在创建时生效）', () => {
    const file = join(dir(), 'cdp-binding.json')
    writeFileSync(file, '{}', { mode: 0o644 })
    writeCdpBindingState(file, state)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('文件里只有 token / nodeId / bindingId——配对码用完即弃，不落盘', () => {
    const file = join(dir(), 'cdp-binding.json')
    writeCdpBindingState(file, state)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['bindingId', 'nodeId', 'token'])
  })

  it('没有文件 / 半截 JSON / 字段不全 / nodeId 形状不对 → null（重新配对，不是崩）', () => {
    const d = dir()
    expect(readCdpBindingState(join(d, 'missing.json'))).toBeNull()
    const bad = join(d, 'bad.json')
    writeFileSync(bad, '{"token": "t"')
    expect(readCdpBindingState(bad)).toBeNull()
    writeFileSync(bad, JSON.stringify({ token: 't', nodeId: state.nodeId }))
    expect(readCdpBindingState(bad)).toBeNull()
    writeFileSync(bad, JSON.stringify({ ...state, nodeId: '../../etc/passwd' }))
    expect(readCdpBindingState(bad)).toBeNull()
  })

  it('newNodeId 的形状与服务端认的一致（node_ + uuid）', () => {
    const id = newNodeId()
    expect(id).toMatch(/^node_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(newNodeId()).not.toBe(id)
  })
})
