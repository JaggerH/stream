import { describe, it, expect } from 'vitest'
import { parseCdpTarget, parseAppAddress, parseDeviceChrome } from './cdp-target.ts'

describe('parseCdpTarget', () => {
  it('parses chrome with no address', () => {
    expect(parseCdpTarget('chrome')).toEqual({ scheme: 'chrome' })
  })
  it('parses chrome:<tabId>', () => {
    expect(parseCdpTarget('chrome:42')).toEqual({ scheme: 'chrome', address: '42' })
  })
  it('parses facility:<name>', () => {
    expect(parseCdpTarget('facility:xhs')).toEqual({ scheme: 'facility', address: 'xhs' })
  })
  // The alias retired with the browser it named: a working `cloak:` would keep CloakBrowser alive
  // in muscle memory and in docs copied from older docs. Failing loudly is the point.
  it('rejects the retired cloak:<name> spelling', () => {
    expect(() => parseCdpTarget('cloak:xhs')).toThrow(/unknown target scheme 'cloak'/)
  })
  it('rejects facility without a name', () => {
    expect(() => parseCdpTarget('facility')).toThrow(/facility/i)
  })
  it('rejects an unknown scheme', () => {
    expect(() => parseCdpTarget('safari:1')).toThrow(/unknown target scheme 'safari'/)
  })
  // 壳退役之后 `webview` 不再是一档面——它必须像任何陌生 scheme 一样响亮地失败，
  // 而不是静默落到别的档上。
  it('rejects the retired webview target', () => {
    expect(() => parseCdpTarget('webview')).toThrow(/unknown target scheme 'webview'/)
  })
})

/** 桌面两档。`desktop` = 现在最前面那个窗口；`app:` = 指名一个。
 *  标题是可选后缀而不是必填——多数应用只有一个主窗口，强制填是无谓负担；而一旦有多窗口
 *  （2026-08-01 实测：Chrome 同时开着账户选择器和主窗口），没有标题就完全无解。 */
describe('desktop / app 两档', () => {
  it('desktop 不接地址——要指名窗口就用 app:', () => {
    expect(parseCdpTarget('desktop')).toEqual({ scheme: 'desktop' })
    expect(() => parseCdpTarget('desktop:chrome.exe')).toThrow(/takes no address/)
  })

  it('app: 必须给进程', () => {
    expect(parseCdpTarget('app:chrome.exe')).toEqual({ scheme: 'app', address: 'chrome.exe' })
    expect(() => parseCdpTarget('app')).toThrow(/needs a process/)
  })

  it('app: 的标题是可选后缀，用 / 分开', () => {
    expect(parseAppAddress('chrome.exe')).toEqual({ process: 'chrome.exe' })
    expect(parseAppAddress('chrome.exe/扩展程序')).toEqual({ process: 'chrome.exe', title: '扩展程序' })
    // 标题里本身带 / 的（路径样标题）不该被截断——只切第一个
    expect(parseAppAddress('code.exe/a/b — VS Code')).toEqual({ process: 'code.exe', title: 'a/b — VS Code' })
  })

  it('未知 scheme 的提示里列出全部档位，别让人猜', () => {
    expect(() => parseCdpTarget('cloak:xhs')).toThrow(/desktop, app, window/)
  })

  // 两个 Chrome profile 各开一扇「扩展程序 - Google Chrome」：进程、标题一字不差，
  // app: 怎么写都是歧义——只有 windows 报出来的 id 分得开（2026-10-23 Windows 冒烟）。
  it('window:<id> 按 id 指名一扇窗，id 必填', () => {
    expect(parseCdpTarget('window:396088')).toEqual({ scheme: 'window', address: '396088' })
    expect(parseCdpTarget('window:win-3')).toEqual({ scheme: 'window', address: 'win-3' })
    expect(() => parseCdpTarget('window')).toThrow(/needs a window id/)
  })
})

describe('device 档（openspec embeddable-device-gateway）', () => {
  it('device:<deviceId>/chrome[:<tabId>]——deviceId 里的冒号不参与切分，chrome 段按 / 切', () => {
    expect(parseCdpTarget('device:linux:nas/chrome')).toEqual({ scheme: 'device', address: 'linux:nas/chrome' })
    expect(parseDeviceChrome('linux:nas/chrome')).toEqual({ deviceId: 'linux:nas', chrome: 'chrome' })
    expect(parseDeviceChrome('linux:nas/chrome:7')).toEqual({ deviceId: 'linux:nas', chrome: 'chrome:7' })
  })

  it('地址形状不对就拒：缺 /chrome 段、chrome 段写成别的名字', () => {
    expect(() => parseDeviceChrome('linux:nas')).toThrow(/chrome/)
    expect(() => parseDeviceChrome('linux:nas/firefox')).toThrow(/chrome/)
    expect(() => parseCdpTarget('device:linux:nas')).toThrow(/chrome/)
    expect(() => parseCdpTarget('device')).toThrow(/chrome/)
  })
})
