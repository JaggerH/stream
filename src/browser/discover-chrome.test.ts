import { describe, it, expect } from 'vitest'
import {
  discoverChromeCandidates,
  parseWindowsMounts,
  type ChromeCandidate,
  type DiscoverFs,
} from './discover-chrome.ts'

const WIN_SYS = 'Program Files/Google/Chrome/Application/chrome.exe'
const WIN_SYS_X86 = 'Program Files (x86)/Google/Chrome/Application/chrome.exe'
const USER_SUFFIX = 'AppData/Local/Google/Chrome/Application/chrome.exe'

/**
 * 全桩的 DiscoverFs。测试永远只看这里喂了什么，跑在哪台机器上、那台机器装没装 Chrome 都
 * 影响不了结果——这正是 Task 2 要求依赖注入的原因。
 */
const fakeFs = (spec: {
  files?: string[]
  dirs?: Record<string, string[]>
  path?: Record<string, string>
  mounts?: string[]
  throwOn?: (kind: 'exists' | 'listDir' | 'which' | 'windowsMounts', arg: string) => boolean
}): DiscoverFs & { calls: string[] } => {
  const files = new Set(spec.files ?? [])
  const calls: string[] = []
  const boom = (kind: 'exists' | 'listDir' | 'which' | 'windowsMounts', arg: string) => {
    if (spec.throwOn?.(kind, arg)) throw new Error(`stub blew up: ${kind} ${arg}`)
  }
  return {
    calls,
    async exists(p) {
      calls.push(`exists ${p}`)
      boom('exists', p)
      return files.has(p)
    },
    async listDir(p) {
      calls.push(`listDir ${p}`)
      boom('listDir', p)
      return spec.dirs?.[p] ?? []
    },
    async which(cmd) {
      calls.push(`which ${cmd}`)
      boom('which', cmd)
      return spec.path?.[cmd]
    },
    async windowsMounts() {
      calls.push('windowsMounts')
      boom('windowsMounts', '')
      return spec.mounts ?? []
    },
  }
}

const exes = (cs: ChromeCandidate[]) => cs.map((c) => c.exe)

