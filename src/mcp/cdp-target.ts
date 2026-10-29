export interface CdpTarget {
  scheme: 'chrome' | 'facility' | 'desktop' | 'app' | 'window' | 'device'
  address?: string
}

/** `app:<process>[/<title>]` 拆开。标题是**可选后缀**：多数应用只有一个主窗口，强制填标题
 *  是无谓负担；而一旦有多窗口（Chrome 同时开着账户选择器和主窗口是常态），没有标题就完全
 *  无解。标题按**包含**匹配——真实窗口标题带动态前后缀，全等在活体上几乎必然落空。 */
export function parseAppAddress(address: string): { process: string; title?: string } {
  const slash = address.indexOf('/')
  if (slash === -1) return { process: address }
  const process = address.slice(0, slash).trim()
  const title = address.slice(slash + 1).trim()
  if (!process) throw new Error(`target 'app' needs a process, e.g. app:chrome.exe`)
  return title ? { process, title } : { process }
}

/** `device:<deviceId>/chrome[:<tabId>]` 的 address 拆开。deviceId 自己带冒号（`linux:nas`），
 *  所以解析器只切**第一个冒号**拿 scheme，这里拿到的是剩下的整段；deviceId 与 chrome 段按
 *  第一个 `/` 切开，chrome 段必须是 `chrome` 或 `chrome:<tabId>`。 */
export function parseDeviceChrome(address: string): { deviceId: string; chrome: string } {
  const slash = address.indexOf('/')
  const deviceId = slash === -1 ? '' : address.slice(0, slash).trim()
  const chrome = slash === -1 ? '' : address.slice(slash + 1).trim()
  if (!deviceId || !/^chrome(:\d+)?$/.test(chrome)) {
    throw new Error(`target 'device' needs an address like <deviceId>/chrome or <deviceId>/chrome:<tabId>, e.g. device:linux:nas/chrome`)
  }
  return { deviceId, chrome }
}

/** Parse a target URI: `chrome` | `chrome:<tabId>` | `facility:<name>` | `desktop` | `app:<process>[/<title>]` | `window:<id>` | `device:<deviceId>/chrome[:<tabId>]`.
 *  scheme = the terminal (which page), the part after `:` is the terminal-local address.
 *  Throws on an unknown scheme, a missing required address, or a forbidden address.
 *
 *  `facility:<name>` was briefly spelled `cloak:<name>`, back when a facility's harvest tab lived
 *  in Stream's own CloakBrowser. That browser is gone (the tab is now one of the user's own Chrome
 *  tabs) and the alias went with it, deliberately: a `cloak:` that still worked would keep a
 *  retired component alive in muscle memory and in every doc copied from an older one. It now
 *  fails as an unknown scheme, which is the error that tells you to write `facility:`. */
export function parseCdpTarget(target: string): CdpTarget {
  const idx = target.indexOf(':')
  const scheme = (idx === -1 ? target : target.slice(0, idx)).trim()
  const address = idx === -1 ? undefined : target.slice(idx + 1).trim() || undefined

  switch (scheme) {
    case 'chrome':
      return address ? { scheme, address } : { scheme }
    case 'facility':
      if (!address) throw new Error(`target 'facility' needs a facility, e.g. facility:xhs`)
      return { scheme, address }
    case 'desktop':
      // 「现在屏幕上最前面那个窗口」。不接地址——要指名窗口就用 app:。
      if (address) throw new Error(`target 'desktop' takes no address; name a window with app:<process>[/<title>] or window:<id>`)
      return { scheme }
    case 'app':
      if (!address) throw new Error(`target 'app' needs a process, e.g. app:chrome.exe or app:chrome.exe/\u6269\u5c55\u7a0b\u5e8f`)
      return { scheme, address }
    case 'window':
      // 按 `cdp_pages({target:'desktop'})` 报出来的 id 指名一扇窗（Windows 是 HWND、mac 是
      // CGWindowID）。同进程、同标题的两扇窗（两个 Chrome profile 各开一扇「扩展程序」）
      // app: 怎么写都是歧义，只有 id 分得开。id 活到窗口关掉为止，**别写进 recipe**。
      if (!address) throw new Error(`target 'window' needs a window id from cdp_pages({target:'desktop'}), e.g. window:396088`)
      return { scheme, address }
    case 'device':
      // 那台设备（配对的桌面 agent 名下）的扩展浏览器。deviceId 里的冒号不参与 scheme 切分
      // （切第一个冒号后整段都是 address），地址形状在这里当场验——坏形状在解析期就报，
      // 不等派发到 device 档才炸。
      if (!address) throw new Error(`target 'device' needs an address like <deviceId>/chrome, e.g. device:linux:nas/chrome`)
      parseDeviceChrome(address)
      return { scheme, address }
    default:
      throw new Error(`unknown target scheme '${scheme}'; known: chrome, facility, desktop, app, window, device`)
  }
}
