// capabilities/desktop/src/wsl.test.ts
//
// 这几个函数是包里**唯一**一份 WSL 判据：`isWslVersionString` 的判据必须与 `register.rs::is_wsl` 一致，
// `buildWindowsAgentEnv` 的 WSLENV 名单必须与实际传给 spawn 的 env 同源，
// `buildRegisterEnv` 是 `--register` 那次 spawn 的 env 来源（`host-agent/index.ts` 的
// `defaultDeps().register`）——「register 真的收到了 STREAM_DATA_DIR」那一条钉在
// `host-agent/index.test.ts` 里，这里只钉这个纯函数自己的两支。
import { describe, it, expect } from 'vitest'
import { isWslVersionString, buildWindowsAgentEnv, translateToWindowsPath, buildRegisterEnv, detectWsl } from './wsl.ts'

describe('isWslVersionString（判据必须与 register.rs 的 is_wsl 一致——同抄一条，别自己发明）', () => {
  it('本机实测的 WSL2 内核字符串 → true', () => {
    expect(isWslVersionString('Linux version 5.15.167.4-microsoft-standard-WSL2 (...)')).toBe(true)
  })
  it('普通 Linux 内核字符串 → false', () => {
    expect(isWslVersionString('Linux version 6.8.0-generic (...)')).toBe(false)
  })
})

describe('detectWsl（读不到 /proc/version 就当不是 WSL，不抛）', () => {
  it('注入的读取函数返回 WSL 字符串 → true', () => {
    expect(detectWsl(() => 'Linux version 5.15.0-microsoft-standard-WSL2')).toBe(true)
  })
  it('注入的读取函数抛出（文件不存在等）→ false，不往外抛', () => {
    expect(
      detectWsl(() => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })
})

describe('translateToWindowsPath', () => {
  it('wslpath -w 成功 → 返回翻译后的路径（去掉尾部换行）', () => {
    const out = translateToWindowsPath('/data', () => ({ status: 0, stdout: '\\\\wsl.localhost\\Ubuntu\\data\n' }))
    expect(out).toBe('\\\\wsl.localhost\\Ubuntu\\data')
  })
  it('wslpath 非 0 退出 → undefined', () => {
    const out = translateToWindowsPath('/data', () => ({ status: 1, stdout: '' }))
    expect(out).toBeUndefined()
  })
  it('wslpath 输出全是空白 → 当失败处理（undefined）', () => {
    const out = translateToWindowsPath('/data', () => ({ status: 0, stdout: '   \n' }))
    expect(out).toBeUndefined()
  })
})

describe('buildWindowsAgentEnv（WSLENV 名单必须与实际传给 spawn 的 env 同源）', () => {
  it('把 env 的所有 key 拼进 WSLENV，原 env 的值不变', () => {
    const env = { STREAM_DATA_DIR: '/data' }
    const out = buildWindowsAgentEnv(env)
    expect(out.STREAM_DATA_DIR).toBe('/data')
    expect(out.WSLENV).toBe('STREAM_DATA_DIR')
  })

  it('不改原对象（纯函数）', () => {
    const env = { A: '1' }
    buildWindowsAgentEnv(env)
    expect(env).toEqual({ A: '1' })
  })
})

// `--register` 子进程该带的 env。收的是**已经解析好**的 dataDir——翻译在 mountHostAgent 里
// 只做一次，这个函数不自己翻。
describe('buildRegisterEnv', () => {
  it('非 WSL：只有 STREAM_DATA_DIR，不加 WSLENV', () => {
    expect(buildRegisterEnv('/data', false)).toEqual({ STREAM_DATA_DIR: '/data' })
  })

  // 收的是**已经解析好**的路径（WSL 下调用方给的就是 Windows 路径）——这个函数不自己翻，
  // 翻译在 mountHostAgent 里只做一次。这里传一个 Windows 形状的值正是为了钉住这条：
  // 它原样出去，没有被二次翻译。
  it('WSL：原样带上调用方给的路径，并补一个只含它自己的 WSLENV', () => {
    expect(buildRegisterEnv('\\\\wsl.localhost\\Ubuntu\\data', true)).toEqual({
      STREAM_DATA_DIR: '\\\\wsl.localhost\\Ubuntu\\data',
      WSLENV: 'STREAM_DATA_DIR',
    })
  })
})