describe('discoverChromeCandidates', () => {
  it('只有 Windows 侧：找到系统级安装', async () => {
    const fs = fakeFs({ mounts: ['/mnt/c'], files: [`/mnt/c/${WIN_SYS}`] })
    expect(await discoverChromeCandidates(fs)).toEqual([
      { exe: `/mnt/c/${WIN_SYS}`, side: 'windows', source: 'standard' },
    ])
  })

  it('只有 Windows 侧：Program Files (x86) 同样算候选', async () => {
    const fs = fakeFs({ mounts: ['/mnt/c'], files: [`/mnt/c/${WIN_SYS}`, `/mnt/c/${WIN_SYS_X86}`] })
    expect(await discoverChromeCandidates(fs)).toEqual([
      { exe: `/mnt/c/${WIN_SYS}`, side: 'windows', source: 'standard' },
      { exe: `/mnt/c/${WIN_SYS_X86}`, side: 'windows', source: 'standard' },
    ])
  })

  it('只有 Linux 侧：PATH 里的 chrome/chromium 都算候选', async () => {
    const fs = fakeFs({
      path: { 'google-chrome': '/usr/bin/google-chrome', chromium: '/usr/bin/chromium' },
    })
    expect(await discoverChromeCandidates(fs)).toEqual([
      { exe: '/usr/bin/google-chrome', side: 'linux', source: 'path' },
      { exe: '/usr/bin/chromium', side: 'linux', source: 'path' },
    ])
  })

  it('两侧都有：全都返回，Windows 侧排在前——但只是排序，没有替用户选中任何一个', async () => {
    const fs = fakeFs({
      mounts: ['/mnt/c'],
      files: [`/mnt/c/${WIN_SYS}`],
      path: { 'google-chrome': '/usr/bin/google-chrome' },
    })
    const got = await discoverChromeCandidates(fs)
    expect(got.map((c) => c.side)).toEqual(['windows', 'linux'])
    // 返回值里没有"选中"这个概念：两条并列，选谁是调用方问用户的事（spec §4）
    expect(got).toHaveLength(2)
    expect(Object.keys(got[0]).sort()).toEqual(['exe', 'side', 'source'])
  })

  it('两侧都没有：空清单，不抛', async () => {
    const fs = fakeFs({ mounts: ['/mnt/c'], dirs: { '/mnt/c/Users': ['Jagger'] } })
    expect(await discoverChromeCandidates(fs)).toEqual([])
  })

  it('挂载点不是 c（wsl.conf 改过 root）时照样发现，绝不硬编码 /mnt/c', async () => {
    const fs = fakeFs({ mounts: ['/windows/d'], files: [`/windows/d/${WIN_SYS}`] })
    expect(exes(await discoverChromeCandidates(fs))).toEqual([`/windows/d/${WIN_SYS}`])
    // 一次都没去碰 /mnt/c
    expect(fs.calls.some((c) => c.includes('/mnt/c'))).toBe(false)
  })

  it('多块盘各有一个 Chrome：都发现，按挂载顺序', async () => {
    const fs = fakeFs({
      mounts: ['/mnt/c', '/mnt/d'],
      files: [`/mnt/c/${WIN_SYS}`, `/mnt/d/${WIN_SYS}`],
    })
    expect(exes(await discoverChromeCandidates(fs))).toEqual([
      `/mnt/c/${WIN_SYS}`,
      `/mnt/d/${WIN_SYS}`,
    ])
  })

  it('多个 Windows 用户目录：全部枚举，不用 Linux 用户名去拼', async () => {
    const fs = fakeFs({
      mounts: ['/mnt/c'],
      dirs: { '/mnt/c/Users': ['Public', 'Alice', 'Bob', 'Default'] },
      files: [`/mnt/c/Users/Alice/${USER_SUFFIX}`, `/mnt/c/Users/Bob/${USER_SUFFIX}`],
    })
    expect(await discoverChromeCandidates(fs)).toEqual([
      { exe: `/mnt/c/Users/Alice/${USER_SUFFIX}`, side: 'windows', source: 'user-install' },
      { exe: `/mnt/c/Users/Bob/${USER_SUFFIX}`, side: 'windows', source: 'user-install' },
    ])
    // 枚举，不是拼：Users 下每一项都问过，包括最终没装 Chrome 的
    expect(fs.calls).toContain(`exists /mnt/c/Users/Public/${USER_SUFFIX}`)
    expect(fs.calls).toContain(`exists /mnt/c/Users/Default/${USER_SUFFIX}`)
  })

  it('系统级 + 用户级并存：系统级在前', async () => {
    const fs = fakeFs({
      mounts: ['/mnt/c'],
      dirs: { '/mnt/c/Users': ['ExampleUser'] },
      files: [`/mnt/c/${WIN_SYS}`, `/mnt/c/Users/ExampleUser/${USER_SUFFIX}`],
    })
    expect(exes(await discoverChromeCandidates(fs))).toEqual([
      `/mnt/c/${WIN_SYS}`,
      `/mnt/c/Users/ExampleUser/${USER_SUFFIX}`,
    ])
  })

  it('同一个 exe 只出现一次（两个命令名指向同一个二进制 / 同一块盘挂了两处）', async () => {
    const fs = fakeFs({
      mounts: ['/mnt/c', '/mnt/c/'],
      files: [`/mnt/c/${WIN_SYS}`],
      path: { 'google-chrome': '/usr/bin/chrome', 'google-chrome-stable': '/usr/bin/chrome' },
    })
    expect(exes(await discoverChromeCandidates(fs))).toEqual([`/mnt/c/${WIN_SYS}`, '/usr/bin/chrome'])
  })

  it('非 WSL（没有 Windows 挂载）时一个 /mnt 路径都不探', async () => {
    const fs = fakeFs({ path: { chromium: '/usr/bin/chromium' } })
    await discoverChromeCandidates(fs)
    expect(fs.calls.filter((c) => c.startsWith('exists'))).toEqual([])
    expect(fs.calls.filter((c) => c.startsWith('listDir'))).toEqual([])
  })

  it('单个探测抛异常不会拖垮整轮发现', async () => {
    const fs = fakeFs({
      mounts: ['/mnt/c', '/mnt/d'],
      files: [`/mnt/d/${WIN_SYS}`],
      path: { chromium: '/usr/bin/chromium' },
      // C 盘掉了：列 Users 和查系统目录都炸
      throwOn: (_kind, arg) => arg.startsWith('/mnt/c'),
    })
    expect(exes(await discoverChromeCandidates(fs))).toEqual([`/mnt/d/${WIN_SYS}`, '/usr/bin/chromium'])
  })

  it('windowsMounts 本身抛异常时退化成纯 Linux 发现', async () => {
    const fs = fakeFs({
      path: { 'google-chrome': '/usr/bin/google-chrome' },
      throwOn: (kind) => kind === 'windowsMounts',
    })
    expect(exes(await discoverChromeCandidates(fs))).toEqual(['/usr/bin/google-chrome'])
  })
})

