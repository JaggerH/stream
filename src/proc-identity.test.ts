// src/proc-identity.test.ts
import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { portHolder } from './proc-identity.ts'

/** 一份最小的假 /proc：监听表 + 一个持着那个 socket 的进程。 */
function fakeProc(opts: { hexPort: string; state?: string; inode?: string; ownerFdLink?: string }) {
  const inode = opts.inode ?? '99001'
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    `   0: 0100007F:${opts.hexPort} 00000000:0000 ${opts.state ?? '0A'} 00000000:00000000 00:00000000 00000000  1000 0 ${inode} 1 0 0 0 0`,
  ].join('\n')
  return {
    read: (p: string) => {
      if (p === '/proc/net/tcp') return tcp
      throw new Error('ENOENT')
    },
    listDirs: (p: string) => {
      if (p === '/proc') return ['1234', 'net', 'self']
      if (p === '/proc/1234/fd') return ['0', '7']
      throw new Error('EACCES')
    },
    readLink: (p: string) => {
      if (p === '/proc/1234/fd/7') return opts.ownerFdLink ?? `socket:[${inode}]`
      return 'pipe:[1]'
    },
  }
}

describe('portHolder', () => {
  it('按监听表的 inode 找到持有它的进程', () => {
    const f = fakeProc({ hexPort: '22C5' }) // 8901
    expect(portHolder(8901, f.read, f.listDirs, f.readLink)?.pid).toBe(1234)
  })

  it('只认 LISTEN（0A）行——同口的已建立连接不算占口', () => {
    const f = fakeProc({ hexPort: '22C5', state: '01' })
    expect(portHolder(8901, f.read, f.listDirs, f.readLink)).toBeNull()
  })

  it('没有进程持着那个 socket 时回 null，不猜一个 pid', () => {
    const f = fakeProc({ hexPort: '22C5', ownerFdLink: 'socket:[7]' })
    expect(portHolder(8901, f.read, f.listDirs, f.readLink)).toBeNull()
  })

  it('真机：自己占一个口，能把自己认出来（钉住十六进制口/字段下标没算错）', async () => {
    if (!existsSync('/proc/net/tcp')) return // /proc 不可读的平台上这条无从谈起
    const srv = createServer()
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    try {
      const holder = portHolder(port)
      expect(holder?.pid).toBe(process.pid)
      expect(holder?.cmdline).toBeTruthy()
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })
})