// 本机 2026-07-29 实测的 /proc/mounts 片段（含 Docker Desktop 的重复绑定），不是手编的
const REAL_PROC_MOUNTS = [
  'none /mnt/wsl tmpfs rw,relatime 0 0',
  'drivers /usr/lib/wsl/drivers 9p ro,dirsync,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222,mmap,access=client,msize=65536,trans=fd,rfd=8,wfd=8 0 0',
  '/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0',
  'C:\\134 /mnt/c 9p rw,dirsync,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=6,wfd=6 0 0',
  'C:\\134 /mnt/wsl/docker-desktop-bind-mounts/Ubuntu/8e44293574240765226f639281b89726874b555f 9p rw,dirsync,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=6,wfd=6 0 0',
  'C:\\134 /mnt/c 9p rw,dirsync,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=6,wfd=6 0 0',
  'C:\\134Program\\040Files\\134Docker\\134Docker\\134resources /Docker/host 9p rw,dirsync,noatime,aname=drvfs;path=C:\\Program Files\\Docker\\Docker\\resources;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=3,wfd=3 0 0',
  '',
].join('\n')

describe('parseWindowsMounts', () => {
  it('真实 /proc/mounts：一块盘只出一个挂载点，Docker 的重复绑定和非盘根的 9p 都排掉', () => {
    expect(parseWindowsMounts(REAL_PROC_MOUNTS)).toEqual(['/mnt/c'])
  })

  it('多块盘按盘符排序', () => {
    const src = [
      'D:\\134 /mnt/d 9p rw,aname=drvfs;path=D:\\;uid=1000 0 0',
      'C:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\;uid=1000 0 0',
    ].join('\n')
    expect(parseWindowsMounts(src)).toEqual(['/mnt/c', '/mnt/d'])
  })

  it('wsl.conf 把 root 改成 /windows/ 时读出来的就是 /windows/c', () => {
    const src = 'C:\\134 /windows/c 9p rw,aname=drvfs;path=C:\\;uid=1000 0 0'
    expect(parseWindowsMounts(src)).toEqual(['/windows/c'])
  })

  it('老式 drvfs 行没有 path= 选项，退回设备字段判盘根', () => {
    const src = 'C: /mnt/c drvfs rw,noatime,uid=1000,gid=1000 0 0'
    expect(parseWindowsMounts(src)).toEqual(['/mnt/c'])
  })

  it('挂载点里的空格按八进制转义还原', () => {
    const src = 'C:\\134 /mnt/my\\040drive 9p rw,aname=drvfs;path=C:\\;uid=1000 0 0'
    expect(parseWindowsMounts(src)).toEqual(['/mnt/my drive'])
  })

  it('纯 Linux（没有任何 Windows 盘）返回空', () => {
    const src = ['/dev/sda1 / ext4 rw,relatime 0 0', 'proc /proc proc rw,nosuid 0 0'].join('\n')
    expect(parseWindowsMounts(src)).toEqual([])
  })

  it('空输入 / 残行不抛', () => {
    expect(parseWindowsMounts('')).toEqual([])
    expect(parseWindowsMounts('garbage\nC:\\134 /mnt/c\n')).toEqual([])
  })
})
